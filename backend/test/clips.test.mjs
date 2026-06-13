import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipItemId, parseClipId, isClipItem } from '../src/repo.mjs';

test('clipItemId composes a composite range key', () => {
  assert.equal(clipItemId('babc123', 'c001'), 'babc123#hl#c001');
});

test('parseClipId round-trips a composite id', () => {
  const id = clipItemId('babc123', 'c001');
  assert.deepEqual(parseClipId(id), { bookId: 'babc123', clipId: 'c001' });
});

test('parseClipId returns null for a plain book id', () => {
  assert.equal(parseClipId('babc123'), null);
});

test('isClipItem distinguishes clips from books', () => {
  assert.equal(isClipItem('babc123'), false);          // book id
  assert.equal(isClipItem('babc123#hl#c001'), true);   // clip id
});

test('parseClipId keeps a clipId that itself contains a separator-free string', () => {
  // clip ids are c<base36> and never contain '#', so the first '#hl#' splits cleanly
  const { bookId, clipId } = parseClipId('bxyz#hl#cqqq');
  assert.equal(bookId, 'bxyz');
  assert.equal(clipId, 'cqqq');
});
