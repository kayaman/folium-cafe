import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grayscalePixels, isPrintShortcut, printRenderScale, resolvePrintPages } from '../print-support.mjs';

test('resolves current and single-page print selections', () => {
  assert.deepEqual(resolvePrintPages({ mode: 'current', current: 7, total: 12 }), { pages: [7], error: null });
  assert.deepEqual(resolvePrintPages({ mode: 'single', current: 7, single: ' 4 ', total: 12 }), { pages: [4], error: null });
});

test('resolves inclusive ranges, including equal endpoints', () => {
  assert.deepEqual(resolvePrintPages({ mode: 'range', current: 1, start: '2', end: '5', total: 8 }), { pages: [2, 3, 4, 5], error: null });
  assert.deepEqual(resolvePrintPages({ mode: 'range', current: 1, start: '3', end: '3', total: 8 }), { pages: [3], error: null });
});

test('rejects incomplete, fractional, reversed, and out-of-bounds selections', () => {
  assert.equal(resolvePrintPages({ mode: 'single', current: 1, single: '', total: 8 }).error, 'required');
  assert.equal(resolvePrintPages({ mode: 'single', current: 1, single: '1.5', total: 8 }).error, 'integer');
  assert.equal(resolvePrintPages({ mode: 'range', current: 1, start: '5', end: '2', total: 8 }).error, 'order');
  assert.equal(resolvePrintPages({ mode: 'range', current: 1, start: '0', end: '2', total: 8 }).error, 'bounds');
  assert.equal(resolvePrintPages({ mode: 'single', current: 1, single: '9', total: 8 }).error, 'bounds');
  assert.equal(resolvePrintPages({ mode: 'single', current: 1, single: '-1', total: 8 }).error, 'integer');
});

test('uses 150 DPI unless the pixel budget requires a smaller scale', () => {
  assert.equal(printRenderScale(612, 792), 150 / 72);
  const capped = printRenderScale(5000, 5000, 150, 1_000_000);
  assert.equal(capped, 0.2);
  assert.equal(printRenderScale(0, 792), 1);
});

test('grayscale conversion is deterministic and preserves alpha', () => {
  const pixels = new Uint8ClampedArray([255, 0, 0, 200, 10, 20, 30, 255]);
  grayscalePixels(pixels);
  assert.deepEqual([...pixels], [76, 76, 76, 200, 18, 18, 18, 255]);
});

test('recognizes Ctrl/Cmd+P without hijacking unrelated shortcuts', () => {
  assert.equal(isPrintShortcut({ key: 'p', ctrlKey: true, metaKey: false, altKey: false }), true);
  assert.equal(isPrintShortcut({ key: 'P', ctrlKey: false, metaKey: true, altKey: false }), true);
  assert.equal(isPrintShortcut({ key: 'p', ctrlKey: true, metaKey: false, altKey: true }), false);
  assert.equal(isPrintShortcut({ key: 's', ctrlKey: true, metaKey: false, altKey: false }), false);
});
