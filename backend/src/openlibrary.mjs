// Open Library book lookup. Backs POST /api/booklookup: given a title+author or
// an ISBN, return a small list of candidate matches with normalized metadata and
// a derived Goodreads link (Open Library carries `id_goodreads` for many
// editions). No persistence, no AWS — just one outbound fetch to openlibrary.org.
//
// Mirrors bedrock.mjs: pure, exported normalizers + one async orchestrator whose
// transport (`fetch`) is injectable so tests run fully offline.

const SEARCH_URL = 'https://openlibrary.org/search.json';
const COVER_BASE = 'https://covers.openlibrary.org/b';
const GOODREADS_SHOW = 'https://www.goodreads.com/book/show/';
const GOODREADS_SEARCH = 'https://www.goodreads.com/search?q=';

// Open Library asks callers to send a descriptive User-Agent; it also improves
// rate-limit treatment. Overridable via env for staging/contact changes.
const USER_AGENT =
  process.env.OL_USER_AGENT || 'FoliumCafe/1.0 (+https://folium.cafe; m@rco.sh)';

// Only these doc fields are requested (keeps the response small and means a
// single search call already carries the Goodreads id + ISBN we need).
const FIELDS = 'key,title,author_name,first_publish_year,cover_i,isbn,id_goodreads';

const TIMEOUT_MS = 5000;
const DEFAULT_LIMIT = 10;

const defaultFetch = (...a) => globalThis.fetch(...a);

// Trim a string; undefined when empty/blank or not a string.
function str(v) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

// PURE, exported. The Goodreads show URL for a numeric id, else null. Goodreads
// show ids are always numeric, so this doubles as sanitization — anything that
// isn't a run of digits is discarded.
export function buildGoodreadsUrl(id) {
  const s = id == null ? '' : String(id).trim();
  return /^\d+$/.test(s) ? GOODREADS_SHOW + s : null;
}

// PURE, exported. Prefer the Open Library cover-by-id endpoint; fall back to
// cover-by-isbn; null when we have neither.
export function buildCoverUrl(coverI, isbn) {
  if (coverI != null && /^\d+$/.test(String(coverI))) {
    return `${COVER_BASE}/id/${coverI}-M.jpg`;
  }
  const i = str(isbn);
  if (i) return `${COVER_BASE}/isbn/${encodeURIComponent(i)}-M.jpg`;
  return null;
}

// PURE, exported. A Goodreads *search* URL for a book, used as the fallback link
// when no Goodreads id is known so "View on Goodreads" is never a dead end.
export function buildSearchFallback({ isbn, title, author } = {}) {
  const q = str(isbn) || [str(title), str(author)].filter(Boolean).join(' ');
  if (!q) return null;
  return GOODREADS_SEARCH + encodeURIComponent(q);
}

// PURE, exported. Coerce a raw search query into a clean shape: trimmed strings,
// a limit clamped to [1, 20], and the chosen mode (isbn beats title).
export function normalizeQuery({ isbn, title, author, limit } = {}) {
  const n = Number(limit);
  const clamped = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 20) : DEFAULT_LIMIT;
  return {
    isbn: str(isbn),
    title: str(title),
    author: str(author),
    limit: clamped,
  };
}

// Prefer a 13-digit ISBN, else the first; strip separators to digits/X.
function pickIsbn(list) {
  if (!Array.isArray(list)) return undefined;
  const cleaned = list
    .map((v) => (typeof v === 'string' ? v.replace(/[^0-9Xx]/g, '').toUpperCase() : ''))
    .filter((v) => v.length);
  if (!cleaned.length) return undefined;
  return cleaned.find((v) => v.length === 13) || cleaned[0];
}

// PURE, exported. Map one Open Library search doc to a candidate. Every field is
// normalized to a clean value (or undefined / null / []), and a per-candidate
// Goodreads link is derived (id link when present, search fallback otherwise).
export function mapDoc(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};

  const title = str(d.title);
  const authors = Array.isArray(d.author_name)
    ? d.author_name.map((a) => str(a)).filter((a) => a !== undefined)
    : [];
  const year = Number.isFinite(d.first_publish_year) ? Math.trunc(d.first_publish_year) : undefined;
  const isbn = pickIsbn(d.isbn);
  const coverUrl = buildCoverUrl(d.cover_i, isbn);

  const grId = Array.isArray(d.id_goodreads) ? d.id_goodreads[0] : d.id_goodreads;
  const goodreadsUrl = buildGoodreadsUrl(grId);
  const searchUrl = buildSearchFallback({ isbn, title, author: authors[0] });

  return { title, authors, year, isbn, coverUrl, goodreadsUrl, searchUrl };
}

// async; `deps.fetch` is injectable (default = global fetch) so tests pass a
// fake. Performs one Open Library search and returns mapped candidates. Throws
// on any transport / non-2xx / parse failure (the handler maps that to 502).
export async function searchBooks(query, deps = {}) {
  const fetchImpl = deps.fetch || defaultFetch;
  const { isbn, title, author, limit } = normalizeQuery(query);

  const params = new URLSearchParams({ fields: FIELDS, limit: String(limit) });
  if (isbn) params.set('isbn', isbn);
  else {
    if (title) params.set('title', title);
    if (author) params.set('author', author);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${SEARCH_URL}?${params.toString()}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res || !res.ok) {
    throw new Error('openlibrary ' + (res ? res.status : 'no-response'));
  }
  const data = await res.json();
  const docs = Array.isArray(data?.docs) ? data.docs : [];
  return docs.slice(0, limit).map(mapDoc);
}
