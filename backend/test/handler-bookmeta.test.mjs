import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOOK_META_FIELDS, updateBookMeta } from '../src/repo.mjs';

// The allowlist is the security boundary for PATCH /api/books/{id}: only these
// attributes can ever be written by a client.
test('BOOK_META_FIELDS allows the expected metadata fields only', () => {
  for (const k of ['title', 'author', 'subtitle', 'authors', 'edition', 'publisher', 'year', 'isbn', 'language', 'series', 'description']) {
    assert.ok(BOOK_META_FIELDS.has(k), `${k} should be allowed`);
  }
  // A few attributes a client must never be able to set via PATCH.
  for (const k of ['id', 'pk', 'collections', 'url', 'currentPage', 'format', '__proto__']) {
    assert.equal(BOOK_META_FIELDS.has(k), false, `${k} must not be allowed`);
  }
});

// When every supplied key is non-allowlisted (or undefined), updateBookMeta
// builds an empty UpdateExpression and returns early WITHOUT calling DynamoDB —
// so this assertion runs fully offline. A leaked key would attempt a send and
// throw (no AWS credentials / network), failing the test.
test('updateBookMeta is a no-op (no AWS call) when nothing is allowlisted', async () => {
  await assert.doesNotReject(
    updateBookMeta('b123', { id: 'evil', pk: 'lib', collections: ['x'], title: undefined }),
  );
});
