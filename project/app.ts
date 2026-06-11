/* ============================================================
   FOLIO — app.ts  (TypeScript, transpiled in-browser via Babel)
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
const PDFJS_CDN = 'https://unpkg.com/pdfjs-dist@' + PDFJS_VER;

// A cross-origin URL can't be used directly as a Worker (SecurityError), so we
// fetch the worker source and spin it up from a same-origin blob URL.
let _workerReady: Promise<void> | null = null;
function ensureWorker(): Promise<void> {
  if (_workerReady) return _workerReady;
  _workerReady = (async () => {
    try {
      const code = await (await fetch(PDFJS_CDN + '/build/pdf.worker.min.js')).text();
      pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
        new Blob([code], { type: 'application/javascript' }));
    } catch (e) {
      console.warn('blob worker failed; falling back', e);
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_CDN + '/build/pdf.worker.min.js';
    }
  })();
  return _workerReady;
}

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

// ---------- tiny DOM helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;
const el = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

function toast(msg: string): void {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  window.clearTimeout((toast as any)._t);
  (toast as any)._t = window.setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- API client ----------
// The book metadata that lives server-side (everything except the PDF bytes).
type BookMeta = Omit<Book, 'data'>;

async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  const res = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) { onUnauthorized(); throw new Error('unauthorized'); }
  return res;
}

let _onUnauthorized: () => void = () => {};
function onUnauthorized(): void { _onUnauthorized(); }

// List metadata for all books (no bytes).
async function dbAll(): Promise<BookMeta[]> {
  const res = await api('/books');
  if (!res.ok) return [];
  const { books } = await res.json();
  return books as BookMeta[];
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

// Update just the reading position (used by persistPage).
async function dbPutProgress(b: Book): Promise<void> {
  await api('/books/' + encodeURIComponent(b.id) + '/progress', {
    method: 'PUT',
    body: JSON.stringify({ currentPage: b.currentPage, lastReadAt: b.lastReadAt || Date.now() }),
  });
}

// Fetch the PDF bytes for one book via a presigned URL.
async function dbGet(id: string): Promise<ArrayBuffer | null> {
  const res = await api('/books/' + encodeURIComponent(id) + '/url');
  if (!res.ok) return null;
  const { url } = await res.json();
  const file = await fetch(url);
  if (!file.ok) return null;
  return file.arrayBuffer();
}

async function dbDel(id: string): Promise<void> {
  await api('/books/' + encodeURIComponent(id), { method: 'DELETE' });
}

function stripData(b: Book): BookMeta {
  const { data, ...rest } = b;
  return rest;
}

// ---------- state ----------
const LS = {
  user: 'folio.user',
  view: 'folio.view',
  width: 'folio.readerWidth',
};
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
  if (!ts) return 'Not yet opened';
  const d = Date.now() - ts, m = 60000, h = m * 60, day = h * 24;
  if (d < m) return 'Just now';
  if (d < h) return Math.floor(d / m) + ' min ago';
  if (d < day) return Math.floor(d / h) + 'h ago';
  if (d < day * 7) return Math.floor(d / day) + 'd ago';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
}

// ---------- cover & ingest ----------
async function loadDoc(data: ArrayBuffer): Promise<any> {
  await ensureWorker();
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
    return book;
  } catch (e) {
    console.error('ingest failed', e);
    toast('Could not read “' + (file as any).name + '”');
    return null;
  }
}

async function addFiles(files: FileList | File[]): Promise<void> {
  const arr = Array.from(files).filter(f => /pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!arr.length) { toast('Please choose PDF files'); return; }
  toast(arr.length === 1 ? 'Shelving your book…' : 'Shelving ' + arr.length + ' books…');
  for (const f of arr) {
    const b = await ingest(f);
    if (b) books.unshift(b);
  }
  renderLibrary();
  toast('Added to your library');
}


// ============================================================
//  LIBRARY RENDERING
// ============================================================
const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3l14 9-14 9V3z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6"/></svg>',
};

function coverMarkup(b: Book): string {
  if (b.cover) {
    return `<div class="cover" style="background-image:url('${b.cover}')"><span class="spine"></span>` +
      (b.lastReadAt ? `<span class="pct">${pct(b)}%</span>` : '') +
      `<button class="del" data-del="${b.id}" title="Remove">${ICON.trash}</button></div>`;
  }
  const initials = (b.author || '').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return `<div class="cover"><span class="spine"></span>
      <div class="gen-cover">
        <div class="gt">${escapeHtml(b.title)}</div>
        <div class="grule"></div>
        <div class="ga">${escapeHtml(b.author || initials || 'Unknown')}</div>
      </div>` +
    (b.lastReadAt ? `<span class="pct">${pct(b)}%</span>` : '') +
    `<button class="del" data-del="${b.id}" title="Remove">${ICON.trash}</button></div>`;
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
      <div class="rmeta"><div class="rt">${escapeHtml(b.title)}</div><div class="ra">${escapeHtml(b.author || 'Unknown author')}</div></div>
      <div class="rprog"><div class="progress"><i style="width:${pct(b)}%"></i></div><span class="progress-num">${b.lastReadAt ? pct(b) + '%' : 'New'}</span></div>
      <div class="rwhen">${relTime(b.lastReadAt)}</div>
      <button class="rresume" data-open="${b.id}">${ICON.play}${b.lastReadAt ? 'Resume' : 'Read'}</button>
      <button class="del rmenu" data-del="${b.id}" title="Remove">${ICON.trash}</button>
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
  el('cont-author').textContent = b.author || 'Unknown author';
  el('cont-bar').style.width = pct(b) + '%';
  el('cont-num').textContent = 'Page ' + b.currentPage + ' of ' + b.numPages + ' · ' + pct(b) + '%';
}

function renderLibrary(): void {
  // active view button
  document.querySelectorAll('#viewswitch button').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.view === viewMode);
  });
  el('lib-count').textContent = books.length
    ? books.length + (books.length === 1 ? ' volume' : ' volumes')
    : '';
  renderContinue();

  const body = el('lib-body');
  if (!books.length) {
    el('continue').classList.remove('show');
    body.innerHTML = `<div class="empty">
      <div class="ic">❦</div>
      <h3>Your shelves are empty</h3>
      <p>Add a PDF to begin your collection. Everything stays privately on this device.</p>
      <button class="mast-btn brass" id="empty-add" style="margin:0 auto">Add your first book</button>
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
  if (!window.confirm('Remove “' + b.title + '” from your library?\nThis deletes the file from this device.')) return;
  await dbDel(id);
  books = books.filter(x => x.id !== id);
  renderLibrary();
  toast('Removed from library');
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
};

async function openBook(id: string): Promise<void> {
  const meta = books.find(x => x.id === id);
  if (!meta) { toast('Could not open that book'); return; }
  const b = meta as Book;
  reader.book = b;
  reader.page = Math.min(Math.max(1, b.currentPage || 1), b.numPages);
  reader.zoom = 1;
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
    if (!bytes) { toast('Could not load this PDF'); el('r-loading').classList.add('hidden'); return; }
    reader.doc = await loadDoc(bytes);
    await renderPage(reader.page, false);
  } catch (e) {
    console.error(e); toast('Failed to load this PDF');
  }
  el('r-loading').classList.add('hidden');
}

function closeReader(): void {
  exitZen();
  el('reader').classList.remove('show');
  document.body.style.overflow = '';
  reader.doc = null; reader.book = null;
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
  col.appendChild(wrap);

  if (!keepScroll) el('r-stage').scrollTop = 0;
  updateReaderChrome();
  persistPage();
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

function wireReader(): void {
  el('r-back').addEventListener('click', closeReader);
  el('r-prev').addEventListener('click', () => go(-1));
  el('r-next').addEventListener('click', () => go(1));
  el('r-prev-s').addEventListener('click', () => go(-1));
  el('r-next-s').addEventListener('click', () => go(1));
  el('r-stage').addEventListener('wheel', onReaderWheel, { passive: false });
  el('r-focus').addEventListener('click', toggleZen);

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
    // click left/right thirds to page (only when not selecting text)
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
    else if (k === 'Escape') { if (el('reader').classList.contains('zen')) exitZen(); else closeReader(); }
  });

  window.addEventListener('resize', onResize);
}

// ============================================================
//  AUTH
// ============================================================
function showApp(name: string): void {
  el('login').classList.add('hidden');
  el('app').classList.remove('hidden');
  const initial = (name.trim()[0] || 'R').toUpperCase();
  el('avatar-initial').textContent = initial;
  el('user-name').textContent = name.trim() || 'Reader';
}
function wireAuth(): void {
  el<HTMLFormElement>('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (el('login-name') as HTMLInputElement).value.trim() || 'Reader';
    const pass = (el('login-pass') as HTMLInputElement).value;
    if (!pass) return;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password: pass }),
      });
      if (!res.ok) { toast('Wrong password'); return; }
      localStorage.setItem(LS.user, JSON.stringify({ name }));
      showApp(name);
      await boot();
    } catch {
      toast('Could not reach the server');
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
  try {
    books = (await dbAll()) as unknown as Book[];
  } catch (e) { console.error('api error', e); books = []; }
  renderLibrary();
}

function init(): void {
  wireAuth();
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
  // restore session
  const saved = localStorage.getItem(LS.user);
  if (saved) {
    try {
      const u = JSON.parse(saved);
      showApp(u.name || 'Reader');
      boot();
    } catch { /* show login */ }
  }
}

init();

})();