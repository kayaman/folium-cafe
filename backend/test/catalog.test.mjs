import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePublisherName, publisherId, mapDoc } from '../src/openlibrary.mjs';
import { canonicalMetadata, findUniqueIsbnMatch, resolveCatalogLink, sanitizeCandidate } from '../src/catalog.mjs';

test('publisher identity normalizes safe spelling variants without fuzzy merging', () => {
  assert.equal(normalizePublisherName(' Companhia & Filhos, S.A. '), 'companhia-and-filhos-s-a');
  assert.equal(normalizePublisherName('Companhia and Filhos S A'), 'companhia-and-filhos-s-a');
  assert.equal(publisherId('Éditions du Café'), 'publisher:editions-du-cafe');
  assert.notEqual(publisherId('Penguin'), publisherId('Penguin Random House'));
});

test('Open Library docs map to stable normalized entity ids', () => {
  const candidate = mapDoc({
    key: '/works/OL123W', edition_key: ['OL456M'], title: 'A Book',
    author_name: ['Ada Author'], author_key: ['OL789A'], publisher: ['Fine Press'],
  });
  assert.equal(candidate.catalogBookId, 'ol-edition:OL456M');
  assert.deepEqual(candidate.authorEntities, [{ id: 'ol-author:OL789A', name: 'Ada Author' }]);
  assert.deepEqual(candidate.publishers, [{ id: 'publisher:fine-press', name: 'Fine Press' }]);
});

test('catalog candidates are sanitized and external URLs are host allowlisted', () => {
  const candidate = sanitizeCandidate({
    catalogBookId: 'ol-edition:OL456M', title: '  A Book ', year: 2024,
    authorEntities: [{ id: 'ol-author:OL789A', name: ' Ada Author ' }],
    publishers: [{ id: 'ignored', name: 'Fine Press' }],
    coverUrl: 'https://covers.openlibrary.org/b/id/1-M.jpg',
    sourceUrl: 'https://openlibrary.org/books/OL456M',
    goodreadsUrl: 'https://evil.example/book',
  });
  assert.equal(candidate.title, 'A Book');
  assert.equal(candidate.goodreadsUrl, undefined);
  assert.equal(candidate.publishers[0].id, 'publisher:fine-press');
  assert.equal(sanitizeCandidate({ catalogBookId: 'not-open-library' }), null);
});

test('link resolution preserves non-empty private metadata as overrides', () => {
  const candidate = sanitizeCandidate({
    catalogBookId: 'ol-work:OL123W', title: 'Canonical title', year: 2020,
    authorEntities: [{ id: 'ol-author:OL789A', name: 'Canonical Author' }],
    publishers: [{ name: 'Canonical Press' }],
  });
  const link = resolveCatalogLink({ title: 'My title', author: '', publisher: '' }, candidate);
  assert.equal(link.title, 'My title');
  assert.deepEqual(link.authors, ['Canonical Author']);
  assert.equal(link.publisher, 'Canonical Press');
  assert.equal(link.metadataOverrides.title, 'My title');
  assert.deepEqual(canonicalMetadata(candidate).authors, ['Canonical Author']);
});

test('ISBN matching auto-selects only one exact normalized candidate', () => {
  const a = { isbn: '9780134685991' };
  const b = { isbn: '9780000000000' };
  assert.equal(findUniqueIsbnMatch('978-0-13-468599-1', [a, b]), a);
  assert.equal(findUniqueIsbnMatch('9780134685991', [a, { ...a }]), null);
  assert.equal(findUniqueIsbnMatch('', [a]), null);
});
