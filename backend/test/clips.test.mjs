import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ddb, clipItemId, parseClipId, isClipItem, putClipping } from '../src/repo.mjs';

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

// Regression: putClipping must store the COMPOSITE key as the item id even though
// the incoming clip carries its own `id`. A spread that clobbered `id` with the
// bare clip id produced a record with no '#hl#' — which slipped past isClipItem
// and leaked into listBooks as a phantom, title-less "book" (blanking the shelf).
test('putClipping stores the composite key, not the bare clip id', async (t) => {
  let captured;
  t.mock.method(ddb, 'send', async (cmd) => { captured = cmd.input; return {}; });

  await putClipping('bmqf', { id: 'cmqf', page: 7, color: '#dcb064', rects: [{ x: 0, y: 0, w: 1, h: 1 }] });

  assert.equal(captured.Item.id, 'bmqf#hl#cmqf');
  assert.equal(isClipItem(captured.Item.id), true);
  assert.equal(captured.Item.bookId, 'bmqf');
  // payload fields survive
  assert.equal(captured.Item.page, 7);
  assert.equal(captured.Item.color, '#dcb064');
});
