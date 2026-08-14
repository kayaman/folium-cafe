import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, getBook, listBooks, setBookCatalog, setBookCatalogEntities } from './repo.mjs';
import { publisherId, searchBooks } from './openlibrary.mjs';

const TABLE = process.env.CATALOG_TABLE_NAME;
const CACHE_SECONDS = 30 * 24 * 60 * 60;
const META_FIELDS = [
  'title', 'subtitle', 'authors', 'publisher', 'year', 'isbn', 'language',
  'goodreadsUrl', 'coverUrl', 'sourceUrl',
];

const clean = (value, max = 500) => typeof value === 'string' && value.trim()
  ? value.trim().slice(0, max) : undefined;
const cleanId = (value, prefix) => {
  const id = clean(value, 180);
  return id && id.startsWith(prefix) ? id : undefined;
};
const safeUrl = (value, hosts) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
      ? url.toString() : undefined;
  } catch { return undefined; }
};

function compact(value) {
  if (Array.isArray(value)) return value.map(compact).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, compact(item)]));
  }
  return value;
}

export function sanitizeCandidate(input = {}) {
  const rawBookId = cleanId(input.catalogBookId, 'ol-');
  const catalogBookId = rawBookId && /^ol-(?:edition:OL\d+M|work:OL\d+W)$/.test(rawBookId) ? rawBookId : undefined;
  if (!catalogBookId) return null;
  const authors = Array.isArray(input.authorEntities)
    ? input.authorEntities.slice(0, 20).map((a) => ({
      id: (() => {
        const external = cleanId(a?.id, 'ol-author:');
        if (external && /^ol-author:OL\d+A$/.test(external)) return external;
        const local = cleanId(a?.id, 'local-author:');
        return local && /^local-author:[A-Za-z0-9%._~!()*'-]+$/.test(local) ? local : undefined;
      })(),
      name: clean(a?.name, 200),
    })).filter((a) => a.id && a.name)
    : [];
  const rawPublishers = Array.isArray(input.publishers) ? input.publishers : [];
  const publishers = rawPublishers.slice(0, 10).map((p) => {
    const name = clean(p?.name, 200);
    return name ? { id: publisherId(name), name } : null;
  }).filter(Boolean);
  const year = Number(input.year);
  return compact({
    catalogBookId,
    editionId: clean(input.editionId, 80),
    workId: clean(input.workId, 80),
    title: clean(input.title, 500),
    subtitle: clean(input.subtitle, 500),
    authors,
    publishers,
    year: Number.isInteger(year) && year > 0 && year < 10000 ? year : undefined,
    isbn: clean(input.isbn, 32),
    language: clean(input.language, 40),
    coverUrl: safeUrl(input.coverUrl, ['openlibrary.org']),
    goodreadsUrl: safeUrl(input.goodreadsUrl, ['goodreads.com']),
    sourceUrl: safeUrl(input.sourceUrl, ['openlibrary.org']),
  });
}

export function canonicalMetadata(candidate) {
  return compact({
    title: candidate.title,
    subtitle: candidate.subtitle,
    authors: candidate.authors.map((a) => a.name),
    publisher: candidate.publishers[0]?.name,
    year: candidate.year,
    isbn: candidate.isbn,
    language: candidate.language,
    goodreadsUrl: candidate.goodreadsUrl,
    coverUrl: candidate.coverUrl,
    sourceUrl: candidate.sourceUrl,
  });
}

function isPresent(value) {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '';
}

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  }
  return String(a ?? '') === String(b ?? '');
}

export function resolveCatalogLink(book, candidate) {
  const canonical = canonicalMetadata(candidate);
  const resolved = {};
  const overrides = {};
  for (const field of META_FIELDS) {
    if (field === 'coverUrl' || field === 'sourceUrl') continue;
    const current = field === 'authors'
      ? (book.authors?.length ? book.authors : (book.author ? [book.author] : []))
      : book[field];
    const source = canonical[field];
    if (isPresent(current)) {
      resolved[field] = current;
      if (isPresent(source) && !sameValue(current, source)) overrides[field] = current;
    } else if (isPresent(source)) {
      resolved[field] = source;
    }
  }
  resolved.authors = resolved.authors ?? [];
  resolved.author = resolved.authors.join(', ');
  return {
    ...resolved,
    catalogBookId: candidate.catalogBookId,
    catalogAuthorIds: candidate.authors.map((a) => a.id),
    catalogPublisherIds: candidate.publishers.map((p) => p.id),
    canonicalMetadata: canonical,
    metadataOverrides: overrides,
  };
}

export function normalizeIsbn(value) {
  return String(value ?? '').replace(/[^0-9X]/gi, '').toUpperCase();
}

export function findUniqueIsbnMatch(isbn, candidates = []) {
  const wanted = normalizeIsbn(isbn);
  if (!wanted) return null;
  const exact = candidates.filter((candidate) => normalizeIsbn(candidate?.isbn) === wanted);
  return exact.length === 1 ? exact[0] : null;
}

const entityKey = (kind, id) => ({ pk: `${kind}#${id}`, id: 'meta' });

async function putEntity(kind, id, value) {
  if (!TABLE || !id) return;
  const now = Math.floor(Date.now() / 1000);
  const previous = kind === 'book' ? null : await getEntity(kind, id);
  const aliases = [...new Set([...(previous?.aliases ?? []), ...(value.aliases ?? [])])].slice(0, 30);
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: compact({
      ...entityKey(kind, id), kind, entityId: id, ...previous, ...value,
      name: previous?.name || value.name,
      aliases,
      fetchedAt: now, ttl: now + CACHE_SECONDS,
    }),
  }));
}

export async function getEntity(kind, id) {
  if (!TABLE || !id) return null;
  const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: entityKey(kind, id) }));
  if (!out.Item) return null;
  const { pk: _pk, id: _id, ...entity } = out.Item;
  return entity;
}

export async function cacheCandidate(candidate) {
  await Promise.all([
    cacheBookCandidate(candidate),
    ...candidate.authors.map((author) => putEntity('author', author.id, {
      name: author.name,
      aliases: [author.name],
      sourceUrl: author.id.startsWith('ol-author:')
        ? `https://openlibrary.org/authors/${author.id.slice('ol-author:'.length)}` : undefined,
      imageUrl: author.id.startsWith('ol-author:')
        ? `https://covers.openlibrary.org/a/olid/${author.id.slice('ol-author:'.length)}-M.jpg` : undefined,
    })),
    ...candidate.publishers.map((publisher) => putEntity('publisher', publisher.id, {
      name: publisher.name,
      aliases: [publisher.name],
    })),
  ]);
}

async function cacheBookCandidate(candidate) {
  return putEntity('book', candidate.catalogBookId, {
    ...canonicalMetadata(candidate),
    editionId: candidate.editionId,
    workId: candidate.workId,
    authorEntities: candidate.authors,
    publishers: candidate.publishers,
  });
}

export async function linkBook(userId, id, rawCandidate) {
  let candidate = sanitizeCandidate(rawCandidate);
  if (!candidate) throw new TypeError('invalid candidate');
  if (TABLE) {
    const cached = await getEntity('book', candidate.catalogBookId);
    if (!cached) throw new TypeError('candidate not cached');
    candidate = sanitizeCandidate({
      ...cached,
      catalogBookId: candidate.catalogBookId,
      authorEntities: cached.authorEntities,
      publishers: cached.publishers,
    });
  }
  const book = await getBook(userId, id);
  if (!book) return null;
  const link = resolveCatalogLink(book, candidate);
  await cacheCandidate(candidate);
  await setBookCatalog(userId, id, link);
  return { ...book, ...link, catalogMatchStatus: 'linked', catalogCheckedAt: Date.now() };
}

export async function searchCatalog({ kind = 'book', query, isbn, title, author, limit = 10 } = {}) {
  let candidates;
  if (kind === 'author') candidates = await searchBooks({ author: query || author, limit });
  else if (kind === 'publisher') candidates = await searchBooks({ publisher: query, limit });
  else candidates = await searchBooks({ isbn, title: title || query, author, limit });
  if (kind === 'book') await Promise.all(candidates.map(cacheBookCandidate));
  if (kind === 'author') {
    const map = new Map();
    for (const candidate of candidates) for (const entity of candidate.authorEntities) map.set(entity.id, entity);
    await Promise.all([...map.values()].map((entity) => putEntity('author', entity.id, {
      name: entity.name, aliases: [entity.name],
      sourceUrl: entity.id.startsWith('ol-author:') ? `https://openlibrary.org/authors/${entity.id.slice(10)}` : undefined,
      imageUrl: entity.id.startsWith('ol-author:') ? `https://covers.openlibrary.org/a/olid/${entity.id.slice(10)}-M.jpg` : undefined,
    })));
    return { authors: [...map.values()] };
  }
  if (kind === 'publisher') {
    const map = new Map();
    for (const candidate of candidates) for (const entity of candidate.publishers) map.set(entity.id, entity);
    await Promise.all([...map.values()].map((entity) => putEntity('publisher', entity.id, {
      name: entity.name, aliases: [entity.name],
    })));
    return { publishers: [...map.values()] };
  }
  return { books: candidates };
}

export async function attachCatalogEntities(userId, id, rawAuthorIds = [], rawPublisherIds = []) {
  const book = await getBook(userId, id);
  if (!book) return null;
  if (book.catalogBookId) return book;
  const authorIds = Array.isArray(rawAuthorIds) ? rawAuthorIds.slice(0, 20).filter((value) =>
    typeof value === 'string' && value.length <= 300
      && (/^local-author:[A-Za-z0-9%._~!()*'-]+$/.test(value) || /^ol-author:OL\d+A$/.test(value))) : [];
  const publisherIds = Array.isArray(rawPublisherIds) ? rawPublisherIds.slice(0, 1).filter((value) =>
    typeof value === 'string' && value.length <= 300
      && (/^publisher:[a-z0-9-]+$/.test(value) || /^local-publisher:[A-Za-z0-9%._~!()*'-]+$/.test(value))) : [];
  for (const entityId of authorIds.filter((value) => value.startsWith('ol-author:'))) {
    if (TABLE && !(await getEntity('author', entityId))) throw new TypeError('unknown author');
  }
  for (const entityId of publisherIds.filter((value) => value.startsWith('publisher:'))) {
    if (TABLE && !(await getEntity('publisher', entityId))) throw new TypeError('unknown publisher');
  }
  await setBookCatalogEntities(userId, id, authorIds, publisherIds);
  return { ...book, catalogAuthorIds: authorIds, catalogPublisherIds: publisherIds };
}

export async function listUserCatalog(userId) {
  const library = (await listBooks(userId)).filter((b) => b.format !== 'note');
  const authorMap = new Map();
  const publisherMap = new Map();
  for (const book of library) {
    const canonicalAuthors = Array.isArray(book.canonicalMetadata?.authors) ? book.canonicalMetadata.authors : null;
    const names = canonicalAuthors?.length
      ? canonicalAuthors
      : (book.authors?.length ? book.authors : (book.author ? [book.author] : []));
    names.forEach((name, index) => {
      const id = book.catalogAuthorIds?.[index] || `local-author:${encodeURIComponent(name.toLowerCase())}`;
      const entity = authorMap.get(id) || { id, name, aliases: [name], bookIds: [], local: !id.startsWith('ol-author:') };
      entity.bookIds.push(book.id);
      authorMap.set(id, entity);
    });
    const publisherName = book.canonicalMetadata?.publisher || book.publisher;
    if (publisherName) {
      const id = book.catalogPublisherIds?.[0] || publisherId(publisherName);
      const entity = publisherMap.get(id) || { id, name: publisherName, aliases: [publisherName], bookIds: [], local: !book.catalogPublisherIds?.length || id.startsWith('local-publisher:') };
      entity.bookIds.push(book.id);
      publisherMap.set(id, entity);
    }
  }
  await Promise.all([...authorMap.values()].map(async (entity) => {
    if (entity.local) return;
    const cached = await getEntity('author', entity.id);
    if (cached) Object.assign(entity, {
      name: cached.name || entity.name,
      aliases: cached.aliases || entity.aliases,
      sourceUrl: cached.sourceUrl,
      imageUrl: cached.imageUrl,
    });
  }));
  await Promise.all([...publisherMap.values()].map(async (entity) => {
    if (entity.local) return;
    const cached = await getEntity('publisher', entity.id);
    if (cached) Object.assign(entity, {
      name: cached.name || entity.name,
      aliases: cached.aliases || entity.aliases,
    });
  }));
  const books = library.map((book) => ({
    id: book.id,
    title: book.title,
    author: book.author,
    authors: book.authors ?? [],
    publisher: book.publisher,
    cover: book.cover,
    catalogBookId: book.catalogBookId,
    catalogMatchStatus: book.catalogMatchStatus ?? 'unmatched',
  }));
  return { books, authors: [...authorMap.values()], publishers: [...publisherMap.values()] };
}
