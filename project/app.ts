/* ============================================================
   FOLIUM CAFÉ — app.ts  (so you remember the page you were on)
   ============================================================ */
(() => {

// ---------- pdf.js ----------
// The preview iframe pauses requestAnimationFrame; pdf.js's display renderer
// drives its continuation loop with rAF, so we route it through setTimeout.
// (Works identically in a normally-loaded browser tab.)
(window as any).requestAnimationFrame = (cb: FrameRequestCallback): number =>
  window.setTimeout(() => cb(performance.now()), 0) as unknown as number;

const pdfjs: any = (window as any).pdfjsLib;
const PDFJS_VER = '3.11.174';
// unpkg is only used for the lazy standard fonts / CJK cmaps; the library and
// its worker are self-hosted under /vendor so the reader works offline.
const PDFJS_CDN = 'https://unpkg.com/pdfjs-dist@' + PDFJS_VER;
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';

// ---------- types ----------
interface Book {
  id: string;
  title: string;
  author: string;
  fileName: string;
  data: ArrayBuffer;
  numPages: number;
  currentPage: number;
  cover: string | null;   // dataURL or null -> generated text cover
  addedAt: number;
  lastReadAt: number;
}
type ViewMode = 'shelf' | 'grid' | 'list';

// A clipping: a saved selection from one page. rects are normalized page
// coordinates (fractions 0..1) so they reflow across zoom/width/resize.
// A region clip has one rect; a text clip (phase 2) has one rect per line + text.
interface Rect { x: number; y: number; w: number; h: number; }
interface Clip {
  id: string;
  page: number;
  rects: Rect[];
  color: string;
  text?: string;
  note?: string;
  createdAt: number;
}

// ---------- tiny DOM helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;
const el = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// ---------- i18n ----------
// Locale-aware UI strings. The EN dict is the source of truth for the key set;
// PT/ES are typed off it so `tsc --noEmit` fails on any missing or extra key.
// Never translated: the FOLIUM CAFÉ wordmark/crest, <title>,
// manifest.webmanifest (incl. the "Continue reading" shortcut), meta description.
type Locale = 'en' | 'pt-BR' | 'es';
type LangPref = 'system' | Locale;

const EN = {
  'login.tagline': 'so you remember the page you were on',
  'login.reader': 'Reader',
  'login.namePh': 'Your name',
  'login.passphrase': 'Passphrase',
  'login.submit': 'Enter the café',
  'login.note': 'Your library is kept on a private shelf — sign in from any device to pick up where you left off.',
  'mast.libraryTitle': 'Library',
  'mast.viewAria': 'Library view',
  'mast.shelf': 'Shelf',
  'mast.shelfTitle': 'Bookshelf',
  'mast.covers': 'Covers',
  'mast.coversTitle': 'Cover grid',
  'mast.list': 'List',
  'mast.listTitle': 'Reading list',
  'mast.add': 'Add books',
  'mast.addTitle': 'Add PDFs',
  'menu.atCafe': 'at the café',
  'menu.settings': 'Settings',
  'menu.install': 'Install Folium Café',
  'menu.signOut': 'Sign out',
  'mast.offline': 'Offline',
  'common.reader': 'Reader',
  'lib.title': 'Your Library',
  'lib.count.one': '{n} volume',
  'lib.count.other': '{n} volumes',
  'lib.continue': 'Continue reading',
  'lib.resume': 'Resume',
  'lib.read': 'Read',
  'lib.new': 'New',
  'lib.pageOf': 'Page {page} of {total} · {pct}%',
  'lib.unknownAuthor': 'Unknown author',
  'lib.unknown': 'Unknown',
  'lib.offlineDot': 'Available offline',
  'lib.remove': 'Remove',
  'lib.emptyTitle': 'Your shelves are empty',
  'lib.emptyBody': 'Add a PDF to begin your collection. Your shelf follows you to any device.',
  'lib.emptyAdd': 'Add your first book',
  'lib.confirmRemove': 'Remove “{title}” from your library?\nThis removes the book from your shelf.',
  'rdr.back': 'Back to library',
  'rdr.prevPage': 'Previous page',
  'rdr.nextPage': 'Next page',
  'rdr.prev': 'Previous',
  'rdr.next': 'Next',
  'rdr.widthTitle': 'Page width',
  'rdr.comfort': 'Comfort',
  'rdr.full': 'Full',
  'rdr.zoomOut': 'Zoom out',
  'rdr.zoomIn': 'Zoom in',
  'rdr.focus': 'Distraction-free (F)',
  'rdr.zenHint': 'Move the cursor up to show controls · Esc to exit',
  'drop.kicker': 'Add to your library',
  'drop.body': 'Drop PDF files to shelve them',
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.langSystem': 'System default',
  'settings.done': 'Done',
  'toast.offlineAdd': 'You’re offline — try adding books when you’re back online',
  'toast.cantRead': 'Could not read “{name}”',
  'toast.pdfOnly': 'Please choose PDF files',
  'toast.shelving.one': 'Shelving your book…',
  'toast.shelving.other': 'Shelving {n} books…',
  'toast.shelvingShared.one': 'Shelving your shared book…',
  'toast.shelvingShared.other': 'Shelving {n} shared books…',
  'toast.added': 'Added to your library',
  'toast.offlineRetry': 'You’re offline — try again when you’re back online',
  'toast.removed': 'Removed from library',
  'toast.cantOpen': 'Could not open that book',
  'toast.cantLoad': 'Could not load this PDF',
  'toast.notDownloaded': 'This book isn’t downloaded on this device',
  'toast.loadFailed': 'Failed to load this PDF',
  'toast.wrongPass': 'Wrong password',
  'toast.noServer': 'Could not reach the server',
  'time.notOpened': 'Not yet opened',
  'time.justNow': 'Just now',
  'pwa.updated': 'Folium Café has been updated',
  'pwa.installed': 'Folium Café is on your home screen',
  'clip.snapshot': 'Snapshot and share',
  'clip.captureHint': 'Drag a box over the page — Esc to cancel',
  'clip.sheetTitle': 'Share a clipping',
  'clip.color': 'Highlight colour',
  'clip.save': 'Save clipping',
  'clip.share': 'Share',
  'clip.download': 'Download',
  'clip.delete': 'Delete',
  'clip.close': 'Close',
  'clip.saved': 'Clipping saved',
  'clip.removed': 'Clipping removed',
  'clip.shareFailed': 'Could not share — downloaded instead',
} as const;
type MsgKey = keyof typeof EN;

const PT: Record<MsgKey, string> = {
  'login.tagline': 'para você lembrar da página em que parou',
  'login.reader': 'Leitor',
  'login.namePh': 'Seu nome',
  'login.passphrase': 'Senha',
  'login.submit': 'Entrar no café',
  'login.note': 'Sua biblioteca fica numa estante particular — entre de qualquer dispositivo para continuar de onde parou.',
  'mast.libraryTitle': 'Biblioteca',
  'mast.viewAria': 'Visualização da biblioteca',
  'mast.shelf': 'Estante',
  'mast.shelfTitle': 'Estante de livros',
  'mast.covers': 'Capas',
  'mast.coversTitle': 'Grade de capas',
  'mast.list': 'Lista',
  'mast.listTitle': 'Lista de leitura',
  'mast.add': 'Adicionar livros',
  'mast.addTitle': 'Adicionar PDFs',
  'menu.atCafe': 'no café',
  'menu.settings': 'Configurações',
  'menu.install': 'Instalar o Folium Café',
  'menu.signOut': 'Sair',
  'mast.offline': 'Offline',
  'common.reader': 'Leitor',
  'lib.title': 'Sua Biblioteca',
  'lib.count.one': '{n} volume',
  'lib.count.other': '{n} volumes',
  'lib.continue': 'Continuar lendo',
  'lib.resume': 'Retomar',
  'lib.read': 'Ler',
  'lib.new': 'Novo',
  'lib.pageOf': 'Página {page} de {total} · {pct}%',
  'lib.unknownAuthor': 'Autor desconhecido',
  'lib.unknown': 'Desconhecido',
  'lib.offlineDot': 'Disponível offline',
  'lib.remove': 'Remover',
  'lib.emptyTitle': 'Suas estantes estão vazias',
  'lib.emptyBody': 'Adicione um PDF para começar sua coleção. Sua estante acompanha você em qualquer dispositivo.',
  'lib.emptyAdd': 'Adicione seu primeiro livro',
  'lib.confirmRemove': 'Remover “{title}” da sua biblioteca?\nIsso remove o livro da sua estante.',
  'rdr.back': 'Voltar à biblioteca',
  'rdr.prevPage': 'Página anterior',
  'rdr.nextPage': 'Próxima página',
  'rdr.prev': 'Anterior',
  'rdr.next': 'Próxima',
  'rdr.widthTitle': 'Largura da página',
  'rdr.comfort': 'Conforto',
  'rdr.full': 'Total',
  'rdr.zoomOut': 'Diminuir zoom',
  'rdr.zoomIn': 'Aumentar zoom',
  'rdr.focus': 'Sem distrações (F)',
  'rdr.zenHint': 'Mova o cursor para cima para mostrar os controles · Esc para sair',
  'drop.kicker': 'Adicionar à sua biblioteca',
  'drop.body': 'Solte arquivos PDF para colocá-los na estante',
  'settings.title': 'Configurações',
  'settings.language': 'Idioma',
  'settings.langSystem': 'Padrão do sistema',
  'settings.done': 'Concluído',
  'toast.offlineAdd': 'Você está offline — tente adicionar livros quando voltar a ficar online',
  'toast.cantRead': 'Não foi possível ler “{name}”',
  'toast.pdfOnly': 'Escolha arquivos PDF',
  'toast.shelving.one': 'Colocando seu livro na estante…',
  'toast.shelving.other': 'Colocando {n} livros na estante…',
  'toast.shelvingShared.one': 'Colocando o livro compartilhado na estante…',
  'toast.shelvingShared.other': 'Colocando {n} livros compartilhados na estante…',
  'toast.added': 'Adicionado à sua biblioteca',
  'toast.offlineRetry': 'Você está offline — tente novamente quando voltar a ficar online',
  'toast.removed': 'Removido da biblioteca',
  'toast.cantOpen': 'Não foi possível abrir esse livro',
  'toast.cantLoad': 'Não foi possível carregar este PDF',
  'toast.notDownloaded': 'Este livro não está baixado neste dispositivo',
  'toast.loadFailed': 'Falha ao carregar este PDF',
  'toast.wrongPass': 'Senha incorreta',
  'toast.noServer': 'Não foi possível conectar ao servidor',
  'time.notOpened': 'Ainda não aberto',
  'time.justNow': 'Agora mesmo',
  'pwa.updated': 'O Folium Café foi atualizado',
  'pwa.installed': 'O Folium Café está na sua tela inicial',
  'clip.snapshot': 'Recortar e compartilhar',
  'clip.captureHint': 'Arraste uma caixa sobre a página — Esc para cancelar',
  'clip.sheetTitle': 'Compartilhar um recorte',
  'clip.color': 'Cor do destaque',
  'clip.save': 'Salvar recorte',
  'clip.share': 'Compartilhar',
  'clip.download': 'Baixar',
  'clip.delete': 'Excluir',
  'clip.close': 'Fechar',
  'clip.saved': 'Recorte salvo',
  'clip.removed': 'Recorte removido',
  'clip.shareFailed': 'Não foi possível compartilhar — baixado em vez disso',
};

const ES: Record<MsgKey, string> = {
  'login.tagline': 'para que recuerdes la página en la que estabas',
  'login.reader': 'Lector',
  'login.namePh': 'Tu nombre',
  'login.passphrase': 'Contraseña',
  'login.submit': 'Entrar al café',
  'login.note': 'Tu biblioteca se guarda en un estante privado: inicia sesión desde cualquier dispositivo para continuar donde lo dejaste.',
  'mast.libraryTitle': 'Biblioteca',
  'mast.viewAria': 'Vista de la biblioteca',
  'mast.shelf': 'Estante',
  'mast.shelfTitle': 'Estantería',
  'mast.covers': 'Portadas',
  'mast.coversTitle': 'Cuadrícula de portadas',
  'mast.list': 'Lista',
  'mast.listTitle': 'Lista de lectura',
  'mast.add': 'Añadir libros',
  'mast.addTitle': 'Añadir PDFs',
  'menu.atCafe': 'en el café',
  'menu.settings': 'Ajustes',
  'menu.install': 'Instalar Folium Café',
  'menu.signOut': 'Cerrar sesión',
  'mast.offline': 'Sin conexión',
  'common.reader': 'Lector',
  'lib.title': 'Tu Biblioteca',
  'lib.count.one': '{n} volumen',
  'lib.count.other': '{n} volúmenes',
  'lib.continue': 'Seguir leyendo',
  'lib.resume': 'Reanudar',
  'lib.read': 'Leer',
  'lib.new': 'Nuevo',
  'lib.pageOf': 'Página {page} de {total} · {pct}%',
  'lib.unknownAuthor': 'Autor desconocido',
  'lib.unknown': 'Desconocido',
  'lib.offlineDot': 'Disponible sin conexión',
  'lib.remove': 'Quitar',
  'lib.emptyTitle': 'Tus estantes están vacíos',
  'lib.emptyBody': 'Añade un PDF para empezar tu colección. Tu estante te sigue en cualquier dispositivo.',
  'lib.emptyAdd': 'Añade tu primer libro',
  'lib.confirmRemove': '¿Quitar “{title}” de tu biblioteca?\nEsto elimina el libro de tu estante.',
  'rdr.back': 'Volver a la biblioteca',
  'rdr.prevPage': 'Página anterior',
  'rdr.nextPage': 'Página siguiente',
  'rdr.prev': 'Anterior',
  'rdr.next': 'Siguiente',
  'rdr.widthTitle': 'Ancho de página',
  'rdr.comfort': 'Cómodo',
  'rdr.full': 'Completo',
  'rdr.zoomOut': 'Alejar',
  'rdr.zoomIn': 'Acercar',
  'rdr.focus': 'Sin distracciones (F)',
  'rdr.zenHint': 'Mueve el cursor hacia arriba para mostrar los controles · Esc para salir',
  'drop.kicker': 'Añadir a tu biblioteca',
  'drop.body': 'Suelta archivos PDF para colocarlos en el estante',
  'settings.title': 'Ajustes',
  'settings.language': 'Idioma',
  'settings.langSystem': 'Predeterminado del sistema',
  'settings.done': 'Listo',
  'toast.offlineAdd': 'Estás sin conexión: intenta añadir libros cuando vuelvas a estar en línea',
  'toast.cantRead': 'No se pudo leer “{name}”',
  'toast.pdfOnly': 'Elige archivos PDF',
  'toast.shelving.one': 'Colocando tu libro en el estante…',
  'toast.shelving.other': 'Colocando {n} libros en el estante…',
  'toast.shelvingShared.one': 'Colocando el libro compartido en el estante…',
  'toast.shelvingShared.other': 'Colocando {n} libros compartidos en el estante…',
  'toast.added': 'Añadido a tu biblioteca',
  'toast.offlineRetry': 'Estás sin conexión: inténtalo de nuevo cuando vuelvas a estar en línea',
  'toast.removed': 'Eliminado de la biblioteca',
  'toast.cantOpen': 'No se pudo abrir ese libro',
  'toast.cantLoad': 'No se pudo cargar este PDF',
  'toast.notDownloaded': 'Este libro no está descargado en este dispositivo',
  'toast.loadFailed': 'Error al cargar este PDF',
  'toast.wrongPass': 'Contraseña incorrecta',
  'toast.noServer': 'No se pudo conectar con el servidor',
  'time.notOpened': 'Aún sin abrir',
  'time.justNow': 'Ahora mismo',
  'pwa.updated': 'Folium Café se ha actualizado',
  'pwa.installed': 'Folium Café está en tu pantalla de inicio',
  'clip.snapshot': 'Recortar y compartir',
  'clip.captureHint': 'Arrastra un recuadro sobre la página — Esc para cancelar',
  'clip.sheetTitle': 'Compartir un recorte',
  'clip.color': 'Color de resaltado',
  'clip.save': 'Guardar recorte',
  'clip.share': 'Compartir',
  'clip.download': 'Descargar',
  'clip.delete': 'Eliminar',
  'clip.close': 'Cerrar',
  'clip.saved': 'Recorte guardado',
  'clip.removed': 'Recorte eliminado',
  'clip.shareFailed': 'No se pudo compartir — descargado en su lugar',
};

const DICTS: Record<Locale, Record<MsgKey, string>> = { en: EN, 'pt-BR': PT, es: ES };

let locale: Locale = 'en';                 // set for real by setLanguage() in init()
let pluralRules = new Intl.PluralRules('en');

function t(key: MsgKey, params?: Record<string, string | number>): string {
  let s: string = DICTS[locale][key] ?? EN[key];
  if (params) for (const [k, v] of Object.entries(params)) s = s.split('{' + k + '}').join(String(v));
  return s;
}

// en/pt/es all reduce to one/other in CLDR (pt classes 0 as "one" — which a
// hand-rolled n === 1 check would get wrong).
function tn(base: string, n: number): string {
  const cat = pluralRules.select(n) === 'one' ? 'one' : 'other';
  return t((base + '.' + cat) as MsgKey, { n });
}

function resolveLocale(): Locale {
  const pref = (localStorage.getItem(LS.lang) || 'system') as LangPref;
  if (pref !== 'system') return pref;
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language || 'en'];
  for (const tag of tags) {
    const l = tag.toLowerCase();
    if (l.startsWith('pt')) return 'pt-BR';   // closest we offer for pt-PT too
    if (l.startsWith('es')) return 'es';
    if (l.startsWith('en')) return 'en';
  }
  return 'en';
}

function applyI18n(): void {
  document.documentElement.lang = locale;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n as MsgKey); });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach(n => { n.title = t(n.dataset.i18nTitle as MsgKey); });
  document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach(n => { n.placeholder = t(n.dataset.i18nPlaceholder as MsgKey); });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach(n => { n.setAttribute('aria-label', t(n.dataset.i18nAria as MsgKey)); });
}

function setLanguage(pref: LangPref): void {
  localStorage.setItem(LS.lang, pref);
  locale = resolveLocale();
  pluralRules = new Intl.PluralRules(locale);
  applyI18n();
  if (!el('app').classList.contains('hidden')) renderLibrary();
}

function toast(msg: string): void {
  const node = el('toast');
  node.textContent = msg;
  node.classList.add('show');
  window.clearTimeout((toast as any)._t);
  (toast as any)._t = window.setTimeout(() => node.classList.remove('show'), 2200);
}

// ---------- API client ----------
// The book metadata that lives server-side (everything except the PDF bytes).
type BookMeta = Omit<Book, 'data'>;

// Network failure and auth failure need different reactions (offline mode vs
// login screen), so api() throws typed errors instead of one generic Error.
class ApiAuthError extends Error {}
class ApiNetworkError extends Error {}

async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
  } catch (e) {
    setOffline(true);
    throw new ApiNetworkError(String(e));
  }
  setOffline(false);
  if (res.status === 401) { onUnauthorized(); throw new ApiAuthError('unauthorized'); }
  return res;
}

let _onUnauthorized: () => void = () => {};
function onUnauthorized(): void { _onUnauthorized(); }

// ---------- offline stores ----------
// PDF bytes and the library snapshot live in the Cache API under synthetic
// same-origin keys. The service worker never touches these caches, so they
// survive SW updates; logout deletes them.
const PDF_CACHE = 'folium-pdf';
const DATA_CACHE = 'folium-data';
const SHARED_CACHE = 'folium-shared';
const pdfKey = (id: string) => '/pdf-store/' + encodeURIComponent(id);
const PDF_LRU_MAX = 10;

let offlineIds = new Set<string>();   // books readable offline (drives the card dot)

function lruRead(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(LS.pdfLru) || '{}'); } catch { return {}; }
}
function touchLru(id: string): void {
  const lru = lruRead();
  lru[id] = Date.now();
  localStorage.setItem(LS.pdfLru, JSON.stringify(lru));
}
function dropLru(id: string): void {
  const lru = lruRead();
  delete lru[id];
  localStorage.setItem(LS.pdfLru, JSON.stringify(lru));
}

async function cachePdf(id: string, buf: ArrayBuffer): Promise<void> {
  try {
    const est = await navigator.storage?.estimate?.().catch(() => null);
    if (est && est.quota && ((est.usage || 0) + buf.byteLength) > est.quota * 0.9) return;
    const cache = await caches.open(PDF_CACHE);
    await cache.put(pdfKey(id),
      new Response(buf.slice(0), { headers: { 'content-type': 'application/pdf' } }));
    touchLru(id);
    // Evict least-recently-read beyond the cap; a re-open just re-downloads.
    const lru = lruRead();
    const ids = Object.keys(lru).sort((a, b) => lru[a] - lru[b]);
    while (ids.length > PDF_LRU_MAX) {
      const oldest = ids.shift()!;
      await cache.delete(pdfKey(oldest));
      dropLru(oldest);
    }
    await refreshOfflineIds();
  } catch { /* quota or private mode — caching is best-effort */ }
}

async function evictPdf(id: string): Promise<void> {
  try { await (await caches.open(PDF_CACHE)).delete(pdfKey(id)); } catch {}
  dropLru(id);
  await refreshOfflineIds();
}

async function refreshOfflineIds(): Promise<void> {
  try {
    const keys = await (await caches.open(PDF_CACHE)).keys();
    offlineIds = new Set(keys.map(r => decodeURIComponent(new URL(r.url).pathname.replace('/pdf-store/', ''))));
  } catch { offlineIds = new Set(); }
}

// ---------- offline progress queue ----------
// Only the latest position per book matters, so a keyed map is lossless.
function enqueueProgress(b: Book): void {
  let q: Record<string, { currentPage: number; lastReadAt: number }>;
  try { q = JSON.parse(localStorage.getItem(LS.progressQueue) || '{}'); } catch { q = {}; }
  if (!q[b.id] || b.lastReadAt >= q[b.id].lastReadAt) {
    q[b.id] = { currentPage: b.currentPage, lastReadAt: b.lastReadAt };
  }
  localStorage.setItem(LS.progressQueue, JSON.stringify(q));
}

async function flushProgressQueue(): Promise<void> {
  let q: Record<string, { currentPage: number; lastReadAt: number }>;
  try { q = JSON.parse(localStorage.getItem(LS.progressQueue) || '{}'); } catch { return; }
  for (const id of Object.keys(q)) {
    try {
      // Drop the entry on any server response (404 = book deleted meanwhile).
      await api('/books/' + encodeURIComponent(id) + '/progress',
        { method: 'PUT', body: JSON.stringify(q[id]) });
      delete q[id];
      localStorage.setItem(LS.progressQueue, JSON.stringify(q));
    } catch { break; }  // still offline (or logged out): retry on the next trigger
  }
}

// ---------- offline indicator ----------
let _offline = false;
function setOffline(off: boolean): void {
  if (off === _offline) return;
  _offline = off;
  const badge = document.getElementById('offline-badge');
  if (badge) badge.classList.toggle('show', off);
}

// List metadata for all books (no bytes). Network-first with a snapshot
// fallback so the shelf survives flaky connections and cold offline starts.
async function dbAll(): Promise<BookMeta[]> {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await api('/books');
    if (!res.ok) throw new ApiNetworkError('list ' + res.status);
    const body = await res.json();
    await cache.put('/data-store/books', new Response(JSON.stringify(body))).catch(() => {});
    return body.books as BookMeta[];
  } catch (e) {
    if (e instanceof ApiAuthError) throw e;     // real logout — no fallback
    const hit = await cache.match('/data-store/books');
    if (hit) { setOffline(true); return (await hit.json()).books as BookMeta[]; }
    throw e;
  }
}

// Persist metadata. If the book carries fresh `data`, upload the bytes to S3.
async function dbPut(b: Book): Promise<void> {
  const meta: BookMeta = stripData(b);
  const res = await api('/books', { method: 'POST', body: JSON.stringify(meta) });
  if (!res.ok) throw new Error('save failed');
  const { uploadUrl } = await res.json();
  if (b.data && uploadUrl) {
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: b.data,
    });
    if (!put.ok) throw new Error('upload failed');
  }
}

// Update just the reading position (used by persistPage). Offline updates
// queue locally and replay when the connection returns.
async function dbPutProgress(b: Book): Promise<void> {
  try {
    await api('/books/' + encodeURIComponent(b.id) + '/progress', {
      method: 'PUT',
      body: JSON.stringify({ currentPage: b.currentPage, lastReadAt: b.lastReadAt || Date.now() }),
    });
  } catch (e) {
    if (e instanceof ApiNetworkError) { enqueueProgress(b); return; }
    throw e;
  }
}

// Fetch the PDF bytes for one book: local cache first (bytes are immutable
// per id), then the presigned URL, filling the cache for offline reading.
async function dbGet(id: string): Promise<ArrayBuffer | null> {
  try {
    const hit = await (await caches.open(PDF_CACHE)).match(pdfKey(id));
    if (hit) { touchLru(id); return hit.arrayBuffer(); }
  } catch { /* fall through to network */ }
  const res = await api('/books/' + encodeURIComponent(id) + '/url');
  if (!res.ok) return null;
  const { url } = await res.json();
  const file = await fetch(url);
  if (!file.ok) return null;
  const buf = await file.arrayBuffer();
  cachePdf(id, buf);   // fire-and-forget; never blocks the reader
  return buf;
}

async function dbDel(id: string): Promise<void> {
  await api('/books/' + encodeURIComponent(id), { method: 'DELETE' });
  await evictPdf(id);
}

function stripData(b: Book): BookMeta {
  const { data, ...rest } = b;
  return rest;
}

// ---------- clippings (data) ----------
const DEFAULT_CLIP_COLOR = '#dcb064';
const CLIP_COLORS = ['#dcb064', '#5e261d', '#3c5340', '#e8c34a'];
const cid = (): string => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clipsKey = (bookId: string) => '/data-store/clips/' + encodeURIComponent(bookId);

interface ClipOp { op: 'put' | 'del'; bookId: string; clip?: Clip; clipId?: string; }

async function readClipCache(bookId: string): Promise<Clip[]> {
  try {
    const hit = await (await caches.open(DATA_CACHE)).match(clipsKey(bookId));
    return hit ? ((await hit.json()).clips as Clip[]) : [];
  } catch { return []; }
}
async function writeClipCache(bookId: string, clips: Clip[]): Promise<void> {
  try {
    await (await caches.open(DATA_CACHE)).put(clipsKey(bookId), new Response(JSON.stringify({ clips })));
  } catch { /* best-effort */ }
}

// List a book's clippings; network-first with an offline cache fallback.
async function clipsAll(bookId: string): Promise<Clip[]> {
  try {
    const res = await api('/books/' + encodeURIComponent(bookId) + '/clips');
    if (!res.ok) throw new ApiNetworkError('clips ' + res.status);
    const body = await res.json();
    await writeClipCache(bookId, body.clips as Clip[]);
    return body.clips as Clip[];
  } catch (e) {
    if (e instanceof ApiAuthError) throw e;
    return readClipCache(bookId);
  }
}

async function clipPut(bookId: string, clip: Clip): Promise<void> {
  const arr = await readClipCache(bookId);
  const i = arr.findIndex(x => x.id === clip.id);
  if (i >= 0) arr[i] = clip; else arr.push(clip);
  await writeClipCache(bookId, arr);
  try {
    await api('/books/' + encodeURIComponent(bookId) + '/clips',
      { method: 'POST', body: JSON.stringify(clip) });
  } catch (e) {
    if (e instanceof ApiNetworkError) { enqueueClip({ op: 'put', bookId, clip }); return; }
    throw e;
  }
}

async function clipDel(bookId: string, clipId: string): Promise<void> {
  await writeClipCache(bookId, (await readClipCache(bookId)).filter(x => x.id !== clipId));
  try {
    await api('/books/' + encodeURIComponent(bookId) + '/clips/' + encodeURIComponent(clipId),
      { method: 'DELETE' });
  } catch (e) {
    if (e instanceof ApiNetworkError) { enqueueClip({ op: 'del', bookId, clipId }); return; }
    throw e;
  }
}

// Ordered op log (a put must reach the server before its delete), replayed FIFO.
function enqueueClip(op: ClipOp): void {
  let q: ClipOp[];
  try { q = JSON.parse(localStorage.getItem(LS.clipQueue) || '[]'); } catch { q = []; }
  q.push(op);
  localStorage.setItem(LS.clipQueue, JSON.stringify(q));
}
async function flushClipQueue(): Promise<void> {
  let q: ClipOp[];
  try { q = JSON.parse(localStorage.getItem(LS.clipQueue) || '[]'); } catch { return; }
  while (q.length) {
    const op = q[0];
    try {
      if (op.op === 'put') {
        await api('/books/' + encodeURIComponent(op.bookId) + '/clips',
          { method: 'POST', body: JSON.stringify(op.clip) });
      } else {
        await api('/books/' + encodeURIComponent(op.bookId) + '/clips/' + encodeURIComponent(op.clipId!),
          { method: 'DELETE' });
      }
      q.shift();
      localStorage.setItem(LS.clipQueue, JSON.stringify(q));
    } catch { break; }  // still offline (or logged out): retry on the next trigger
  }
}

// ---------- state ----------
const LS = {
  user: 'folium.user',
  view: 'folium.view',
  width: 'folium.readerWidth',
  pdfLru: 'folium.pdfLru',
  progressQueue: 'folium.progressQueue',
  clipQueue: 'folium.clipQueue',
  lang: 'folium.lang',
};
migrateLocalStorage();   // must run before viewMode/reader.width read their keys
let books: Book[] = [];
let viewMode: ViewMode = (localStorage.getItem(LS.view) as ViewMode) || 'shelf';

// ---------- helpers ----------
function uid(): string { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function prettifyName(fn: string): string {
  return fn.replace(/\.pdf$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}
function pct(b: Book): number {
  if (b.numPages <= 1) return b.currentPage >= b.numPages ? 100 : 0;
  return Math.round(((b.currentPage - 1) / (b.numPages - 1)) * 100);
}
function relTime(ts: number): string {
  if (!ts) return t('time.notOpened');
  const d = Date.now() - ts, m = 60000, h = m * 60, day = h * 24;
  if (d < m) return t('time.justNow');
  const rtf = new Intl.RelativeTimeFormat(locale, { style: 'narrow' });
  if (d < h) return rtf.format(-Math.floor(d / m), 'minute');
  if (d < day) return rtf.format(-Math.floor(d / h), 'hour');
  if (d < day * 7) return rtf.format(-Math.floor(d / day), 'day');
  return new Date(ts).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
}

// ---------- cover & ingest ----------
async function loadDoc(data: ArrayBuffer): Promise<any> {
  // pdf.js detaches the buffer; pass a copy so we keep the original.
  // standardFontDataUrl/cMapUrl let it render PDFs that rely on the base-14
  // fonts or CJK character maps without embedded resources.
  return pdfjs.getDocument({
    data: data.slice(0),
    standardFontDataUrl: PDFJS_CDN + '/standard_fonts/',
    cMapUrl: PDFJS_CDN + '/cmaps/',
    cMapPacked: true,
  }).promise;
}
async function renderCover(doc: any): Promise<string | null> {
  try {
    const page = await doc.getPage(1);
    const target = 320;
    const v1 = page.getViewport({ scale: 1 });
    const scale = target / v1.width;
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
    return c.toDataURL('image/jpeg', 0.82);
  } catch { return null; }
}
async function ingest(file: File | { name: string; buf: ArrayBuffer }): Promise<Book | null> {
  try {
    const name = (file as any).name as string;
    const buf = (file as any).buf
      ? (file as any).buf as ArrayBuffer
      : await (file as File).arrayBuffer();
    const doc = await loadDoc(buf);
    let title = prettifyName(name), author = '';
    try {
      const meta = await doc.getMetadata();
      const info = meta && meta.info ? meta.info : {};
      if (info.Title && String(info.Title).trim()) title = String(info.Title).trim();
      if (info.Author && String(info.Author).trim()) author = String(info.Author).trim();
    } catch { /* ignore */ }
    const cover = await renderCover(doc);
    const book: Book = {
      id: uid(), title, author, fileName: name, data: buf,
      numPages: doc.numPages, currentPage: 1, cover,
      addedAt: Date.now(), lastReadAt: 0,
    };
    await dbPut(book);
    cachePdf(book.id, buf);   // bytes are already in hand — make it offline-ready
    return book;
  } catch (e) {
    console.error('ingest failed', e);
    if (e instanceof ApiNetworkError) toast(t('toast.offlineAdd'));
    else toast(t('toast.cantRead', { name: (file as any).name }));
    return null;
  }
}

async function addFiles(files: FileList | File[]): Promise<void> {
  const arr = Array.from(files).filter(f => /pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!arr.length) { toast(t('toast.pdfOnly')); return; }
  toast(tn('toast.shelving', arr.length));
  for (const f of arr) {
    const b = await ingest(f);
    if (b) books.unshift(b);
  }
  renderLibrary();
  toast(t('toast.added'));
}


// ============================================================
//  LIBRARY RENDERING
// ============================================================
const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3l14 9-14 9V3z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6"/></svg>',
};

function coverMarkup(b: Book): string {
  const offdot = offlineIds.has(b.id) ? `<span class="offdot" title="${t('lib.offlineDot')}"></span>` : '';
  if (b.cover) {
    return `<div class="cover" style="background-image:url('${b.cover}')"><span class="spine"></span>${offdot}` +
      (b.lastReadAt ? `<span class="pct">${pct(b)}%</span>` : '') +
      `<button class="del" data-del="${b.id}" title="${t('lib.remove')}">${ICON.trash}</button></div>`;
  }
  const initials = (b.author || '').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return `<div class="cover"><span class="spine"></span>${offdot}
      <div class="gen-cover">
        <div class="gt">${escapeHtml(b.title)}</div>
        <div class="grule"></div>
        <div class="ga">${escapeHtml(b.author || initials) || t('lib.unknown')}</div>
      </div>` +
    (b.lastReadAt ? `<span class="pct">${pct(b)}%</span>` : '') +
    `<button class="del" data-del="${b.id}" title="${t('lib.remove')}">${ICON.trash}</button></div>`;
}

function bookCard(b: Book): string {
  return `<div class="book" data-open="${b.id}">
    ${coverMarkup(b)}
    <div class="lbl"><div class="t">${escapeHtml(b.title)}</div><div class="a">${escapeHtml(b.author || '\u00A0')}</div></div>
  </div>`;
}

function renderShelf(list: Book[]): string {
  // chunk into rows of N to lay a plank under each row
  const perRow = 6;
  let html = '';
  for (let i = 0; i < list.length; i += perRow) {
    const row = list.slice(i, i + perRow);
    html += `<div class="shelf-section"><div class="shelf">${row.map(bookCard).join('')}</div><div class="shelf-plank"></div></div>`;
  }
  return html;
}
function renderGrid(list: Book[]): string {
  return `<div class="grid">${list.map(bookCard).join('')}</div>`;
}
function renderList(list: Book[]): string {
  const rows = list.map(b => {
    const cv = b.cover
      ? `<div class="rcv" style="background-image:url('${b.cover}')"></div>`
      : `<div class="rcv"><div class="gen-cover"><div class="gt">${escapeHtml(b.title)}</div></div></div>`;
    return `<div class="row" data-open="${b.id}">
      ${cv}
      <div class="rmeta"><div class="rt">${escapeHtml(b.title)}</div><div class="ra">${escapeHtml(b.author) || t('lib.unknownAuthor')}</div></div>
      <div class="rprog"><div class="progress"><i style="width:${pct(b)}%"></i></div><span class="progress-num">${b.lastReadAt ? pct(b) + '%' : t('lib.new')}</span></div>
      <div class="rwhen">${relTime(b.lastReadAt)}</div>
      <button class="rresume" data-open="${b.id}">${ICON.play}${b.lastReadAt ? t('lib.resume') : t('lib.read')}</button>
      <button class="del rmenu" data-del="${b.id}" title="${t('lib.remove')}">${ICON.trash}</button>
    </div>`;
  }).join('');
  return `<div class="list">${rows}</div>`;
}

function renderContinue(): void {
  const c = el('continue');
  const read = books.filter(b => b.lastReadAt > 0).sort((a, b) => b.lastReadAt - a.lastReadAt);
  if (!read.length) { c.classList.remove('show'); return; }
  const b = read[0];
  c.classList.add('show');
  c.setAttribute('data-open', b.id);
  const cv = el('cont-cover');
  cv.style.backgroundImage = b.cover ? `url('${b.cover}')` : 'none';
  cv.innerHTML = b.cover ? '' : `<div class="gen-cover" style="position:absolute;inset:0;border-radius:2px"><div class="gt" style="font-size:13px">${escapeHtml(b.title)}</div><div class="grule"></div><div class="ga">${escapeHtml(b.author)}</div></div>`;
  el('cont-title').textContent = b.title;
  el('cont-author').textContent = b.author || t('lib.unknownAuthor');
  el('cont-bar').style.width = pct(b) + '%';
  el('cont-num').textContent = t('lib.pageOf', { page: b.currentPage, total: b.numPages, pct: pct(b) });
}

function renderLibrary(): void {
  // active view button
  document.querySelectorAll('#viewswitch button').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.view === viewMode);
  });
  el('lib-count').textContent = books.length ? tn('lib.count', books.length) : '';
  renderContinue();

  const body = el('lib-body');
  if (!books.length) {
    el('continue').classList.remove('show');
    body.innerHTML = `<div class="empty">
      <div class="ic">❦</div>
      <h3>${t('lib.emptyTitle')}</h3>
      <p>${t('lib.emptyBody')}</p>
      <button class="mast-btn brass" id="empty-add" style="margin:0 auto">${t('lib.emptyAdd')}</button>
    </div>`;
    const ea = document.getElementById('empty-add');
    if (ea) ea.addEventListener('click', () => el('file-input').click());
    return;
  }
  // newest-first base order
  const list = books.slice().sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt));
  if (viewMode === 'shelf') body.innerHTML = renderShelf(list);
  else if (viewMode === 'grid') body.innerHTML = renderGrid(list);
  else body.innerHTML = renderList(list);
}

// delegated clicks on library
function wireLibrary(): void {
  el('library').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const del = t.closest('[data-del]') as HTMLElement | null;
    if (del) { e.preventDefault(); e.stopPropagation(); confirmDelete(del.dataset.del!); return; }
    const open = t.closest('[data-open]') as HTMLElement | null;
    if (open) { e.preventDefault(); openBook(open.dataset.open!); }
  });
  el('continue').addEventListener('click', (e) => {
    e.preventDefault();
    const id = el('continue').getAttribute('data-open');
    if (id) openBook(id);
  });
}

async function confirmDelete(id: string): Promise<void> {
  const b = books.find(x => x.id === id);
  if (!b) return;
  if (!window.confirm(t('lib.confirmRemove', { title: b.title }))) return;
  try {
    await dbDel(id);
  } catch (e) {
    if (e instanceof ApiNetworkError) { toast(t('toast.offlineRetry')); return; }
    throw e;
  }
  books = books.filter(x => x.id !== id);
  renderLibrary();
  toast(t('toast.removed'));
}

// view switch
function wireViewSwitch(): void {
  el('viewswitch').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button') as HTMLElement | null;
    if (!btn) return;
    viewMode = btn.dataset.view as ViewMode;
    localStorage.setItem(LS.view, viewMode);
    renderLibrary();
  });
}

// ============================================================
//  READER
// ============================================================
const reader = {
  book: null as Book | null,
  doc: null as any,
  page: 1,
  width: (localStorage.getItem(LS.width) as 'comfort' | 'full') || 'comfort',
  zoom: 1,
  rendering: false,
  renderToken: 0,
  saveTimer: 0 as any,
  peekTimer: 0 as any,
  wheelLock: 0,
  clips: [] as Clip[],
  capturing: false,
};

async function openBook(id: string): Promise<void> {
  const meta = books.find(x => x.id === id);
  if (!meta) { toast(t('toast.cantOpen')); return; }
  const b = meta as Book;
  reader.book = b;
  reader.page = Math.min(Math.max(1, b.currentPage || 1), b.numPages);
  reader.zoom = 1;
  reader.clips = [];
  exitCapture();
  el('r-title-t').textContent = b.title;
  el('r-title-a').textContent = b.author || '';
  el('r-total').textContent = '/ ' + b.numPages;
  setWidthButtons();
  const rd = el('reader');
  rd.classList.add('show');
  document.body.style.overflow = 'hidden';
  el('r-loading').classList.remove('hidden');
  try {
    const bytes = await dbGet(id);
    if (!bytes) { toast(t('toast.cantLoad')); el('r-loading').classList.add('hidden'); return; }
    reader.doc = await loadDoc(bytes);
    // An offline clip load is fine (empty); a real 401 must not leave the
    // reader open behind the login screen.
    reader.clips = await clipsAll(id).catch(e => { if (e instanceof ApiAuthError) throw e; return []; });
    await renderPage(reader.page, false);
  } catch (e) {
    console.error(e);
    if (e instanceof ApiAuthError) { closeReader(); return; }
    if (e instanceof ApiNetworkError) toast(t('toast.notDownloaded'));
    else toast(t('toast.loadFailed'));
  }
  el('r-loading').classList.add('hidden');
}

function closeReader(): void {
  exitZen();
  exitCapture();
  el('reader').classList.remove('show');
  document.body.style.overflow = '';
  reader.doc = null; reader.book = null;
  reader.clips = [];
  renderLibrary();
}

function stageWidth(): number {
  const stage = el('r-stage');
  return stage.clientWidth;
}

async function renderPage(n: number, keepScroll: boolean): Promise<void> {
  if (!reader.doc || !reader.book) return;
  n = Math.min(Math.max(1, n), reader.book.numPages);
  reader.page = n;
  const token = ++reader.renderToken;
  const page = await reader.doc.getPage(n);
  if (token !== reader.renderToken) return; // superseded

  const v1 = page.getViewport({ scale: 1 });
  const avail = stageWidth();
  const sidePad = avail < 700 ? 36 : 64; // room for column padding + scrollbar
  const cap = reader.width === 'comfort' ? 860 : Infinity;
  const targetCSS = Math.floor(Math.min(avail - sidePad, cap) * reader.zoom);
  const cssScale = targetCSS / v1.width;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale: cssScale * dpr });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = targetCSS + 'px';
  canvas.style.height = Math.round(targetCSS * (v1.height / v1.width)) + 'px';
  await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
  if (token !== reader.renderToken) return;

  const col = el('r-col');
  col.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'rpage';
  wrap.appendChild(canvas);
  const cssW = targetCSS;
  const cssH = Math.round(targetCSS * (v1.height / v1.width));
  renderClipOverlay(wrap, cssW, cssH);
  col.appendChild(wrap);

  if (!keepScroll) el('r-stage').scrollTop = 0;
  updateReaderChrome();
  persistPage();
}

// Draws saved clips for the current page as overlay boxes over the page canvas.
function renderClipOverlay(wrap: HTMLElement, cssW: number, cssH: number): void {
  const here = reader.clips.filter(c => c.page === reader.page);
  if (!here.length) return;
  const layer = document.createElement('div');
  layer.className = 'rclips';
  for (const c of here) {
    for (const r of c.rects) {
      if (r.w <= 0 || r.h <= 0) continue;
      const box = document.createElement('div');
      box.className = c.text ? 'rclip text' : 'rclip';
      box.dataset.clip = c.id;
      box.style.left = (r.x * cssW) + 'px';
      box.style.top = (r.y * cssH) + 'px';
      box.style.width = (r.w * cssW) + 'px';
      box.style.height = (r.h * cssH) + 'px';
      box.style.setProperty('--clip-color', c.color || DEFAULT_CLIP_COLOR);
      layer.appendChild(box);
    }
  }
  wrap.appendChild(layer);
}

function updateReaderChrome(): void {
  const b = reader.book; if (!b) return;
  (el('r-page-input') as HTMLInputElement).value = String(reader.page);
  const p = b.numPages <= 1 ? 100 : ((reader.page - 1) / (b.numPages - 1)) * 100;
  el('r-progress-bar').style.width = p + '%';
  (el('r-prev') as HTMLButtonElement).disabled = reader.page <= 1;
  (el('r-next') as HTMLButtonElement).disabled = reader.page >= b.numPages;
  (el('r-prev-s') as HTMLButtonElement).disabled = reader.page <= 1;
  (el('r-next-s') as HTMLButtonElement).disabled = reader.page >= b.numPages;
}

function persistPage(): void {
  const b = reader.book; if (!b) return;
  b.currentPage = reader.page;
  b.lastReadAt = Date.now();
  const cached = books.find(x => x.id === b.id);
  if (cached) { cached.currentPage = b.currentPage; cached.lastReadAt = b.lastReadAt; }
  window.clearTimeout(reader.saveTimer);
  reader.saveTimer = window.setTimeout(() => { dbPutProgress(b).catch(() => {}); }, 350);
}

function go(delta: number): void {
  if (!reader.book) return;
  const next = reader.page + delta;
  if (next < 1 || next > reader.book.numPages) return;
  renderPage(next, false);
}

// Edge-aware page turning: the wheel scrolls within a tall page, and only flips
// pages once you're already at the top/bottom edge and keep scrolling. A short
// cooldown stops trackpad momentum from skipping multiple pages per gesture.
function onReaderWheel(e: WheelEvent): void {
  if (!reader.doc || !reader.book) return;
  if (reader.capturing) { e.preventDefault(); return; }   // no paging mid-capture
  const down = e.deltaY > 0, up = e.deltaY < 0;
  if (!down && !up) return; // pure horizontal / no vertical intent

  const stage = el('r-stage');
  const atTop = stage.scrollTop <= 1;
  const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 1;

  // Not at the relevant edge yet -> let the page scroll natively.
  if ((down && !atBottom) || (up && !atTop)) return;

  // At the edge: swallow the event and (rate-limited) turn the page.
  e.preventDefault();
  if (e.timeStamp - reader.wheelLock < 500) return;
  if (down && reader.page < reader.book.numPages) { reader.wheelLock = e.timeStamp; go(1); }
  else if (up && reader.page > 1) { reader.wheelLock = e.timeStamp; go(-1); }
}
function setWidthButtons(): void {
  document.querySelectorAll('#width-seg button').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.w === reader.width);
  });
}

let resizeTimer: any = 0;
function onResize(): void {
  if (!el('reader').classList.contains('show')) return;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => renderPage(reader.page, true), 160);
}

// distraction-free / zen
function enterZen(): void {
  const rd = el('reader');
  rd.classList.add('zen');
  const hint = el('zen-hint');
  hint.classList.add('show');
  window.setTimeout(() => hint.classList.remove('show'), 2600);
  if (rd.requestFullscreen) rd.requestFullscreen().catch(() => {});
  window.setTimeout(() => renderPage(reader.page, true), 120);
}
function exitZen(): void {
  const rd = el('reader');
  if (!rd.classList.contains('zen')) return;
  rd.classList.remove('zen', 'peek');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  window.setTimeout(() => renderPage(reader.page, true), 120);
}
function toggleZen(): void {
  el('reader').classList.contains('zen') ? exitZen() : enterZen();
}
function peek(): void {
  const rd = el('reader');
  if (!rd.classList.contains('zen')) return;
  rd.classList.add('peek');
  window.clearTimeout(reader.peekTimer);
  reader.peekTimer = window.setTimeout(() => rd.classList.remove('peek'), 2200);
}

// ============================================================
//  CLIPPINGS — capture, card, share
// ============================================================
function exitCapture(): void {
  reader.capturing = false;
  const rd = document.getElementById('reader'); if (rd) rd.classList.remove('capturing');
  const snap = document.getElementById('r-snap'); if (snap) snap.classList.remove('active');
  const sel = document.getElementById('r-capsel'); if (sel) sel.classList.remove('show');
}
function toggleCapture(): void {
  if (!reader.doc) return;
  reader.capturing = !reader.capturing;
  el('reader').classList.toggle('capturing', reader.capturing);
  el('r-snap').classList.toggle('active', reader.capturing);
  if (reader.capturing) toast(t('clip.captureHint'));
  else { const sel = document.getElementById('r-capsel'); if (sel) sel.classList.remove('show'); }
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function fitText(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (ctx.measureText(s).width <= maxW) return s;
  let str = s;
  while (str.length > 1 && ctx.measureText(str + '…').width > maxW) str = str.slice(0, -1);
  return str + '…';
}

// Compose a branded quote card: the cropped region matted on warm paper with the
// book title and a Folium mark. `rect` is normalized; `src` is the live page canvas.
async function composeRegionCard(src: HTMLCanvasElement, rect: Rect, title: string): Promise<Blob> {
  const W = 1080, H = 1350, pad = 84, footerH = 176;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#efe6d2';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(178,133,58,.55)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(W - pad, pad); ctx.stroke();

  const sx = rect.x * src.width, sy = rect.y * src.height;
  const sw = Math.max(1, rect.w * src.width), sh = Math.max(1, rect.h * src.height);
  const ar = sw / sh;
  const boxW = W - 2 * pad, boxH = H - 2 * pad - footerH;
  let dw = boxW, dh = dw / ar;
  if (dh > boxH) { dh = boxH; dw = dh * ar; }
  const dx = (W - dw) / 2, dy = pad + 24 + (boxH - dh) / 2;

  ctx.save();
  ctx.shadowColor = 'rgba(40,26,12,.35)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 18;
  ctx.fillStyle = '#fdfaf2';
  roundRectPath(ctx, dx - 16, dy - 16, dw + 32, dh + 32, 6);
  ctx.fill();
  ctx.restore();
  ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
  ctx.strokeStyle = '#c9b88f'; ctx.lineWidth = 1;
  ctx.strokeRect(dx - 16, dy - 16, dw + 32, dh + 32);

  try { await (document as any).fonts.ready; } catch { /* fall back to system serif */ }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#5e261d';
  ctx.font = '700 44px "Zilla Slab", Georgia, serif';
  ctx.fillText(fitText(ctx, title, W - 2 * pad), W / 2, H - pad - 46);
  ctx.fillStyle = '#897a5f';
  ctx.font = 'italic 28px "Spectral", Georgia, serif';
  ctx.fillText('❦  folium.cafe', W / 2, H - pad - 4);

  return await new Promise<Blob>((resolve) => cv.toBlob((b) => resolve(b!), 'image/png'));
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function shareOrDownload(blob: Blob, book: Book): Promise<void> {
  const file = new File([blob], 'folium-clip.png', { type: 'image/png' });
  const nav: any = navigator;
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: book.title, text: '“' + book.title + '” — folium.cafe' });
      return;
    } catch (e: any) {
      if (e && e.name === 'AbortError') return;   // user dismissed the sheet
      downloadBlob(blob, 'folium-clip.png');
      toast(t('clip.shareFailed'));
      return;
    }
  }
  downloadBlob(blob, 'folium-clip.png');
}

// ---------- clip share sheet ----------
let sheetState: { rect: Rect; clip?: Clip; color: string; blob?: Blob } | null = null;

async function openClipSheet(arg: { clip?: Clip; region?: { rect: Rect } }): Promise<void> {
  const book = reader.book; if (!book) return;
  const canvas = el('r-col').querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const clip = arg.clip;
  const rect = clip ? clip.rects[0] : arg.region!.rect;
  if (!rect) return;
  sheetState = { rect, clip, color: clip?.color || DEFAULT_CLIP_COLOR };
  const blob = await composeRegionCard(canvas, rect, book.title);
  sheetState.blob = blob;
  const img = el('clip-preview') as HTMLImageElement;
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob);
  renderSwatches();
  el('clip-save').classList.toggle('hidden', !!clip);
  el('clip-colors').classList.toggle('hidden', !!clip);
  el('clip-delete').classList.toggle('hidden', !clip);
  el('clip-sheet').classList.remove('hidden');
}
function renderSwatches(): void {
  const wrap = el('clip-colors');
  wrap.innerHTML = '';
  for (const c of CLIP_COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (sheetState && sheetState.color === c ? ' active' : '');
    b.style.background = c;
    b.dataset.color = c;
    wrap.appendChild(b);
  }
}
function closeClipSheet(): void {
  const img = el('clip-preview') as HTMLImageElement;
  if (img.src) { URL.revokeObjectURL(img.src); img.removeAttribute('src'); }
  el('clip-sheet').classList.add('hidden');
  sheetState = null;
}

function wireReader(): void {
  el('r-back').addEventListener('click', closeReader);
  el('r-prev').addEventListener('click', () => go(-1));
  el('r-next').addEventListener('click', () => go(1));
  el('r-prev-s').addEventListener('click', () => go(-1));
  el('r-next-s').addEventListener('click', () => go(1));
  el('r-stage').addEventListener('wheel', onReaderWheel, { passive: false });
  el('r-focus').addEventListener('click', toggleZen);

  // --- clippings: snapshot capture + saved-clip taps + share sheet ---
  el('r-snap').addEventListener('click', toggleCapture);

  let capStart: { x: number; y: number } | null = null;
  let suppressClick = false;
  const stageEl = el('r-stage');
  stageEl.addEventListener('pointerdown', (e) => {
    if (!reader.capturing) return;
    e.preventDefault();
    capStart = { x: e.clientX, y: e.clientY };
    const sel = el('r-capsel');
    Object.assign(sel.style, { left: e.clientX + 'px', top: e.clientY + 'px', width: '0px', height: '0px' });
    sel.classList.add('show');
    try { stageEl.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
  });
  stageEl.addEventListener('pointermove', (e) => {
    if (!reader.capturing || !capStart) return;
    const x = Math.min(e.clientX, capStart.x), y = Math.min(e.clientY, capStart.y);
    const w = Math.abs(e.clientX - capStart.x), h = Math.abs(e.clientY - capStart.y);
    Object.assign(el('r-capsel').style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  });
  stageEl.addEventListener('pointerup', (e) => {
    if (!reader.capturing || !capStart) return;
    const x0 = Math.min(e.clientX, capStart.x), y0 = Math.min(e.clientY, capStart.y);
    const x1 = Math.max(e.clientX, capStart.x), y1 = Math.max(e.clientY, capStart.y);
    capStart = null;
    suppressClick = true;   // the drag also fires a click; don't page-turn on it
    const canvas = el('r-col').querySelector('canvas') as HTMLCanvasElement | null;
    exitCapture();
    if (!canvas) return;
    const cb = canvas.getBoundingClientRect();
    const ix0 = Math.max(x0, cb.left), iy0 = Math.max(y0, cb.top);
    const ix1 = Math.min(x1, cb.right), iy1 = Math.min(y1, cb.bottom);
    const iw = ix1 - ix0, ih = iy1 - iy0;
    if (iw < 10 || ih < 10) return;   // too small or outside the page
    openClipSheet({ region: { rect: { x: (ix0 - cb.left) / cb.width, y: (iy0 - cb.top) / cb.height, w: iw / cb.width, h: ih / cb.height } } });
  });
  stageEl.addEventListener('pointercancel', () => { capStart = null; suppressClick = false; exitCapture(); });
  // A capture drag also emits a click; consume it in the capture phase so it
  // reaches neither the page-turn handler nor a clip box it happened to end on.
  stageEl.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); }
  }, true);

  // tap a saved clip box → open its share sheet
  el('r-col').addEventListener('click', (e) => {
    const box = (e.target as HTMLElement).closest('.rclip') as HTMLElement | null;
    if (!box) return;
    e.stopPropagation();
    const c = reader.clips.find(x => x.id === box.dataset.clip);
    if (c) openClipSheet({ clip: c });
  });

  // share sheet
  el('clip-colors').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('.swatch') as HTMLElement | null;
    if (!b || !sheetState) return;
    sheetState.color = b.dataset.color!;
    renderSwatches();
  });
  el('clip-share').addEventListener('click', () => { if (sheetState?.blob && reader.book) shareOrDownload(sheetState.blob, reader.book); });
  el('clip-download').addEventListener('click', () => { if (sheetState?.blob) downloadBlob(sheetState.blob, 'folium-clip.png'); });
  el('clip-save').addEventListener('click', async () => {
    if (!sheetState || !reader.book) return;
    const clip: Clip = { id: cid(), page: reader.page, rects: [sheetState.rect], color: sheetState.color, createdAt: Date.now() };
    reader.clips.push(clip);
    closeClipSheet();
    renderPage(reader.page, true);
    toast(t('clip.saved'));
    try { await clipPut(reader.book.id, clip); } catch (err) { console.error(err); }
  });
  el('clip-delete').addEventListener('click', async () => {
    if (!sheetState?.clip || !reader.book) return;
    const id = sheetState.clip.id, bookId = reader.book.id;
    reader.clips = reader.clips.filter(x => x.id !== id);
    closeClipSheet();
    renderPage(reader.page, true);
    toast(t('clip.removed'));
    try { await clipDel(bookId, id); } catch (err) { console.error(err); }
  });
  el('clip-close').addEventListener('click', closeClipSheet);
  el('clip-sheet').addEventListener('click', (e) => { if (e.target === el('clip-sheet')) closeClipSheet(); });

  el('r-zoom-in').addEventListener('click', () => { reader.zoom = Math.min(reader.zoom + 0.15, 2.2); renderPage(reader.page, true); });
  el('r-zoom-out').addEventListener('click', () => { reader.zoom = Math.max(reader.zoom - 0.15, 0.6); renderPage(reader.page, true); });

  el('width-seg').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button') as HTMLElement | null;
    if (!btn) return;
    reader.width = btn.dataset.w as 'comfort' | 'full';
    localStorage.setItem(LS.width, reader.width);
    reader.zoom = 1;
    setWidthButtons();
    renderPage(reader.page, true);
  });

  const pi = el('r-page-input') as HTMLInputElement;
  const commit = () => {
    const v = parseInt(pi.value, 10);
    if (!isNaN(v) && reader.book) renderPage(v, false);
    else pi.value = String(reader.page);
  };
  pi.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { commit(); pi.blur(); } });
  pi.addEventListener('blur', commit);

  // mouse reveal in zen
  el('reader').addEventListener('mousemove', peek);
  el('r-stage').addEventListener('click', (e) => {
    // click left/right thirds to page (only when not selecting text or capturing)
    if (reader.capturing) return;
    if (suppressClick) { suppressClick = false; return; }
    if (window.getSelection && String(window.getSelection())) return;
    const x = (e as MouseEvent).clientX;
    const w = window.innerWidth;
    if (x < w * 0.32) go(-1);
    else if (x > w * 0.68) go(1);
  });

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) el('reader').classList.remove('zen', 'peek');
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (!el('reader').classList.contains('show')) return;
    const k = (e as KeyboardEvent).key;
    const tag = (document.activeElement && (document.activeElement as HTMLElement).tagName) || '';
    if (tag === 'INPUT') return;
    if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') { e.preventDefault(); go(1); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); go(-1); }
    else if (k === 'ArrowDown') { el('r-stage').scrollTop += 120; }
    else if (k === 'ArrowUp') { el('r-stage').scrollTop -= 120; }
    else if (k === 'Home') { e.preventDefault(); renderPage(1, false); }
    else if (k === 'End' && reader.book) { e.preventDefault(); renderPage(reader.book.numPages, false); }
    else if (k === 'f' || k === 'F') { toggleZen(); }
    else if (k === 'Escape') {
      if (reader.capturing) exitCapture();
      else if (!el('clip-sheet').classList.contains('hidden')) closeClipSheet();
      else if (el('reader').classList.contains('zen')) exitZen();
      else closeReader();
    }
  });

  window.addEventListener('resize', onResize);
}

// ============================================================
//  AUTH
// ============================================================
function showApp(name: string): void {
  el('login').classList.add('hidden');
  el('app').classList.remove('hidden');
  const initial = (name.trim()[0] || t('common.reader')[0]).toUpperCase();
  el('avatar-initial').textContent = initial;
  el('user-name').textContent = name.trim() || t('common.reader');
}
function wireAuth(): void {
  el<HTMLFormElement>('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (el('login-name') as HTMLInputElement).value.trim() || t('common.reader');
    const pass = (el('login-pass') as HTMLInputElement).value;
    if (!pass) return;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password: pass }),
      });
      if (!res.ok) { toast(t('toast.wrongPass')); return; }
      localStorage.setItem(LS.user, JSON.stringify({ name }));
      showApp(name);
      await boot();
    } catch {
      toast(t('toast.noServer'));
    }
  });

  el('avatar').addEventListener('click', (e) => {
    e.stopPropagation();
    el('dropdown').classList.toggle('hidden');
  });
  document.addEventListener('click', () => el('dropdown').classList.add('hidden'));
  el('dropdown').addEventListener('click', (e) => e.stopPropagation());
  el('btn-logout').addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    localStorage.removeItem(LS.user);
    // Logout means "this device is no longer mine": drop everything local.
    localStorage.removeItem(LS.pdfLru);
    localStorage.removeItem(LS.progressQueue);
    localStorage.removeItem(LS.clipQueue);
    try {
      await Promise.all([caches.delete(PDF_CACHE), caches.delete(DATA_CACHE), caches.delete(SHARED_CACHE)]);
    } catch {}
    offlineIds = new Set();
    el('app').classList.add('hidden');
    el('login').classList.remove('hidden');
    el('dropdown').classList.add('hidden');
    (el('login-pass') as HTMLInputElement).value = '';
    booted = false;
    books = [];
  });
  el('brand').addEventListener('click', () => { if (el('reader').classList.contains('show')) closeReader(); });
}

// ============================================================
//  UPLOAD WIRING + DRAG/DROP
// ============================================================
function wireUpload(): void {
  el('btn-upload').addEventListener('click', () => el('file-input').click());
  el<HTMLInputElement>('file-input').addEventListener('change', (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (files && files.length) addFiles(files);
    (e.target as HTMLInputElement).value = '';
  });
  let dragDepth = 0;
  const drop = el('drop');
  window.addEventListener('dragenter', (e) => {
    if (el('login').classList.contains('hidden') === false) return;
    e.preventDefault(); dragDepth++; drop.classList.add('show');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => { e.preventDefault(); dragDepth--; if (dragDepth <= 0) { drop.classList.remove('show'); dragDepth = 0; } });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; drop.classList.remove('show');
    if (el('login').classList.contains('hidden') === false) return;
    const dt = (e as DragEvent).dataTransfer;
    if (dt && dt.files && dt.files.length) addFiles(dt.files);
  });
}

// ============================================================
//  BOOT
// ============================================================
let booted = false;
async function boot(): Promise<void> {
  if (booted) { renderLibrary(); return; }
  booted = true;
  flushProgressQueue();   // replay page turns queued while offline
  flushClipQueue();       // replay clipping create/delete ops queued offline
  await refreshOfflineIds();
  try {
    books = (await dbAll()) as unknown as Book[];
  } catch (e) {
    console.error('api error', e);
    books = [];
    booted = false;       // first-run offline: let a later 'online' event retry
  }
  renderLibrary();
  await handleLaunchParams();
}

// Deep links: ?continue=1 (app shortcut) and ?shared=1 (share_target redirect).
// Runs after boot so it only acts once the user is authenticated.
async function handleLaunchParams(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (!params.has('continue') && !params.has('shared')) return;
  history.replaceState(null, '', '/');
  if (params.has('shared')) await drainSharedCache();
  if (params.has('continue')) {
    const last = books.filter(b => b.lastReadAt > 0).sort((a, b) => b.lastReadAt - a.lastReadAt)[0];
    if (last) openBook(last.id);
  }
}

// PDFs received via the Android share sheet wait in the shared cache (put
// there by the service worker) until someone is signed in to shelve them.
async function drainSharedCache(): Promise<void> {
  try {
    const cache = await caches.open(SHARED_CACHE);
    const keys = await cache.keys();
    if (!keys.length) return;
    toast(tn('toast.shelvingShared', keys.length));
    for (const req of keys) {
      const res = await cache.match(req);
      if (!res) continue;
      const name = decodeURIComponent(res.headers.get('x-file-name') || '') || 'Shared.pdf';
      const buf = await res.arrayBuffer();
      const b = await ingest({ name, buf });
      if (b) books.unshift(b);
      await cache.delete(req);
    }
    renderLibrary();
    toast(t('toast.added'));
  } catch (e) { console.warn('shared intake failed', e); }
}

// ============================================================
//  PWA
// ============================================================
function wirePwa(): void {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(e => console.warn('sw registration failed', e));
    });
    // A controller swap after the first one means a new version took over.
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast(t('pwa.updated'));
      hadController = true;
    });
  }
  // Ask Android to protect our caches (PDFs) from storage-pressure eviction.
  navigator.storage?.persist?.().catch(() => {});

  window.addEventListener('online', () => {
    flushProgressQueue();
    flushClipQueue();
    if (!el('app').classList.contains('hidden')) { booted = false; boot(); }
  });

  let deferredInstall: any = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    e.preventDefault();
    deferredInstall = e;
    el('btn-install').classList.remove('hidden');
  });
  el('btn-install').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch { /* dismissed */ }
    deferredInstall = null;
    el('btn-install').classList.add('hidden');
    el('dropdown').classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => {
    el('btn-install').classList.add('hidden');
    toast(t('pwa.installed'));
  });
}

function migrateLocalStorage(): void {
  // one-time folio.* -> folium.* key migration (delete after a few releases)
  const map: Record<string, string> = {
    'folio.user': 'folium.user',
    'folio.view': 'folium.view',
    'folio.readerWidth': 'folium.readerWidth',
  };
  for (const [oldKey, newKey] of Object.entries(map)) {
    const old = localStorage.getItem(oldKey);
    if (old !== null && localStorage.getItem(newKey) === null) localStorage.setItem(newKey, old);
    localStorage.removeItem(oldKey);
  }
}

function wireSettings(): void {
  const modal = el('settings');
  const sel = el<HTMLSelectElement>('lang-select');
  el('btn-settings').addEventListener('click', () => {
    sel.value = localStorage.getItem(LS.lang) || 'system';
    modal.classList.remove('hidden');
    el('dropdown').classList.add('hidden');
  });
  sel.addEventListener('change', () => setLanguage(sel.value as LangPref));  // applies live
  el('settings-done').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && !modal.classList.contains('hidden')) modal.classList.add('hidden');
  });
}

function init(): void {
  locale = resolveLocale();
  pluralRules = new Intl.PluralRules(locale);
  applyI18n();
  wireAuth();
  wireSettings();
  _onUnauthorized = () => {
    localStorage.removeItem(LS.user);
    el('app').classList.add('hidden');
    el('login').classList.remove('hidden');
    booted = false;
  };
  wireViewSwitch();
  wireLibrary();
  wireUpload();
  wireReader();
  wirePwa();
  // restore session
  const saved = localStorage.getItem(LS.user);
  if (saved) {
    try {
      const u = JSON.parse(saved);
      showApp(u.name || t('common.reader'));
      boot();
    } catch { /* show login */ }
  }
}

init();

})();