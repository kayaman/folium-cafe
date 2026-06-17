import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNoteId, isClipItem, mediaKey } from '../src/repo.mjs';

// ---------- isNoteId ----------

test('isNoteId accepts an n-prefixed id', () => {
  assert.equal(isNoteId('nabc123'), true);
});

test('isNoteId rejects a book id', () => {
  assert.equal(isNoteId('babc'), false);
});

test('isNoteId rejects undefined / non-strings', () => {
  assert.equal(isNoteId(undefined), false);
  assert.equal(isNoteId(null), false);
  assert.equal(isNoteId(123), false);
});

// ---------- notes survive the listBooks clip filter ----------

test('a note id has no clip separator, so isClipItem is false', () => {
  // listBooks filters out items whose id contains '#hl#'. A note id is
  // n<base36> and never carries the separator, so notes are listed.
  assert.equal(isClipItem('nabc123'), false);
});

// ---------- mediaKey cross-check ----------

test('mediaKey routes a note to the per-user notes prefix', () => {
  assert.equal(mediaKey('user1', 'nabc', 'note'), 'u/user1/notes/nabc.md');
});
