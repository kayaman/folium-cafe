/* ============================================================
   FOLIUM CAFÉ — app.ts  (so you remember the page you were on)
   ============================================================ */

import { mediaFormatForUrl, AUDIO_EXT, VIDEO_EXT } from './share-routing.mjs';
import { grayscalePixels, isPrintShortcut, printRenderScale, resolvePrintPages } from './print-support.mjs';

// File Handling API (open-with). Minimal ambient types — the import above makes
// this file a module, so the interfaces are wrapped in `declare global` to keep
// merging with the global scope / lib DOM types instead of staying file-local.
declare global {
  interface LaunchParams { files?: FileSystemFileHandle[] }
  interface LaunchQueue { setConsumer(cb: (p: LaunchParams) => void): void }
  interface Window { launchQueue?: LaunchQueue }
  // GA4 gtag.js, loaded from index.html — ambient so the analytics helper inside
  // the app IIFE can reference it (`declare` is illegal inside a function body).
  function gtag(...args: unknown[]): void;
}

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

// ---------- marked (markdown) ----------
// Vendored UMD build (window.marked), precached in the SW shell. Configured once
// at startup: GitHub-style line breaks, and raw inline HTML in note bodies is
// neutralized (single-user, but avoid surprises from pasted markup).
const marked: any = (window as any).marked;
function setupMarked(): void {
  try {
    marked?.setOptions?.({ breaks: true });
    // marked v12 dropped the `sanitize` option; the supported way to refuse raw
    // inline/block HTML is a renderer override that escapes the html token.
    if (marked?.use) {
      marked.use({
        renderer: {
          html(token: any): string {
            const raw = typeof token === 'string' ? token : (token?.raw ?? token?.text ?? '');
            return escapeHtml(String(raw));
          },
        },
      });
    }
  } catch { /* markdown rendering is best-effort */ }
}
// Render markdown to an HTML string for the note preview, falling back to escaped
// plain text if the library is unavailable.
function renderMarkdown(src: string): string {
  try {
    if (marked?.parse) return marked.parse(src) as string;
  } catch { /* fall through */ }
  return '<p>' + escapeHtml(src).replace(/\n/g, '<br>') + '</p>';
}

// ---------- lazy vendor loader ----------
// Injects a <script src=path> once and resolves when it loads. Used to pull in
// heavy/optional libs (fflate for CBZ) on demand rather than precaching them.
// The SW caches /vendor/* on first fetch (VENDOR_CACHE) so it works offline next
// time. Memoized so concurrent callers share one load.
const _vendorLoads = new Map<string, Promise<void>>();
function loadVendor(path: string): Promise<void> {
  let p = _vendorLoads.get(path);
  if (p) return p;
  p = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = path;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { _vendorLoads.delete(path); reject(new Error('failed to load ' + path)); };
    document.head.appendChild(s);
  });
  _vendorLoads.set(path, p);
  return p;
}

// ---------- types ----------
// Multi-format seam (Phase 0). Today every book is a PDF; `format` defaults to
// 'pdf' everywhere it's read (`book.format ?? 'pdf'`). The remaining formats are
// declared now so the adapter plumbing is type-complete before later phases land.
type DocFormat = 'pdf' | 'cbz' | 'epub' | 'txt' | 'md' | 'audio' | 'video' | 'note';
type DocMode = 'canvas' | 'scroll' | 'reflow' | 'media';

// What a format can do — drives reader-chrome gating in openBook(). PDF = all on.
interface DocCaps {
  paged: boolean;
  canvasPages: boolean;
  textSelectable: boolean;
  regionClippable: boolean;
  timeMedia: boolean;
  reflowable: boolean;
  zoomable: boolean;
  printable: boolean;
}

// A position within a document. PDF uses `page`; later formats use cfi / fraction
// / seconds. `reader.pos` is the source of truth, `reader.page` mirrors pos.page.
interface DocPos {
  page?: number;
  cfi?: string;
  fraction?: number;   // whole-document scroll (txt/md)
  seconds?: number;
  frac?: number;       // within-page scroll fraction 0..1 (pdf/cbz), zoom-independent
}

// Everything an adapter needs to paint itself into the reader column.
interface RenderCtx {
  col: HTMLElement;
  stage: HTMLElement;
  width: 'comfort' | 'full';
  zoom: number;
  token: number;
  drawClipOverlay(wrap: HTMLElement, cssW: number, cssH: number): void;
}

// The per-format rendering/position contract. PdfAdapter is the only impl today.
interface DocAdapter {
  readonly format: DocFormat;
  readonly mode: DocMode;
  readonly caps: DocCaps;
  readonly total: number;
  render(pos: DocPos, ctx: RenderCtx, keepScroll: boolean): Promise<void>;
  toBarPercent(pos: DocPos): number;
  posLabel(pos: DocPos): { current: string; total: string };
  currentCanvas(): HTMLCanvasElement | null;
  renderPrintPage?(page: number, options: { dpi: number; grayscale: boolean }): Promise<PrintPage>;
  destroy(): void;
}

interface PrintPage {
  blob: Blob;
  widthPoints: number;
  heightPoints: number;
}

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
  format?: DocFormat;     // defaults to 'pdf'; absent on legacy/PDF books
  noteFormat?: 'text' | 'markdown';  // notes only ('note' format)
  // Generalized reading position for non-paged formats (scroll/media). Paged
  // formats keep using `currentPage`; scroll formats persist `{kind:'fraction'}`.
  progress?: { kind: 'page' | 'cfi' | 'fraction' | 'seconds'; value: number | string };
  posFrac?: number;    // synced within-page fraction for paged formats
  collections?: string[];     // collection ids this book belongs to
  url?: string;               // linked external media: https stream URL (no stored bytes)
  provider?: string | null;   // linked media: free-text provider passthrough
  // Enriched bibliographic metadata (AI fill / manual edit). `author` above stays
  // the display string; `authors` is the structured list it's joined from.
  subtitle?: string;
  authors?: string[];
  edition?: string;
  publisher?: string;
  year?: number;
  isbn?: string;
  language?: string;
  series?: string;
  description?: string;
  goodreadsUrl?: string;      // Goodreads book link (Open Library match or manual paste)
  catalogBookId?: string;
  catalogAuthorIds?: string[];
  catalogPublisherIds?: string[];
  canonicalMetadata?: Record<string, unknown>;
  metadataOverrides?: Record<string, unknown>;
  catalogMatchStatus?: 'unmatched' | 'checking' | 'suggested' | 'none' | 'linked';
  catalogCheckedAt?: number;
  catalogSuggestions?: Candidate[];
}
// A user-defined grouping of books. Membership lives on each Book.collections.
type Collection = { id: string; name: string; createdAt: number };
// A note is a first-class library item with no PDF bytes: numPages 1, no cover.
function isNote(b: Book): boolean { return b.format === 'note'; }
type ViewMode = 'shelf' | 'grid' | 'list';
type CatalogTab = 'books' | 'authors' | 'publishers';
interface CatalogEntity { id: string; name: string; aliases?: string[]; bookIds: string[]; local?: boolean; sourceUrl?: string; imageUrl?: string; }

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
  'login.note': 'Your library is kept on a private shelf — sign in from any device to pick up where you left off.',
  'auth.tabSignIn': 'Sign in',
  'auth.tabSignUp': 'Sign up',
  'auth.username': 'Username',
  'auth.usernamePh': 'your-handle',
  'auth.email': 'Email',
  'auth.emailPh': 'you@example.com',
  'auth.password': 'Password',
  'auth.newPassword': 'New password',
  'auth.signIn': 'Sign in',
  'auth.signUp': 'Create account',
  'auth.code': 'Verification code',
  'auth.codePh': '123456',
  'auth.confirm': 'Confirm',
  'auth.resend': 'Resend code',
  'auth.forgot': 'Forgot password?',
  'auth.resetSend': 'Send reset code',
  'auth.resetConfirm': 'Set new password',
  'auth.backToSignIn': 'Back to sign in',
  'auth.handleHint': '4–12 chars, lowercase letters and digits',
  'auth.checkEmail': 'Check your email for the verification code',
  'auth.resetSent': 'Reset code sent — check your email',
  'auth.passwordReset': 'Password updated — you can now sign in',
  'toast.signUpFailed': 'Could not create account',
  'toast.confirmFailed': 'Wrong or expired code — try again',
  'toast.resetFailed': 'Could not reset password',
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
  'mast.addLabel': 'Add',
  'mast.linkMedia': 'Link media',
  'catalog.navAria': 'Library catalog',
  'catalog.books': 'Books',
  'catalog.authors': 'Authors',
  'catalog.publishers': 'Publishers',
  'catalog.search': 'Search catalog',
  'catalog.local': 'Local',
  'catalog.bookCount.one': '{n} book',
  'catalog.bookCount.other': '{n} books',
  'catalog.emptyAuthors': 'No authors yet. Add author names in Book details.',
  'catalog.emptyPublishers': 'No publishers yet. Add a publisher in Book details.',
  'catalog.linked': 'Linked to Open Library',
  'catalog.suggested': 'A catalog match is ready for review',
  'catalog.unmatched': 'Not linked to a catalog record',
  'catalog.unlink': 'Unlink catalog record',
  'catalog.unlinked': 'Catalog record unlinked',
  'catalog.matched': 'Book linked to the catalog',
  'catalog.matching': 'Checking catalog metadata…',
  'catalog.localOverrides': 'Local edits: {fields}',
  'menu.atCafe': 'at the café',
  'menu.settings': 'Settings',
  'menu.install': 'Install Folium Café',
  'menu.signOut': 'Sign out',
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
  'a11y.openBook': 'Open {title}',
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
  'print.action': 'Print pages',
  'print.title': 'Print PDF',
  'print.pages': 'Pages',
  'print.current': 'Current page ({page})',
  'print.single': 'Single page',
  'print.range': 'Page range',
  'print.from': 'From',
  'print.fromAria': 'From page',
  'print.to': 'to',
  'print.toAria': 'To page',
  'print.color': 'Color',
  'print.colorOption': 'Color',
  'print.bwOption': 'Black and white',
  'print.sizing': 'Page sizing',
  'print.fit': 'Fit to printable area',
  'print.actual': 'Actual size',
  'print.hint': 'Paper size, orientation, and copies are available in the system print dialog.',
  'print.submit': 'Print',
  'print.preparing': 'Preparing page {current} of {total}…',
  'print.error.required': 'Enter a page number.',
  'print.error.integer': 'Use whole page numbers only.',
  'print.error.bounds': 'Choose pages from 1 to {total}.',
  'print.error.order': 'The first page must come before the last page.',
  'print.error.failed': 'Could not prepare these pages for printing.',
  'print.error.unsupported': 'Printing is not supported in this browser.',
  'drop.kicker': 'Add to your library',
  'drop.body': 'Drop PDF files to shelve them',
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.langSystem': 'System default',
  'settings.done': 'Done',
  'toast.offlineAdd': 'You’re offline — try adding books when you’re back online',
  'toast.quotaFull': 'Library full — you’ve reached the 50 GB storage limit',
  'toast.cantRead': 'Could not read “{name}”',
  'toast.unsupported': 'Unsupported file type — try PDF, EPUB, CBZ, TXT, Markdown, audio or video',
  'toast.shelving.one': 'Shelving your book…',
  'toast.shelving.other': 'Shelving {n} books…',
  'toast.shelvingShared.one': 'Shelving your shared book…',
  'toast.shelvingShared.other': 'Shelving {n} shared books…',
  'share.note.untitled': 'Shared note',
  'share.drain.allFailed': 'Nothing could be added',
  'share.drain.partial': 'Shelved {ok}, {failed} couldn’t be added',
  'share.waiting.one': '1 item waiting — sign in to shelve it',
  'share.waiting.other': '{n} items waiting — sign in to shelve them',
  'toast.added': 'Added to your library',
  'toast.offlineRetry': 'You’re offline — try again when you’re back online',
  'toast.staleServer': 'Couldn’t refresh — showing your saved library',
  'toast.libLoadFailed': 'Couldn’t load your library — please try again',
  'toast.removed': 'Removed from library',
  'toast.cantOpen': 'Could not open that book',
  'toast.cantLoad': 'Could not load this PDF',
  'toast.notDownloaded': 'This book isn’t downloaded on this device',
  'toast.loadFailed': 'Failed to load this PDF',
  'toast.mediaError': 'Playback needs a connection — try again online',
  'toast.wrongPass': 'Wrong password',
  'toast.noServer': 'Could not reach the server',
  'time.notOpened': 'Not yet opened',
  'time.justNow': 'Just now',
  'pwa.updated': 'Folium Café has been updated',
  'pwa.installed': 'Folium Café is on your home screen',
  'pwa.offer': 'Add Folium Café to your home screen for faster, offline reading.',
  'pwa.offerCta': 'Install',
  'pwa.offerDismiss': 'Not now',
  'clip.snapshot': 'Snapshot and share',
  'clip.captureHint': 'Drag a box over the page — Esc to cancel',
  'clip.highlight': 'Highlight',
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
  'share.action': 'Share file',
  'share.preparing': 'Preparing to share…',
  'share.failed': 'Couldn’t share this file',
  'share.offline': 'You’re offline — can’t share this file',
  'share.tooLargeDownloaded': 'File is large — downloaded instead',
  'share.linkCopied': 'Link copied to clipboard',
  'note.new': 'New note',
  'note.kind': 'Note',
  'note.untitled': 'Untitled note',
  'note.plain': 'Plain text',
  'note.markdown': 'Markdown',
  'note.format': 'Format',
  'note.preview': 'Preview',
  'note.edit': 'Edit',
  'note.saved': 'Saved',
  'note.savedOffline': 'Saved on this device — will sync when online',
  'note.delete': 'Delete note',
  'note.confirmDelete': 'Delete “{title}”?',
  'note.emptyAdd': 'Write your first note',
  'toast.noteCreated': 'Note created',
  'toast.noteRemoved': 'Note removed',
  'coll.all': 'All',
  'coll.new': 'New collection',
  'coll.namePrompt': 'Name this collection',
  'coll.renamePrompt': 'Rename collection',
  'coll.rename': 'Rename',
  'coll.delete': 'Delete',
  'coll.confirmDelete': 'Delete the collection “{name}”? Your books stay; only the grouping is removed.',
  'coll.assignTitle': 'Collections',
  'coll.save': 'Save',
  'coll.none': 'No collections yet — create one to group your books.',
  'coll.empty': 'Nothing in this collection yet.',
  'coll.uncollected': 'Uncollected',
  'coll.manage': 'Manage collections',
  'coll.manageTitle': 'Collections',
  'card.menu': 'More actions',
  'media.link.tabLink': 'Link',
  'media.link.url': 'Media URL',
  'media.link.urlPh': 'https://example.com/audio.mp3',
  'media.link.titleField': 'Title',
  'media.link.authorField': 'Author',
  'media.link.kindAudio': 'Audio',
  'media.link.kindVideo': 'Video',
  'media.link.add': 'Add link',
  'media.link.badUrl': 'Enter a valid https URL',
  'media.link.added': 'Linked media added',
  'confirm.title': 'Please confirm',
  'confirm.cancel': 'Cancel',
  'confirm.ok': 'Confirm',
  'reader.error.title': 'This book would not open',
  'reader.error.body': 'Something went wrong loading it. Check your connection and try again.',
  'reader.error.retry': 'Retry',
  'settings.reading': 'Reading',
  'settings.textSize': 'Text size',
  'settings.lineSpacing': 'Line spacing',
  'settings.decreaseTextSize': 'Decrease text size',
  'settings.increaseTextSize': 'Increase text size',
  'settings.decreaseLineSpacing': 'Decrease line spacing',
  'settings.increaseLineSpacing': 'Increase line spacing',
  'settings.theme': 'Theme',
  'theme.system': 'System default',
  'theme.paper': 'Paper',
  'theme.sepia': 'Sepia',
  'theme.dark': 'Dark',
  'theme.hc': 'High contrast',
  'theme.toDark': 'Switch to dark',
  'theme.toLight': 'Switch to light',
  'details.title': 'Book details',
  'details.fTitle': 'Title',
  'details.fSubtitle': 'Subtitle',
  'details.fAuthors': 'Authors',
  'details.authorsPh': 'Separate names with commas',
  'details.fSeries': 'Series',
  'details.fEdition': 'Edition',
  'details.fPublisher': 'Publisher',
  'details.fYear': 'Year',
  'details.fIsbn': 'ISBN',
  'details.fLanguage': 'Language',
  'details.fDescription': 'Description',
  'details.fCollection': 'Collections',
  'details.fillAI': 'Fill with AI',
  'details.aiLoading': 'Reading the cover…',
  'details.aiFilled': 'Filled in what we could find',
  'details.aiError': 'Could not read the metadata',
  'details.aiOffline': 'You’re offline — try again when online',
  'details.saved': 'Details saved',
  'details.menuItem': 'Details',
  'cover.section': 'Cover',
  'cover.upload': 'Upload image',
  'cover.catalog': 'Use catalog cover',
  'cover.reset': 'Reset to document',
  'cover.invalid': 'Choose a JPEG, PNG, or WebP image under 10 MB',
  'cover.resetDone': 'Original document cover restored',
  'cover.noCatalog': 'Link a catalog record with a cover first',
  'goodreads.section': 'Find online',
  'goodreads.find': 'Search Open Library',
  'goodreads.searching': 'Searching…',
  'goodreads.needTitle': 'Enter a title or ISBN first',
  'goodreads.noMatches': 'No matches found',
  'goodreads.resultsLabel': 'Search results',
  'goodreads.pick': 'Use this',
  'goodreads.noLink': 'No Goodreads link for this match',
  'goodreads.urlLabel': 'Goodreads URL',
  'goodreads.urlPh': 'https://www.goodreads.com/book/show/…',
  'goodreads.view': 'View on Goodreads',
  'goodreads.badUrl': 'Enter a valid Goodreads URL',
  'goodreads.offline': 'You’re offline — try again when online',
  'goodreads.error': 'Could not search right now',
  'menu.about': 'About',
  'about.tagline': 'so you remember the page you were on',
  'about.lead': 'A quiet, private reading room for everything you mean to read. Shelve your books, open them on any device, and always land back on the exact page — and line — you left.',
  'about.featuresTitle': 'What’s inside',
  'about.f1.h': 'Pick up where you left off',
  'about.f1.b': 'Every page turn is saved to your shelf. Switch devices and resume mid-sentence.',
  'about.f2.h': 'More than PDFs',
  'about.f2.b': 'PDFs, EPUBs, CBZ comics, plain text and Markdown, even audiobooks and video — one calm library for all of it, plus notes you write in place.',
  'about.f3.h': 'Yours alone',
  'about.f3.b': 'A single private library behind your sign-in. No feeds, no ads, no one else browsing your shelves.',
  'about.f4.h': 'Works offline',
  'about.f4.b': 'Install it like a native app. Your current books travel with you — on a plane, underground, anywhere.',
  'about.f5.h': 'Highlight and share',
  'about.f5.b': 'Mark a passage or snip a handsome clipping, then share it in a tap.',
  'about.f6.h': 'Made for comfortable reading',
  'about.f6.b': 'Paper, sepia, dark and high-contrast themes, adjustable type, and a distraction-free focus mode.',
  'about.done': 'Close',
} as const;
type MsgKey = keyof typeof EN;

const PT: Record<MsgKey, string> = {
  'login.tagline': 'para você lembrar da página em que parou',
  'login.note': 'Sua biblioteca fica numa estante particular — entre de qualquer dispositivo para continuar de onde parou.',
  'auth.tabSignIn': 'Entrar',
  'auth.tabSignUp': 'Cadastrar',
  'auth.username': 'Nome de usuário',
  'auth.usernamePh': 'seu-apelido',
  'auth.email': 'E-mail',
  'auth.emailPh': 'voce@exemplo.com',
  'auth.password': 'Senha',
  'auth.newPassword': 'Nova senha',
  'auth.signIn': 'Entrar',
  'auth.signUp': 'Criar conta',
  'auth.code': 'Código de verificação',
  'auth.codePh': '123456',
  'auth.confirm': 'Confirmar',
  'auth.resend': 'Reenviar código',
  'auth.forgot': 'Esqueceu a senha?',
  'auth.resetSend': 'Enviar código de redefinição',
  'auth.resetConfirm': 'Definir nova senha',
  'auth.backToSignIn': 'Voltar para entrar',
  'auth.handleHint': '4–12 caracteres, letras minúsculas e dígitos',
  'auth.checkEmail': 'Verifique seu e-mail para o código de verificação',
  'auth.resetSent': 'Código enviado — verifique seu e-mail',
  'auth.passwordReset': 'Senha atualizada — você já pode entrar',
  'toast.signUpFailed': 'Não foi possível criar a conta',
  'toast.confirmFailed': 'Código errado ou expirado — tente novamente',
  'toast.resetFailed': 'Não foi possível redefinir a senha',
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
  'mast.addLabel': 'Adicionar',
  'mast.linkMedia': 'Vincular mídia',
  'catalog.navAria': 'Catálogo da biblioteca',
  'catalog.books': 'Livros',
  'catalog.authors': 'Autores',
  'catalog.publishers': 'Editoras',
  'catalog.search': 'Buscar no catálogo',
  'catalog.local': 'Local',
  'catalog.bookCount.one': '{n} livro',
  'catalog.bookCount.other': '{n} livros',
  'catalog.emptyAuthors': 'Ainda não há autores. Adicione nomes em Detalhes do livro.',
  'catalog.emptyPublishers': 'Ainda não há editoras. Adicione uma editora em Detalhes do livro.',
  'catalog.linked': 'Vinculado à Open Library',
  'catalog.suggested': 'Há uma correspondência para revisar',
  'catalog.unmatched': 'Não vinculado a um registro do catálogo',
  'catalog.unlink': 'Desvincular registro do catálogo',
  'catalog.unlinked': 'Registro do catálogo desvinculado',
  'catalog.matched': 'Livro vinculado ao catálogo',
  'catalog.matching': 'Verificando metadados do catálogo…',
  'catalog.localOverrides': 'Edições locais: {fields}',
  'menu.atCafe': 'no café',
  'menu.settings': 'Configurações',
  'menu.install': 'Instalar o Folium Café',
  'menu.signOut': 'Sair',
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
  'a11y.openBook': 'Abrir {title}',
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
  'print.action': 'Imprimir páginas',
  'print.title': 'Imprimir PDF',
  'print.pages': 'Páginas',
  'print.current': 'Página atual ({page})',
  'print.single': 'Página única',
  'print.range': 'Intervalo de páginas',
  'print.from': 'De',
  'print.fromAria': 'Página inicial',
  'print.to': 'até',
  'print.toAria': 'Página final',
  'print.color': 'Cor',
  'print.colorOption': 'Colorido',
  'print.bwOption': 'Preto e branco',
  'print.sizing': 'Tamanho da página',
  'print.fit': 'Ajustar à área imprimível',
  'print.actual': 'Tamanho real',
  'print.hint': 'Tamanho do papel, orientação e cópias estão disponíveis na caixa de impressão do sistema.',
  'print.submit': 'Imprimir',
  'print.preparing': 'Preparando página {current} de {total}…',
  'print.error.required': 'Digite um número de página.',
  'print.error.integer': 'Use apenas números de página inteiros.',
  'print.error.bounds': 'Escolha páginas de 1 a {total}.',
  'print.error.order': 'A primeira página deve vir antes da última.',
  'print.error.failed': 'Não foi possível preparar estas páginas para impressão.',
  'print.error.unsupported': 'A impressão não é compatível com este navegador.',
  'drop.kicker': 'Adicionar à sua biblioteca',
  'drop.body': 'Solte arquivos PDF para colocá-los na estante',
  'settings.title': 'Configurações',
  'settings.language': 'Idioma',
  'settings.langSystem': 'Padrão do sistema',
  'settings.done': 'Concluído',
  'toast.offlineAdd': 'Você está offline — tente adicionar livros quando voltar a ficar online',
  'toast.quotaFull': 'Biblioteca cheia — você atingiu o limite de 50 GB de armazenamento',
  'toast.cantRead': 'Não foi possível ler “{name}”',
  'toast.unsupported': 'Tipo de arquivo não suportado — tente PDF, EPUB, CBZ, TXT, Markdown, áudio ou vídeo',
  'toast.shelving.one': 'Colocando seu livro na estante…',
  'toast.shelving.other': 'Colocando {n} livros na estante…',
  'toast.shelvingShared.one': 'Colocando o livro compartilhado na estante…',
  'toast.shelvingShared.other': 'Colocando {n} livros compartilhados na estante…',
  'share.note.untitled': 'Nota compartilhada',
  'share.drain.allFailed': 'Nada pôde ser adicionado',
  'share.drain.partial': 'Adicionados {ok}, {failed} não puderam ser adicionados',
  'share.waiting.one': '1 item aguardando — entre para colocá-lo na estante',
  'share.waiting.other': '{n} itens aguardando — entre para colocá-los na estante',
  'toast.added': 'Adicionado à sua biblioteca',
  'toast.offlineRetry': 'Você está offline — tente novamente quando voltar a ficar online',
  'toast.staleServer': 'Não foi possível atualizar — mostrando sua biblioteca salva',
  'toast.libLoadFailed': 'Não foi possível carregar sua biblioteca — tente novamente',
  'toast.removed': 'Removido da biblioteca',
  'toast.cantOpen': 'Não foi possível abrir esse livro',
  'toast.cantLoad': 'Não foi possível carregar este PDF',
  'toast.notDownloaded': 'Este livro não está baixado neste dispositivo',
  'toast.loadFailed': 'Falha ao carregar este PDF',
  'toast.mediaError': 'A reprodução precisa de conexão — tente novamente online',
  'toast.wrongPass': 'Senha incorreta',
  'toast.noServer': 'Não foi possível conectar ao servidor',
  'time.notOpened': 'Ainda não aberto',
  'time.justNow': 'Agora mesmo',
  'pwa.updated': 'O Folium Café foi atualizado',
  'pwa.installed': 'O Folium Café está na sua tela inicial',
  'pwa.offer': 'Adicione o Folium Café à tela inicial para uma leitura mais rápida e offline.',
  'pwa.offerCta': 'Instalar',
  'pwa.offerDismiss': 'Agora não',
  'clip.snapshot': 'Recortar e compartilhar',
  'clip.captureHint': 'Arraste uma caixa sobre a página — Esc para cancelar',
  'clip.highlight': 'Destacar',
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
  'share.action': 'Compartilhar arquivo',
  'share.preparing': 'Preparando para compartilhar…',
  'share.failed': 'Não foi possível compartilhar este arquivo',
  'share.offline': 'Você está offline — não dá para compartilhar este arquivo',
  'share.tooLargeDownloaded': 'Arquivo grande — baixado em vez disso',
  'share.linkCopied': 'Link copiado para a área de transferência',
  'note.new': 'Nova nota',
  'note.kind': 'Nota',
  'note.untitled': 'Nota sem título',
  'note.plain': 'Texto simples',
  'note.markdown': 'Markdown',
  'note.format': 'Formato',
  'note.preview': 'Visualizar',
  'note.edit': 'Editar',
  'note.saved': 'Salvo',
  'note.savedOffline': 'Salvo neste dispositivo — será sincronizado quando você estiver online',
  'note.delete': 'Excluir nota',
  'note.confirmDelete': 'Excluir “{title}”?',
  'note.emptyAdd': 'Escreva sua primeira nota',
  'toast.noteCreated': 'Nota criada',
  'toast.noteRemoved': 'Nota removida',
  'coll.all': 'Todas',
  'coll.new': 'Nova coleção',
  'coll.namePrompt': 'Nomeie esta coleção',
  'coll.renamePrompt': 'Renomear coleção',
  'coll.rename': 'Renomear',
  'coll.delete': 'Excluir',
  'coll.confirmDelete': 'Excluir a coleção “{name}”? Seus livros permanecem; só o agrupamento é removido.',
  'coll.assignTitle': 'Coleções',
  'coll.save': 'Salvar',
  'coll.none': 'Nenhuma coleção ainda — crie uma para agrupar seus livros.',
  'coll.empty': 'Nada nesta coleção ainda.',
  'coll.uncollected': 'Sem coleção',
  'coll.manage': 'Gerenciar coleções',
  'coll.manageTitle': 'Coleções',
  'card.menu': 'Mais ações',
  'media.link.tabLink': 'Link',
  'media.link.url': 'URL da mídia',
  'media.link.urlPh': 'https://exemplo.com/audio.mp3',
  'media.link.titleField': 'Título',
  'media.link.authorField': 'Autor',
  'media.link.kindAudio': 'Áudio',
  'media.link.kindVideo': 'Vídeo',
  'media.link.add': 'Adicionar link',
  'media.link.badUrl': 'Insira uma URL https válida',
  'media.link.added': 'Mídia vinculada adicionada',
  'confirm.title': 'Confirme, por favor',
  'confirm.cancel': 'Cancelar',
  'confirm.ok': 'Confirmar',
  'reader.error.title': 'Este livro não pôde ser aberto',
  'reader.error.body': 'Algo deu errado ao carregá-lo. Verifique sua conexão e tente novamente.',
  'reader.error.retry': 'Tentar de novo',
  'settings.reading': 'Leitura',
  'settings.textSize': 'Tamanho do texto',
  'settings.lineSpacing': 'Espaçamento',
  'settings.decreaseTextSize': 'Diminuir tamanho do texto',
  'settings.increaseTextSize': 'Aumentar tamanho do texto',
  'settings.decreaseLineSpacing': 'Diminuir espaçamento',
  'settings.increaseLineSpacing': 'Aumentar espaçamento',
  'settings.theme': 'Tema',
  'theme.system': 'Padrão do sistema',
  'theme.paper': 'Papel',
  'theme.sepia': 'Sépia',
  'theme.dark': 'Escuro',
  'theme.hc': 'Alto contraste',
  'theme.toDark': 'Mudar para escuro',
  'theme.toLight': 'Mudar para claro',
  'details.title': 'Detalhes do livro',
  'details.fTitle': 'Título',
  'details.fSubtitle': 'Subtítulo',
  'details.fAuthors': 'Autores',
  'details.authorsPh': 'Separe os nomes por vírgulas',
  'details.fSeries': 'Série',
  'details.fEdition': 'Edição',
  'details.fPublisher': 'Editora',
  'details.fYear': 'Ano',
  'details.fIsbn': 'ISBN',
  'details.fLanguage': 'Idioma',
  'details.fDescription': 'Descrição',
  'details.fCollection': 'Coleções',
  'details.fillAI': 'Preencher com IA',
  'details.aiLoading': 'Lendo a capa…',
  'details.aiFilled': 'Preenchemos o que encontramos',
  'details.aiError': 'Não foi possível ler os metadados',
  'details.aiOffline': 'Você está offline — tente novamente quando estiver online',
  'details.saved': 'Detalhes salvos',
  'details.menuItem': 'Detalhes',
  'cover.section': 'Capa',
  'cover.upload': 'Enviar imagem',
  'cover.catalog': 'Usar capa do catálogo',
  'cover.reset': 'Restaurar do documento',
  'cover.invalid': 'Escolha uma imagem JPEG, PNG ou WebP de até 10 MB',
  'cover.resetDone': 'Capa original do documento restaurada',
  'cover.noCatalog': 'Primeiro vincule um registro com capa',
  'goodreads.section': 'Buscar online',
  'goodreads.find': 'Buscar na Open Library',
  'goodreads.searching': 'Buscando…',
  'goodreads.needTitle': 'Informe um título ou ISBN primeiro',
  'goodreads.noMatches': 'Nenhuma correspondência encontrada',
  'goodreads.resultsLabel': 'Resultados da busca',
  'goodreads.pick': 'Usar este',
  'goodreads.noLink': 'Sem link do Goodreads para esta correspondência',
  'goodreads.urlLabel': 'URL do Goodreads',
  'goodreads.urlPh': 'https://www.goodreads.com/book/show/…',
  'goodreads.view': 'Ver no Goodreads',
  'goodreads.badUrl': 'Informe uma URL válida do Goodreads',
  'goodreads.offline': 'Você está offline — tente novamente quando estiver online',
  'goodreads.error': 'Não foi possível buscar agora',
  'menu.about': 'Sobre',
  'about.tagline': 'para você lembrar da página em que parou',
  'about.lead': 'Uma sala de leitura tranquila e particular para tudo o que você pretende ler. Coloque seus livros na estante, abra-os em qualquer dispositivo e volte sempre exatamente à página — e à linha — em que parou.',
  'about.featuresTitle': 'O que tem dentro',
  'about.f1.h': 'Continue de onde parou',
  'about.f1.b': 'Cada virada de página é salva na sua estante. Troque de dispositivo e retome no meio da frase.',
  'about.f2.h': 'Muito além de PDFs',
  'about.f2.b': 'PDFs, EPUBs, quadrinhos CBZ, texto puro e Markdown, e até audiolivros e vídeo — uma biblioteca tranquila para tudo isso, além de notas que você escreve ali mesmo.',
  'about.f3.h': 'Só sua',
  'about.f3.b': 'Uma única biblioteca particular protegida pelo seu login. Sem feeds, sem anúncios, ninguém mais folheando suas estantes.',
  'about.f4.h': 'Funciona offline',
  'about.f4.b': 'Instale como um aplicativo nativo. Seus livros atuais viajam com você — no avião, no metrô, em qualquer lugar.',
  'about.f5.h': 'Destaque e compartilhe',
  'about.f5.b': 'Marque um trecho ou recorte um clipe elegante e compartilhe com um toque.',
  'about.f6.h': 'Feito para uma leitura confortável',
  'about.f6.b': 'Temas papel, sépia, escuro e alto contraste, tipografia ajustável e um modo de foco sem distrações.',
  'about.done': 'Fechar',
};

const ES: Record<MsgKey, string> = {
  'login.tagline': 'para que recuerdes la página en la que estabas',
  'login.note': 'Tu biblioteca se guarda en un estante privado: inicia sesión desde cualquier dispositivo para continuar donde lo dejaste.',
  'auth.tabSignIn': 'Iniciar sesión',
  'auth.tabSignUp': 'Registrarse',
  'auth.username': 'Nombre de usuario',
  'auth.usernamePh': 'tu-apodo',
  'auth.email': 'Correo electrónico',
  'auth.emailPh': 'tu@ejemplo.com',
  'auth.password': 'Contraseña',
  'auth.newPassword': 'Nueva contraseña',
  'auth.signIn': 'Iniciar sesión',
  'auth.signUp': 'Crear cuenta',
  'auth.code': 'Código de verificación',
  'auth.codePh': '123456',
  'auth.confirm': 'Confirmar',
  'auth.resend': 'Reenviar código',
  'auth.forgot': '¿Olvidaste tu contraseña?',
  'auth.resetSend': 'Enviar código de restablecimiento',
  'auth.resetConfirm': 'Establecer nueva contraseña',
  'auth.backToSignIn': 'Volver a iniciar sesión',
  'auth.handleHint': '4–12 caracteres, letras minúsculas y dígitos',
  'auth.checkEmail': 'Revisa tu correo para el código de verificación',
  'auth.resetSent': 'Código enviado — revisa tu correo',
  'auth.passwordReset': 'Contraseña actualizada — ya puedes iniciar sesión',
  'toast.signUpFailed': 'No se pudo crear la cuenta',
  'toast.confirmFailed': 'Código incorrecto o expirado — intenta de nuevo',
  'toast.resetFailed': 'No se pudo restablecer la contraseña',
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
  'mast.addLabel': 'Añadir',
  'mast.linkMedia': 'Vincular medios',
  'catalog.navAria': 'Catálogo de la biblioteca',
  'catalog.books': 'Libros',
  'catalog.authors': 'Autores',
  'catalog.publishers': 'Editoriales',
  'catalog.search': 'Buscar en el catálogo',
  'catalog.local': 'Local',
  'catalog.bookCount.one': '{n} libro',
  'catalog.bookCount.other': '{n} libros',
  'catalog.emptyAuthors': 'Aún no hay autores. Añade nombres en Detalles del libro.',
  'catalog.emptyPublishers': 'Aún no hay editoriales. Añade una editorial en Detalles del libro.',
  'catalog.linked': 'Enlazado con Open Library',
  'catalog.suggested': 'Hay una coincidencia para revisar',
  'catalog.unmatched': 'No enlazado con un registro del catálogo',
  'catalog.unlink': 'Desenlazar registro del catálogo',
  'catalog.unlinked': 'Registro del catálogo desenlazado',
  'catalog.matched': 'Libro enlazado con el catálogo',
  'catalog.matching': 'Comprobando metadatos del catálogo…',
  'catalog.localOverrides': 'Ediciones locales: {fields}',
  'menu.atCafe': 'en el café',
  'menu.settings': 'Ajustes',
  'menu.install': 'Instalar Folium Café',
  'menu.signOut': 'Cerrar sesión',
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
  'a11y.openBook': 'Abrir {title}',
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
  'print.action': 'Imprimir páginas',
  'print.title': 'Imprimir PDF',
  'print.pages': 'Páginas',
  'print.current': 'Página actual ({page})',
  'print.single': 'Página única',
  'print.range': 'Intervalo de páginas',
  'print.from': 'Desde',
  'print.fromAria': 'Página inicial',
  'print.to': 'hasta',
  'print.toAria': 'Página final',
  'print.color': 'Color',
  'print.colorOption': 'Color',
  'print.bwOption': 'Blanco y negro',
  'print.sizing': 'Tamaño de página',
  'print.fit': 'Ajustar al área imprimible',
  'print.actual': 'Tamaño real',
  'print.hint': 'El tamaño del papel, la orientación y las copias están disponibles en el diálogo de impresión del sistema.',
  'print.submit': 'Imprimir',
  'print.preparing': 'Preparando página {current} de {total}…',
  'print.error.required': 'Introduce un número de página.',
  'print.error.integer': 'Usa solo números de página enteros.',
  'print.error.bounds': 'Elige páginas de 1 a {total}.',
  'print.error.order': 'La primera página debe ir antes de la última.',
  'print.error.failed': 'No se pudieron preparar estas páginas para imprimir.',
  'print.error.unsupported': 'La impresión no es compatible con este navegador.',
  'drop.kicker': 'Añadir a tu biblioteca',
  'drop.body': 'Suelta archivos PDF para colocarlos en el estante',
  'settings.title': 'Ajustes',
  'settings.language': 'Idioma',
  'settings.langSystem': 'Predeterminado del sistema',
  'settings.done': 'Listo',
  'toast.offlineAdd': 'Estás sin conexión: intenta añadir libros cuando vuelvas a estar en línea',
  'toast.quotaFull': 'Biblioteca llena: has alcanzado el límite de 50 GB de almacenamiento',
  'toast.cantRead': 'No se pudo leer “{name}”',
  'toast.unsupported': 'Tipo de archivo no compatible — prueba PDF, EPUB, CBZ, TXT, Markdown, audio o vídeo',
  'toast.shelving.one': 'Colocando tu libro en el estante…',
  'toast.shelving.other': 'Colocando {n} libros en el estante…',
  'toast.shelvingShared.one': 'Colocando el libro compartido en el estante…',
  'toast.shelvingShared.other': 'Colocando {n} libros compartidos en el estante…',
  'share.note.untitled': 'Nota compartida',
  'share.drain.allFailed': 'No se pudo añadir nada',
  'share.drain.partial': 'Añadidos {ok}, {failed} no se pudieron añadir',
  'share.waiting.one': '1 elemento en espera — inicia sesión para añadirlo',
  'share.waiting.other': '{n} elementos en espera — inicia sesión para añadirlos',
  'toast.added': 'Añadido a tu biblioteca',
  'toast.offlineRetry': 'Estás sin conexión: inténtalo de nuevo cuando vuelvas a estar en línea',
  'toast.staleServer': 'No se pudo actualizar: mostrando tu biblioteca guardada',
  'toast.libLoadFailed': 'No se pudo cargar tu biblioteca: inténtalo de nuevo',
  'toast.removed': 'Eliminado de la biblioteca',
  'toast.cantOpen': 'No se pudo abrir ese libro',
  'toast.cantLoad': 'No se pudo cargar este PDF',
  'toast.notDownloaded': 'Este libro no está descargado en este dispositivo',
  'toast.loadFailed': 'Error al cargar este PDF',
  'toast.mediaError': 'La reproducción necesita conexión — inténtalo de nuevo en línea',
  'toast.wrongPass': 'Contraseña incorrecta',
  'toast.noServer': 'No se pudo conectar con el servidor',
  'time.notOpened': 'Aún sin abrir',
  'time.justNow': 'Ahora mismo',
  'pwa.updated': 'Folium Café se ha actualizado',
  'pwa.installed': 'Folium Café está en tu pantalla de inicio',
  'pwa.offer': 'Añade Folium Café a tu pantalla de inicio para una lectura más rápida y sin conexión.',
  'pwa.offerCta': 'Instalar',
  'pwa.offerDismiss': 'Ahora no',
  'clip.snapshot': 'Recortar y compartir',
  'clip.captureHint': 'Arrastra un recuadro sobre la página — Esc para cancelar',
  'clip.highlight': 'Resaltar',
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
  'share.action': 'Compartir archivo',
  'share.preparing': 'Preparando para compartir…',
  'share.failed': 'No se pudo compartir este archivo',
  'share.offline': 'Estás sin conexión — no se puede compartir este archivo',
  'share.tooLargeDownloaded': 'Archivo grande — descargado en su lugar',
  'share.linkCopied': 'Enlace copiado al portapapeles',
  'note.new': 'Nueva nota',
  'note.kind': 'Nota',
  'note.untitled': 'Nota sin título',
  'note.plain': 'Texto sin formato',
  'note.markdown': 'Markdown',
  'note.format': 'Formato',
  'note.preview': 'Vista previa',
  'note.edit': 'Editar',
  'note.saved': 'Guardado',
  'note.savedOffline': 'Guardado en este dispositivo — se sincronizará cuando estés en línea',
  'note.delete': 'Eliminar nota',
  'note.confirmDelete': '¿Eliminar “{title}”?',
  'note.emptyAdd': 'Escribe tu primera nota',
  'toast.noteCreated': 'Nota creada',
  'toast.noteRemoved': 'Nota eliminada',
  'coll.all': 'Todas',
  'coll.new': 'Nueva colección',
  'coll.namePrompt': 'Nombra esta colección',
  'coll.renamePrompt': 'Renombrar colección',
  'coll.rename': 'Renombrar',
  'coll.delete': 'Eliminar',
  'coll.confirmDelete': '¿Eliminar la colección “{name}”? Tus libros permanecen; solo se quita la agrupación.',
  'coll.assignTitle': 'Colecciones',
  'coll.save': 'Guardar',
  'coll.none': 'Aún no hay colecciones — crea una para agrupar tus libros.',
  'coll.empty': 'Nada en esta colección todavía.',
  'coll.uncollected': 'Sin colección',
  'coll.manage': 'Gestionar colecciones',
  'coll.manageTitle': 'Colecciones',
  'card.menu': 'Más acciones',
  'media.link.tabLink': 'Enlace',
  'media.link.url': 'URL del medio',
  'media.link.urlPh': 'https://ejemplo.com/audio.mp3',
  'media.link.titleField': 'Título',
  'media.link.authorField': 'Autor',
  'media.link.kindAudio': 'Audio',
  'media.link.kindVideo': 'Vídeo',
  'media.link.add': 'Añadir enlace',
  'media.link.badUrl': 'Introduce una URL https válida',
  'media.link.added': 'Medio enlazado añadido',
  'confirm.title': 'Confirma, por favor',
  'confirm.cancel': 'Cancelar',
  'confirm.ok': 'Confirmar',
  'reader.error.title': 'Este libro no se pudo abrir',
  'reader.error.body': 'Algo salió mal al cargarlo. Revisa tu conexión e inténtalo de nuevo.',
  'reader.error.retry': 'Reintentar',
  'settings.reading': 'Lectura',
  'settings.textSize': 'Tamaño del texto',
  'settings.lineSpacing': 'Interlineado',
  'settings.decreaseTextSize': 'Disminuir tamaño del texto',
  'settings.increaseTextSize': 'Aumentar tamaño del texto',
  'settings.decreaseLineSpacing': 'Disminuir interlineado',
  'settings.increaseLineSpacing': 'Aumentar interlineado',
  'settings.theme': 'Tema',
  'theme.system': 'Predeterminado del sistema',
  'theme.paper': 'Papel',
  'theme.sepia': 'Sepia',
  'theme.dark': 'Oscuro',
  'theme.hc': 'Alto contraste',
  'theme.toDark': 'Cambiar a oscuro',
  'theme.toLight': 'Cambiar a claro',
  'details.title': 'Detalles del libro',
  'details.fTitle': 'Título',
  'details.fSubtitle': 'Subtítulo',
  'details.fAuthors': 'Autores',
  'details.authorsPh': 'Separa los nombres con comas',
  'details.fSeries': 'Serie',
  'details.fEdition': 'Edición',
  'details.fPublisher': 'Editorial',
  'details.fYear': 'Año',
  'details.fIsbn': 'ISBN',
  'details.fLanguage': 'Idioma',
  'details.fDescription': 'Descripción',
  'details.fCollection': 'Colecciones',
  'details.fillAI': 'Rellenar con IA',
  'details.aiLoading': 'Leyendo la portada…',
  'details.aiFilled': 'Rellenamos lo que pudimos encontrar',
  'details.aiError': 'No se pudieron leer los metadatos',
  'details.aiOffline': 'Estás sin conexión — inténtalo de nuevo cuando estés en línea',
  'details.saved': 'Detalles guardados',
  'details.menuItem': 'Detalles',
  'cover.section': 'Portada',
  'cover.upload': 'Subir imagen',
  'cover.catalog': 'Usar portada del catálogo',
  'cover.reset': 'Restaurar del documento',
  'cover.invalid': 'Elige una imagen JPEG, PNG o WebP de hasta 10 MB',
  'cover.resetDone': 'Portada original del documento restaurada',
  'cover.noCatalog': 'Primero enlaza un registro que tenga portada',
  'goodreads.section': 'Buscar en línea',
  'goodreads.find': 'Buscar en Open Library',
  'goodreads.searching': 'Buscando…',
  'goodreads.needTitle': 'Escribe un título o ISBN primero',
  'goodreads.noMatches': 'No se encontraron coincidencias',
  'goodreads.resultsLabel': 'Resultados de la búsqueda',
  'goodreads.pick': 'Usar este',
  'goodreads.noLink': 'Sin enlace de Goodreads para esta coincidencia',
  'goodreads.urlLabel': 'URL de Goodreads',
  'goodreads.urlPh': 'https://www.goodreads.com/book/show/…',
  'goodreads.view': 'Ver en Goodreads',
  'goodreads.badUrl': 'Escribe una URL válida de Goodreads',
  'goodreads.offline': 'Estás sin conexión — inténtalo de nuevo cuando estés en línea',
  'goodreads.error': 'No se pudo buscar ahora',
  'menu.about': 'Acerca de',
  'about.tagline': 'para que recuerdes la página en la que estabas',
  'about.lead': 'Una sala de lectura tranquila y privada para todo lo que quieres leer. Coloca tus libros en la estantería, ábrelos en cualquier dispositivo y vuelve siempre a la página — y a la línea — exacta en la que lo dejaste.',
  'about.featuresTitle': 'Qué incluye',
  'about.f1.h': 'Retoma donde lo dejaste',
  'about.f1.b': 'Cada cambio de página se guarda en tu estantería. Cambia de dispositivo y continúa a mitad de la frase.',
  'about.f2.h': 'Más que PDFs',
  'about.f2.b': 'PDFs, EPUBs, cómics CBZ, texto plano y Markdown, e incluso audiolibros y vídeo — una biblioteca serena para todo ello, además de notas que escribes en el momento.',
  'about.f3.h': 'Solo tuya',
  'about.f3.b': 'Una única biblioteca privada tras tu inicio de sesión. Sin feeds, sin anuncios, sin nadie más hojeando tus estanterías.',
  'about.f4.h': 'Funciona sin conexión',
  'about.f4.b': 'Instálala como una app nativa. Tus libros actuales viajan contigo — en un avión, en el metro, donde sea.',
  'about.f5.h': 'Subraya y comparte',
  'about.f5.b': 'Marca un pasaje o recorta un bonito fragmento y compártelo con un toque.',
  'about.f6.h': 'Pensada para una lectura cómoda',
  'about.f6.b': 'Temas papel, sepia, oscuro y de alto contraste, tipografía ajustable y un modo de enfoque sin distracciones.',
  'about.done': 'Cerrar',
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
  if (!el('app').classList.contains('hidden')) {
    if (catalogTab === 'books') renderLibrary();
    else void setCatalogTab(catalogTab);
  }
}

function toast(msg: string, opts?: { error?: boolean; duration?: number }): void {
  const node = el('toast');
  node.textContent = msg;
  node.classList.toggle('error', !!opts?.error);
  node.classList.add('show');
  // Register the click-to-dismiss listener once.
  if (!(toast as any)._wired) {
    (toast as any)._wired = true;
    node.addEventListener('click', () => {
      window.clearTimeout((toast as any)._t);
      node.classList.remove('show');
    });
  }
  const duration = opts?.duration ?? (opts?.error ? 4200 : 2200);
  window.clearTimeout((toast as any)._t);
  (toast as any)._t = window.setTimeout(() => node.classList.remove('show'), duration);
}

// Summary toast shared by the share/launch drains: all-ok, all-failed, or partial.
function shelveSummaryToast(ok: number, failed: number): void {
  if (failed === 0) toast(t('toast.added'));
  else if (ok === 0) toast(t('share.drain.allFailed'), { error: true });
  else toast(t('share.drain.partial', { ok, failed }), { error: true });
}

// Selector for tabbable elements inside an overlay — used by trapFocus/confirmDialog.
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Focus management for modal overlays: saves the previously-focused element,
// moves focus into the overlay, and keeps Tab/Shift+Tab cycling within it.
// Returns a teardown fn that removes the listener and restores focus. Close
// sites call the teardown stored on the element as (overlay as any)._untrap.
function trapFocus(overlay: HTMLElement, firstFocus?: HTMLElement): () => void {
  const prev = document.activeElement as HTMLElement | null;
  const tabbables = () => Array.from(overlay.querySelectorAll<HTMLElement>(TABBABLE))
    .filter(e => e.offsetParent !== null || e === overlay);
  const target = firstFocus || tabbables()[0] || overlay;
  if (!firstFocus && target === overlay && overlay.tabIndex < 0) overlay.tabIndex = -1;
  target.focus();
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const items = tabbables();
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement;
    if (e.shiftKey && (active === first || !overlay.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };
  overlay.addEventListener('keydown', onKey);
  return () => {
    overlay.removeEventListener('keydown', onKey);
    if (prev && typeof prev.focus === 'function') prev.focus();
  };
}

// Styled replacement for window.confirm(): resolves true on Confirm, false on
// Cancel / Escape / backdrop click. Wires its listeners on open and tears them
// all down on resolve, so repeated calls never leak handlers.
function confirmDialog(message: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const overlay = el('confirm-dialog');
    const ok = el('confirm-ok');
    const cancel = el('confirm-cancel');
    el('confirm-msg').textContent = message;
    overlay.classList.remove('hidden');
    const untrap = trapFocus(overlay, ok);
    let done = false;
    const finish = (val: boolean) => {
      if (done) return;
      done = true;
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      untrap();
      overlay.classList.add('hidden');
      resolve(val);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (e: Event) => { if (e.target === overlay) finish(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}

// ---------- analytics ----------
function track(event: string, params?: Record<string, unknown>) {
  const g = (globalThis as { gtag?: (...args: unknown[]) => void }).gtag;
  if (typeof g === 'function') g('event', event, params);
}

// ---------- API client ----------
// The book metadata that lives server-side (everything except the PDF bytes).
type BookMeta = Omit<Book, 'data'>;

// Network failure and auth failure need different reactions (offline mode vs
// login screen), so api() throws typed errors instead of one generic Error.
class ApiAuthError extends Error {}
class ApiNetworkError extends Error {}
// Raised when an upload would exceed (or did exceed) the per-user storage quota.
class ApiQuotaError extends Error {}

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

// Set by wireAuth(); lets _onUnauthorized reset the auth card to the sign-in step.
let _showAuthStep: (step: string) => void = () => {};

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

async function cachePdf(id: string, buf: ArrayBuffer, mime: string = 'application/pdf'): Promise<void> {
  try {
    const est = await navigator.storage?.estimate?.().catch(() => null);
    if (est && est.quota && ((est.usage || 0) + buf.byteLength) > est.quota * 0.9) return;
    const cache = await caches.open(PDF_CACHE);
    await cache.put(pdfKey(id),
      new Response(buf.slice(0), { headers: { 'content-type': mime } }));
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
// Only the latest position per book matters, so a keyed map is lossless. Paged
// formats queue `{currentPage}`; scroll/media formats queue a generalized
// `{progress:{kind,value}}` — the body is shaped here so flush is a dumb replay.
type ProgressBody =
  | { currentPage: number; frac?: number; lastReadAt: number }
  | { progress: { kind: 'page' | 'cfi' | 'fraction' | 'seconds'; value: number | string }; lastReadAt: number };

function progressBodyFor(b: Book): ProgressBody {
  const lastReadAt = b.lastReadAt || Date.now();
  if (b.progress) return { progress: b.progress, lastReadAt };
  const body: { currentPage: number; frac?: number; lastReadAt: number } = { currentPage: b.currentPage, lastReadAt };
  if (typeof b.posFrac === 'number') body.frac = b.posFrac;
  return body;
}

function enqueueProgress(b: Book): void {
  let q: Record<string, ProgressBody>;
  try { q = JSON.parse(localStorage.getItem(LS.progressQueue) || '{}'); } catch { q = {}; }
  const body = progressBodyFor(b);
  if (!q[b.id] || b.lastReadAt >= q[b.id].lastReadAt) q[b.id] = body;
  localStorage.setItem(LS.progressQueue, JSON.stringify(q));
}

async function flushProgressQueue(): Promise<void> {
  let q: Record<string, ProgressBody>;
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
}

// List metadata for all books (no bytes). Network-first with a snapshot
// fallback so the shelf survives flaky connections and cold offline starts.
async function dbAll(): Promise<BookMeta[]> {
  const cache = await caches.open(DATA_CACHE);
  // GET /api/books returns { books, collections }. Also tolerate a legacy
  // snapshot that cached a bare books array. Side-effects the `collections` global.
  const take = (body: any): BookMeta[] => {
    if (Array.isArray(body)) { collections = []; return body as BookMeta[]; }
    collections = Array.isArray(body.collections) ? body.collections : [];
    return (body.books ?? []) as BookMeta[];
  };
  // Tell "reached the server but it failed" (a 5xx/parse error — abnormal, and
  // previously invisible because we silently served the cache) apart from genuine
  // offline. The former gets surfaced so a server outage isn't a silent stale view.
  let reachedServer = false;
  try {
    const res = await api('/books');
    reachedServer = true;
    if (!res.ok) throw new ApiNetworkError('list ' + res.status);
    const body = await res.json();
    await cache.put('/data-store/books', new Response(JSON.stringify(body))).catch(() => {});
    return take(body);
  } catch (e) {
    if (e instanceof ApiAuthError) throw e;     // real logout — no fallback
    const hit = await cache.match('/data-store/books');
    if (hit) {
      setOffline(true);
      // Genuine offline is expected (offline-first) and stays quiet; a server
      // failure means the shown library may be stale, so say so.
      if (reachedServer) toast(t('toast.staleServer'), { error: true });
      return take(await hit.json());
    }
    if (reachedServer) toast(t('toast.libLoadFailed'), { error: true });
    throw e;
  }
}

// Persist metadata. If the book carries fresh `data`, upload the bytes to S3.
async function dbPut(b: Book): Promise<void> {
  // Tell the backend the format-specific content-type we'd use; it echoes back
  // the authoritative `contentType` baked into the presigned PUT signature, and
  // the S3 PUT MUST send exactly that header or the signature check fails.
  const meta: BookMeta & { contentType?: string; size?: number } = stripData(b);
  meta.contentType = mimeFor(b.format ?? 'pdf', b.fileName);
  // Declared upload size — drives the server's quota admission check.
  meta.size = b.data ? b.data.byteLength : 0;
  const res = await api('/books', { method: 'POST', body: JSON.stringify(meta) });
  if (res.status === 413) throw new ApiQuotaError('quota exceeded');
  if (!res.ok) throw new Error('save failed');
  const { uploadUrl, contentType } = await res.json();
  if (b.data && b.data.byteLength && uploadUrl) {
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': contentType || mimeFor(b.format ?? 'pdf', b.fileName) },
      body: b.data,
    });
    if (!put.ok) throw new Error('upload failed');
    // Verify the true uploaded size against the quota now that the bytes landed.
    // A 413 here means the file overshot; the server has already undone the upload.
    const fin = await api('/books/' + encodeURIComponent(b.id) + '/finalize', { method: 'POST' });
    if (fin.status === 413) throw new ApiQuotaError('quota exceeded');
    if (!fin.ok) throw new Error('finalize failed');
  }
}

// Update just the reading position (used by persistPos). Offline updates
// queue locally and replay when the connection returns.
async function dbPutProgress(b: Book): Promise<void> {
  try {
    await api('/books/' + encodeURIComponent(b.id) + '/progress', {
      method: 'PUT',
      body: JSON.stringify(progressBodyFor(b)),
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

// ---------- collections (data) ----------
// Thin wrappers over the BFF routes. ApiNetworkError propagates to the UI flows,
// which toast offline; ApiAuthError propagates to the login screen via api().
async function apiCreateCollection(name: string): Promise<Collection> {
  const c: Collection = { id: collId(), name, createdAt: Date.now() };
  const res = await api('/collections', { method: 'POST', body: JSON.stringify(c) });
  if (!res.ok) throw new Error('create failed');
  return c;
}
async function apiRenameCollection(id: string, name: string): Promise<void> {
  const res = await api('/collections/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error('rename failed');
}
async function apiDeleteCollection(id: string): Promise<void> {
  const res = await api('/collections/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!res.ok) throw new Error('delete failed');
}
async function apiSetBookCollections(bookId: string, ids: string[]): Promise<void> {
  const res = await api('/books/' + encodeURIComponent(bookId) + '/collections', { method: 'PUT', body: JSON.stringify({ collections: ids }) });
  if (!res.ok) throw new Error('set failed');
}

// Resolve a fresh presigned GET URL for a book's bytes WITHOUT downloading them.
// Media (audio/video) streams straight from S3 via this URL (range requests),
// so it never touches dbGet / the PDF LRU. Presigned URLs expire (~15 min), so
// the media adapter fetches one at open time (and again on a playback error).
async function presignedUrlFor(id: string): Promise<string> {
  const res = await api('/books/' + encodeURIComponent(id) + '/url');
  if (!res.ok) throw new ApiNetworkError('url ' + res.status);
  const { url } = await res.json();
  if (!url) throw new ApiNetworkError('no url');
  return url as string;
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

// ---------- notes (data) ----------
// Notes carry their body server-side (like a tiny book), but the body lives in
// the metadata store flow, not S3. Cache-first in `folium-data` under
// /data-store/note/{id} so a note survives offline; writes go through PUT
// /api/notes/{id}, queuing on network failure (latest-body-wins per id).
const noteBodyKey = (id: string) => '/data-store/note/' + encodeURIComponent(id);

// Fetch a note's body: cache first, then GET /api/notes/{id}, filling the cache.
async function dbGetNote(id: string): Promise<string> {
  try {
    const hit = await (await caches.open(DATA_CACHE)).match(noteBodyKey(id));
    if (hit) return (await hit.json()).body as string;
  } catch { /* fall through to network */ }
  const res = await api('/notes/' + encodeURIComponent(id));
  if (!res.ok) return '';
  const body = (await res.json()).body as string || '';
  try { await (await caches.open(DATA_CACHE)).put(noteBodyKey(id), new Response(JSON.stringify({ body }))); } catch {}
  return body;
}

// Persist a note's body: write the cache, then PUT. Offline → enqueue the id.
async function dbPutNote(id: string, body: string): Promise<void> {
  try { await (await caches.open(DATA_CACHE)).put(noteBodyKey(id), new Response(JSON.stringify({ body }))); } catch {}
  try {
    await api('/notes/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ body }) });
  } catch (e) {
    if (e instanceof ApiNetworkError) { enqueueNote(id); return; }
    throw e;
  }
}

// Delete a note: server item + its cached body. Also drop any queued edit.
async function dbDelNote(id: string): Promise<void> {
  await api('/notes/' + encodeURIComponent(id), { method: 'DELETE' });
  try { await (await caches.open(DATA_CACHE)).delete(noteBodyKey(id)); } catch {}
  try {
    const q = JSON.parse(localStorage.getItem(LS.noteQueue) || '{}');
    if (q[id]) { delete q[id]; localStorage.setItem(LS.noteQueue, JSON.stringify(q)); }
  } catch {}
}

// Create a note's metadata item server-side. Body is saved separately (dbPutNote).
async function dbCreateNote(meta: BookMeta): Promise<void> {
  const res = await api('/notes', {
    method: 'POST',
    body: JSON.stringify({ id: meta.id, title: meta.title, noteFormat: meta.noteFormat }),
  });
  if (!res.ok) throw new Error('note create failed');
}

// Update a note's metadata (title / noteFormat) — reuses the notes PUT route.
async function dbPutNoteMeta(id: string, fields: { title?: string; noteFormat?: 'text' | 'markdown' }): Promise<void> {
  await api('/notes/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(fields) });
}

// Dirty-id set: which note bodies still need to reach the server. Latest body
// wins because the body itself is read from the cache at flush time.
function enqueueNote(id: string): void {
  let q: Record<string, 1>;
  try { q = JSON.parse(localStorage.getItem(LS.noteQueue) || '{}'); } catch { q = {}; }
  q[id] = 1;
  localStorage.setItem(LS.noteQueue, JSON.stringify(q));
}
async function flushNoteQueue(): Promise<void> {
  let q: Record<string, 1>;
  try { q = JSON.parse(localStorage.getItem(LS.noteQueue) || '{}'); } catch { return; }
  for (const id of Object.keys(q)) {
    try {
      const hit = await (await caches.open(DATA_CACHE)).match(noteBodyKey(id));
      const body = hit ? ((await hit.json()).body as string) : '';
      await api('/notes/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ body }) });
      delete q[id];
      localStorage.setItem(LS.noteQueue, JSON.stringify(q));
    } catch { break; }  // still offline (or logged out): retry on the next trigger
  }
}

// ---------- state ----------
const LS = {
  user: 'folium.user',
  view: 'folium.view',
  zoom: 'folium.zoom',
  lastZoom: 'folium.lastZoom',
  width: 'folium.readerWidth',
  pdfLru: 'folium.pdfLru',
  progressQueue: 'folium.progressQueue',
  clipQueue: 'folium.clipQueue',
  noteQueue: 'folium.noteQueue',
  lang: 'folium.lang',
  theme: 'folium.theme',
  activeCollection: 'folium.activeCollection',       // legacy single-id (migrated → activeCollections)
  activeCollections: 'folium.activeCollections',     // JSON array of active filter ids
  readerFontScale: 'folium.readerFontScale',
  readerLineHeight: 'folium.readerLineHeight',
};

const TYPE_LIMITS = { scaleMin: 0.8, scaleMax: 2.0, scaleStep: 0.1, lhMin: 1.4, lhMax: 2.3, lhStep: 0.15 };
const clampType = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
let readerFontScale = clampType(Number(localStorage.getItem(LS.readerFontScale)) || 1, TYPE_LIMITS.scaleMin, TYPE_LIMITS.scaleMax);
let readerLineHeight = clampType(Number(localStorage.getItem(LS.readerLineHeight)) || 1.75, TYPE_LIMITS.lhMin, TYPE_LIMITS.lhMax);

// Single apply-point: set CSS vars (instant reflow for scroll/markdown) and, if an
// EPUB is open, push the values into its iframe via epub.js themes (duck-typed).
function applyReaderType(): void {
  const root = document.documentElement.style;
  root.setProperty('--reader-font-scale', String(readerFontScale));
  root.setProperty('--reader-line-height', String(readerLineHeight));
  const a = reader.adapter as any;
  if (a && typeof a.applyType === 'function') a.applyType(readerFontScale, readerLineHeight);
}
function setReaderFontScale(v: number): void {
  readerFontScale = clampType(Number(v.toFixed(2)), TYPE_LIMITS.scaleMin, TYPE_LIMITS.scaleMax);
  localStorage.setItem(LS.readerFontScale, String(readerFontScale));
  applyReaderType();
}
function setReaderLineHeight(v: number): void {
  readerLineHeight = clampType(Number(v.toFixed(2)), TYPE_LIMITS.lhMin, TYPE_LIMITS.lhMax);
  localStorage.setItem(LS.readerLineHeight, String(readerLineHeight));
  applyReaderType();
}

// ---------- theme ----------
type ThemePref = 'system' | 'paper' | 'sepia' | 'dark' | 'hc';
let themePref: ThemePref = (localStorage.getItem(LS.theme) as ThemePref) || 'system';
const prefersDark = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
function resolveTheme(p: ThemePref): 'paper' | 'sepia' | 'dark' | 'hc' {
  if (p === 'system') return prefersDark() ? 'dark' : 'paper';
  return p;
}
const THEME_COLOR: Record<string, string> = { paper: '#5e261d', sepia: '#7c3327', dark: '#161109', hc: '#000000' };
const isDarkTheme = (resolved: string): boolean => resolved === 'dark' || resolved === 'hc';
function applyTheme(): void {
  const resolved = resolveTheme(themePref);
  document.documentElement.dataset.theme = resolved;
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', THEME_COLOR[resolved]);
  const a = reader.adapter as any;
  if (a && typeof a.applyTheme === 'function') a.applyTheme(resolved);
  // Reflect the current light/dark state on the masthead toggle.
  const btn = document.getElementById('btn-theme');
  if (btn) {
    const dark = isDarkTheme(resolved);
    btn.innerHTML = dark ? ICON.sun : ICON.moon;
    const label = dark ? t('theme.toLight') : t('theme.toDark');
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }
}
// Quick light/dark toggle (the Settings dropdown keeps system/sepia/high-contrast).
function wireThemeToggle(): void {
  el('btn-theme').addEventListener('click', () => {
    setTheme(isDarkTheme(resolveTheme(themePref)) ? 'paper' : 'dark');
  });
}
function setTheme(p: ThemePref): void {
  themePref = p;
  localStorage.setItem(LS.theme, p);
  applyTheme();
}
if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePref === 'system') applyTheme(); });

migrateLocalStorage();   // must run before viewMode/reader.width read their keys
let books: Book[] = [];
let viewMode: ViewMode = (localStorage.getItem(LS.view) as ViewMode) || 'shelf';
let catalogTab: CatalogTab = 'books';
let catalogEntities: { authors: CatalogEntity[]; publishers: CatalogEntity[] } = { authors: [], publishers: [] };
let collections: Collection[] = [];
// The "Uncollected" filter pseudo-id. Real collection ids always start with
// `coll`, so this can never collide and may live in the same Set as real ids.
const UNCOLLECTED = '__uncollected__';
// Multi-select collection filter. An empty set means "All". Persisted as a JSON
// array under LS.activeCollections; a legacy single-id value is migrated in once.
let activeCollections: Set<string> = loadActiveCollections();
function loadActiveCollections(): Set<string> {
  const raw = localStorage.getItem(LS.activeCollections);
  if (raw) {
    try { const a = JSON.parse(raw); if (Array.isArray(a)) return new Set(a.filter((x) => typeof x === 'string')); }
    catch { /* malformed — fall through to legacy/empty */ }
  }
  const legacy = localStorage.getItem(LS.activeCollection);
  localStorage.removeItem(LS.activeCollection);   // one-time migration
  return new Set(legacy ? [legacy] : []);
}
function persistActiveCollections(): void {
  if (activeCollections.size) localStorage.setItem(LS.activeCollections, JSON.stringify([...activeCollections]));
  else localStorage.removeItem(LS.activeCollections);
}
// Drop any active filter whose collection no longer exists (deleted out-of-band).
// The UNCOLLECTED sentinel is always valid. Called after every library re-pull.
function pruneActiveCollections(): void {
  const live = new Set(collections.map((c) => c.id));
  let changed = false;
  for (const id of [...activeCollections]) {
    if (id !== UNCOLLECTED && !live.has(id)) { activeCollections.delete(id); changed = true; }
  }
  if (changed) persistActiveCollections();
}

// ---------- helpers ----------
function uid(): string { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function collId(): string { return 'coll' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function prettifyName(fn: string): string {
  return fn.replace(/\.pdf$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}
// Map a file name + MIME to a DocFormat (extension wins; MIME is the tiebreaker).
// Ingest still only accepts PDFs this phase, so in practice this returns 'pdf'.
function detectFormat(name: string, mime?: string): DocFormat | null {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const byExt: Record<string, DocFormat> = {
    pdf: 'pdf',
    cbz: 'cbz',
    epub: 'epub',
    txt: 'txt',
    md: 'md', markdown: 'md',
  };
  if (byExt[ext]) return byExt[ext];
  // Audio/video extension knowledge lives in share-routing.mjs (single source of truth).
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  const m = (mime || '').toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m === 'application/epub+zip') return 'epub';
  if (m === 'application/vnd.comicbook+zip' || m === 'application/x-cbz') return 'cbz';
  if (m === 'text/markdown') return 'md';
  if (m.startsWith('text/')) return 'txt';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return null;
}

// The content-type to send to S3 for a book's bytes. Parameterizes the formerly
// hardcoded 'application/pdf' in dbPut/cachePdf. PDF books -> 'application/pdf'.
function mimeFor(format: DocFormat, fileName: string): string {
  switch (format) {
    case 'pdf': return 'application/pdf';
    case 'cbz': return 'application/vnd.comicbook+zip';
    case 'epub': return 'application/epub+zip';
    case 'txt': return 'text/plain; charset=utf-8';
    case 'md': return 'text/markdown; charset=utf-8';
    case 'note': return 'text/markdown; charset=utf-8';
    case 'audio':
    case 'video': {
      const ext = (fileName.split('.').pop() || '').toLowerCase();
      const map: Record<string, string> = {
        mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
        ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
        mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
      };
      return map[ext] || (format === 'audio' ? 'audio/mpeg' : 'video/mp4');
    }
  }
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
// Within-page scroll as a fraction of the page's scrollable height (zoom/screen
// independent). Mirrors ScrollTextAdapter's whole-doc math, applied per page.
function fracFromStage(stage: HTMLElement): number {
  const max = stage.scrollHeight - stage.clientHeight;
  return max > 0 ? Math.min(Math.max(stage.scrollTop / max, 0), 1) : 0;
}
function restoreFracToStage(stage: HTMLElement, frac: number): void {
  requestAnimationFrame(() => {
    const max = stage.scrollHeight - stage.clientHeight;
    stage.scrollTop = max > 0 ? Math.min(Math.max(frac, 0), 1) * max : 0;
  });
}
// Debounced within-page scroll capture for paged adapters. Returns a detach fn.
function attachPagedScroll(stage: HTMLElement): () => void {
  let timer = 0 as any;
  const handler = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      setReaderPos({ page: reader.pos.page, frac: fracFromStage(stage) });
      persistPos();
    }, 200);
  };
  stage.addEventListener('scroll', handler, { passive: true });
  return () => { stage.removeEventListener('scroll', handler); window.clearTimeout(timer); };
}
// Per-book zoom, per device. LRU-capped so the map can't grow without bound.
function getBookZoom(id: string): number | null {
  try {
    const m = JSON.parse(localStorage.getItem(LS.zoom) || '{}');
    return typeof m[id] === 'number' ? m[id] : null;
  } catch { return null; }
}
function setBookZoom(id: string, z: number): void {
  let m: Record<string, number>;
  try { m = JSON.parse(localStorage.getItem(LS.zoom) || '{}'); } catch { m = {}; }
  delete m[id]; m[id] = z;
  const keys = Object.keys(m);
  if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete m[k];
  localStorage.setItem(LS.zoom, JSON.stringify(m));
  localStorage.setItem(LS.lastZoom, String(z));
}
// Coerce to string before escaping: a book stored without a `title`/`author`
// attribute comes back undefined, and `undefined.replace` would throw — which
// previously killed the WHOLE grid render (the count + continue card survived,
// the shelf went blank) because the throw is swallowed up in boot/resync.
function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
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
// A 320px-tall JPEG cover from an image element (the CBZ first page), mirroring
// renderCover's dataURL approach but sourced from a decoded <img> not a PDF page.
function renderImageCover(img: HTMLImageElement): string | null {
  try {
    const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
    const target = 320;
    const scale = target / ih;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(iw * scale));
    c.height = Math.max(1, Math.floor(ih * scale));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  } catch { return null; }
}

// A small ~480px-wide JPEG of a PDF page, returned as RAW base64 (no data: prefix)
// for the AI enrichment endpoint. Modeled on renderCover but wider and at a lower
// quality, since the bytes ship over the wire. Returns null on render failure.
async function pageToJpegB64(page: any): Promise<string | null> {
  try {
    const target = 480;
    const v1 = page.getViewport({ scale: 1 });
    const scale = target / v1.width;
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
    const url = c.toDataURL('image/jpeg', 0.7);
    const comma = url.indexOf(',');
    return comma >= 0 ? url.slice(comma + 1) : null;
  } catch { return null; }
}

// Collect AI-enrichment inputs for a book WITHOUT re-uploading its bytes: the
// already-stored cover dataURL, and (for PDFs) text + a few page images pulled
// from the cached/presigned bytes via dbGet. Returns null for formats we can't
// enrich, or an inputs object the backend's POST /api/enrich consumes.
async function gatherEnrichInputs(b: Book): Promise<{ coverImageB64?: string; coverMime?: string; pageImagesB64?: string[]; pagesText?: string; formatHint: string } | null> {
  const fmt = b.format ?? 'pdf';
  if (!['pdf', 'epub', 'cbz', 'txt', 'md'].includes(fmt)) return null;
  const out: { coverImageB64?: string; coverMime?: string; pageImagesB64?: string[]; pagesText?: string; formatHint: string } = { formatHint: fmt };

  // Cover (any format): split a data: URL into its mime + raw base64.
  if (b.cover && b.cover.startsWith('data:')) {
    const semi = b.cover.indexOf(';');
    const comma = b.cover.indexOf(',');
    if (semi > 5 && comma > semi) {
      out.coverMime = b.cover.slice(5, semi);
      out.coverImageB64 = b.cover.slice(comma + 1);
    }
  }

  if (fmt === 'pdf') {
    let buf: ArrayBuffer | null = null;
    try { buf = await dbGet(b.id); } catch { buf = null; }   // null when offline — degrade to cover-only
    if (buf) {
      try {
        const doc = await loadDoc(buf);
        const texts: string[] = [];
        const images: string[] = [];
        const n = Math.min(doc.numPages, 5);
        for (let i = 1; i <= n; i++) {
          const page = await doc.getPage(i);
          try {
            const tc = await page.getTextContent();
            texts.push((tc.items || []).map((it: any) => it.str || '').join(' '));
          } catch { /* page text best-effort */ }
          if (i <= 3) {
            const img = await pageToJpegB64(page);
            if (img) images.push(img);
          }
        }
        const joined = texts.join('\n').trim();
        if (joined) out.pagesText = joined.slice(0, 12000);
        if (images.length) out.pageImagesB64 = images;
      } catch { /* parse best-effort — keep whatever cover we have */ }
    }
  } else if (fmt === 'txt' || fmt === 'md') {
    // Body is readily available on the in-memory book for these scroll formats.
    try {
      if (b.data && b.data.byteLength) {
        const text = new TextDecoder('utf-8').decode(b.data).trim();
        if (text) out.pagesText = text.slice(0, 12000);
      }
    } catch { /* ignore */ }
  }
  // epub/cbz: cover only (best-effort, already handled above).
  return out;
}

// PDF ingest: parse locally, lift Title/Author, render a cover, upload bytes.
async function ingestPdf(name: string, buf: ArrayBuffer): Promise<Book> {
  const doc = await loadDoc(buf);
  let title = prettifyName(name), author = '';
  try {
    const meta = await doc.getMetadata();
    const info = meta && meta.info ? meta.info : {};
    if (info.Title && String(info.Title).trim()) title = String(info.Title).trim();
    if (info.Author && String(info.Author).trim()) author = String(info.Author).trim();
  } catch { /* ignore */ }
  const cover = await renderCover(doc);
  return {
    id: uid(), title, author, fileName: name, data: buf,
    numPages: doc.numPages, currentPage: 1, cover,
    addedAt: Date.now(), lastReadAt: 0, format: 'pdf',
  };
}

// CBZ ingest: unzip enough to count pages and render a cover from the first image.
async function ingestCbz(name: string, buf: ArrayBuffer): Promise<Book> {
  const pages = await unzipCbz(buf);
  if (!pages.length) throw new Error('no images in archive');
  let cover: string | null = null;
  try {
    const first = await imageFromBytes(pages[0].data, imageMimeFor(pages[0].name));
    cover = renderImageCover(first);
  } catch { /* cover is best-effort */ }
  return {
    id: uid(), title: prettifyName(name.replace(/\.cbz$/i, '')), author: '', fileName: name, data: buf,
    numPages: pages.length, currentPage: 1, cover,
    addedAt: Date.now(), lastReadAt: 0, format: 'cbz',
  };
}

// EPUB ingest: open with epub.js to lift Title/Author from the OPF metadata and
// a best-effort cover from coverUrl(). numPages isn't meaningful for reflow → 1.
// Position starts at the book's beginning (progress unset); the bytes are
// uploaded with application/epub+zip and cached locally like a PDF.
async function ingestEpub(name: string, buf: ArrayBuffer): Promise<Book> {
  const ePub = await loadEpubLib();
  let title = prettifyName(name.replace(/\.epub$/i, '')), author = '';
  let cover: string | null = null;
  let epubBook: any = null;
  try {
    epubBook = ePub(buf.slice(0));   // copy: epub.js/JSZip may retain the buffer
    await epubBook.ready;
    const meta = await epubBook.loaded.metadata;
    if (meta?.title && String(meta.title).trim()) title = String(meta.title).trim();
    if (meta?.creator && String(meta.creator).trim()) author = String(meta.creator).trim();
    cover = await epubCover(epubBook);
  } catch { /* metadata/cover are best-effort — keep the prettified name */ }
  try { epubBook?.destroy?.(); } catch { /* ignore */ }
  return {
    id: uid(), title, author, fileName: name, data: buf,
    numPages: 1, currentPage: 1, cover,
    addedAt: Date.now(), lastReadAt: 0, format: 'epub',
  };
}

// Best-effort EPUB cover: epub.js coverUrl() yields a blob URL for the OPF cover
// image; decode it to an <img> and render a 320px-tall JPEG dataURL (same shape
// as renderImageCover). Returns null if the book has no cover or decoding fails.
async function epubCover(epubBook: any): Promise<string | null> {
  try {
    const url: string | null = await epubBook.coverUrl();
    if (!url) return null;
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('cover decode failed'));
      im.src = url;
    });
    const out = renderImageCover(img);
    try { URL.revokeObjectURL(url); } catch { /* not an object URL */ }
    return out;
  } catch { return null; }
}

// Text/Markdown ingest: a single-"page" scroll doc; for markdown, derive the
// title from the first H1 if present. No cover (a generated text cover renders).
function ingestText(name: string, buf: ArrayBuffer, format: 'txt' | 'md'): Book {
  const text = new TextDecoder('utf-8').decode(buf);
  let title = prettifyName(name.replace(/\.(txt|md|markdown)$/i, ''));
  if (format === 'md') {
    const h1 = text.split('\n').map(s => s.trim()).find(s => /^#\s+\S/.test(s));
    if (h1) title = h1.replace(/^#\s+/, '').slice(0, 120);
  }
  return {
    id: uid(), title, author: '', fileName: name, data: buf,
    numPages: 1, currentPage: 1, cover: null,
    addedAt: Date.now(), lastReadAt: 0, format,
  };
}

// Audio/Video ingest: no local parse, no cover (the generated text cover renders).
// The bytes are uploaded to S3 with the file's real MIME so range-request
// playback works; playback is online-only (the bytes are never cached locally).
function ingestMedia(name: string, format: 'audio' | 'video', mime?: string): Book {
  return {
    id: uid(), title: prettifyName(name.replace(/\.[^.]+$/, '')), author: '',
    fileName: name, data: new ArrayBuffer(0),
    numPages: 1, currentPage: 1, cover: null,
    addedAt: Date.now(), lastReadAt: 0, format,
    // `mime` is carried via the file's type; mimeFor() also recovers it from the
    // extension, so we don't need to stash it on the book.
  };
}

// Linked external media: a library item backed by an https stream URL, no bytes.
// `url`/`provider` ride through dbPut() → POST /api/books, which skips the S3 PUT.
function ingestLinkedMedia(url: string, title: string, author: string, format: 'audio' | 'video'): Book {
  let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* validated by caller */ }
  return {
    id: uid(), title: title.trim() || host || t('lib.unknown'), author: author.trim(),
    fileName: url, data: new ArrayBuffer(0),
    numPages: 1, currentPage: 1, cover: null,
    addedAt: Date.now(), lastReadAt: 0, format, url, provider: host || null,
  };
}

async function ingest(file: File | { name: string; buf: ArrayBuffer; type?: string }): Promise<Book | null> {
  const name = (file as any).name as string;
  try {
    const buf = (file as any).buf
      ? (file as any).buf as ArrayBuffer
      : await (file as File).arrayBuffer();
    const mime = (file as any).type as string | undefined;
    const format = detectFormat(name, mime) ?? 'pdf';
    let book: Book;
    switch (format) {
      case 'cbz': book = await ingestCbz(name, buf); break;
      case 'epub': book = await ingestEpub(name, buf); break;
      case 'txt': book = ingestText(name, buf, 'txt'); break;
      case 'md': book = ingestText(name, buf, 'md'); break;
      case 'audio': book = ingestMedia(name, 'audio', mime); break;
      case 'video': book = ingestMedia(name, 'video', mime); break;
      default: book = await ingestPdf(name, buf); break;   // pdf
    }
    // Upload the bytes (dbPut sends the format-appropriate content-type). For
    // media we attach the bytes only for this upload, then make the offline copy
    // for the byte-backed formats. Audio/video are online-only — they must NEVER
    // go through cachePdf / the PDF LRU (large files would blow the quota guard).
    // Shelve into every real collection currently filtered (the UNCOLLECTED
    // sentinel is not a real collection, so it's excluded).
    const into = [...activeCollections].filter(id => id !== UNCOLLECTED);
    if (into.length) book.collections = into;
    book.data = buf;
    await dbPut(book);
    track('add_book', { format: book.format });
    if (format !== 'audio' && format !== 'video') {
      cachePdf(book.id, buf, mimeFor(book.format ?? 'pdf', name));   // bytes in hand — make it offline-ready
    }
    book.data = new ArrayBuffer(0);   // drop the in-memory bytes; nothing else needs them
    return book;
  } catch (e) {
    console.error('ingest failed', e);
    if (e instanceof ApiQuotaError) toast(t('toast.quotaFull'), { error: true });
    else if (e instanceof ApiNetworkError) toast(t('toast.offlineAdd'));
    else toast(t('toast.cantRead', { name }));
    return null;
  }
}

async function addFiles(files: FileList | File[]): Promise<void> {
  // Accept any format ingest understands this phase; reject the rest with a hint.
  const SUPPORTED = new Set<DocFormat>(['pdf', 'cbz', 'epub', 'txt', 'md', 'audio', 'video']);
  const arr = Array.from(files).filter(f => {
    const fmt = detectFormat(f.name, f.type);
    return fmt != null && SUPPORTED.has(fmt);
  });
  if (!arr.length) { toast(t('toast.unsupported')); return; }
  toast(tn('toast.shelving', arr.length));
  for (const f of arr) {
    const b = await ingest(f);
    if (b) books.unshift(b);
  }
  renderLibrary();
  void checkCatalogMatches(books);
  toast(t('toast.added'));
}


// ============================================================
//  LIBRARY RENDERING
// ============================================================
const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3l14 9-14 9V3z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
};

// The card affordance that opens the book-details / AI-enrichment editor. Only
// real books carry it (notes have no bibliographic metadata).
function detailsBtn(b: Book): string {
  return `<button class="cardmenu" data-details="${b.id}" title="${t('details.menuItem')}" data-i18n-title="details.menuItem" aria-label="${t('details.menuItem')}" data-i18n-aria="details.menuItem">${ICON.info}</button>`;
}

// Share affordance: hands the book's file to the OS share sheet. `cls` lets covers
// (cardmenu) and list rows (del rmenu) reuse the same button.
function shareBtn(b: Book, cls = 'cardmenu'): string {
  return `<button class="${cls}" data-share="${b.id}" title="${t('share.action')}" data-i18n-title="share.action" aria-label="${t('share.action')}" data-i18n-aria="share.action">${ICON.share}</button>`;
}

// MD / TXT corner badge for note covers.
function noteBadge(b: Book): string {
  const kind = b.noteFormat === 'markdown' ? 'MD' : 'TXT';
  return `<span class="note-badge">${kind}</span>`;
}

// Badge a card with its collection(s): the first name, plus a "+N" overflow pill
// when the book is in more than one. '' when uncollected or only in collections
// we don't know about. Notes are never collected.
function collectionBadge(b: Book): string {
  const cs = bookCollections(b);
  if (!cs.length) return '';
  const allNames = cs.map(c => c.name).join(', ');
  // The overflow "+N" rides inside the single pill so it can't overlap on covers
  // (where the badge is absolutely positioned).
  const more = cs.length > 1 ? `<span class="coll-badge-more">+${cs.length - 1}</span>` : '';
  return `<span class="coll-badge" title="${escapeHtml(allNames)}">${escapeHtml(cs[0].name)}${more}</span>`;
}

function coverMarkup(b: Book): string {
  const offdot = offlineIds.has(b.id) ? `<span class="offdot" title="${t('lib.offlineDot')}"></span>` : '';
  if (isNote(b)) {
    const title = b.title || t('note.untitled');
    return `<div class="cover note-cover"><span class="spine"></span>${offdot}${noteBadge(b)}
      <div class="gen-cover">
        <div class="gt">${escapeHtml(title)}</div>
        <div class="grule"></div>
        <div class="ga">${t('note.kind')}</div>
      </div>` +
      shareBtn(b) +
      `<button class="cardmenu" data-menu="${b.id}" title="${t('card.menu')}">⋮</button>` +
      `<button class="del" data-del="${b.id}" title="${t('note.delete')}">${ICON.trash}</button></div>`;
  }
  if (b.cover) {
    return `<div class="cover" style="background-image:url('${b.cover}')"><span class="spine"></span>${offdot}` +
      collectionBadge(b) +
      (b.lastReadAt ? `<span class="pct">${pct(b)}%</span>` : '') +
      detailsBtn(b) +
      shareBtn(b) +
      `<button class="cardmenu" data-menu="${b.id}" title="${t('card.menu')}">⋮</button>` +
      `<button class="del" data-del="${b.id}" title="${t('lib.remove')}">${ICON.trash}</button></div>`;
  }
  const initials = (b.author || '').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return `<div class="cover"><span class="spine"></span>${offdot}
      <div class="gen-cover">
        <div class="gt">${escapeHtml(b.title)}</div>
        <div class="grule"></div>
        <div class="ga">${escapeHtml(b.author || initials) || t('lib.unknown')}</div>
      </div>` +
    collectionBadge(b) +
    (b.lastReadAt ? `<span class="pct">${pct(b)}%</span>` : '') +
    detailsBtn(b) +
    shareBtn(b) +
    `<button class="cardmenu" data-menu="${b.id}" title="${t('card.menu')}">⋮</button>` +
    `<button class="del" data-del="${b.id}" title="${t('lib.remove')}">${ICON.trash}</button></div>`;
}

function bookCard(b: Book): string {
  return `<div class="book" data-open="${b.id}" tabindex="0" role="button" aria-label="${escapeHtml(t('a11y.openBook', { title: b.title }))}">
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
    if (isNote(b)) {
      const title = b.title || t('note.untitled');
      return `<div class="row" data-open="${b.id}">
        <div class="rcv note-cover"><div class="gen-cover"><div class="gt">${escapeHtml(title)}</div></div>${noteBadge(b)}</div>
        <div class="rmeta"><div class="rt">${escapeHtml(title)}</div><div class="ra">${t('note.kind')}</div></div>
        <div class="rprog"></div>
        <div class="rwhen">${relTime(b.lastReadAt)}</div>
        <button class="rresume" data-open="${b.id}">${ICON.note}${t('note.edit')}</button>
        ${shareBtn(b, 'del rmenu')}
        <button class="del rmenu" data-menu="${b.id}" title="${t('card.menu')}">⋮</button>
        <button class="del rmenu" data-del="${b.id}" title="${t('note.delete')}">${ICON.trash}</button>
      </div>`;
    }
    const cv = b.cover
      ? `<div class="rcv" style="background-image:url('${b.cover}')"></div>`
      : `<div class="rcv"><div class="gen-cover"><div class="gt">${escapeHtml(b.title)}</div></div></div>`;
    return `<div class="row" data-open="${b.id}">
      ${cv}
      <div class="rmeta"><div class="rt">${escapeHtml(b.title)}${collectionBadge(b)}</div><div class="ra">${escapeHtml(b.author) || t('lib.unknownAuthor')}</div></div>
      <div class="rprog"><div class="progress"><i style="width:${pct(b)}%"></i></div><span class="progress-num">${b.lastReadAt ? pct(b) + '%' : t('lib.new')}</span></div>
      <div class="rwhen">${relTime(b.lastReadAt)}</div>
      <button class="rresume" data-open="${b.id}">${ICON.play}${b.lastReadAt ? t('lib.resume') : t('lib.read')}</button>
      <button class="del rmenu" data-details="${b.id}" title="${t('details.menuItem')}" data-i18n-title="details.menuItem" aria-label="${t('details.menuItem')}" data-i18n-aria="details.menuItem">${ICON.info}</button>
      ${shareBtn(b, 'del rmenu')}
      <button class="del rmenu" data-menu="${b.id}" title="${t('card.menu')}">⋮</button>
      <button class="del rmenu" data-del="${b.id}" title="${t('lib.remove')}">${ICON.trash}</button>
    </div>`;
  }).join('');
  return `<div class="list">${rows}</div>`;
}

function renderContinue(): void {
  const c = el('continue');
  const read = books.filter(b => !isNote(b) && b.lastReadAt > 0).sort((a, b) => b.lastReadAt - a.lastReadAt);
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
      <div class="empty-actions">
        <button class="mast-btn brass" id="empty-add">${t('lib.emptyAdd')}</button>
        <button class="mast-btn" id="empty-note">${t('note.emptyAdd')}</button>
      </div>
    </div>`;
    const ea = document.getElementById('empty-add');
    if (ea) ea.addEventListener('click', () => el('file-input').click());
    const en = document.getElementById('empty-note');
    if (en) en.addEventListener('click', () => createNote());
    return;
  }
  // newest-first base order, then narrow to the active collection filter (if any)
  let list = books.slice().sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt));
  if (activeCollections.size) list = list.filter(matchesCollectionFilter);
  let view: string;
  if (!list.length && activeCollections.size) view = `<div class="empty"><p>${t('coll.empty')}</p></div>`;
  else if (viewMode === 'shelf') view = renderShelf(list);
  else if (viewMode === 'grid') view = renderGrid(list);
  else view = renderList(list);
  body.innerHTML = renderChips() + view;
}

function renderCatalogEntities(kind: 'authors' | 'publishers', query = ''): void {
  const host = el('catalog-body');
  const q = query.trim().toLocaleLowerCase(locale);
  const entities = catalogEntities[kind].filter((entity) => !q
    || entity.name.toLocaleLowerCase(locale).includes(q)
    || entity.aliases?.some((alias) => alias.toLocaleLowerCase(locale).includes(q)));
  const empty = kind === 'authors' ? t('catalog.emptyAuthors') : t('catalog.emptyPublishers');
  const cards = entities.map((entity) => {
    const titles = entity.bookIds.map((id) => books.find((book) => book.id === id)?.title).filter(Boolean);
    const image = kind === 'authors' && entity.imageUrl
      ? `<img class="entity-avatar" src="${escapeHtml(entity.imageUrl)}" alt="" loading="lazy">` : '';
    const name = entity.sourceUrl
      ? `<a href="${escapeHtml(entity.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entity.name)}</a>`
      : escapeHtml(entity.name);
    const aliases = (entity.aliases ?? []).filter((alias) => alias !== entity.name);
    return `<article class="entity-card">${image}<div class="entity-card-copy"><h3>${name}${entity.local ? `<span class="entity-local">${t('catalog.local')}</span>` : ''}</h3>`
      + `<p>${tn('catalog.bookCount', entity.bookIds.length)}</p>`
      + (aliases.length ? `<p>${aliases.map((alias) => escapeHtml(alias)).join(' · ')}</p>` : '')
      + `<div class="entity-books">${titles.map((title) => escapeHtml(title)).join(' · ')}</div></div></article>`;
  }).join('');
  host.innerHTML = `<div class="catalog-search"><input id="catalog-search-input" type="search" value="${escapeHtml(query)}" placeholder="${escapeHtml(t('catalog.search'))}" aria-label="${escapeHtml(t('catalog.search'))}"></div>`
    + (cards ? `<div class="entity-grid">${cards}</div>` : `<div class="empty"><p>${empty}</p></div>`);
  el<HTMLInputElement>('catalog-search-input').addEventListener('input', (event) => {
    renderCatalogEntities(kind, (event.target as HTMLInputElement).value);
    const input = document.getElementById('catalog-search-input') as HTMLInputElement | null;
    input?.focus(); input?.setSelectionRange(input.value.length, input.value.length);
  });
}

async function loadCatalogEntities(): Promise<void> {
  try {
    const res = await api('/catalog');
    if (!res.ok) throw new Error('catalog failed');
    const data = await res.json();
    catalogEntities = {
      authors: Array.isArray(data.authors) ? data.authors : [],
      publishers: Array.isArray(data.publishers) ? data.publishers : [],
    };
  } catch (error) {
    if (!(error instanceof ApiNetworkError)) console.error('catalog load', error);
    // Offline fallback: catalog views can still be derived from the book snapshot.
    const authors = new Map<string, CatalogEntity>();
    const publishers = new Map<string, CatalogEntity>();
    for (const book of books.filter((item) => !isNote(item))) {
      const names = book.authors?.length ? book.authors : (book.author ? [book.author] : []);
      names.forEach((name, index) => {
        const id = book.catalogAuthorIds?.[index] || `local-author:${name.toLocaleLowerCase()}`;
        const entity = authors.get(id) || { id, name, bookIds: [], local: !book.catalogAuthorIds?.[index] };
        entity.bookIds.push(book.id); authors.set(id, entity);
      });
      if (book.publisher) {
        const id = book.catalogPublisherIds?.[0] || `local-publisher:${book.publisher.toLocaleLowerCase()}`;
        const entity = publishers.get(id) || { id, name: book.publisher, bookIds: [], local: !book.catalogPublisherIds?.[0] };
        entity.bookIds.push(book.id); publishers.set(id, entity);
      }
    }
    catalogEntities = { authors: [...authors.values()], publishers: [...publishers.values()] };
  }
}

async function setCatalogTab(tab: CatalogTab): Promise<void> {
  catalogTab = tab;
  el('catalog-tabs').querySelectorAll('button').forEach((button) => button.classList.toggle('active', (button as HTMLElement).dataset.catalogTab === tab));
  const booksView = tab === 'books';
  el('viewswitch').classList.toggle('hidden', !booksView);
  el('continue').classList.toggle('hidden', !booksView);
  el('lib-body').classList.toggle('hidden', !booksView);
  el('catalog-body').classList.toggle('hidden', booksView);
  el('lib-title').textContent = t(tab === 'books' ? 'lib.title' : `catalog.${tab}` as MsgKey);
  el('lib-count').textContent = booksView ? (books.length ? tn('lib.count', books.length) : '') : '';
  if (booksView) { renderLibrary(); return; }
  await loadCatalogEntities();
  renderCatalogEntities(tab);
}

function wireCatalogTabs(): void {
  el('catalog-tabs').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('[data-catalog-tab]') as HTMLElement | null;
    if (button) void setCatalogTab(button.dataset.catalogTab as CatalogTab);
  });
}

// OR semantics across the active filter: a book matches if "Uncollected" is
// selected and it has no collections, or any of its collections is selected.
function matchesCollectionFilter(b: Book): boolean {
  const cols = b.collections || [];
  if (activeCollections.has(UNCOLLECTED) && cols.length === 0) return true;
  return cols.some(c => activeCollections.has(c));
}

// Per-collection book counts (a book in N collections counts toward each), plus
// the tally of uncollected items. Reused by the chip bar and the manage modal.
function collectionCounts(): { map: Map<string, number>; uncollected: number } {
  const map = new Map<string, number>();
  let uncollected = 0;
  for (const b of books) {
    const cols = b.collections || [];
    if (!cols.length) { uncollected++; continue; }
    for (const c of cols) map.set(c, (map.get(c) || 0) + 1);
  }
  return { map, uncollected };
}

// The collection filter bar: All · <each collection (count)> · Uncollected · (+)
// · ⚙ manage. Chips multi-select (OR). Rendered into #lib-body each
// renderLibrary() so it reflects state.
function renderChips(): string {
  const { map, uncollected } = collectionCounts();
  const chip = (active: boolean, attr: string, label: string, n?: number) =>
    `<button class="chip${active ? ' active' : ''}" ${attr}>${escapeHtml(label)}` +
    (n != null ? `<span class="chip-count">${n}</span>` : '') + `</button>`;
  const all = chip(activeCollections.size === 0, 'data-chip-all', t('coll.all'));
  const colls = collections.map(c =>
    chip(activeCollections.has(c.id), `data-chip="${c.id}"`, c.name || t('coll.new'), map.get(c.id) || 0)).join('');
  const uncol = uncollected
    ? chip(activeCollections.has(UNCOLLECTED), `data-chip="${UNCOLLECTED}"`, t('coll.uncollected'), uncollected)
    : '';
  const add = `<button class="chip chip-add" data-chip-new title="${t('coll.new')}" aria-label="${t('coll.new')}">+</button>`;
  const manage = collections.length
    ? `<button class="chip-edit chip-manage" data-coll-manage title="${t('coll.manage')}" aria-label="${t('coll.manage')}">${ICON.gear}</button>`
    : '';
  return `<div class="chipbar">` + all + colls + uncol + add + manage + `</div>`;
}

async function createCollectionFlow(): Promise<void> {
  const name = (window.prompt(t('coll.namePrompt')) || '').trim();
  if (!name) return;
  try {
    const c = await apiCreateCollection(name);
    collections.push(c); activeCollections.add(c.id); persistActiveCollections();
    track('collection_create');
    renderLibrary();
  } catch (e) { if (e instanceof ApiNetworkError) toast(t('toast.offlineRetry')); else throw e; }
}
async function renameCollectionFlow(id: string): Promise<void> {
  const cur = collections.find(c => c.id === id); if (!cur) return;
  const name = (window.prompt(t('coll.renamePrompt'), cur.name) || '').trim();
  if (!name || name === cur.name) return;
  try { await apiRenameCollection(id, name); cur.name = name; renderLibrary(); refreshCollectionManager(); }
  catch (e) { if (e instanceof ApiNetworkError) toast(t('toast.offlineRetry')); else throw e; }
}
async function deleteCollectionFlow(id: string): Promise<void> {
  const cur = collections.find(c => c.id === id); if (!cur) return;
  if (!await confirmDialog(t('coll.confirmDelete', { name: cur.name }))) return;
  try { await apiDeleteCollection(id); }
  catch (e) { if (e instanceof ApiNetworkError) { toast(t('toast.offlineRetry')); return; } throw e; }
  collections = collections.filter(c => c.id !== id);
  for (const b of books) if (b.collections) b.collections = b.collections.filter(x => x !== id);
  if (activeCollections.delete(id)) persistActiveCollections();
  renderLibrary();
  refreshCollectionManager();
}

// A book may belong to MANY collections. These helpers resolve the membership to
// live Collection objects and build the shared multi-check list used by both
// assignment surfaces (the per-book picker and the book-details editor).
function bookCollections(b: Book): Collection[] {
  return (b.collections || [])
    .map(id => collections.find(c => c.id === id))
    .filter(Boolean) as Collection[];
}
function collectionChecklist(selectedIds: string[]): string {
  const sel = new Set(selectedIds);
  return collections.map(c =>
    `<label class="coll-check"><input type="checkbox" value="${c.id}"${sel.has(c.id) ? ' checked' : ''}>${escapeHtml(c.name || t('coll.new'))}</label>`
  ).join('');
}
// Read the checked collection ids out of a checklist container (#coll-picker-list
// or #bd-f-collection).
function checkedCollectionIds(containerId: string): string[] {
  return Array.from(el(containerId).querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(i => i.value);
}

// Per-book collection assignment: a multi-check modal (#coll-picker) that PUTs
// the book's full membership (any number of collections). Opened from a card's ⋮.
let pickerBookId: string | null = null;
function openCollectionPicker(bookId: string): void {
  const b = books.find(x => x.id === bookId); if (!b) return;
  pickerBookId = bookId;
  el('coll-picker-list').innerHTML = collections.length
    ? collectionChecklist(b.collections || [])
    : `<p class="coll-none">${t('coll.none')}</p>`;
  const picker = el('coll-picker');
  picker.classList.remove('hidden');
  (picker as any)._untrap = trapFocus(picker, el('coll-picker-save'));
}
function closeCollectionPicker(): void {
  const picker = el('coll-picker');
  (picker as any)._untrap?.();
  picker.classList.add('hidden');
  pickerBookId = null;
}
async function saveCollectionPicker(): Promise<void> {
  if (!pickerBookId) return;
  const ids = checkedCollectionIds('coll-picker-list');
  try { await apiSetBookCollections(pickerBookId, ids); }
  catch (e) { if (e instanceof ApiNetworkError) { toast(t('toast.offlineRetry')); return; } throw e; }
  const b = books.find(x => x.id === pickerBookId); if (b) b.collections = ids;
  closeCollectionPicker();
  renderLibrary();
}
function wireCollectionPicker(): void {
  el('coll-picker-save').addEventListener('click', saveCollectionPicker);
  el('coll-picker-cancel').addEventListener('click', closeCollectionPicker);
  el('coll-picker').addEventListener('click', (e) => { if (e.target === el('coll-picker')) closeCollectionPicker(); });
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && !el('coll-picker').classList.contains('hidden')) closeCollectionPicker();
  });
}

// Manage-collections modal (#coll-manage): the home for rename/delete now that
// the chip bar is multi-select. One row per collection (name + count + edit
// tools). Rename/delete reuse the existing flows, which call back into
// refreshCollectionManager() so the list stays current while the modal is open.
function renderCollectionManagerRows(): string {
  if (!collections.length) return `<p class="coll-none">${t('coll.none')}</p>`;
  const { map } = collectionCounts();
  return collections.map(c => `<div class="coll-row">
      <span class="coll-row-name">${escapeHtml(c.name || t('coll.new'))}</span>
      <span class="chip-count">${map.get(c.id) || 0}</span>
      <button class="chip-edit" data-chip-rename="${c.id}" title="${t('coll.rename')}" aria-label="${t('coll.rename')}">${ICON.note}</button>
      <button class="chip-edit" data-chip-del="${c.id}" title="${t('coll.delete')}" aria-label="${t('coll.delete')}">${ICON.trash}</button>
    </div>`).join('');
}
function refreshCollectionManager(): void {
  if (el('coll-manage').classList.contains('hidden')) return;
  el('coll-manage-list').innerHTML = renderCollectionManagerRows();
}
function openCollectionManager(): void {
  el('coll-manage-list').innerHTML = renderCollectionManagerRows();
  const m = el('coll-manage');
  m.classList.remove('hidden');
  (m as any)._untrap = trapFocus(m, el('coll-manage-done'));
}
function closeCollectionManager(): void {
  const m = el('coll-manage');
  (m as any)._untrap?.();
  m.classList.add('hidden');
}
function wireCollectionManager(): void {
  el('coll-manage-done').addEventListener('click', closeCollectionManager);
  el('coll-manage').addEventListener('click', (e) => { if (e.target === el('coll-manage')) closeCollectionManager(); });
  el('coll-manage-list').addEventListener('click', (e) => {
    const tgt = e.target as HTMLElement;
    const ren = tgt.closest('[data-chip-rename]') as HTMLElement | null;
    if (ren) { e.preventDefault(); renameCollectionFlow(ren.dataset.chipRename!); return; }
    const del = tgt.closest('[data-chip-del]') as HTMLElement | null;
    if (del) { e.preventDefault(); deleteCollectionFlow(del.dataset.chipDel!); return; }
  });
  // Escape is bound to the overlay (not document) so a confirm dialog opened over
  // this modal — a sibling overlay — doesn't also close the manager underneath it.
  el('coll-manage').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') { e.preventDefault(); closeCollectionManager(); }
  });
}

// Book-details editor (#book-details): the app's metadata editor, doubling as the
// AI-enrichment surface. Opened from a card's details affordance; PATCHes an
// allowlisted field set and merges the result back into the in-memory book.
let detailsBookId: string | null = null;
let detailsAuthors: { id?: string; name: string }[] = [];
let detailsPublisherId: string | undefined;
let detailsCover: string | null | undefined;
let entitySearchTimer: number | undefined;
const bdInput = (f: string) => el<HTMLInputElement | HTMLTextAreaElement>('bd-f-' + f);

function syncAuthorChips(): void {
  el('bd-author-chips').innerHTML = detailsAuthors.map((author, index) =>
    `<span class="entity-token">${escapeHtml(author.name)}<button type="button" data-remove-author="${index}" aria-label="Remove ${escapeHtml(author.name)}">×</button></span>`).join('');
  bdInput('authors').value = detailsAuthors.map((author) => author.name).join(', ');
}

function addDetailsAuthor(name: string, id?: string): void {
  const clean = name.trim();
  if (!clean || detailsAuthors.some((author) => author.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) return;
  detailsAuthors.push({ id, name: clean });
  syncAuthorChips();
  el<HTMLInputElement>('bd-author-input').value = '';
  el('bd-author-options').classList.add('hidden');
}

function renderEntityOptions(kind: 'author' | 'publisher', entities: { id?: string; name: string }[]): void {
  const list = el(kind === 'author' ? 'bd-author-options' : 'bd-publisher-options');
  list.innerHTML = entities.map((entity, index) => `<li role="option" tabindex="-1" data-entity-kind="${kind}" data-entity-idx="${index}">${escapeHtml(entity.name)}</li>`).join('');
  (list as any)._entities = entities;
  list.classList.toggle('hidden', entities.length === 0);
  const input = el(kind === 'author' ? 'bd-author-input' : 'bd-f-publisher');
  input.setAttribute('aria-expanded', entities.length ? 'true' : 'false');
}

async function searchEntityOptions(kind: 'author' | 'publisher', query: string): Promise<void> {
  const local = catalogEntities[kind === 'author' ? 'authors' : 'publishers']
    .filter((entity) => entity.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 6);
  if (query.length < 2) { renderEntityOptions(kind, local); return; }
  try {
    const res = await api('/catalog/search', { method: 'POST', body: JSON.stringify({ kind, query, limit: 8 }) });
    if (!res.ok) throw new Error('search failed');
    const data = await res.json();
    const remote = data[kind === 'author' ? 'authors' : 'publishers'] ?? [];
    const merged = new Map([...local, ...remote].map((entity: CatalogEntity) => [entity.id || entity.name, entity]));
    renderEntityOptions(kind, [...merged.values()].slice(0, 10));
  } catch { renderEntityOptions(kind, local); }
}

function syncMatchState(book: Book): void {
  const state = el('bd-match-state');
  const linked = !!book.catalogBookId;
  const base = linked ? t('catalog.linked')
    : (book.catalogMatchStatus === 'checking' ? t('catalog.matching')
      : (book.catalogMatchStatus === 'suggested' ? t('catalog.suggested') : t('catalog.unmatched')));
  const labelKeys: Record<string, MsgKey> = {
    title: 'details.fTitle', subtitle: 'details.fSubtitle', authors: 'details.fAuthors',
    publisher: 'details.fPublisher', year: 'details.fYear', isbn: 'details.fIsbn',
    language: 'details.fLanguage', description: 'details.fDescription',
  };
  const overrideLabels = Object.keys(book.metadataOverrides ?? {}).map((field) => labelKeys[field] ? t(labelKeys[field]) : field);
  state.textContent = base + (overrideLabels.length ? ` · ${t('catalog.localOverrides', { fields: overrideLabels.join(', ') })}` : '');
  state.classList.toggle('linked', linked);
  el('bd-unlink').classList.toggle('hidden', !linked);
  el<HTMLButtonElement>('bd-cover-catalog').disabled = !book.canonicalMetadata?.coverUrl;
}

function syncCoverPreview(): void {
  const preview = el('bd-cover-preview');
  const cover = detailsCover;
  preview.style.backgroundImage = cover ? `url('${cover}')` : 'none';
}

function openBookDetails(id: string): void {
  const b = books.find(x => x.id === id); if (!b) return;
  void loadCatalogEntities();
  detailsBookId = id;
  bdInput('title').value = b.title || '';
  bdInput('subtitle').value = b.subtitle || '';
  const names = b.authors && b.authors.length ? b.authors : (b.author ? [b.author] : []);
  detailsAuthors = names.map((name, index) => ({ id: b.catalogAuthorIds?.[index], name }));
  syncAuthorChips();
  el<HTMLInputElement>('bd-author-input').value = '';
  for (const optionId of ['bd-author-options', 'bd-publisher-options']) el(optionId).classList.add('hidden');
  bdInput('series').value = b.series || '';
  bdInput('edition').value = b.edition || '';
  bdInput('publisher').value = b.publisher || '';
  detailsPublisherId = b.catalogPublisherIds?.[0];
  bdInput('year').value = b.year != null ? String(b.year) : '';
  bdInput('isbn').value = b.isbn || '';
  bdInput('language').value = b.language || '';
  bdInput('description').value = b.description || '';
  bdInput('goodreads').value = b.goodreadsUrl || '';
  detailsCover = b.cover;
  syncCoverPreview();
  el('bd-cover-status').textContent = '';
  syncMatchState(b);
  el('bd-f-collection').innerHTML = collections.length
    ? collectionChecklist(b.collections || [])
    : `<p class="coll-none">${t('coll.none')}</p>`;
  bdCandidates = Array.isArray(b.catalogSuggestions) ? b.catalogSuggestions : [];
  if (bdCandidates.length) renderCandidates(bdCandidates);
  else el('bd-gr-results').innerHTML = '';
  el('bd-gr-status').textContent = bdCandidates.length ? t('catalog.suggested') : '';
  bdUpdateGoodreadsView();
  const modal = el('book-details');
  modal.classList.remove('hidden');
  (modal as any)._untrap = trapFocus(modal, bdInput('title'));
}
function closeBookDetails(): void {
  const modal = el('book-details');
  (modal as any)._untrap?.();
  modal.classList.add('hidden');
  detailsBookId = null;
}
async function fillBookDetailsAI(): Promise<void> {
  if (!detailsBookId) return;
  const b = books.find(x => x.id === detailsBookId); if (!b) return;
  const btn = el<HTMLButtonElement>('bd-ai');
  btn.disabled = true;
  toast(t('details.aiLoading'));
  try {
    const inputs = await gatherEnrichInputs(b);
    if (!inputs) { toast(t('details.aiError')); return; }
    const res = await api('/enrich', { method: 'POST', body: JSON.stringify(inputs) });
    const { fields } = await res.json();
    const set = (f: string, val: string) => { const inp = bdInput(f); if (!inp.value.trim() && val) inp.value = val; };
    if (fields) {
      set('title', fields.title || '');
      set('subtitle', fields.subtitle || '');
      if (!detailsAuthors.length && Array.isArray(fields.authors)) {
        detailsAuthors = fields.authors.map((name: string) => ({ name }));
        syncAuthorChips();
      }
      set('series', fields.series || '');
      set('edition', fields.edition || '');
      set('publisher', fields.publisher || '');
      set('year', fields.year != null ? String(fields.year) : '');
      set('isbn', fields.isbn || '');
      set('language', fields.language || '');
      set('description', fields.description || '');
    }
    toast(t('details.aiFilled'));
  } catch (e) {
    if (e instanceof ApiNetworkError) toast(t('details.aiOffline'));
    else toast(t('details.aiError'));
  } finally {
    btn.disabled = false;
  }
}
// Open Library lookup → Goodreads link. A candidate carries normalized metadata
// plus a derived Goodreads link (id link when known, else a Goodreads search URL).
interface Candidate {
  catalogBookId?: string; editionId?: string; workId?: string; sourceUrl?: string | null;
  title?: string; subtitle?: string; authors: string[];
  authorEntities?: { id: string; name: string }[];
  publisher?: string; publishers?: { id: string; name: string }[];
  year?: number; isbn?: string; language?: string;
  coverUrl: string | null; goodreadsUrl: string | null; searchUrl: string | null;
}
let bdCandidates: Candidate[] = [];

// Accept only an https goodreads.com URL — matches the backend's PATCH guard so
// the user gets immediate feedback instead of a 400 round-trip.
function isGoodreadsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && (u.host === 'goodreads.com' || u.host === 'www.goodreads.com');
  } catch { return false; }
}

// Toggle the "View on Goodreads" anchor from the current URL field value.
function bdUpdateGoodreadsView(): void {
  const url = bdInput('goodreads').value.trim();
  const a = el<HTMLAnchorElement>('bd-gr-view');
  if (url) { a.href = url; a.classList.remove('hidden'); }
  else { a.removeAttribute('href'); a.classList.add('hidden'); }
}

// Render Open Library candidates into the picker. All text is external/untrusted
// → escaped. Rows whose match carries no Goodreads id get a subtle hint.
function renderCandidates(cands: Candidate[]): void {
  const list = el('bd-gr-results');
  list.innerHTML = cands.map((c, i) => {
    const title = escapeHtml(c.title || t('lib.unknown'));
    const meta = [c.authors.join(', '), c.year != null ? String(c.year) : ''].filter(Boolean).join(' · ');
    const thumb = c.coverUrl
      ? `<img class="bd-gr-thumb" src="${escapeHtml(c.coverUrl)}" alt="" loading="lazy">`
      : `<span class="bd-gr-thumb bd-gr-thumb-none" aria-hidden="true"></span>`;
    const hint = c.goodreadsUrl ? '' : `<span class="bd-gr-nolink">${escapeHtml(t('goodreads.noLink'))}</span>`;
    return `<li class="bd-gr-cand" role="option" data-cand-idx="${i}" tabindex="0">`
      + thumb
      + `<div class="bd-gr-meta"><div class="bd-gr-t">${title}</div>`
      + `<div class="bd-gr-a">${escapeHtml(meta)}</div>${hint}</div>`
      + `<button class="mast-btn bd-gr-pick" data-cand-idx="${i}" data-i18n="goodreads.pick">${escapeHtml(t('goodreads.pick'))}</button>`
      + `</li>`;
  }).join('');
}

// Fill empty metadata inputs from a chosen candidate (non-destructive, mirroring
// the AI fill), and set the Goodreads link (id link, else search fallback).
async function applyCandidate(c: Candidate): Promise<void> {
  if (!detailsBookId || !c.catalogBookId) return;
  const response = await api('/books/' + encodeURIComponent(detailsBookId) + '/catalog-match', {
    method: 'POST', body: JSON.stringify({ candidate: c }),
  });
  if (!response.ok) throw new Error('catalog match failed');
  const result = await response.json();
  const book = books.find((item) => item.id === detailsBookId);
  if (book && result.book) Object.assign(book, result.book);
  const set = (f: string, val: string) => { const inp = bdInput(f); if (!inp.value.trim() && val) inp.value = val; };
  set('title', c.title || '');
  if (!detailsAuthors.length) {
    detailsAuthors = (c.authorEntities?.length ? c.authorEntities : c.authors.map((name) => ({ name }))).slice();
    syncAuthorChips();
  }
  set('publisher', c.publisher || c.publishers?.[0]?.name || '');
  set('year', c.year != null ? String(c.year) : '');
  set('isbn', c.isbn || '');
  set('language', c.language || '');
  const grInput = bdInput('goodreads');
  const link = c.goodreadsUrl || c.searchUrl || '';
  if (!grInput.value.trim() && link) grInput.value = link;
  bdUpdateGoodreadsView();
  if (book) syncMatchState(book);
  toast(t('catalog.matched'));
}

// Search Open Library using the current modal inputs (title/authors/isbn) so an
// edited-but-unsaved title is used. Analogue of fillBookDetailsAI.
async function searchOnlineMeta(): Promise<void> {
  if (!detailsBookId) return;
  const btn = el<HTMLButtonElement>('bd-gr-search');
  const status = el('bd-gr-status');
  const title = bdInput('title').value.trim();
  const author = detailsAuthors[0]?.name || '';
  const isbn = bdInput('isbn').value.trim();
  if (!title && !isbn) { status.textContent = t('goodreads.needTitle'); return; }
  btn.disabled = true;
  status.textContent = t('goodreads.searching');
  try {
    const res = await api('/catalog/search', { method: 'POST', body: JSON.stringify({ kind: 'book', title, author, isbn }) });
    const { books: candidates } = await res.json();
    bdCandidates = Array.isArray(candidates) ? candidates : [];
    if (!bdCandidates.length) { status.textContent = t('goodreads.noMatches'); el('bd-gr-results').innerHTML = ''; }
    else { status.textContent = ''; renderCandidates(bdCandidates); }
  } catch (e) {
    if (e instanceof ApiNetworkError) status.textContent = t('goodreads.offline');
    else status.textContent = t('goodreads.error');
  } finally {
    btn.disabled = false;
  }
}

async function saveBookDetails(): Promise<void> {
  if (!detailsBookId) return;
  const pendingAuthor = el<HTMLInputElement>('bd-author-input').value.trim();
  if (pendingAuthor) addDetailsAuthor(pendingAuthor);
  const id = detailsBookId;
  const authors = detailsAuthors.map((author) => author.name);
  const yearRaw = bdInput('year').value.trim();
  const year = yearRaw ? parseInt(yearRaw, 10) : NaN;
  const cids = checkedCollectionIds('bd-f-collection');
  const fields: Omit<Partial<Book>, 'year'> & { year?: number | null } = {
    title: bdInput('title').value.trim() || t('lib.unknown'),
    subtitle: bdInput('subtitle').value.trim(),
    authors,
    author: authors.join(', '),
    series: bdInput('series').value.trim(),
    edition: bdInput('edition').value.trim(),
    publisher: bdInput('publisher').value.trim(),
    isbn: bdInput('isbn').value.trim(),
    language: bdInput('language').value.trim(),
    description: bdInput('description').value.trim(),
    collections: cids,
    goodreadsUrl: bdInput('goodreads').value.trim(),
    cover: detailsCover,
  };
  fields.year = yearRaw ? (!Number.isNaN(year) ? year : null) : null;
  if (fields.goodreadsUrl && !isGoodreadsUrl(fields.goodreadsUrl)) {
    toast(t('goodreads.badUrl'));
    return;
  }
  try {
    const res = await api('/books/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(fields) });
    if (!res.ok) throw new Error('patch failed');
    const result = await res.json();
    const saved = books.find(x => x.id === id);
    if (saved && result.book) Object.assign(saved, result.book);
    if (saved && !saved.catalogBookId) {
      const authorIds = detailsAuthors.map((author) => author.id
        || `local-author:${encodeURIComponent(author.name.toLocaleLowerCase())}`);
      const publisherIds = fields.publisher
        ? [detailsPublisherId || `local-publisher:${encodeURIComponent(fields.publisher.toLocaleLowerCase())}`]
        : [];
      const entityRes = await api('/books/' + encodeURIComponent(id) + '/catalog-entities', {
        method: 'PUT', body: JSON.stringify({ authorIds, publisherIds }),
      });
      if (entityRes.ok) {
        const entityResult = await entityRes.json();
        if (entityResult.book) Object.assign(saved, entityResult.book);
      }
    }
  } catch (e) {
    if (e instanceof ApiNetworkError) { toast(t('toast.offlineRetry')); return; }
    throw e;
  }
  const b = books.find(x => x.id === id);
  if (b) Object.assign(b, fields);
  closeBookDetails();
  renderLibrary();
  toast(t('details.saved'));
}

async function imageBlobToCover(blob: Blob): Promise<string> {
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const node = new Image(); node.onload = () => resolve(node); node.onerror = reject; node.src = url;
    });
    const maxHeight = 480;
    const scale = Math.min(1, maxHeight / Math.max(1, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    let quality = .82;
    let result = canvas.toDataURL('image/jpeg', quality);
    while (result.length > 290_000 && quality > .5) {
      quality -= .08; result = canvas.toDataURL('image/jpeg', quality);
    }
    if (result.length > 300_000) throw new Error('cover too large');
    return result;
  } finally { URL.revokeObjectURL(url); }
}

async function regenerateOriginalCover(book: Book): Promise<string | null> {
  const format = book.format ?? 'pdf';
  if (!['pdf', 'cbz', 'epub'].includes(format)) return null;
  const bytes = await dbGet(book.id);
  if (!bytes) throw new Error('document unavailable');
  if (format === 'pdf') return renderCover(await loadDoc(bytes));
  if (format === 'cbz') {
    const pages = await unzipCbz(bytes);
    if (!pages.length) return null;
    return renderImageCover(await imageFromBytes(pages[0].data, imageMimeFor(pages[0].name)));
  }
  const ePub = await loadEpubLib();
  const epubBook = ePub(bytes.slice(0));
  try { await epubBook.ready; return await epubCover(epubBook); }
  finally { try { epubBook.destroy?.(); } catch {} }
}

async function unlinkCatalog(): Promise<void> {
  if (!detailsBookId) return;
  const response = await api('/books/' + encodeURIComponent(detailsBookId) + '/catalog-match', { method: 'DELETE' });
  if (!response.ok) throw new Error('unlink failed');
  const book = books.find((item) => item.id === detailsBookId);
  if (book) {
    delete book.catalogBookId; delete book.catalogAuthorIds; delete book.catalogPublisherIds;
    delete book.canonicalMetadata; delete book.metadataOverrides; book.catalogMatchStatus = 'unmatched';
    syncMatchState(book);
  }
  toast(t('catalog.unlinked'));
}

function wireBookDetails(): void {
  el('bd-save').addEventListener('click', saveBookDetails);
  el('bd-cancel').addEventListener('click', closeBookDetails);
  el('bd-ai').addEventListener('click', fillBookDetailsAI);
  el('bd-gr-search').addEventListener('click', searchOnlineMeta);
  el('bd-f-goodreads').addEventListener('input', bdUpdateGoodreadsView);
  const pickFromEvent = (e: Event) => {
    const hit = (e.target as HTMLElement).closest('[data-cand-idx]') as HTMLElement | null;
    if (!hit) return;
    e.preventDefault();
    const c = bdCandidates[Number(hit.dataset.candIdx)];
    if (c) void applyCandidate(c).catch(() => { el('bd-gr-status').textContent = t('goodreads.error'); });
  };
  el('bd-gr-results').addEventListener('click', pickFromEvent);
  el('bd-gr-results').addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Enter' || k === ' ') pickFromEvent(e);
  });
  el('bd-author-chips').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('[data-remove-author]') as HTMLElement | null;
    if (!button) return;
    detailsAuthors.splice(Number(button.dataset.removeAuthor), 1); syncAuthorChips();
  });
  const authorInput = el<HTMLInputElement>('bd-author-input');
  authorInput.addEventListener('input', () => {
    window.clearTimeout(entitySearchTimer);
    entitySearchTimer = window.setTimeout(() => void searchEntityOptions('author', authorInput.value.trim()), 280);
  });
  authorInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && !el('bd-author-options').classList.contains('hidden')) {
      event.preventDefault(); el('bd-author-options').querySelector<HTMLElement>('[role="option"]')?.focus();
    } else if ((event.key === 'Enter' || event.key === ',') && authorInput.value.trim()) {
      event.preventDefault(); addDetailsAuthor(authorInput.value.replace(/,$/, ''));
    } else if (event.key === 'Backspace' && !authorInput.value && detailsAuthors.length) {
      detailsAuthors.pop(); syncAuthorChips();
    }
  });
  const publisherInput = bdInput('publisher') as HTMLInputElement;
  publisherInput.addEventListener('input', () => {
    detailsPublisherId = undefined;
    window.clearTimeout(entitySearchTimer);
    entitySearchTimer = window.setTimeout(() => void searchEntityOptions('publisher', publisherInput.value.trim()), 280);
  });
  publisherInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && !el('bd-publisher-options').classList.contains('hidden')) {
      event.preventDefault(); el('bd-publisher-options').querySelector<HTMLElement>('[role="option"]')?.focus();
    }
  });
  for (const id of ['bd-author-options', 'bd-publisher-options']) {
    el(id).addEventListener('click', (event) => {
      const option = (event.target as HTMLElement).closest('[data-entity-idx]') as HTMLElement | null;
      if (!option) return;
      const list = el(id) as any;
      const entity = list._entities?.[Number(option.dataset.entityIdx)];
      if (!entity) return;
      if (option.dataset.entityKind === 'author') addDetailsAuthor(entity.name, entity.local ? undefined : entity.id);
      else { publisherInput.value = entity.name; detailsPublisherId = entity.local ? undefined : entity.id; list.classList.add('hidden'); }
    });
    el(id).addEventListener('keydown', (event) => {
      const current = (event.target as HTMLElement).closest('[role="option"]') as HTMLElement | null;
      if (!current) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); current.click(); }
      if (event.key === 'Escape') { el(id).classList.add('hidden'); (id === 'bd-author-options' ? authorInput : publisherInput).focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const options = Array.from(el(id).querySelectorAll<HTMLElement>('[role="option"]'));
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        options[(options.indexOf(current) + delta + options.length) % options.length]?.focus();
      }
    });
  }
  el<HTMLInputElement>('bd-cover-upload').addEventListener('change', async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      el('bd-cover-status').textContent = t('cover.invalid'); return;
    }
    try { detailsCover = await imageBlobToCover(file); syncCoverPreview(); }
    catch { el('bd-cover-status').textContent = t('cover.invalid'); }
  });
  el('bd-cover-catalog').addEventListener('click', async () => {
    const book = books.find((item) => item.id === detailsBookId);
    const url = book?.canonicalMetadata?.coverUrl;
    if (typeof url !== 'string') { el('bd-cover-status').textContent = t('cover.noCatalog'); return; }
    try {
      const response = await fetch(url); if (!response.ok) throw new Error('cover fetch');
      detailsCover = await imageBlobToCover(await response.blob()); syncCoverPreview();
    } catch { el('bd-cover-status').textContent = t('goodreads.error'); }
  });
  el('bd-cover-reset').addEventListener('click', async () => {
    const book = books.find((item) => item.id === detailsBookId); if (!book) return;
    try { detailsCover = await regenerateOriginalCover(book); syncCoverPreview(); el('bd-cover-status').textContent = t('cover.resetDone'); }
    catch { el('bd-cover-status').textContent = t('toast.cantLoad'); }
  });
  el('bd-unlink').addEventListener('click', () => void unlinkCatalog().catch(() => toast(t('goodreads.error'))));
  el('book-details').addEventListener('click', (e) => { if (e.target === el('book-details')) closeBookDetails(); });
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && !el('book-details').classList.contains('hidden')) closeBookDetails();
  });
}

// delegated clicks on library
function wireLibrary(): void {
  el('library').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const chipNew = t.closest('[data-chip-new]');
    if (chipNew) { e.preventDefault(); createCollectionFlow(); return; }
    const chipManage = t.closest('[data-coll-manage]');
    if (chipManage) { e.preventDefault(); openCollectionManager(); return; }
    const chipAll = t.closest('[data-chip-all]');
    if (chipAll) { e.preventDefault(); activeCollections.clear(); persistActiveCollections(); renderLibrary(); return; }
    const chipBtn = t.closest('[data-chip]') as HTMLElement | null;
    if (chipBtn) {
      e.preventDefault();
      const id = chipBtn.dataset.chip!;
      if (activeCollections.has(id)) activeCollections.delete(id); else activeCollections.add(id);
      persistActiveCollections();
      renderLibrary();
      return;
    }
    const det = t.closest('[data-details]') as HTMLElement | null;
    if (det) { e.preventDefault(); e.stopPropagation(); openBookDetails(det.dataset.details!); return; }
    const share = t.closest('[data-share]') as HTMLElement | null;
    if (share) {
      e.preventDefault(); e.stopPropagation();
      const b = books.find(x => x.id === share.dataset.share!);
      if (b) shareBook(b);
      return;
    }
    const menu = t.closest('[data-menu]') as HTMLElement | null;
    if (menu) { e.preventDefault(); e.stopPropagation(); openCollectionPicker(menu.dataset.menu!); return; }
    const del = t.closest('[data-del]') as HTMLElement | null;
    if (del) { e.preventDefault(); e.stopPropagation(); confirmDelete(del.dataset.del!); return; }
    const open = t.closest('[data-open]') as HTMLElement | null;
    if (open) {
      e.preventDefault();
      const id = open.dataset.open!;
      const it = books.find(x => x.id === id);
      if (it && isNote(it)) openNote(id); else openBook(id);
    }
  });
  // Keyboard activation for the focusable .book cards (role=button). List-view
  // rows already have a focusable .rresume button, so they are not tab stops.
  el('library').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement;
    if (!target.matches('.book[data-open]')) return;
    e.preventDefault();   // Space would otherwise scroll the page
    const id = target.dataset.open!;
    const it = books.find(x => x.id === id);
    if (it && isNote(it)) openNote(id); else openBook(id);
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
  if (!await confirmDialog(t('lib.confirmRemove', { title: b.title }))) return;
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

// ---------- document adapters ----------

// Shared canvas page painter for the paged/canvas formats (PDF + CBZ). Holds the
// viewport/dpr/sizing + `.rpage` DOM-build math that used to live inline in
// PdfAdapter.render(): comfort cap 860, sidePad, dpr cap 2, the clip overlay
// call. `draw(c2d, cssScale, dpr)` paints one page onto the canvas at device
// pixels (PDF -> page.render; CBZ -> drawImage). `intrinsic{W,H}` are the page's
// natural pixel dimensions, used for the aspect ratio and the CSS->intrinsic
// scale. Returns the painted canvas + its CSS box; the caller may add a text
// layer afterwards. Returns null if superseded mid-flight (token changed).
async function paintCanvasPage(
  draw: (c2d: CanvasRenderingContext2D, cssScale: number, dpr: number) => Promise<void> | void,
  intrinsicW: number,
  intrinsicH: number,
  ctx: RenderCtx,
  keepScroll: boolean,
): Promise<{ canvas: HTMLCanvasElement; wrap: HTMLElement; cssW: number; cssH: number; cssScale: number } | null> {
  const token = ctx.token;
  const avail = stageWidth();
  const sidePad = avail < 700 ? 36 : 64; // room for column padding + scrollbar
  const cap = ctx.width === 'comfort' ? 860 : Infinity;
  const targetCSS = Math.floor(Math.min(avail - sidePad, cap) * ctx.zoom);
  const cssScale = targetCSS / intrinsicW;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = targetCSS;
  const cssH = Math.round(targetCSS * (intrinsicH / intrinsicW));

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(intrinsicW * cssScale * dpr);
  canvas.height = Math.floor(intrinsicH * cssScale * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  await draw(canvas.getContext('2d')!, cssScale, dpr);
  if (token !== reader.renderToken) return null; // superseded

  const col = ctx.col;
  col.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'rpage';
  const fmt = reader.adapter?.format;
  if (fmt) wrap.setAttribute('data-fmt', fmt);
  wrap.appendChild(canvas);
  reader.cssW = cssW; reader.cssH = cssH; reader.cssScale = cssScale;
  ctx.drawClipOverlay(wrap, cssW, cssH);
  col.appendChild(wrap);
  clearSelToolbar();
  if (!keepScroll) ctx.stage.scrollTop = 0;
  return { canvas, wrap, cssW, cssH, cssScale };
}

// The DocAdapter seam. PdfAdapter is the only implementation today; its render()
// holds the exact canvas pipeline the old renderPage() ran inline, so the PDF
// experience is unchanged. Future formats (cbz/epub/txt/...) add their own
// adapters behind makeAdapter() without touching the reader shell.
class PdfAdapter implements DocAdapter {
  readonly format: DocFormat = 'pdf';
  readonly mode: DocMode = 'canvas';
  readonly caps: DocCaps = {
    paged: true,
    canvasPages: true,
    textSelectable: true,
    regionClippable: true,
    timeMedia: false,
    reflowable: false,
    zoomable: true,
    printable: true,
  };
  private doc: any;
  private canvas: HTMLCanvasElement | null = null;
  private detachScroll: (() => void) | null = null;

  constructor(doc: any) { this.doc = doc; }

  get total(): number { return this.doc.numPages; }

  // The PDF canvas pipeline, now expressed through paintCanvasPage(). The draw
  // fn builds the pdf.js viewport at device pixels and renders into the canvas;
  // paintCanvasPage owns the sizing/DOM math (identical to the former inline
  // body). The selectable text layer is added afterwards. Staleness is checked
  // against ctx.token (the reader's renderToken at the time renderAt was called).
  async render(pos: DocPos, ctx: RenderCtx, keepScroll: boolean): Promise<void> {
    const n = pos.page!;
    const token = ctx.token;
    const page = await this.doc.getPage(n);
    if (token !== reader.renderToken) return; // superseded

    const v1 = page.getViewport({ scale: 1 });
    const out = await paintCanvasPage(
      async (c2d, cssScale, dpr) => {
        const vp = page.getViewport({ scale: cssScale * dpr });
        await page.render({ canvasContext: c2d, viewport: vp }).promise;
      },
      v1.width, v1.height, ctx, keepScroll,
    );
    if (!out) return; // superseded
    this.canvas = out.canvas;
    renderTextLayerFor(page, out.wrap, out.cssScale, token);
    this.detachScroll?.();
    restoreFracToStage(ctx.stage, pos.frac ?? 0);
    this.detachScroll = attachPagedScroll(ctx.stage);
  }

  toBarPercent(pos: DocPos): number {
    const n = pos.page ?? 1;
    return this.total <= 1 ? 100 : ((n - 1) / (this.total - 1)) * 100;
  }

  posLabel(pos: DocPos): { current: string; total: string } {
    return { current: String(pos.page ?? 1), total: String(this.total) };
  }

  currentCanvas(): HTMLCanvasElement | null { return this.canvas; }

  async renderPrintPage(pageNumber: number, options: { dpi: number; grayscale: boolean }): Promise<PrintPage> {
    const page = await this.doc.getPage(pageNumber);
    const natural = page.getViewport({ scale: 1 });
    const scale = printRenderScale(natural.width, natural.height, options.dpi);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d', { alpha: false })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    if (options.grayscale) {
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      grayscalePixels(pixels.data);
      ctx.putImageData(pixels, 0, 0);
    }
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error('print image encode failed')), 'image/png');
    });
    canvas.width = 1;
    canvas.height = 1;
    return { blob, widthPoints: natural.width, heightPoints: natural.height };
  }

  destroy(): void { this.detachScroll?.(); this.detachScroll = null; this.doc = null; this.canvas = null; }
}

// Natural-order comparator for archive entry names so page 2 sorts before
// page 10 (string sort would not). Falls back to locale compare for the rest.
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

const CBZ_IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;

// Decode one image (raw bytes) to an HTMLImageElement via a blob URL, revoking
// the URL once it loads or fails. The image content-type only matters for the
// blob; the extension-derived type keeps Safari happy for some formats.
function imageFromBytes(bytes: Uint8Array, mime: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
    img.src = url;
  });
}
function imageMimeFor(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  };
  return map[ext] || 'image/jpeg';
}

// Unzip a CBZ (comic archive) and return its image page entries in reading
// order. Uses the lazily-loaded fflate. Entry bytes are kept in memory; pages
// are decoded to <img> on demand at render time.
async function unzipCbz(bytes: ArrayBuffer): Promise<{ name: string; data: Uint8Array }[]> {
  await loadVendor('/vendor/fflate.min.js');
  const fflate: any = (window as any).fflate;
  const files = fflate.unzipSync(new Uint8Array(bytes)) as Record<string, Uint8Array>;
  return Object.keys(files)
    .filter(n => CBZ_IMAGE_RE.test(n) && files[n] && files[n].length > 0)
    .sort(naturalCompare)
    .map(n => ({ name: n, data: files[n] }));
}

// A CBZ comic: a zip of images, each a page painted to a canvas (so region
// clipping captures it 1:1). No selectable text layer.
class CbzAdapter implements DocAdapter {
  readonly format: DocFormat = 'cbz';
  readonly mode: DocMode = 'canvas';
  readonly caps: DocCaps = {
    paged: true,
    canvasPages: true,
    textSelectable: false,
    regionClippable: true,
    timeMedia: false,
    reflowable: false,
    zoomable: true,
    printable: false,
  };
  private pages: { name: string; data: Uint8Array }[];
  private canvas: HTMLCanvasElement | null = null;
  private detachScroll: (() => void) | null = null;

  constructor(pages: { name: string; data: Uint8Array }[]) { this.pages = pages; }

  get total(): number { return this.pages.length; }

  async render(pos: DocPos, ctx: RenderCtx, keepScroll: boolean): Promise<void> {
    const n = pos.page!;
    const token = ctx.token;
    const entry = this.pages[n - 1];
    if (!entry) return;
    const img = await imageFromBytes(entry.data, imageMimeFor(entry.name));
    if (token !== reader.renderToken) return; // superseded
    const out = await paintCanvasPage(
      (c2d, _cssScale, _dpr) => {
        c2d.imageSmoothingQuality = 'high';
        c2d.drawImage(img, 0, 0, c2d.canvas.width, c2d.canvas.height);
      },
      img.naturalWidth || 1, img.naturalHeight || 1, ctx, keepScroll,
    );
    if (!out) return; // superseded
    this.canvas = out.canvas;
    this.detachScroll?.();
    restoreFracToStage(ctx.stage, pos.frac ?? 0);
    this.detachScroll = attachPagedScroll(ctx.stage);
  }

  toBarPercent(pos: DocPos): number {
    const n = pos.page ?? 1;
    return this.total <= 1 ? 100 : ((n - 1) / (this.total - 1)) * 100;
  }
  posLabel(pos: DocPos): { current: string; total: string } {
    return { current: String(pos.page ?? 1), total: String(this.total) };
  }
  currentCanvas(): HTMLCanvasElement | null { return this.canvas; }
  destroy(): void { this.detachScroll?.(); this.detachScroll = null; this.pages = []; this.canvas = null; }
}

// A plain-text or Markdown document rendered as one scrollable column. No
// canvas, no paging: position is a 0..1 scroll fraction persisted on scroll.
class ScrollTextAdapter implements DocAdapter {
  readonly format: DocFormat;
  readonly mode: DocMode = 'scroll';
  readonly caps: DocCaps = {
    paged: false,
    canvasPages: false,
    textSelectable: true,
    regionClippable: false,
    timeMedia: false,
    reflowable: false,
    zoomable: false,
    printable: false,
  };
  readonly total = 1;
  private text: string;
  private isMd: boolean;
  private scrollHandler: (() => void) | null = null;
  private scrollTimer = 0 as any;

  constructor(text: string, format: DocFormat) {
    this.text = text;
    this.format = format;
    this.isMd = format === 'md';
  }

  async render(pos: DocPos, ctx: RenderCtx, _keepScroll: boolean): Promise<void> {
    const col = ctx.col;
    col.innerHTML = '';
    const container = document.createElement('div');
    if (this.isMd) {
      container.className = 'doc-scroll markdown-body';
      container.innerHTML = renderMarkdown(this.text);
    } else {
      container.className = 'doc-scroll doc-plain';
      const pre = document.createElement('pre');
      pre.textContent = this.text;
      container.appendChild(pre);
    }
    col.appendChild(container);

    // Restore the saved scroll fraction after layout settles.
    const stage = ctx.stage;
    const frac = Math.min(Math.max(pos.fraction ?? 0, 0), 1);
    requestAnimationFrame(() => {
      const max = stage.scrollHeight - stage.clientHeight;
      stage.scrollTop = max > 0 ? frac * max : 0;
      this.attachScroll(stage);
    });
  }

  // Debounced scroll listener: writes the fraction back through the reader's
  // persist path. Re-attached on each render; detached in destroy().
  private attachScroll(stage: HTMLElement): void {
    this.detachScroll(stage);
    this.scrollHandler = () => {
      window.clearTimeout(this.scrollTimer);
      this.scrollTimer = window.setTimeout(() => {
        const max = stage.scrollHeight - stage.clientHeight;
        const f = max > 0 ? Math.min(Math.max(stage.scrollTop / max, 0), 1) : 0;
        setReaderPos({ fraction: f });
        persistPos();
      }, 280);
    };
    stage.addEventListener('scroll', this.scrollHandler, { passive: true });
  }
  private detachScroll(stage: HTMLElement): void {
    if (this.scrollHandler) stage.removeEventListener('scroll', this.scrollHandler);
    this.scrollHandler = null;
    window.clearTimeout(this.scrollTimer);
  }

  toBarPercent(pos: DocPos): number {
    return Math.round(Math.min(Math.max(pos.fraction ?? 0, 0), 1) * 100);
  }
  posLabel(pos: DocPos): { current: string; total: string } {
    const p = Math.round(Math.min(Math.max(pos.fraction ?? 0, 0), 1) * 100);
    return { current: p + '%', total: '' };
  }
  currentCanvas(): HTMLCanvasElement | null { return null; }
  destroy(): void {
    try { this.detachScroll(el('r-stage')); } catch { /* reader gone */ }
  }
}

// mm:ss for media position labels (clamps NaN/negatives to 0:00).
function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// Audio / video, online-only. Streams from S3 via a fresh presigned URL rather
// than downloading bytes (so it never goes through dbGet / the PDF LRU). A
// native <audio>/<video> element handles playback and seeking; position is the
// element's currentTime, persisted as {kind:'seconds'} on a throttled timeupdate
// (and on pause/ended/unload). total=1, no paging/zoom/capture/text.
class MediaAdapter implements DocAdapter {
  readonly format: DocFormat;
  readonly mode: DocMode = 'media';
  readonly caps: DocCaps = {
    paged: false,
    canvasPages: false,
    textSelectable: false,
    regionClippable: false,
    timeMedia: true,
    reflowable: false,
    zoomable: false,
    printable: false,
  };
  readonly total = 1;
  private urlFor: () => Promise<string>;
  private media: HTMLMediaElement | null = null;
  private duration = 0;
  private startSeconds = 0;
  private lastSaved = 0;
  private onMeta = () => {};
  private onTime = () => {};
  private onError = () => {};
  private onPause = () => {};
  private onUnload = () => {};

  constructor(book: Book, urlFor: () => Promise<string>) {
    this.format = book.format === 'video' ? 'video' : 'audio';
    this.urlFor = urlFor;
  }

  async render(pos: DocPos, ctx: RenderCtx, _keepScroll: boolean): Promise<void> {
    const token = ctx.token;
    this.startSeconds = Math.max(0, pos.seconds ?? 0);
    const url = await this.urlFor();
    if (token !== reader.renderToken) return; // superseded (closed / re-opened)

    const col = ctx.col;
    col.innerHTML = '';
    const stage = document.createElement('div');
    stage.className = 'media-stage ' + (this.format === 'video' ? 'is-video' : 'is-audio');

    const elm = (this.format === 'video'
      ? document.createElement('video')
      : document.createElement('audio')) as HTMLMediaElement;
    elm.controls = true;
    elm.preload = 'metadata';
    if (this.format === 'video') {
      (elm as HTMLVideoElement).playsInline = true;
      elm.setAttribute('playsinline', '');
    }
    elm.src = url;
    this.media = elm;

    // Restore the saved position once the browser knows the duration/seekable
    // range; only seek when there's something to restore.
    this.onMeta = () => {
      this.duration = Number.isFinite(elm.duration) ? elm.duration : 0;
      if (this.startSeconds > 0 && this.startSeconds < (this.duration || Infinity)) {
        try { elm.currentTime = this.startSeconds; } catch { /* not seekable yet */ }
      }
      updateReaderChrome();
    };
    // Throttle hard: timeupdate fires ~4x/sec; persist at most every 4s.
    this.onTime = () => {
      const now = elm.currentTime;
      setReaderPos({ seconds: now });
      el('r-progress-bar').style.width = this.toBarPercent(reader.pos) + '%';
      if (Math.abs(now - this.lastSaved) >= 4) { this.lastSaved = now; this.flush(); }
    };
    this.onPause = () => { this.lastSaved = elm.currentTime; this.flush(); };
    this.onUnload = () => { if (this.media) { setReaderPos({ seconds: this.media.currentTime }); persistPos(); } };
    // On a stream error (commonly an expired presigned URL), re-fetch a fresh
    // URL and resume from the last known position.
    this.onError = () => {
      const at = elm.currentTime || this.startSeconds;
      this.urlFor().then((fresh) => {
        if (!this.media) return;
        this.startSeconds = at;
        this.media.src = fresh;
        this.media.load();
      }).catch(() => { toast(t('toast.mediaError')); });
    };

    elm.addEventListener('loadedmetadata', this.onMeta);
    elm.addEventListener('timeupdate', this.onTime);
    elm.addEventListener('pause', this.onPause);
    elm.addEventListener('ended', this.onPause);
    elm.addEventListener('error', this.onError);
    window.addEventListener('pagehide', this.onUnload);

    stage.appendChild(elm);
    col.appendChild(stage);
  }

  private flush(): void {
    if (!this.media) return;
    setReaderPos({ seconds: this.media.currentTime });
    persistPos();
  }

  toBarPercent(pos: DocPos): number {
    const d = this.duration || (this.media && Number.isFinite(this.media.duration) ? this.media.duration : 0);
    if (!d) return 0;
    return Math.min(100, Math.max(0, ((pos.seconds ?? 0) / d) * 100));
  }
  posLabel(pos: DocPos): { current: string; total: string } {
    const d = this.duration || (this.media && Number.isFinite(this.media.duration) ? this.media.duration : 0);
    return { current: fmtClock(pos.seconds ?? 0), total: d ? fmtClock(d) : '' };
  }
  currentCanvas(): HTMLCanvasElement | null { return null; }
  destroy(): void {
    const m = this.media;
    if (m) {
      try {
        m.removeEventListener('loadedmetadata', this.onMeta);
        m.removeEventListener('timeupdate', this.onTime);
        m.removeEventListener('pause', this.onPause);
        m.removeEventListener('ended', this.onPause);
        m.removeEventListener('error', this.onError);
        m.pause();
        m.removeAttribute('src');
        m.src = '';
        m.load();   // stop buffering / release the network connection
      } catch { /* element already detached */ }
    }
    window.removeEventListener('pagehide', this.onUnload);
    this.media = null;
  }
}

// Lazily load epub.js (and its JSZip dependency, which the UMD build reads off
// window.JSZip at evaluation time — so jszip MUST be injected first). Both are
// vendored, not precached; the VENDOR_CACHE rule keeps them offline-ready after
// first use. Returns window.ePub once available.
async function loadEpubLib(): Promise<any> {
  await loadVendor('/vendor/jszip.min.js');   // must resolve before epub.min.js evaluates
  await loadVendor('/vendor/epub.min.js');
  return (window as any).ePub;
}

// An EPUB: epub.js renders a reflowable, paginated single column into an iframe.
// No canvas, no clean page count: position is a CFI persisted on relocation and
// restored on open. Text selection lives inside the iframe, so it's surfaced via
// rendition.on('selected') into the existing share-text card. Locations (for the
// progress percentage) are generated lazily in the background after open.
class EpubAdapter implements DocAdapter {
  readonly format: DocFormat = 'epub';
  readonly mode: DocMode = 'reflow';
  readonly caps: DocCaps = {
    paged: false,            // no numeric page input — CFI-positioned
    canvasPages: false,      // no canvas → region capture + text-layer code inert
    textSelectable: true,    // via rendition 'selected', surfaced as a share card
    regionClippable: false,  // no persisted highlights for epub
    timeMedia: false,
    reflowable: true,
    zoomable: false,
    printable: false,
  };
  readonly total = 1;        // reflow has no clean page count; nav is prev/next
  private epub: any;
  private rendition: any = null;
  private stage: HTMLElement | null = null;
  private displayed = false;
  private cfi: string | null;
  private percent = 0;
  private locationsReady = false;
  private saveTimer = 0 as any;
  private onRelocated = (loc: any) => this.handleRelocated(loc);
  private onSelected = (cfiRange: string, contents: any) => this.handleSelected(cfiRange, contents);

  constructor(epub: any, startCfi: string | null) {
    this.epub = epub;
    this.cfi = startCfi;
  }

  applyType(scale: number, lineHeight: number): void {
    if (!this.rendition) return;
    try {
      this.rendition.themes.fontSize(Math.round(scale * 100) + '%');
      this.rendition.themes.override('line-height', String(lineHeight), true);
    } catch { /* themes API best-effort */ }
  }

  applyTheme(theme: string): void {
    if (!this.rendition) return;
    const map: Record<string, { bg: string; fg: string; link: string }> = {
      paper: { bg: '#efe6d2', fg: '#2a2018', link: '#5e261d' },
      sepia: { bg: '#f2e8d0', fg: '#3a2c18', link: '#7c3327' },
      dark:  { bg: '#211b14', fg: '#e8dcc4', link: '#caa24e' },
      hc:    { bg: '#000000', fg: '#ffffff', link: '#ffd24a' },
    };
    const c = map[theme] || map.paper;
    try {
      // override() targets body CSS props (background/color); reliable across the
      // vendored epub.js. Link color is left to the book's own styles.
      this.rendition.themes.override('background', c.bg, true);
      this.rendition.themes.override('color', c.fg, true);
    } catch { /* themes API best-effort */ }
  }

  async render(pos: DocPos, ctx: RenderCtx, _keepScroll: boolean): Promise<void> {
    const token = ctx.token;
    await this.epub.ready;
    if (token !== reader.renderToken) return; // superseded (closed / re-opened)

    if (!this.rendition) {
      const col = ctx.col;
      col.innerHTML = '';
      const stage = document.createElement('div');
      stage.className = 'epub-stage';
      const viewEl = document.createElement('div');
      viewEl.id = 'epub-view';
      viewEl.className = 'epub-view';
      stage.appendChild(viewEl);
      col.appendChild(stage);
      this.stage = stage;

      this.rendition = this.epub.renderTo(viewEl, {
        width: '100%',
        height: '100%',
        flow: 'paginated',
        spread: 'none',
        allowScriptedContent: false,
      });
      this.rendition.on('relocated', this.onRelocated);
      this.rendition.on('selected', this.onSelected);
      await this.rendition.display(pos.cfi || this.cfi || undefined);
      this.applyType(readerFontScale, readerLineHeight);
      this.applyTheme(resolveTheme(themePref));
      this.displayed = true;
      this.generateLocations();
    } else {
      // A re-render (e.g. width/resize change): re-display the current spot and
      // re-assert type overrides (epub.js may rebuild the iframe on display).
      await this.rendition.display(this.cfi || pos.cfi || undefined);
      this.applyType(readerFontScale, readerLineHeight);
      this.applyTheme(resolveTheme(themePref));
    }
  }

  // Generate locations in the background so the progress bar can show a real
  // percentage. Best-effort and non-blocking — page turns work without it.
  private generateLocations(): void {
    try {
      this.epub.locations.generate(1024).then(() => {
        this.locationsReady = true;
        if (this.cfi) {
          this.percent = this.safePercent(this.cfi);
          el('r-progress-bar').style.width = (this.percent * 100) + '%';
        }
      }).catch(() => {});
    } catch { /* locations are best-effort */ }
  }

  private safePercent(cfi: string): number {
    try {
      const p = this.epub.locations.percentageFromCfi(cfi);
      return Number.isFinite(p) ? Math.min(Math.max(p, 0), 1) : this.percent;
    } catch { return this.percent; }
  }

  private handleRelocated(loc: any): void {
    const cfi = loc?.start?.cfi;
    if (!cfi) return;
    this.cfi = cfi;
    if (this.locationsReady) this.percent = this.safePercent(cfi);
    else if (typeof loc?.start?.percentage === 'number') this.percent = Math.min(Math.max(loc.start.percentage, 0), 1);
    setReaderPos({ cfi });
    updateReaderChrome();
    // Coalesce: relocated fires on every page turn; debounce the persist.
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => persistPos(), 500);
  }

  // Iframe selections never reach the top document's selectionchange handler, so
  // epub.js hands us the selected range here. Resolve it to a string and surface
  // the existing Share toolbar (no rects → text-card share only).
  private handleSelected(cfiRange: string, contents: any): void {
    let text = '';
    try { text = (contents?.window?.getSelection?.()?.toString() || '').trim(); } catch { /* cross-frame */ }
    if (!text) return;
    surfaceTextShare(text, cfiRange, contents);
  }

  next(): void { this.rendition?.next?.(); }
  prev(): void { this.rendition?.prev?.(); }

  toBarPercent(_pos: DocPos): number { return Math.round(this.percent * 100); }
  posLabel(_pos: DocPos): { current: string; total: string } {
    return { current: Math.round(this.percent * 100) + '%', total: '' };
  }
  currentCanvas(): HTMLCanvasElement | null { return null; }
  destroy(): void {
    window.clearTimeout(this.saveTimer);
    try {
      this.rendition?.off?.('relocated', this.onRelocated);
      this.rendition?.off?.('selected', this.onSelected);
      this.rendition?.destroy?.();
    } catch { /* already torn down */ }
    try { this.epub?.destroy?.(); } catch { /* ignore */ }
    this.rendition = null; this.epub = null; this.stage = null;
  }
}

// Build the right adapter for a book's format. Canvas/text formats parse `bytes`;
// media formats stream from S3 and take a lazy presigned-URL getter instead
// (openBook passes null bytes + urlFor for those — see makeAdapter call there).
async function makeAdapter(book: Book, bytes: ArrayBuffer | null, urlFor?: () => Promise<string>): Promise<DocAdapter> {
  const format = book.format ?? 'pdf';
  switch (format) {
    case 'pdf':
      return new PdfAdapter(await loadDoc(bytes!));
    case 'cbz':
      return new CbzAdapter(await unzipCbz(bytes!));
    case 'epub': {
      const ePub = await loadEpubLib();
      const epubBook = ePub(bytes!);   // ArrayBuffer ctor
      const startCfi = book.progress?.kind === 'cfi' ? String(book.progress.value) : null;
      return new EpubAdapter(epubBook, startCfi);
    }
    case 'txt':
    case 'md':
      return new ScrollTextAdapter(new TextDecoder('utf-8').decode(bytes!), format);
    case 'audio':
    case 'video':
      return new MediaAdapter(book, urlFor ?? (() => presignedUrlFor(book.id)));
    default:
      throw new Error('Unsupported format: ' + format);
  }
}

const reader = {
  book: null as Book | null,
  adapter: null as DocAdapter | null,
  pos: { page: 1 } as DocPos,
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
  cssW: 0,
  cssH: 0,
  cssScale: 1,
};

// Set both the source-of-truth pos and the page mirror that the existing
// capture/overlay/nav code reads. Always keep them in lockstep.
function setReaderPos(pos: DocPos): void {
  reader.pos = pos;
  if (pos.page != null) reader.page = pos.page;
}

// Fills #r-col with a recovery panel when a book fails to load, instead of
// leaving the reader blank. Built with safe DOM construction (no innerHTML). A
// later successful renderAt replaces #r-col content, clearing the panel.
function renderReaderError(retryId: string): void {
  const col = el('r-col');
  col.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'r-error';
  const ic = document.createElement('div');
  ic.className = 'r-error-ic';
  ic.textContent = '⚠';
  const h3 = document.createElement('h3');
  h3.textContent = t('reader.error.title');
  const p = document.createElement('p');
  p.textContent = t('reader.error.body');
  const actions = document.createElement('div');
  actions.className = 'r-error-actions';
  const back = document.createElement('button');
  back.className = 'mast-btn';
  back.textContent = t('rdr.back');
  back.addEventListener('click', () => closeReader());
  const retry = document.createElement('button');
  retry.className = 'mast-btn brass';
  retry.textContent = t('reader.error.retry');
  retry.addEventListener('click', () => openBook(retryId));
  actions.append(back, retry);
  box.append(ic, h3, p, actions);
  col.appendChild(box);
}

async function openBook(id: string): Promise<void> {
  const meta = books.find(x => x.id === id);
  if (!meta) { toast(t('toast.cantOpen')); return; }
  const b = meta as Book;
  track('open_book', { format: b.format });
  reader.adapter?.destroy();   // tear down any previous adapter (scroll listeners etc.)
  reader.adapter = null;
  reader.book = b;
  // Tentative paged position; for scroll formats it's replaced with a fraction
  // once the adapter (and thus the mode) is known, just below.
  setReaderPos({ page: Math.min(Math.max(1, b.currentPage || 1), b.numPages), frac: b.posFrac ?? 0 });
  reader.zoom = getBookZoom(id) ?? (Number(localStorage.getItem(LS.lastZoom)) || 1);
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
    // Media (audio/video) is online-only: it streams from S3 via a fresh
    // presigned URL and must NOT download bytes (no dbGet / no PDF LRU). All
    // other formats fetch their bytes here.
    const fmt = b.format ?? 'pdf';
    const isMedia = fmt === 'audio' || fmt === 'video';
    let bytes: ArrayBuffer | null = null;
    if (isMedia) {
      reader.adapter = await makeAdapter(b, null, () => presignedUrlFor(id));
    } else {
      bytes = await dbGet(id);
      if (!bytes) { toast(t('toast.cantLoad'), { error: true }); renderReaderError(id); el('r-loading').classList.add('hidden'); return; }
      reader.adapter = await makeAdapter(b, bytes);
    }
    // Scroll formats restore a 0..1 scroll fraction (stored generalized as
    // book.progress) rather than a page; media restores a seconds offset;
    // paged formats keep the page set above.
    if (reader.adapter.mode === 'scroll') {
      const stored = b.progress?.kind === 'fraction' ? Number(b.progress.value) : 0;
      setReaderPos({ fraction: Number.isFinite(stored) ? stored : 0 });
    } else if (reader.adapter.mode === 'media') {
      const stored = b.progress?.kind === 'seconds' ? Number(b.progress.value) : 0;
      setReaderPos({ seconds: Number.isFinite(stored) ? stored : 0 });
    } else if (reader.adapter.mode === 'reflow') {
      const stored = b.progress?.kind === 'cfi' ? String(b.progress.value) : '';
      setReaderPos(stored ? { cfi: stored } : {});
    }
    // Gate reader chrome on the adapter's capabilities. For PDF every cap is on,
    // so no class is added and the UI is unchanged.
    const caps = reader.adapter.caps;
    rd.classList.toggle('no-capture', !caps.regionClippable);
    rd.classList.toggle('no-zoom', !caps.zoomable);
    rd.classList.toggle('no-paged', !caps.paged);
    rd.classList.toggle('no-print', !caps.printable);
    rd.classList.toggle('text-share-only', !caps.textSelectable);
    // Reflow (epub): no numeric pager, but the floating prev/next arrows stay
    // (CSS re-shows .rnav under .is-reflow even though .no-paged is set).
    rd.classList.toggle('is-reflow', reader.adapter.mode === 'reflow');
    // An offline clip load is fine (empty); a real 401 must not leave the
    // reader open behind the login screen.
    reader.clips = await clipsAll(id).catch(e => { if (e instanceof ApiAuthError) throw e; return []; });
    await renderAt(reader.pos, false);
  } catch (e) {
    console.error(e);
    if (e instanceof ApiAuthError) { closeReader(); return; }
    if (e instanceof ApiNetworkError) toast(t('toast.notDownloaded'), { error: true });
    else toast(t('toast.loadFailed'), { error: true });
    renderReaderError(id);
  }
  el('r-loading').classList.add('hidden');
}

function closeReader(): void {
  cancelPrintDialog();
  exitZen();
  exitCapture();
  el('reader').classList.remove('show');
  document.body.style.overflow = '';
  reader.adapter?.destroy();
  reader.adapter = null; reader.book = null;
  reader.clips = [];
  renderLibrary();
}

function stageWidth(): number {
  const stage = el('r-stage');
  return stage.clientWidth;
}

// Thin coordinator: clamp + set position, bump the render token, hand off to the
// adapter, then (if not superseded) refresh chrome and persist. The PDF canvas
// pipeline lives in PdfAdapter.render(); this is the only render entry point.
async function renderAt(pos: DocPos, keepScroll: boolean): Promise<void> {
  if (!reader.adapter || !reader.book) return;
  if (pos.page != null) {
    pos = { ...pos, page: Math.min(Math.max(1, pos.page), reader.book.numPages) };
  }
  if (keepScroll && reader.adapter.caps.canvasPages) {
    pos = { ...pos, frac: fracFromStage(el('r-stage')) };
  }
  setReaderPos(pos);
  const token = ++reader.renderToken;
  const ctx: RenderCtx = {
    col: el('r-col'),
    stage: el('r-stage'),
    width: reader.width,
    zoom: reader.zoom,
    token,
    drawClipOverlay: (wrap, cssW, cssH) => renderClipOverlay(wrap, cssW, cssH),
  };
  await reader.adapter.render(reader.pos, ctx, keepScroll);
  if (token !== reader.renderToken) return; // superseded
  updateReaderChrome();
  persistPos();
}

// Renders a selectable PDF.js text layer over the page canvas (text PDFs only;
// scanned PDFs yield no text, so the layer stays empty). The vendored 3.11
// build sizes glyph spans with calc(var(--scale-factor) * Npx), so that CSS
// variable must be set to the viewport scale or the text misaligns.
async function renderTextLayerFor(page: any, wrap: HTMLElement, cssScale: number, token: number): Promise<void> {
  try {
    const textContent = await page.getTextContent();
    if (token !== reader.renderToken || !textContent.items.length) return;
    const vp = page.getViewport({ scale: cssScale });
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    // Match the canvas CSS box exactly (canvas height uses Math.round); a floor
    // here would clip the bottom text row out of the overflow:clip container.
    layer.style.width = Math.round(vp.width) + 'px';
    layer.style.height = Math.round(vp.height) + 'px';
    layer.style.setProperty('--scale-factor', String(cssScale));
    wrap.insertBefore(layer, wrap.querySelector('.rclips'));
    await (pdfjs as any).renderTextLayer({ textContentSource: textContent, container: layer, viewport: vp }).promise;
  } catch { /* text layer is best-effort */ }
}

// Rebuilds only the clip overlay (after a save/delete) — no page or text re-render.
function refreshClipOverlay(): void {
  const wrap = el('r-col').querySelector('.rpage') as HTMLElement | null;
  if (!wrap) return;
  wrap.querySelector('.rclips')?.remove();
  renderClipOverlay(wrap, reader.cssW, reader.cssH);
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
  const b = reader.book; const ad = reader.adapter; if (!b || !ad) return;
  const label = ad.posLabel(reader.pos);
  (el('r-page-input') as HTMLInputElement).value = label.current;
  el('r-progress-bar').style.width = ad.toBarPercent(reader.pos) + '%';
  // Reflow (epub) has no page bounds — prev/next are always live (epub.js no-ops
  // at the book edges). Paged formats disable the arrows at the first/last page.
  const atStart = ad.mode === 'reflow' ? false : reader.page <= 1;
  const atEnd = ad.mode === 'reflow' ? false : reader.page >= b.numPages;
  (el('r-prev') as HTMLButtonElement).disabled = atStart;
  (el('r-next') as HTMLButtonElement).disabled = atEnd;
  (el('r-prev-s') as HTMLButtonElement).disabled = atStart;
  (el('r-next-s') as HTMLButtonElement).disabled = atEnd;
}

// Persist the current reader position. Paged/canvas formats write the page
// number on the legacy wire shape ({currentPage}); scroll formats write a
// generalized fraction ({progress:{kind:'fraction',value}}). dbPutProgress
// derives the body from the book's currentPage/progress fields.
function persistPos(): void {
  const b = reader.book; if (!b) return;
  if (reader.adapter?.mode === 'scroll') {
    b.progress = { kind: 'fraction', value: Math.min(Math.max(reader.pos.fraction ?? 0, 0), 1) };
  } else if (reader.adapter?.mode === 'media') {
    b.progress = { kind: 'seconds', value: Math.max(0, reader.pos.seconds ?? 0) };
  } else if (reader.adapter?.mode === 'reflow') {
    if (reader.pos.cfi) b.progress = { kind: 'cfi', value: reader.pos.cfi };
  } else if (reader.pos.page != null) {
    b.currentPage = reader.pos.page;
    b.posFrac = reader.pos.frac ?? 0;
  }
  b.lastReadAt = Date.now();
  const cached = books.find(x => x.id === b.id);
  if (cached) { cached.currentPage = b.currentPage; cached.posFrac = b.posFrac; cached.progress = b.progress; cached.lastReadAt = b.lastReadAt; }
  const progressPct = pct(b);
  if (progressPct > 0 && progressPct % 10 === 0) {
    track('reading_progress', { format: b.format, pct: progressPct });
  }
  window.clearTimeout(reader.saveTimer);
  reader.saveTimer = window.setTimeout(() => { dbPutProgress(b).catch(() => {}); }, 350);
}

// Toggle play/pause for the current media element (Space shortcut). Best-effort:
// no-op if there's no media element or autoplay is blocked.
function toggleMediaPlayback(): void {
  const m = el('r-col').querySelector('audio,video') as HTMLMediaElement | null;
  if (!m) return;
  if (m.paused) m.play().catch(() => {}); else m.pause();
}

function go(delta: number): void {
  if (!reader.book || !reader.adapter) return;
  // Reflow (epub): no page numbers — drive epub.js prev/next directly. The
  // adapter's 'relocated' handler updates pos/chrome and persists the new CFI.
  if (reader.adapter.mode === 'reflow') {
    const ad = reader.adapter as EpubAdapter;
    if (delta > 0) ad.next(); else if (delta < 0) ad.prev();
    return;
  }
  if (reader.adapter.mode !== 'canvas') return;   // scroll formats don't page
  const next = reader.page + delta;
  if (next < 1 || next > reader.book.numPages) return;
  renderAt({ page: next }, false);
}

// Edge-aware page turning: the wheel scrolls within a tall page, and only flips
// pages once you're already at the top/bottom edge and keep scrolling. A short
// cooldown stops trackpad momentum from skipping multiple pages per gesture.
function onReaderWheel(e: WheelEvent): void {
  if (!reader.adapter || !reader.book) return;
  // Reflow (epub): one wheel notch = one page turn, debounced. The iframe owns
  // its own layout, so drive paging explicitly rather than relying on it.
  if (reader.adapter.mode === 'reflow') {
    const down = e.deltaY > 0, up = e.deltaY < 0;
    if (!down && !up) return;
    e.preventDefault();
    if (e.timeStamp - reader.wheelLock < 450) return;
    reader.wheelLock = e.timeStamp;
    go(down ? 1 : -1);
    return;
  }
  if (reader.adapter.mode !== 'canvas') return;   // scroll formats: native scroll
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
// Touch navigation. A gesture is classified at touchend in priority order:
//   1. two-finger tap        -> back        (the touch analog of right-click)
//   2. horizontal swipe      -> left=next, right=prev
//   3. vertical edge swipe   -> the wheel's edge-aware paging (canvas only)
//   4. single/double tap     -> single=forward, double=back
// Single tap (forward) is deferred by one double-tap window so a following tap
// can be recognised as a double tap (back) instead — the cost of mapping both
// onto the same finger. Edge state is captured at touchstart so the swipe that
// scrolls you to the bottom doesn't also flip; a short page with nothing to
// scroll is both edges at once, so a single edge swipe turns it.
const SWIPE_PX = 60;        // min travel for a swipe
const TAP_PX = 10;          // max travel still counted as a tap
const DOUBLE_TAP_MS = 250;  // window to pair two taps into a double tap
let touchStartX = 0;
let touchStartY = 0;
let touchMaxTouches = 1;
let touchAtTop = false;
let touchAtBottom = false;
let touchTracking = false;
let tapTimer: any = 0;
let tapCount = 0;
function cancelPendingTap(): void { window.clearTimeout(tapTimer); tapCount = 0; }
function onTap(): void {
  tapCount++;
  if (tapCount === 1) {
    tapTimer = window.setTimeout(() => {
      tapCount = 0;
      reader.wheelLock = performance.now();
      go(1);   // single tap -> forward
    }, DOUBLE_TAP_MS);
  } else {
    cancelPendingTap();
    reader.wheelLock = performance.now();
    go(-1);    // double tap -> back
  }
}
function onReaderTouchStart(e: TouchEvent): void {
  if (!reader.adapter || !reader.book || reader.capturing) { touchTracking = false; return; }
  if (e.touches.length === 1) {
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchMaxTouches = 1;
    const stage = el('r-stage');
    touchAtTop = stage.scrollTop <= 1;
    touchAtBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 1;
    touchTracking = true;
  } else {
    touchMaxTouches = Math.max(touchMaxTouches, e.touches.length);
  }
}
function onReaderTouchEnd(e: TouchEvent): void {
  if (!touchTracking || !reader.book) return;
  if (e.touches.length > 0) return;   // wait until every finger has lifted
  touchTracking = false;
  const touch = e.changedTouches[0];
  if (!touch) return;
  const dx = touch.clientX - touchStartX;       // >0: moved right
  const dyUp = touchStartY - touch.clientY;      // >0: swiped up (advance)
  const adx = Math.abs(dx), ady = Math.abs(dyUp);
  const onCooldown = e.timeStamp - reader.wheelLock < 500;

  // 1. Two-finger tap -> back. Multi-touch gestures never fall through to swipe
  // or tap-forward, so a pinch can't misfire as a page turn.
  if (touchMaxTouches >= 2) {
    cancelPendingTap();
    if (adx < TAP_PX && ady < TAP_PX && !onCooldown) { reader.wheelLock = e.timeStamp; go(-1); }
    return;
  }

  // 2. Horizontal swipe -> left=next, right=prev (works regardless of scroll).
  if (adx >= SWIPE_PX && adx > ady) {
    cancelPendingTap();
    if (onCooldown) return;
    reader.wheelLock = e.timeStamp;
    go(dx < 0 ? 1 : -1);
    return;
  }

  // 3. Vertical edge swipe -> the wheel's edge-aware paging (canvas formats).
  if (ady >= SWIPE_PX && reader.adapter && reader.adapter.mode === 'canvas') {
    cancelPendingTap();
    if (onCooldown) return;
    const stage = el('r-stage');
    const atTop = stage.scrollTop <= 1;
    const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 1;
    if (dyUp > 0 && touchAtBottom && atBottom && reader.page < reader.book.numPages) {
      reader.wheelLock = e.timeStamp; go(1);
    } else if (dyUp < 0 && touchAtTop && atTop && reader.page > 1) {
      reader.wheelLock = e.timeStamp; go(-1);
    }
    return;
  }

  // 4. Tap (negligible travel) -> single=forward / double=back.
  if (adx < TAP_PX && ady < TAP_PX) {
    if (reader.capturing) return;
    if (window.getSelection && String(window.getSelection())) return;
    onTap();
  }
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
  resizeTimer = window.setTimeout(() => renderAt(reader.pos, true), 160);
}

// distraction-free / zen
function enterZen(): void {
  const rd = el('reader');
  rd.classList.add('zen');
  const hint = el('zen-hint');
  hint.classList.add('show');
  window.setTimeout(() => hint.classList.remove('show'), 2600);
  if (rd.requestFullscreen) rd.requestFullscreen().catch(() => {});
  window.setTimeout(() => renderAt(reader.pos, true), 120);
}
function exitZen(): void {
  const rd = el('reader');
  if (!rd.classList.contains('zen')) return;
  rd.classList.remove('zen', 'peek');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  window.setTimeout(() => renderAt(reader.pos, true), 120);
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
  if (!reader.adapter) return;
  clearSelToolbar();
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

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (cur && ctx.measureText(test).width > maxW) { lines.push(cur); cur = w; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Compose a typography quote card: the selected passage re-set in the book's
// serif on warm paper, attributed to the title/author. No pixel crop.
async function composeTextCard(text: string, book: Book): Promise<Blob> {
  const W = 1080, H = 1350, pad = 110;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#efe6d2'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(178,133,58,.55)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(W - pad, pad); ctx.stroke();

  try { await (document as any).fonts.ready; } catch { /* system serif */ }

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(94,38,29,.16)';
  ctx.font = '700 190px Georgia, "Times New Roman", serif';
  ctx.fillText('“', pad - 12, pad + 150);

  const maxW = W - 2 * pad;
  const bodyTop = pad + 70, bodyBottom = H - pad - 170, maxH = bodyBottom - bodyTop;
  ctx.textAlign = 'center';
  let size = 60, lines: string[] = [];
  while (size >= 26) {
    ctx.font = '500 ' + size + 'px "Spectral", Georgia, serif';
    lines = wrapLines(ctx, text, maxW);
    if (lines.length * size * 1.34 <= maxH) break;
    size -= 3;
  }
  const lh = size * 1.34;
  ctx.fillStyle = '#2a2018';
  ctx.font = '500 ' + size + 'px "Spectral", Georgia, serif';
  let y = bodyTop + Math.max(0, (maxH - lines.length * lh) / 2) + size;
  for (const ln of lines) { ctx.fillText(ln, W / 2, y); y += lh; }

  ctx.fillStyle = '#5e261d';
  ctx.font = '700 36px "Zilla Slab", Georgia, serif';
  ctx.fillText(fitText(ctx, '— ' + book.title, maxW), W / 2, H - pad - 78);
  if (book.author) {
    ctx.fillStyle = '#897a5f';
    ctx.font = 'italic 27px "Spectral", Georgia, serif';
    ctx.fillText(fitText(ctx, book.author, maxW), W / 2, H - pad - 40);
  }
  ctx.fillStyle = '#897a5f';
  ctx.font = 'italic 24px "Spectral", Georgia, serif';
  ctx.fillText('❦  folium.cafe', W / 2, H - pad + 2);

  return await new Promise<Blob>((resolve) => cv.toBlob((b) => resolve(b!), 'image/png'));
}

// ---------- text selection toolbar ----------
let pendingSel: { rects: Rect[]; text: string; page: number } | null = null;

function clearSelToolbar(): void {
  pendingSel = null;
  const tb = document.getElementById('sel-toolbar');
  if (tb) tb.classList.remove('show');
}

function positionSelToolbar(first: DOMRect): void {
  const tb = el('sel-toolbar');
  tb.classList.add('show');
  const tbw = tb.offsetWidth || 168, tbh = tb.offsetHeight || 42;
  let left = first.left + first.width / 2 - tbw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tbw - 8));
  const above = first.top - tbh - 10;
  tb.style.left = left + 'px';
  tb.style.top = (above < 8 ? first.bottom + 10 : above) + 'px';
}

function onTextSelection(): void {
  if (reader.capturing) { clearSelToolbar(); return; }
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) { clearSelToolbar(); return; }
  const text = sel.toString().trim();
  const col = el('r-col');
  if (!text || !sel.anchorNode || !col.contains(sel.anchorNode)) { clearSelToolbar(); return; }
  const range = sel.getRangeAt(0);
  const client = Array.from(range.getClientRects());
  if (!client.length) { clearSelToolbar(); return; }
  // Canvas formats (PDF) map the selection to normalized page rects so it can be
  // highlighted. Scroll formats (txt/md) have no canvas: text-share still works
  // (composeTextCard uses the string), but there are no rects to highlight — the
  // Highlight button is gated by the .text-share-only reader class.
  const canvas = reader.adapter?.currentCanvas() ?? null;
  let rects: Rect[] = [];
  if (canvas) {
    const cb = canvas.getBoundingClientRect();
    for (const r of client) {
      if (r.width < 1 || r.height < 1) continue;
      const w = r.width / cb.width, h = r.height / cb.height;
      if (w <= 0 || h <= 0) continue;
      rects.push({ x: (r.left - cb.left) / cb.width, y: (r.top - cb.top) / cb.height, w, h });
    }
    if (!rects.length) { clearSelToolbar(); return; }
  }
  pendingSel = { rects, text, page: reader.page };
  // Persisted highlights need page rects (region-clippable formats only); for
  // scroll text the toolbar offers Share alone.
  const canHighlight = !!reader.adapter?.caps.regionClippable && rects.length > 0;
  el('sel-highlight').classList.toggle('hidden', !canHighlight);
  positionSelToolbar(client[0]);
}

// Surface the Share toolbar for a selection made inside an EPUB iframe (epub.js
// 'selected'). There's no canvas and no top-document selection, so we carry the
// text with empty rects (text-card share only) and position the toolbar over the
// selection by translating the iframe-local client rect into page coordinates.
function surfaceTextShare(text: string, cfiRange: string, contents: any): void {
  if (!text) { clearSelToolbar(); return; }
  pendingSel = { rects: [], text, page: reader.page };
  el('sel-highlight').classList.add('hidden');   // epub: no persisted highlights
  // Best-effort positioning: map the iframe-local selection rect to viewport
  // coords via the iframe's offset. Fall back to the reader stage centre.
  let placed = false;
  try {
    const win = contents?.window || contents?.document?.defaultView;
    const sel = win?.getSelection?.();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const r = range?.getClientRects?.()[0] || range?.getBoundingClientRect?.();
    const frame: HTMLIFrameElement | null = (contents?.document?.defaultView?.frameElement as HTMLIFrameElement) || el('r-col').querySelector('iframe');
    if (r && frame) {
      const fb = frame.getBoundingClientRect();
      positionSelToolbar(new DOMRect(fb.left + r.left, fb.top + r.top, r.width, r.height));
      placed = true;
    }
  } catch { /* cross-frame measurement can throw — fall through */ }
  if (!placed) {
    const sb = el('r-stage').getBoundingClientRect();
    positionSelToolbar(new DOMRect(sb.left + sb.width / 2 - 80, sb.top + 80, 160, 24));
  }
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
// Hand a fully-formed File to the OS share sheet, falling back to a download when
// file-sharing isn't supported (most desktops) or the share fails. Returns what
// happened so callers can decide whether to toast.
async function shareFileOrDownload(file: File, meta: { title: string; text?: string }): Promise<'shared' | 'downloaded' | 'aborted'> {
  const nav: any = navigator;
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: meta.title, text: meta.text });
      return 'shared';
    } catch (e: any) {
      if (e && e.name === 'AbortError') return 'aborted';   // user dismissed the sheet
      downloadBlob(file, file.name);
      return 'downloaded';
    }
  }
  downloadBlob(file, file.name);   // desktop / unsupported → download fallback
  return 'downloaded';
}

// Clip card sharing rides the same primitive (PNG blob → File, bespoke copy).
async function shareOrDownload(blob: Blob, book: Book): Promise<void> {
  const file = new File([blob], 'folium-clip.png', { type: 'image/png' });
  const r = await shareFileOrDownload(file, { title: book.title, text: '“' + book.title + '” — folium.cafe' });
  if (r === 'downloaded') toast(t('clip.shareFailed'));
}

// Above this size a media file is downloaded instead of shared: buffering huge
// bytes risks OOM and the OS share sheet may reject them outright.
const SHARE_SIZE_LIMIT = 500 * 1024 * 1024;   // 500 MiB

function navShareFiles(): boolean {
  const nav: any = navigator;
  return !!(nav.canShare && nav.canShare({ files: [new File([], 'x')] }));
}
function shareText(b: Book): string { return '“' + b.title + '” — folium.cafe'; }

// A safe filename with the right extension for the format. Uploads carry a real
// fileName (reuse its base); notes/linked media don't, so fall back to the title.
function shareFileName(b: Book, fmt: DocFormat): string {
  const fromName = (b.fileName && /\.[a-z0-9]+$/i.test(b.fileName)) ? b.fileName : '';
  let ext: string;
  if (fmt === 'audio' || fmt === 'video') {
    ext = (fromName.split('.').pop() || (fmt === 'audio' ? 'mp3' : 'mp4')).toLowerCase();
  } else {
    ext = fmt === 'note' ? 'md' : fmt;
  }
  const base = fromName ? fromName.replace(/\.[^.]+$/, '') : (b.title || 'folium');
  const safe = base.replace(/[\/\\:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'folium';
  return safe + '.' + ext;
}

// Desktop link fallback for external linked media when Web Share is unavailable.
async function copyOrOpen(url: string): Promise<void> {
  try { await navigator.clipboard.writeText(url); toast(t('share.linkCopied')); }
  catch { window.open(url, '_blank', 'noopener'); }
}

// Share a book as its underlying file via the OS share sheet. Three shapes:
// external linked media → share the URL; notes → a .md file from the note body;
// everything else → the stored bytes (audio/video fetched fresh, since dbGet skips
// media). Falls back to a download when file-sharing isn't available.
async function shareBook(book: Book): Promise<void> {
  const fmt = book.format ?? 'pdf';

  // Linked media (external URL, no stored bytes) → share the link, not a file.
  if (book.url) {
    const nav: any = navigator;
    const data = { title: book.title, text: shareText(book), url: book.url };
    if (nav.share && (!nav.canShare || nav.canShare(data))) {
      try { await nav.share(data); return; }
      catch (e: any) { if (e && e.name === 'AbortError') return; }
    }
    await copyOrOpen(book.url);
    return;
  }

  // Notes → markdown body as a .md file.
  if (fmt === 'note') {
    let body: string;
    try { body = await dbGetNote(book.id); }
    catch (e) { if (e instanceof ApiAuthError) throw e; toast(t('share.offline'), { error: true }); return; }
    const name = shareFileName(book, fmt);
    const file = new File([body], name, { type: mimeFor('note', name) });
    await shareFileOrDownload(file, { title: book.title, text: shareText(book) });
    return;
  }

  // Stored bytes (pdf/cbz/epub/txt/md) and stored media (audio/video).
  const isMedia = fmt === 'audio' || fmt === 'video';
  let buf: ArrayBuffer | null = null;
  try {
    if (isMedia) {
      toast(t('share.preparing'));   // fetching full media bytes can take a moment
      const url = await presignedUrlFor(book.id);
      const res = await fetch(url);
      if (!res.ok) throw new ApiNetworkError('media ' + res.status);
      buf = await res.arrayBuffer();
    } else {
      buf = await dbGet(book.id);   // cache-first, else presigned download
    }
  } catch (e) {
    if (e instanceof ApiAuthError) throw e;
    toast(t('share.offline'), { error: true });
    return;
  }
  if (!buf) { toast(t('share.failed'), { error: true }); return; }

  const name = shareFileName(book, fmt);
  const file = new File([buf], name, { type: mimeFor(fmt, book.fileName || name) });
  if (file.size > SHARE_SIZE_LIMIT && navShareFiles()) {
    downloadBlob(file, name);
    toast(t('share.tooLargeDownloaded'));
    return;
  }
  await shareFileOrDownload(file, { title: book.title, text: shareText(book) });
}

// ---------- PDF printing ----------
type PrintPageMode = 'current' | 'single' | 'range';
type PrintSizing = 'fit' | 'actual';
let printJobToken = 0;
let printPreparing = false;

function checkedPrintValue(name: string): string {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value || '';
}

function setPrintBusy(busy: boolean): void {
  printPreparing = busy;
  el<HTMLButtonElement>('print-submit').disabled = busy;
  el('print-form').querySelectorAll<HTMLInputElement>('input').forEach(input => { input.disabled = busy; });
  if (!busy) syncPrintPageInputs();
}

function syncPrintPageInputs(): void {
  const mode = checkedPrintValue('print-pages') as PrintPageMode;
  const single = el<HTMLInputElement>('print-single');
  const start = el<HTMLInputElement>('print-start');
  const end = el<HTMLInputElement>('print-end');
  single.disabled = printPreparing;
  start.disabled = printPreparing;
  end.disabled = printPreparing;
  single.readOnly = mode !== 'single';
  start.readOnly = mode !== 'range';
  end.readOnly = mode !== 'range';
  single.tabIndex = mode === 'single' ? 0 : -1;
  start.tabIndex = mode === 'range' ? 0 : -1;
  end.tabIndex = mode === 'range' ? 0 : -1;
  document.querySelectorAll<HTMLElement>('#print-dialog [data-print-mode]').forEach(row => {
    row.classList.toggle('is-active', row.dataset.printMode === mode);
  });
}

function setPrintError(message = ''): void {
  const error = el('print-error');
  error.textContent = message;
  error.classList.toggle('hidden', !message);
}

function hidePrintDialog(): void {
  const modal = el('print-dialog');
  (modal as any)._untrap?.();
  (modal as any)._untrap = null;
  modal.classList.add('hidden');
  setPrintBusy(false);
}

function cancelPrintDialog(): void {
  if (el('print-dialog').classList.contains('hidden')) return;
  printJobToken++;
  hidePrintDialog();
}

function openPrintDialog(): void {
  const adapter = reader.adapter;
  if (!reader.book || !adapter?.caps.printable || !adapter.renderPrintPage) return;
  if (!el('print-dialog').classList.contains('hidden')) return;
  exitZen();
  printJobToken++;
  printPreparing = false;
  const form = el<HTMLFormElement>('print-form');
  form.reset();
  const current = reader.page;
  const total = adapter.total;
  el('print-current-label').textContent = t('print.current', { page: current });
  const single = el<HTMLInputElement>('print-single');
  const start = el<HTMLInputElement>('print-start');
  const end = el<HTMLInputElement>('print-end');
  for (const input of [single, start, end]) input.max = String(total);
  single.value = String(current);
  start.value = String(current);
  end.value = String(current);
  setPrintError();
  el('print-progress').classList.add('hidden');
  setPrintBusy(false);
  const modal = el('print-dialog');
  modal.classList.remove('hidden');
  const currentRadio = form.querySelector<HTMLInputElement>('input[name="print-pages"][value="current"]')!;
  (modal as any)._untrap = trapFocus(modal, currentRadio);
}

function printErrorMessage(error: string, total: number): string {
  switch (error) {
    case 'required': return t('print.error.required');
    case 'integer': return t('print.error.integer');
    case 'bounds': return t('print.error.bounds', { total });
    case 'order': return t('print.error.order');
    default: return t('print.error.failed');
  }
}

function waitForImage(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth) return Promise.resolve();
  return new Promise((resolve, reject) => {
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => reject(new Error('print image load failed')), { once: true });
  });
}

async function printPreparedPages(pages: PrintPage[], sizing: PrintSizing, title: string): Promise<void> {
  const frame = document.createElement('iframe');
  frame.className = 'print-frame';
  frame.title = t('print.title');
  frame.setAttribute('aria-hidden', 'true');
  document.body.appendChild(frame);
  const urls: string[] = [];
  let timeout = 0;
  let cleaned = false;
  let afterPrint = () => {};
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    window.clearTimeout(timeout);
    window.removeEventListener('afterprint', afterPrint);
    frame.contentWindow?.removeEventListener('afterprint', afterPrint);
    urls.forEach(url => URL.revokeObjectURL(url));
    frame.remove();
    if (el('reader').classList.contains('show')) el<HTMLButtonElement>('r-print').focus();
  };
  afterPrint = cleanup;

  try {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win || typeof win.print !== 'function') throw new Error('window.print unavailable');
    doc.documentElement.lang = locale;
    doc.title = title;
    const meta = doc.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    const style = doc.createElement('style');
    style.textContent = `
      @page { margin: ${sizing === 'fit' ? '10mm' : '0'}; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #fff; }
      .sheet { break-after: page; page-break-after: always; overflow: hidden; }
      .sheet:last-child { break-after: auto; page-break-after: auto; }
      .sheet.fit { display: flex; align-items: center; justify-content: center; width: 100%; height: 100vh; }
      .sheet.fit img { display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; }
      .sheet.actual img { display: block; max-width: none; }
    `;
    doc.head.replaceChildren(meta, style);
    const imageLoads: Promise<void>[] = [];
    pages.forEach(page => {
      const sheet = doc.createElement('section');
      sheet.className = 'sheet ' + sizing;
      const img = doc.createElement('img');
      const url = URL.createObjectURL(page.blob);
      urls.push(url);
      img.src = url;
      img.alt = '';
      if (sizing === 'actual') {
        img.style.width = page.widthPoints + 'pt';
        img.style.height = page.heightPoints + 'pt';
      }
      sheet.appendChild(img);
      doc.body.appendChild(sheet);
      imageLoads.push(waitForImage(img));
    });
    await Promise.all(imageLoads);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    win.addEventListener('afterprint', afterPrint, { once: true });
    window.addEventListener('afterprint', afterPrint, { once: true });
    timeout = window.setTimeout(cleanup, 120_000);
    win.focus();
    win.print();
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function submitPrint(): Promise<void> {
  const adapter = reader.adapter;
  const book = reader.book;
  if (!book || !adapter?.caps.printable || !adapter.renderPrintPage) return;
  if (typeof window.print !== 'function') { setPrintError(t('print.error.unsupported')); return; }
  const total = adapter.total;
  const selection = resolvePrintPages({
    mode: checkedPrintValue('print-pages') as PrintPageMode,
    current: reader.page,
    single: el<HTMLInputElement>('print-single').value,
    start: el<HTMLInputElement>('print-start').value,
    end: el<HTMLInputElement>('print-end').value,
    total,
  });
  if (selection.error) { setPrintError(printErrorMessage(selection.error, total)); return; }

  setPrintError();
  setPrintBusy(true);
  const progress = el('print-progress');
  progress.classList.remove('hidden');
  const token = ++printJobToken;
  const grayscale = checkedPrintValue('print-color') === 'grayscale';
  const sizing = checkedPrintValue('print-sizing') as PrintSizing;
  const rendered: PrintPage[] = [];
  try {
    for (let i = 0; i < selection.pages.length; i++) {
      if (token !== printJobToken) return;
      progress.textContent = t('print.preparing', { current: i + 1, total: selection.pages.length });
      rendered.push(await adapter.renderPrintPage(selection.pages[i], { dpi: 150, grayscale }));
    }
    if (token !== printJobToken) return;
    hidePrintDialog();
    await printPreparedPages(rendered, sizing, book.title);
  } catch (error) {
    console.error(error);
    if (token !== printJobToken) return;
    if (el('print-dialog').classList.contains('hidden')) openPrintDialog();
    setPrintBusy(false);
    progress.classList.add('hidden');
    setPrintError(error instanceof Error && error.message === 'window.print unavailable'
      ? t('print.error.unsupported') : t('print.error.failed'));
  }
}

// ---------- clip share sheet ----------
let sheetState: { rects: Rect[]; text?: string; clip?: Clip; color: string; blob?: Blob } | null = null;

async function openClipSheet(arg: { clip?: Clip; region?: { rect: Rect }; text?: { rects: Rect[]; text: string } }): Promise<void> {
  const book = reader.book; if (!book) return;
  const canvas = reader.adapter?.currentCanvas() ?? null;
  const clip = arg.clip;
  let rects: Rect[]; let text: string | undefined;
  if (clip) { rects = clip.rects; text = clip.text; }
  else if (arg.text) { rects = arg.text.rects; text = arg.text.text; }
  else { rects = [arg.region!.rect]; text = undefined; }
  if (!rects.length) return;
  sheetState = { rects, text, clip, color: clip?.color || DEFAULT_CLIP_COLOR };
  let blob: Blob;
  if (text) blob = await composeTextCard(text, book);
  else { if (!canvas) return; blob = await composeRegionCard(canvas, rects[0], book.title); }
  sheetState.blob = blob;
  const img = el('clip-preview') as HTMLImageElement;
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob);
  renderSwatches();
  el('clip-save').classList.toggle('hidden', !!clip);
  el('clip-colors').classList.toggle('hidden', !!clip);
  el('clip-delete').classList.toggle('hidden', !clip);
  const sheet = el('clip-sheet');
  sheet.classList.remove('hidden');
  (sheet as any)._untrap = trapFocus(sheet);
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
  const sheet = el('clip-sheet');
  (sheet as any)._untrap?.();
  sheet.classList.add('hidden');
  sheetState = null;
}

function wireReader(): void {
  el('r-back').addEventListener('click', closeReader);
  el('r-prev').addEventListener('click', () => go(-1));
  el('r-next').addEventListener('click', () => go(1));
  el('r-prev-s').addEventListener('click', () => go(-1));
  el('r-next-s').addEventListener('click', () => go(1));
  el('r-stage').addEventListener('wheel', onReaderWheel, { passive: false });
  el('r-stage').addEventListener('touchstart', onReaderTouchStart, { passive: true });
  el('r-stage').addEventListener('touchend', onReaderTouchEnd, { passive: true });
  el('r-focus').addEventListener('click', toggleZen);

  el('r-print').addEventListener('click', openPrintDialog);
  el('r-share').addEventListener('click', () => { if (reader.book) shareBook(reader.book); });

  el('print-form').addEventListener('submit', (e) => { e.preventDefault(); void submitPrint(); });
  el('print-cancel').addEventListener('click', cancelPrintDialog);
  el('print-dialog').addEventListener('click', (e) => { if (e.target === el('print-dialog')) cancelPrintDialog(); });
  document.querySelectorAll<HTMLInputElement>('input[name="print-pages"]').forEach(input => input.addEventListener('change', syncPrintPageInputs));
  for (const id of ['print-single', 'print-start', 'print-end']) {
    el<HTMLInputElement>(id).addEventListener('focus', () => {
      const mode = id === 'print-single' ? 'single' : 'range';
      const radio = document.querySelector<HTMLInputElement>(`input[name="print-pages"][value="${mode}"]`)!;
      if (!radio.checked) { radio.checked = true; syncPrintPageInputs(); }
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('print-dialog').classList.contains('hidden')) {
      e.preventDefault();
      cancelPrintDialog();
      return;
    }
    if (isPrintShortcut(e)
        && el('reader').classList.contains('show') && reader.adapter?.caps.printable) {
      e.preventDefault();
      openPrintDialog();
    }
  }, true);

  // --- clippings: snapshot capture + saved-clip taps + share sheet ---
  el('r-snap').addEventListener('click', toggleCapture);

  let capStart: { x: number; y: number } | null = null;
  let suppressClick = false;
  let lastPointerWasTouch = false;   // route clicks: mouse pages here, touch via touch events
  const stageEl = el('r-stage');
  stageEl.addEventListener('pointerdown', (e) => {
    lastPointerWasTouch = e.pointerType === 'touch';
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
    const canvas = reader.adapter?.currentCanvas() ?? null;
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
    const clip: Clip = { id: cid(), page: reader.page, rects: sheetState.rects, color: sheetState.color, createdAt: Date.now() };
    if (sheetState.text) clip.text = sheetState.text;
    reader.clips.push(clip);
    const bookId = reader.book.id;
    closeClipSheet();
    refreshClipOverlay();
    toast(t('clip.saved'));
    try { await clipPut(bookId, clip); } catch (err) { console.error(err); }
  });
  el('clip-delete').addEventListener('click', async () => {
    if (!sheetState?.clip || !reader.book) return;
    const id = sheetState.clip.id, bookId = reader.book.id;
    reader.clips = reader.clips.filter(x => x.id !== id);
    closeClipSheet();
    refreshClipOverlay();
    toast(t('clip.removed'));
    try { await clipDel(bookId, id); } catch (err) { console.error(err); }
  });
  el('clip-close').addEventListener('click', closeClipSheet);
  el('clip-sheet').addEventListener('click', (e) => { if (e.target === el('clip-sheet')) closeClipSheet(); });

  // --- text selection → floating Highlight / Share toolbar ---
  let selTimer: any = 0;
  document.addEventListener('selectionchange', () => {
    if (!el('reader').classList.contains('show')) return;
    window.clearTimeout(selTimer);
    selTimer = window.setTimeout(onTextSelection, 140);
  });
  el('r-stage').addEventListener('scroll', () => {
    if (!pendingSel) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { clearSelToolbar(); return; }
    const r = sel.getRangeAt(0).getClientRects()[0];
    if (r) positionSelToolbar(r);
  }, { passive: true });
  el('sel-highlight').addEventListener('click', async () => {
    if (!pendingSel || !reader.book) return;
    const clip: Clip = { id: cid(), page: pendingSel.page, rects: pendingSel.rects, color: DEFAULT_CLIP_COLOR, text: pendingSel.text, createdAt: Date.now() };
    const bookId = reader.book.id;
    reader.clips.push(clip);
    window.getSelection()?.removeAllRanges();
    clearSelToolbar();
    refreshClipOverlay();
    toast(t('clip.saved'));
    try { await clipPut(bookId, clip); } catch (err) { console.error(err); }
  });
  el('sel-share').addEventListener('click', () => {
    if (!pendingSel) return;
    const payload = { rects: pendingSel.rects, text: pendingSel.text };
    window.getSelection()?.removeAllRanges();
    clearSelToolbar();
    openClipSheet({ text: payload });
  });

  el('r-zoom-in').addEventListener('click', () => { reader.zoom = Math.min(reader.zoom + 0.15, 2.2); if (reader.book) setBookZoom(reader.book.id, reader.zoom); renderAt(reader.pos, true); });
  el('r-zoom-out').addEventListener('click', () => { reader.zoom = Math.max(reader.zoom - 0.15, 0.6); if (reader.book) setBookZoom(reader.book.id, reader.zoom); renderAt(reader.pos, true); });

  el('width-seg').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button') as HTMLElement | null;
    if (!btn) return;
    reader.width = btn.dataset.w as 'comfort' | 'full';
    localStorage.setItem(LS.width, reader.width);
    setWidthButtons();
    renderAt(reader.pos, true);
  });

  const pi = el('r-page-input') as HTMLInputElement;
  const commit = () => {
    const v = parseInt(pi.value, 10);
    if (!isNaN(v) && reader.book) renderAt({ page: v }, false);
    else pi.value = String(reader.page);
  };
  pi.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { commit(); pi.blur(); } });
  pi.addEventListener('blur', commit);

  // mouse reveal in zen
  el('reader').addEventListener('mousemove', peek);
  // Mouse: left-click anywhere pages forward, right-click pages back. Touch is
  // handled by the touch gesture handlers, so ignore the click it synthesises.
  el('r-stage').addEventListener('click', () => {
    if (lastPointerWasTouch) return;
    if (reader.capturing) return;
    if (suppressClick) { suppressClick = false; return; }
    if (window.getSelection && String(window.getSelection())) return;
    go(1);
  });
  el('r-stage').addEventListener('contextmenu', (e) => {
    if (lastPointerWasTouch) return;                 // leave touch long-press alone
    if (reader.capturing) return;
    if (window.getSelection && String(window.getSelection())) return;  // allow copy menu on a selection
    e.preventDefault();
    go(-1);
  });

  // Click the reader progress bar to seek (paged formats only; reflow/scroll/
  // media have native scroll/seek and are a graceful no-op here).
  const rprog = document.querySelector('.rprogress') as HTMLElement | null;
  rprog?.addEventListener('click', (e) => {
    const ad = reader.adapter; const b = reader.book;
    if (!ad || !b || ad.mode !== 'canvas') return;
    const rect = rprog.getBoundingClientRect();
    if (!rect.width) return;
    const frac = Math.min(Math.max(((e as MouseEvent).clientX - rect.left) / rect.width, 0), 1);
    const page = Math.round(frac * (b.numPages - 1)) + 1;
    renderAt({ page }, false);
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
    // Scroll formats: leave paging/scroll keys to the browser's native handling
    // (Space/PageDown scroll the column); only the global shortcuts below apply.
    const paged = reader.adapter ? reader.adapter.mode === 'canvas' : true;
    // Reflow (epub): Left/Right (and Space/PageUp/PageDown) turn pages via the
    // adapter; don't rely on the iframe having focus. Other keys fall through.
    if (reader.adapter?.mode === 'reflow') {
      if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') { e.preventDefault(); go(1); return; }
      if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); go(-1); return; }
    }
    // Media: Space toggles play/pause (native controls handle seeking). Other
    // keys fall through to global shortcuts (f/Escape) below.
    if (!paged && reader.adapter?.mode === 'media' && k === ' ') {
      e.preventDefault(); toggleMediaPlayback(); return;
    }
    if (paged && (k === 'ArrowRight' || k === 'PageDown' || k === ' ')) { e.preventDefault(); go(1); }
    else if (paged && (k === 'ArrowLeft' || k === 'PageUp')) { e.preventDefault(); go(-1); }
    else if (paged && k === 'ArrowDown') {
      // Scroll within a tall page; once at the bottom edge, flip to the next page.
      const stage = el('r-stage');
      const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 1;
      if (atBottom && reader.book && reader.page < reader.book.numPages) { e.preventDefault(); go(1); }
      else stage.scrollTop += 120;
    }
    else if (paged && k === 'ArrowUp') {
      const stage = el('r-stage');
      const atTop = stage.scrollTop <= 1;
      if (atTop && reader.page > 1) { e.preventDefault(); go(-1); }
      else stage.scrollTop -= 120;
    }
    else if (paged && k === 'Home') { e.preventDefault(); renderAt({ page: 1 }, false); }
    else if (paged && k === 'End' && reader.book) { e.preventDefault(); renderAt({ page: reader.book.numPages }, false); }
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
//  NOTE EDITOR
// ============================================================
// Standalone notes (Phase 1). A note is a library item with no PDF bytes; its
// body lives in the notes store (dbGetNote/dbPutNote). The editor mirrors the
// reader overlay conventions: fixed, .show toggle, body scroll-lock, Escape.
const noteEd = {
  book: null as Book | null,
  saveTimer: 0 as any,
  preview: false,   // markdown preview vs textarea
};

function noteFormatOf(b: Book): 'text' | 'markdown' { return b.noteFormat || 'markdown'; }

function setNoteFormatButtons(fmt: 'text' | 'markdown'): void {
  document.querySelectorAll('#note-format button').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.nf === fmt);
  });
}

// Toggle preview (markdown only): render the textarea into #note-render.
function setNotePreview(on: boolean): void {
  const b = noteEd.book;
  const isMd = b ? noteFormatOf(b) === 'markdown' : false;
  noteEd.preview = on && isMd;
  const ed = el('note-editor');
  ed.classList.toggle('preview', noteEd.preview);
  el('note-preview-toggle').classList.toggle('hidden', !isMd);
  if (noteEd.preview) {
    el('note-render').innerHTML = renderMarkdown((el('note-body') as HTMLTextAreaElement).value);
  }
}

function setNoteSaved(msg: string): void { el('note-saved').textContent = msg; }

// Mirror title/format edits into the in-memory books entry and re-render the lib.
function syncNoteMeta(): void {
  const b = noteEd.book; if (!b) return;
  const cached = books.find(x => x.id === b.id);
  if (cached) { cached.title = b.title; cached.noteFormat = b.noteFormat; cached.lastReadAt = b.lastReadAt; }
}

async function openNote(id: string): Promise<void> {
  const meta = books.find(x => x.id === id);
  if (!meta) { toast(t('toast.cantOpen')); return; }
  const b = meta as Book;
  noteEd.book = b;
  (el('note-title') as HTMLInputElement).value = b.title || '';
  setNoteFormatButtons(noteFormatOf(b));
  setNoteSaved('');
  const ed = el('note-editor');
  ed.classList.add('show');
  document.body.style.overflow = 'hidden';
  let body = '';
  try { body = await dbGetNote(id); }
  catch (e) { if (e instanceof ApiAuthError) { closeNote(); return; } }
  (el('note-body') as HTMLTextAreaElement).value = body;
  // Markdown notes open in preview with an Edit affordance; plain opens to text.
  setNotePreview(noteFormatOf(b) === 'markdown');
  if (!noteEd.preview) (el('note-body') as HTMLTextAreaElement).focus();
}

function closeNote(): void {
  el('note-editor').classList.remove('show', 'preview');
  document.body.style.overflow = '';
  window.clearTimeout(noteEd.saveTimer);
  noteEd.book = null;
  noteEd.preview = false;
  renderLibrary();
}

// Autosave the body, debounced. Uses a fresh title from the first line if blank.
function scheduleNoteSave(): void {
  const b = noteEd.book; if (!b) return;
  window.clearTimeout(noteEd.saveTimer);
  noteEd.saveTimer = window.setTimeout(async () => {
    if (!noteEd.book || noteEd.book.id !== b.id) return;
    const body = (el('note-body') as HTMLTextAreaElement).value;
    b.lastReadAt = Date.now();
    syncNoteMeta();
    try {
      await dbPutNote(b.id, body);
      track('note_save');
      setNoteSaved(navigator.onLine ? t('note.saved') : t('note.savedOffline'));
    } catch (e) {
      if (e instanceof ApiNetworkError) setNoteSaved(t('note.savedOffline'));
      else console.error(e);
    }
  }, 350);
}

// Derive a title from the first non-blank line (markdown heading hashes stripped).
function deriveNoteTitle(body: string): string {
  const line = body.split('\n').map(s => s.trim()).find(s => s.length) || '';
  return line.replace(/^#+\s*/, '').slice(0, 120);
}

// Persist title/format metadata (on blur/change), mirroring into books + lib.
async function saveNoteMeta(): Promise<void> {
  const b = noteEd.book; if (!b) return;
  const input = el('note-title') as HTMLInputElement;
  let title = input.value.trim();
  if (!title) {
    title = deriveNoteTitle((el('note-body') as HTMLTextAreaElement).value) || t('note.untitled');
  }
  b.title = title;
  syncNoteMeta();
  renderLibrary();
  try { await dbPutNoteMeta(b.id, { title: b.title, noteFormat: b.noteFormat }); }
  catch (e) { if (!(e instanceof ApiNetworkError)) console.error(e); }
}

async function changeNoteFormat(fmt: 'text' | 'markdown'): Promise<void> {
  const b = noteEd.book; if (!b || noteFormatOf(b) === fmt) return;
  b.noteFormat = fmt;
  setNoteFormatButtons(fmt);
  syncNoteMeta();
  setNotePreview(false);   // switching format drops back to the editable textarea
  renderLibrary();
  try { await dbPutNoteMeta(b.id, { noteFormat: fmt }); }
  catch (e) { if (!(e instanceof ApiNetworkError)) console.error(e); }
}

async function createNote(): Promise<void> {
  // id MUST start with 'n' so the backend's isNoteId() recognizes it.
  const id = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const note: Book = {
    id, title: '', author: '', fileName: '', data: new ArrayBuffer(0),
    numPages: 1, currentPage: 1, cover: null,
    addedAt: Date.now(), lastReadAt: 0, format: 'note', noteFormat: 'markdown',
  };
  try {
    await dbCreateNote(stripData(note));
  } catch (e) {
    if (e instanceof ApiNetworkError) { toast(t('toast.offlineRetry')); return; }
    console.error(e); toast(t('toast.cantOpen')); return;
  }
  books.unshift(note);
  renderLibrary();
  toast(t('toast.noteCreated'));
  track('note_create');
  openNote(id);
}

async function deleteNote(): Promise<void> {
  const b = noteEd.book; if (!b) return;
  const title = b.title || t('note.untitled');
  if (!await confirmDialog(t('note.confirmDelete', { title }))) return;
  const id = b.id;
  try { await dbDelNote(id); }
  catch (e) {
    if (e instanceof ApiNetworkError) { toast(t('toast.offlineRetry')); return; }
    console.error(e);
  }
  books = books.filter(x => x.id !== id);
  closeNote();
  toast(t('toast.noteRemoved'));
}

// ---------- add menu (masthead "Add" dropdown) ----------
// Mirrors the avatar dropdown's open/close semantics, plus aria-expanded and the
// three actions (upload / new note / link media), each of which closes the menu.
function closeAddMenu(): void {
  el('add-menu').classList.add('hidden');
  el('btn-add').setAttribute('aria-expanded', 'false');
}
function wireAddMenu(): void {
  el('btn-add').addEventListener('click', (e) => {
    e.stopPropagation();
    el('dropdown').classList.add('hidden');   // close the avatar menu if open
    const hidden = el('add-menu').classList.toggle('hidden');
    el('btn-add').setAttribute('aria-expanded', hidden ? 'false' : 'true');
  });
  document.addEventListener('click', () => closeAddMenu());
  el('add-menu').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && !el('add-menu').classList.contains('hidden')) closeAddMenu();
  });
  el('add-books').addEventListener('click', () => { closeAddMenu(); el('file-input').click(); });
  el('add-note').addEventListener('click', () => { closeAddMenu(); createNote(); });
  el('add-link').addEventListener('click', () => { closeAddMenu(); openLinkSheet(); });
}

function wireNotes(): void {
  el('note-back').addEventListener('click', closeNote);
  el('note-delete').addEventListener('click', deleteNote);

  el('note-body').addEventListener('input', scheduleNoteSave);

  const titleInput = el('note-title') as HTMLInputElement;
  titleInput.addEventListener('blur', saveNoteMeta);
  titleInput.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); titleInput.blur(); }
  });

  el('note-format').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button') as HTMLElement | null;
    if (!btn) return;
    changeNoteFormat(btn.dataset.nf as 'text' | 'markdown');
  });

  // Preview toggle flips between rendered markdown and the editable textarea.
  el('note-preview-toggle').addEventListener('click', () => {
    if (!noteEd.book || noteFormatOf(noteEd.book) !== 'markdown') return;
    const next = !noteEd.preview;
    setNotePreview(next);
    if (!next) (el('note-body') as HTMLTextAreaElement).focus();
  });

  document.addEventListener('keydown', (e) => {
    if (!el('note-editor').classList.contains('show')) return;
    if ((e as KeyboardEvent).key === 'Escape') closeNote();
  });
}

// ============================================================
//  AUTH
// ============================================================
function showApp(name: string): void {
  el('login').classList.add('hidden');
  el('app').classList.remove('hidden');
  void setCatalogTab('books');
  const initial = (name.trim()[0] || t('common.reader')[0]).toUpperCase();
  el('avatar-initial').textContent = initial;
  el('user-name').textContent = name.trim() || t('common.reader');
}
type AuthStep = 'signin' | 'signup' | 'confirm' | 'forgot' | 'reset';

function wireAuth(): void {
  let pendingUsername = '';
  let pendingSignupPass = '';
  let forgotUsername = '';

  const STEP_FORM: Record<AuthStep, string> = {
    signin: 'signin-form',
    signup: 'signup-form',
    confirm: 'confirm-step',
    forgot: 'forgot-form',
    reset: 'reset-form',
  };

  function showAuthStep(step: AuthStep): void {
    const showTabs = step === 'signin' || step === 'signup';
    el('auth-tabs').classList.toggle('hidden', !showTabs);
    for (const [s, id] of Object.entries(STEP_FORM)) {
      el(id).classList.toggle('hidden', s !== step);
    }
    if (showTabs) {
      el('auth-tabs').querySelectorAll('.auth-tab').forEach((btn) => {
        btn.classList.toggle('active', (btn as HTMLElement).dataset.tab === step);
      });
    }
  }
  _showAuthStep = (s) => showAuthStep(s as AuthStep);

  // Shared POST helper — same-origin JSON, never throws on HTTP status.
  const post = (path: string, payload: unknown) => fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  });

  async function enterApp(username: string): Promise<void> {
    localStorage.setItem(LS.user, JSON.stringify({ name: username }));
    showApp(username);
    await boot();
  }

  el('auth-tabs').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null;
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (tab === 'signin' || tab === 'signup') showAuthStep(tab);
  });

  el<HTMLFormElement>('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = (el('signin-user') as HTMLInputElement).value.trim();
    const pass = (el('signin-pass') as HTMLInputElement).value;
    if (!username || !pass) return;
    try {
      const res = await post('/api/auth/login', { username, password: pass });
      if (res.status === 403) {
        // Account exists but email not confirmed — route to the confirm step.
        pendingUsername = username;
        pendingSignupPass = pass;
        showAuthStep('confirm');
        toast(t('auth.checkEmail'));
        return;
      }
      if (!res.ok) { toast(t('toast.wrongPass')); return; }
      const data = await res.json();
      track('login', { method: 'cognito' });
      await enterApp(data.username ?? username);
    } catch {
      toast(t('toast.noServer'));
    }
  });

  el<HTMLFormElement>('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = (el('signup-user') as HTMLInputElement).value.trim();
    const email = (el('signup-email') as HTMLInputElement).value.trim();
    const pass = (el('signup-pass') as HTMLInputElement).value;
    try {
      const res = await post('/api/auth/signup', { username, email, password: pass });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        toast(data.error || t('toast.signUpFailed'));
        return;
      }
      pendingUsername = username;
      pendingSignupPass = pass;
      showAuthStep('confirm');
    } catch {
      toast(t('toast.noServer'));
    }
  });

  el<HTMLFormElement>('confirm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = (el('confirm-code') as HTMLInputElement).value.trim();
    try {
      const res = await post('/api/auth/confirm', { username: pendingUsername, code });
      if (!res.ok) { toast(t('toast.confirmFailed')); return; }
      // Auto sign-in when we still hold the password from this session.
      if (pendingSignupPass) {
        const loginRes = await post('/api/auth/login', { username: pendingUsername, password: pendingSignupPass });
        pendingSignupPass = '';
        if (loginRes.ok) {
          const data = await loginRes.json();
          track('sign_up', { method: 'cognito' });
          await enterApp(data.username ?? pendingUsername);
          return;
        }
      }
      showAuthStep('signin');
    } catch {
      toast(t('toast.noServer'));
    }
  });

  el('btn-resend').addEventListener('click', async () => {
    try {
      await post('/api/auth/resend', { username: pendingUsername });
      toast(t('auth.checkEmail'));
    } catch {
      toast(t('toast.noServer'));
    }
  });

  el('btn-forgot').addEventListener('click', () => showAuthStep('forgot'));
  el('btn-back-signin').addEventListener('click', () => showAuthStep('signin'));

  el<HTMLFormElement>('forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    forgotUsername = (el('forgot-user') as HTMLInputElement).value.trim();
    if (!forgotUsername) return;
    try {
      await post('/api/auth/forgot', { username: forgotUsername });
      toast(t('auth.resetSent'));
      showAuthStep('reset');
    } catch {
      toast(t('toast.noServer'));
    }
  });

  el<HTMLFormElement>('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = (el('reset-code') as HTMLInputElement).value.trim();
    const pass = (el('reset-pass') as HTMLInputElement).value;
    try {
      const res = await post('/api/auth/confirm-forgot', { username: forgotUsername, code, password: pass });
      if (!res.ok) { toast(t('toast.resetFailed')); return; }
      toast(t('auth.passwordReset'));
      showAuthStep('signin');
    } catch {
      toast(t('toast.noServer'));
    }
  });

  el('avatar').addEventListener('click', (e) => {
    e.stopPropagation();
    closeAddMenu();
    el('dropdown').classList.toggle('hidden');
  });
  document.addEventListener('click', () => el('dropdown').classList.add('hidden'));
  el('dropdown').addEventListener('click', (e) => e.stopPropagation());
  wireAddMenu();
  el('btn-logout').addEventListener('click', async () => {
    track('logout');
    try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    localStorage.removeItem(LS.user);
    // Logout means "this device is no longer mine": drop everything local.
    localStorage.removeItem(LS.pdfLru);
    localStorage.removeItem(LS.progressQueue);
    localStorage.removeItem(LS.clipQueue);
    localStorage.removeItem(LS.noteQueue);
    try {
      await Promise.all([caches.delete(PDF_CACHE), caches.delete(DATA_CACHE), caches.delete(SHARED_CACHE)]);
    } catch {}
    offlineIds = new Set();
    el('app').classList.add('hidden');
    el('login').classList.remove('hidden');
    el('dropdown').classList.add('hidden');
    (el('signin-pass') as HTMLInputElement).value = '';
    _showAuthStep('signin');
    booted = false;
    books = [];
    collections = [];
    catalogEntities = { authors: [], publishers: [] };
    catalogTab = 'books';
    void showWaitingCue();
  });
  el('brand').addEventListener('click', () => {
    if (el('reader').classList.contains('show')) closeReader();
    void setCatalogTab('books');
  });
}

// ============================================================
//  UPLOAD WIRING + DRAG/DROP
// ============================================================
function wireUpload(): void {
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

// ---------- linked media (add by URL) ----------
let linkKind: 'audio' | 'video' = 'audio';
async function submitLinkedMedia(): Promise<void> {
  const url = (el<HTMLInputElement>('link-url').value || '').trim();
  let ok = false; try { ok = new URL(url).protocol === 'https:'; } catch { /* invalid */ }
  if (!ok) { toast(t('media.link.badUrl')); return; }
  const b = ingestLinkedMedia(url, el<HTMLInputElement>('link-title').value, el<HTMLInputElement>('link-author').value, linkKind);
  try { await dbPut(b); }
  catch (e) {
    if (e instanceof ApiNetworkError) { toast(t('toast.offlineAdd')); return; }
    toast(t('toast.cantRead', { name: url })); return;
  }
  b.data = new ArrayBuffer(0); books.unshift(b);
  closeLinkSheet();
  renderLibrary(); toast(t('media.link.added'));
}
function openLinkSheet(): void {
  const sheet = el('link-sheet');
  sheet.classList.remove('hidden');
  (sheet as any)._untrap = trapFocus(sheet);
}
function closeLinkSheet(): void {
  const sheet = el('link-sheet');
  (sheet as any)._untrap?.();
  sheet.classList.add('hidden');
}
function wireLinkSheet(): void {
  el('link-cancel').addEventListener('click', closeLinkSheet);
  el('link-add').addEventListener('click', submitLinkedMedia);
  el('link-sheet').addEventListener('click', (e) => { if (e.target === el('link-sheet')) closeLinkSheet(); });
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && !el('link-sheet').classList.contains('hidden')) closeLinkSheet();
  });
  el('link-kind').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button') as HTMLElement | null; if (!btn) return;
    linkKind = btn.dataset.kind as 'audio' | 'video';
    el('link-kind').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === btn));
  });
}

// ============================================================
//  BOOT
// ============================================================
let booted = false;

// A gentle sequential matcher avoids request bursts against Open Library. Exact
// ISBNs auto-link server-side; title/author results remain reviewable suggestions.
async function checkCatalogMatches(candidates: Book[] = books): Promise<void> {
  for (const book of candidates) {
    const cacheDays = book.catalogMatchStatus === 'none' ? 1 : 30;
    const staleBefore = Date.now() - cacheDays * 24 * 60 * 60 * 1000;
    if (isNote(book) || book.catalogBookId || (book.catalogCheckedAt ?? 0) > staleBefore) continue;
    try {
      book.catalogMatchStatus = 'checking';
      const response = await api('/books/' + encodeURIComponent(book.id) + '/catalog-check', {
        method: 'POST', body: '{}',
      });
      if (!response.ok) continue;
      const result = await response.json();
      if (result.matched && result.book) Object.assign(book, result.book);
      else {
        book.catalogSuggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
        book.catalogMatchStatus = book.catalogSuggestions.length ? 'suggested' : 'none';
        book.catalogCheckedAt = Date.now();
      }
    } catch (error) {
      if (error instanceof ApiNetworkError) break;
    }
  }
  if (catalogTab === 'books') renderLibrary();
}

// Pull the library list, retrying a transient launch-time network failure.
// Installed PWAs routinely cold-start before the radio/DNS is ready: the first
// /api/books rejects while navigator.onLine is already true, so the 'online'
// event never fires to trigger a retry. Without this, a fresh device (no cached
// snapshot) is stranded on an empty shelf — which reads as "my books didn't
// sync across devices". A cached snapshot short-circuits dbAll (no throw), so
// these retries only ever run on the genuine fresh-device case.
async function loadLibrary(): Promise<void> {
  const backoff = [800, 1600, 3200];
  for (let attempt = 0; ; attempt++) {
    try {
      books = (await dbAll()) as unknown as Book[];
      return;
    } catch (e) {
      if (e instanceof ApiAuthError) throw e;   // real logout — api() already showed login
      if (attempt >= backoff.length) throw e;   // give up; caller shows an empty shelf
      await new Promise((r) => setTimeout(r, backoff[attempt]));
    }
  }
}

async function boot(): Promise<void> {
  if (booted) { renderLibrary(); return; }
  booted = true;
  flushProgressQueue();   // replay page turns queued while offline
  flushClipQueue();       // replay clipping create/delete ops queued offline
  flushNoteQueue();       // replay note-body edits queued offline
  await refreshOfflineIds();
  try {
    await loadLibrary();
  } catch (e) {
    console.error('api error', e);
    books = [];
    booted = false;       // first-run offline: a later resync (online/foreground) retries
  }
  pruneActiveCollections();   // drop active filters whose collection no longer exists
  renderLibrary();
  void checkCatalogMatches();
  await handleLaunchParams();
  await drainLaunchFiles();   // shelve files opened with Folium before sign-in
}

// Re-pull the library from the server when the device comes back online or the
// app returns to the foreground. This is what actually keeps an installed PWA in
// sync across devices: cold-start handles the first load, but a long-lived PWA
// that's resumed (not reloaded) would otherwise keep showing whatever it had
// when last backgrounded. Cheap and idempotent — dbAll is network-first and the
// flushes no-op when offline. Skipped on the login screen and while a book is
// open so it never clobbers active reading state.
async function resyncLibrary(): Promise<void> {
  flushProgressQueue();
  flushClipQueue();
  flushNoteQueue();
  if (el('app').classList.contains('hidden')) return;     // not signed in
  if (el('reader').classList.contains('show')) return;    // mid-read — leave it be
  if (!booted) { await boot(); return; }                  // the initial load never succeeded
  try {
    books = (await dbAll()) as unknown as Book[];
    pruneActiveCollections();
    if (catalogTab === 'books') renderLibrary();
    else await setCatalogTab(catalogTab);
  } catch { /* offline or logged out — dbAll()/api() already drove the UI */ }
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

// mediaFormatForUrl (the shared-URL → audio/video/null decision) is imported
// from ./share-routing.mjs so it can be unit-tested without a browser.

// Shelve a shared media URL as a url-backed linked-media Book (no bytes stored).
function linkedMediaFromShared(url: string, fmt: 'audio' | 'video', title?: string): Promise<Book> {
  return (async () => {
    const b = ingestLinkedMedia(url, (title || '').trim(), '', fmt);
    await dbPut(b);
    b.data = new ArrayBuffer(0);
    return b;
  })();
}

// Shelve a shared link/text payload as a markdown note. The body is the trimmed
// text and url joined by a blank line (whichever are present); the title falls
// back to a derived heading, then to a localized default. Stored verbatim.
async function noteFromShared(rec: { title?: string; text?: string; url?: string }): Promise<Book> {
  const text = (rec.text || '').trim();
  const url = (rec.url || '').trim();
  const body = [text, url].filter(Boolean).join('\n\n');
  const title = (rec.title || '').trim() || deriveNoteTitle(body) || t('share.note.untitled');
  // id MUST start with 'n' so the backend's isNoteId() recognizes it.
  const id = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const note: Book = {
    id, title, author: '', fileName: '', data: new ArrayBuffer(0),
    numPages: 1, currentPage: 1, cover: null,
    addedAt: Date.now(), lastReadAt: 0, format: 'note', noteFormat: 'markdown',
  };
  await dbCreateNote(stripData(note));
  if (body) await dbPutNote(id, body);
  return note;
}

// Items received via the OS share sheet wait in the shared cache (put there by
// the service worker) until someone is signed in to shelve them. Files (`/shared/`
// keys) carry the real content-type so ingest() routes them by detectFormat;
// shared links/text (`/shared-link/` keys, JSON body {title,text,url}) become a
// linked-media Book when the URL is a media file, otherwise a markdown note.
// Every item is deleted whether it shelved or not, so a poison item can't
// re-trip on every launch.
async function drainSharedCache(): Promise<void> {
  try {
    const cache = await caches.open(SHARED_CACHE);
    const keys = await cache.keys();
    if (!keys.length) return;
    toast(tn('toast.shelvingShared', keys.length));
    let ok = 0, failed = 0;
    for (const req of keys) {
      try {
        const res = await cache.match(req);
        if (!res) { await cache.delete(req); continue; }
        const path = new URL(req.url).pathname;
        let b: Book | null;
        if (path.startsWith('/shared-link/')) {
          const rec = await res.json();
          const mf = rec.url ? mediaFormatForUrl(rec.url) : null;
          b = (rec.url && mf) ? await linkedMediaFromShared(rec.url, mf, rec.title) : await noteFromShared(rec);
        } else {
          const name = decodeURIComponent(res.headers.get('x-file-name') || '') || 'Shared';
          const type = res.headers.get('content-type') || undefined;
          const buf = await res.arrayBuffer();
          b = await ingest({ name, buf, type });
        }
        if (b) { books.unshift(b); ok++; } else failed++;
      } catch (e) {
        console.warn('shared item failed', e);
        failed++;
      }
      await cache.delete(req);
    }
    renderLibrary();
    shelveSummaryToast(ok, failed);
  } catch (e) { console.warn('shared intake failed', e); }
}

// ---------- pre-login waiting cue ----------
// How many items are parked in the shared cache awaiting a signed-in user.
async function sharedWaitingCount(): Promise<number> {
  try { return (await (await caches.open(SHARED_CACHE)).keys()).length; } catch { return 0; }
}

// Show/hide the login-card hint telling the user shared items are waiting.
async function showWaitingCue(): Promise<void> {
  const n = await sharedWaitingCount();
  const node = el('login-waiting');
  if (n > 0) { node.textContent = tn('share.waiting', n); node.classList.remove('hidden'); }
  else node.classList.add('hidden');
}

// ---------- launchQueue / file_handlers (open-with) ----------
// Files opened with Folium from the OS (file_handlers) arrive via launchQueue.
// If opened before sign-in, they wait here until boot() drains them post-auth.
let pendingLaunchFiles: FileSystemFileHandle[] = [];
function wireLaunchQueue(): void {
  if (!window.launchQueue) return;
  window.launchQueue.setConsumer(p => {
    const files = p.files || [];
    if (!files.length) return;
    pendingLaunchFiles.push(...files);
    if (booted) void drainLaunchFiles();
  });
}
async function drainLaunchFiles(): Promise<void> {
  if (!pendingLaunchFiles.length) return;
  const handles = pendingLaunchFiles;
  pendingLaunchFiles = [];
  toast(tn('toast.shelving', handles.length));
  let ok = 0, failed = 0;
  for (const h of handles) {
    try {
      const file = await (h as any).getFile() as File;
      const b = await ingest(file);
      if (b) { books.unshift(b); ok++; } else failed++;
    } catch (e) {
      console.warn('launch file failed', e);
      failed++;
    }
  }
  renderLibrary();
  shelveSummaryToast(ok, failed);
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

  window.addEventListener('online', () => { void resyncLibrary(); });
  // Foreground resume: the 'online' event is unreliable on mobile PWAs (the OS
  // often reports online before requests actually succeed), so re-sync whenever
  // the app becomes visible again — the moment a user expects to see what they
  // added on another device.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void resyncLibrary();
  });

  let deferredInstall: any = null;

  // Proactive install offer + A/B test. We can't show the OS install prompt
  // whenever we like — it requires the saved `beforeinstallprompt` event — so we
  // hold onto it and surface a custom banner once the reader has come back. The
  // experiment splits returning users 50/50 between offering on their 2nd visit
  // vs their 3rd, to learn which return point converts better.
  const variant = pwaVariant();
  const threshold = variant === 'visit2' ? 2 : 3;

  async function runInstallPrompt(source: 'menu' | 'banner'): Promise<void> {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try {
      const choice = await deferredInstall.userChoice;
      track('pwa_install_choice', { variant, source, outcome: choice?.outcome || 'unknown' });
      if (choice?.outcome === 'accepted') track('pwa_install', { variant, source });
    } catch { /* dismissed */ }
    deferredInstall = null;
    el('btn-install').classList.add('hidden');
    hideInstallOffer();
  }

  function maybeOfferInstall(): void {
    if (!deferredInstall) return;
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if (localStorage.getItem(PWA_PROMPT_DONE)) return;         // already installed or dismissed
    if (pwaVisits() < threshold) return;                       // not a far enough return visit yet
    const banner = el('install-banner');
    if (!banner.classList.contains('hidden')) return;          // already showing
    banner.classList.remove('hidden');
    requestAnimationFrame(() => banner.classList.add('show'));
    track('pwa_prompt_shown', { variant, visit: pwaVisits() });
  }

  function hideInstallOffer(): void {
    const banner = el('install-banner');
    banner.classList.remove('show');
    banner.classList.add('hidden');
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    e.preventDefault();
    deferredInstall = e;
    el('btn-install').classList.remove('hidden');
    maybeOfferInstall();
  });

  el('install-accept').addEventListener('click', () => {
    localStorage.setItem(PWA_PROMPT_DONE, '1');
    void runInstallPrompt('banner');
  });
  el('install-dismiss').addEventListener('click', () => {
    localStorage.setItem(PWA_PROMPT_DONE, '1');
    track('pwa_prompt_dismiss', { variant, visit: pwaVisits() });
    hideInstallOffer();
  });

  el('btn-install').addEventListener('click', () => {
    el('dropdown').classList.add('hidden');
    void runInstallPrompt('menu');
  });
  window.addEventListener('appinstalled', () => {
    localStorage.setItem(PWA_PROMPT_DONE, '1');
    el('btn-install').classList.add('hidden');
    hideInstallOffer();
    toast(t('pwa.installed'));
  });
}

// ---------- PWA install A/B experiment ----------
const PWA_VISITS = 'folium.pwaVisits';
const PWA_VARIANT = 'folium.pwaVariant';
const PWA_PROMPT_DONE = 'folium.pwaPromptDone';
const PWA_SESSION = 'folium.pwaSession';

// Count one visit per browsing session (a reload inside the same tab/session
// doesn't inflate the count). Called once at boot, before the prompt is wired.
function countPwaVisit(): void {
  try {
    if (sessionStorage.getItem(PWA_SESSION)) return;
    sessionStorage.setItem(PWA_SESSION, '1');
    localStorage.setItem(PWA_VISITS, String(pwaVisits() + 1));
  } catch { /* storage unavailable — feature simply stays off */ }
}

function pwaVisits(): number {
  const n = parseInt(localStorage.getItem(PWA_VISITS) || '0', 10);
  return Number.isFinite(n) ? n : 0;
}

// Sticky 50/50 assignment, decided on first contact and kept for the user.
function pwaVariant(): 'visit2' | 'visit3' {
  const stored = localStorage.getItem(PWA_VARIANT);
  if (stored === 'visit2' || stored === 'visit3') return stored;
  const v: 'visit2' | 'visit3' = Math.random() < 0.5 ? 'visit2' : 'visit3';
  try { localStorage.setItem(PWA_VARIANT, v); } catch { /* ignore */ }
  return v;
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
  const themeSel = el<HTMLSelectElement>('theme-select');
  const closeSettings = () => { (modal as any)._untrap?.(); modal.classList.add('hidden'); };
  function syncTypeReadout(): void {
    el('type-size-val').textContent = Math.round(readerFontScale * 100) + '%';
    el('type-lh-val').textContent = readerLineHeight.toFixed(2);
  }
  el('type-size-dec').addEventListener('click', () => { setReaderFontScale(readerFontScale - TYPE_LIMITS.scaleStep); syncTypeReadout(); });
  el('type-size-inc').addEventListener('click', () => { setReaderFontScale(readerFontScale + TYPE_LIMITS.scaleStep); syncTypeReadout(); });
  el('type-lh-dec').addEventListener('click', () => { setReaderLineHeight(readerLineHeight - TYPE_LIMITS.lhStep); syncTypeReadout(); });
  el('type-lh-inc').addEventListener('click', () => { setReaderLineHeight(readerLineHeight + TYPE_LIMITS.lhStep); syncTypeReadout(); });
  el('btn-settings').addEventListener('click', () => {
    sel.value = localStorage.getItem(LS.lang) || 'system';
    themeSel.value = themePref;
    syncTypeReadout();
    modal.classList.remove('hidden');
    el('dropdown').classList.add('hidden');
    (modal as any)._untrap = trapFocus(modal, sel);
  });
  sel.addEventListener('change', () => setLanguage(sel.value as LangPref));  // applies live
  themeSel.addEventListener('change', () => setTheme(themeSel.value as ThemePref));
  el('settings-done').addEventListener('click', closeSettings);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeSettings(); });
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && !modal.classList.contains('hidden')) closeSettings();
  });
}

function wireAbout(): void {
  const modal = el('about');
  const closeBtn = el('about-done');
  const closeAbout = () => { (modal as any)._untrap?.(); modal.classList.add('hidden'); };
  el('btn-about').addEventListener('click', () => {
    modal.classList.remove('hidden');
    el('dropdown').classList.add('hidden');
    (modal as any)._untrap = trapFocus(modal, closeBtn);
  });
  closeBtn.addEventListener('click', closeAbout);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeAbout(); });
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && !modal.classList.contains('hidden')) closeAbout();
  });
}

function init(): void {
  locale = resolveLocale();
  pluralRules = new Intl.PluralRules(locale);
  applyI18n();
  applyReaderType();
  applyTheme();
  setupMarked();
  wireAuth();
  wireSettings();
  wireAbout();
  wireNotes();
  _onUnauthorized = () => {
    localStorage.removeItem(LS.user);
    el('app').classList.add('hidden');
    el('login').classList.remove('hidden');
    _showAuthStep('signin');
    booted = false;
    books = [];
    collections = [];
    catalogEntities = { authors: [], publishers: [] };
    catalogTab = 'books';
    void showWaitingCue();
  };
  wireViewSwitch();
  wireCatalogTabs();
  wireThemeToggle();
  wireLibrary();
  wireUpload();
  wireCollectionPicker();
  wireCollectionManager();
  wireBookDetails();
  wireLinkSheet();
  wireReader();
  countPwaVisit();   // must run before wirePwa reads the visit count
  wirePwa();
  wireLaunchQueue();
  // restore session
  const saved = localStorage.getItem(LS.user);
  if (saved) {
    try {
      const u = JSON.parse(saved);
      showApp(u.name || t('common.reader'));
      boot();
    } catch { /* show login */ }
  } else {
    void showWaitingCue();   // login is visible — surface any parked shared items
  }
}

init();

})();
