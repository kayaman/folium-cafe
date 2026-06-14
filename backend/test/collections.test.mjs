import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCollectionId, collItemId, isClipItem,
  normalizeCollections, stripFromCollections,
} from '../src/repo.mjs';

// ---------- isCollectionId ----------

test('isCollectionId accepts a coll-prefixed id', () => {
  assert.equal(isCollectionId('coll7x3k'), true);
});

test('isCollectionId rejects book / note / undefined ids', () => {
  assert.equal(isCollectionId('babc'), false);
  assert.equal(isCollectionId('nabc'), false);
  assert.equal(isCollectionId(undefined), false);
});

// ---------- collItemId (identity) ----------

test('collItemId is the identity', () => {
  assert.equal(collItemId('coll7x3k'), 'coll7x3k');
});

// ---------- a collection id has no clip separator ----------

test('a collection id is not a clip item', () => {
  assert.equal(isClipItem('coll7x3k'), false);
});

// ---------- normalizeCollections ----------

test('normalizeCollections defaults missing/null to []', () => {
  assert.deepEqual(normalizeCollections({}), []);
  assert.deepEqual(normalizeCollections({ collections: null }), []);
});

test('normalizeCollections passes through an array', () => {
  assert.deepEqual(normalizeCollections({ collections: ['coll1'] }), ['coll1']);
});

// ---------- stripFromCollections ----------

test('stripFromCollections removes all occurrences', () => {
  assert.deepEqual(stripFromCollections(['a', 'b', 'a'], 'a'), ['b']);
});
