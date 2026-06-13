/* ============================================================
   FOLIUM CAFÉ — sw.ts  (service worker, built by esbuild)
   BUILD_ID is injected at build time (git SHA in CI, 'dev' locally).
   ============================================================ */
declare const BUILD_ID: string;
const sw = self as unknown as ServiceWorkerGlobalScope;

const SHELL_CACHE = `folium-shell-${BUILD_ID}`;
const CDN_CACHE = 'folium-cdn-v1';      // unpkg fonts/cmaps; bump only on PDFJS_VER change
const VENDOR_CACHE = 'folium-vendor-v1'; // lazily-loaded /vendor/* libs (e.g. fflate)
const SHARED_CACHE = 'folium-shared';   // share-target intake, drained by the app
// folium-pdf and folium-data are owned by app.ts and must survive SW updates.
const KEEP = new Set([SHELL_CACHE, CDN_CACHE, VENDOR_CACHE, SHARED_CACHE, 'folium-pdf', 'folium-data']);

// Precached vendor files (served from SHELL_CACHE); lazily-loaded vendor files
// not in this set are cache-first into VENDOR_CACHE on first fetch.
const SHELL_VENDOR = new Set(['/vendor/pdf.min.js', '/vendor/pdf.worker.min.js', '/vendor/marked.min.js']);

const SHELL = [
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/favicon-32.png',
  '/vendor/pdf.min.js',
  '/vendor/pdf.worker.min.js',
  '/vendor/marked.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/crest-mono.svg',
  '/icons/apple-touch-icon.png',
  '/icons/shortcut-continue.png',
];

sw.addEventListener('install', (e: ExtendableEvent) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => sw.skipWaiting())
  );
});

sw.addEventListener('activate', (e: ExtendableEvent) => {
  e.waitUntil((async () => {
    // Only stale shell/cdn caches are deleted; user data caches are never touched.
    for (const k of await caches.keys()) {
      if (/^folium-(shell|cdn)-/.test(k) && !KEEP.has(k)) await caches.delete(k);
    }
    await sw.clients.claim();
  })());
});

async function cacheFirst(cacheName: string, req: Request): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

sw.addEventListener('fetch', (e: FetchEvent) => {
  const url = new URL(e.request.url);

  // share_target: stash the shared PDFs, bounce to the app. The POST never
  // reaches CloudFront (which only allows GET on the site behavior).
  if (e.request.method === 'POST' && url.pathname === '/share-target') {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const files = form.getAll('pdfs').filter((f): f is File => f instanceof File);
        const cache = await caches.open(SHARED_CACHE);
        for (const f of files) {
          await cache.put(
            '/shared/' + Date.now() + '-' + Math.random().toString(16).slice(2) + '-' + encodeURIComponent(f.name),
            new Response(f, { headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(f.name) } })
          );
        }
      } catch (err) {
        console.warn('share-target intake failed', err);
      }
      return Response.redirect('/?shared=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET') return;

  // /api/*: straight to the network. The app layer owns offline fallbacks so
  // it can tell 401 (login) apart from network failure (offline mode).
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;

  // Navigations: network-first, cached shell offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(async () =>
        (await caches.match('/index.html')) ?? Response.error())
    );
    return;
  }

  // PDF.js lazy assets (standard fonts, cmaps) from unpkg: cache-first.
  if (url.hostname === 'unpkg.com') {
    e.respondWith(cacheFirst(CDN_CACHE, e.request));
    return;
  }

  // Lazily-loaded /vendor/* libs (e.g. fflate) that aren't precached in SHELL:
  // cache-first into VENDOR_CACHE so they work offline after the first use. The
  // precached vendor files fall through to the SHELL cache-first below.
  if (url.origin === location.origin && url.pathname.startsWith('/vendor/') && !SHELL_VENDOR.has(url.pathname)) {
    e.respondWith(cacheFirst(VENDOR_CACHE, e.request));
    return;
  }

  // Same-origin static (app shell): cache-first against the versioned cache.
  // Presigned S3 URLs are cross-origin and fall through untouched — app.ts
  // caches PDF bytes itself under stable keys.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then(hit => hit ?? fetch(e.request))
    );
  }
});
