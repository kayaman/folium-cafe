import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGoodreadsUrl,
  buildCoverUrl,
  buildSearchFallback,
  normalizeQuery,
  mapDoc,
  searchBooks,
} from '../src/openlibrary.mjs';

// ---------- buildGoodreadsUrl (pure) ----------

test('buildGoodreadsUrl builds a show URL for a numeric id (string or number)', () => {
  assert.equal(buildGoodreadsUrl(34927404), 'https://www.goodreads.com/book/show/34927404');
  assert.equal(buildGoodreadsUrl('34927404'), 'https://www.goodreads.com/book/show/34927404');
  assert.equal(buildGoodreadsUrl(' 12 '), 'https://www.goodreads.com/book/show/12');
});

test('buildGoodreadsUrl rejects non-numeric / empty / missing ids', () => {
  for (const bad of ['', '   ', 'abc', '12a', null, undefined, 'javascript:alert(1)']) {
    assert.equal(buildGoodreadsUrl(bad), null, `${bad} should be null`);
  }
});

// ---------- buildCoverUrl (pure) ----------

test('buildCoverUrl prefers cover_i, then isbn, then null', () => {
  assert.equal(buildCoverUrl(8091016, undefined), 'https://covers.openlibrary.org/b/id/8091016-M.jpg');
  assert.equal(buildCoverUrl(undefined, '9780134685991'), 'https://covers.openlibrary.org/b/isbn/9780134685991-M.jpg');
  assert.equal(buildCoverUrl(undefined, undefined), null);
  assert.equal(buildCoverUrl(null, '   '), null);
});

// ---------- buildSearchFallback (pure) ----------

test('buildSearchFallback uses the isbn when present, else title+author', () => {
  assert.equal(buildSearchFallback({ isbn: '9780134685991' }), 'https://www.goodreads.com/search?q=9780134685991');
  assert.equal(
    buildSearchFallback({ title: 'Effective Java', author: 'Bloch' }),
    'https://www.goodreads.com/search?q=Effective%20Java%20Bloch',
  );
  assert.equal(buildSearchFallback({}), null);
});

// ---------- normalizeQuery (pure) ----------

test('normalizeQuery trims, clamps the limit to [1,20], defaults to 10', () => {
  assert.deepEqual(normalizeQuery({ title: '  Dune  ', author: ' Herbert ' }),
    { isbn: undefined, title: 'Dune', author: 'Herbert', limit: 10 });
  assert.equal(normalizeQuery({ title: 'x', limit: 999 }).limit, 20);
  assert.equal(normalizeQuery({ title: 'x', limit: 0 }).limit, 1);
  assert.equal(normalizeQuery({ title: 'x', limit: 'nope' }).limit, 10);
});

// ---------- mapDoc (pure) ----------

test('mapDoc maps a full doc to a candidate', () => {
  const c = mapDoc({
    key: '/works/OL5819355W',
    title: 'Effective Java',
    author_name: ['Joshua Bloch'],
    first_publish_year: 2018,
    cover_i: 8091016,
    isbn: ['9780134685991', '0134685997'],
    id_goodreads: ['34927404'],
  });
  assert.equal(c.title, 'Effective Java');
  assert.deepEqual(c.authors, ['Joshua Bloch']);
  assert.equal(c.year, 2018);
  assert.equal(c.isbn, '9780134685991');
  assert.equal(c.coverUrl, 'https://covers.openlibrary.org/b/id/8091016-M.jpg');
  assert.equal(c.goodreadsUrl, 'https://www.goodreads.com/book/show/34927404');
  assert.equal(c.searchUrl, 'https://www.goodreads.com/search?q=9780134685991');
});

test('mapDoc handles missing author_name / cover_i / id_goodreads', () => {
  const c = mapDoc({ title: 'Untitled Thing' });
  assert.deepEqual(c.authors, []);
  assert.equal(c.coverUrl, null);
  assert.equal(c.goodreadsUrl, null);
  // No id → search fallback derived from the title.
  assert.equal(c.searchUrl, 'https://www.goodreads.com/search?q=Untitled%20Thing');
});

test('mapDoc prefers a 13-digit ISBN and tolerates garbage docs', () => {
  assert.equal(mapDoc({ isbn: ['0134685997', '9780134685991'] }).isbn, '9780134685991');
  assert.deepEqual(mapDoc(null).authors, []);
  assert.equal(mapDoc(undefined).title, undefined);
});

// ---------- searchBooks (fake fetch) ----------

function fakeResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

test('searchBooks builds an isbn query, sets a User-Agent, and maps docs', async () => {
  let seenUrl, seenInit;
  const fetch = async (url, init) => {
    seenUrl = url; seenInit = init;
    return fakeResponse({ docs: [{ title: 'X', id_goodreads: ['9'] }] });
  };
  const out = await searchBooks({ isbn: '978-0-13-468599-1' }, { fetch });
  assert.match(seenUrl, /^https:\/\/openlibrary\.org\/search\.json\?/);
  assert.match(seenUrl, /isbn=978-0-13-468599-1/);
  assert.match(seenUrl, /fields=/);
  assert.ok(seenInit.headers['User-Agent']);
  assert.equal(out.length, 1);
  assert.equal(out[0].goodreadsUrl, 'https://www.goodreads.com/book/show/9');
});

test('searchBooks builds a title+author query when no isbn', async () => {
  let seenUrl;
  const fetch = async (url) => { seenUrl = url; return fakeResponse({ docs: [] }); };
  const out = await searchBooks({ title: 'Dune', author: 'Herbert' }, { fetch });
  assert.match(seenUrl, /title=Dune/);
  assert.match(seenUrl, /author=Herbert/);
  assert.doesNotMatch(seenUrl, /isbn=/);
  assert.deepEqual(out, []);
});

test('searchBooks rejects on a non-ok response', async () => {
  const fetch = async () => fakeResponse(null, { ok: false, status: 503 });
  await assert.rejects(() => searchBooks({ title: 'x' }, { fetch }), /openlibrary 503/);
});

test('searchBooks rejects when the transport throws (network)', async () => {
  const fetch = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(() => searchBooks({ title: 'x' }, { fetch }), /ECONNRESET/);
});

test('searchBooks rejects when the body is not valid JSON', async () => {
  const fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
  await assert.rejects(() => searchBooks({ title: 'x' }, { fetch }), /bad json/);
});
