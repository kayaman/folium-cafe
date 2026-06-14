import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLinkedMedia } from '../src/repo.mjs';
import { isHttpsUrl } from '../src/handler.mjs';

// ---------- isLinkedMedia ----------

test('isLinkedMedia is true for an item carrying a non-empty url', () => {
  assert.equal(isLinkedMedia({ url: 'https://x' }), true);
});

test('isLinkedMedia is false without a usable url', () => {
  assert.equal(isLinkedMedia({}), false);
  assert.equal(isLinkedMedia({ url: '' }), false);
  assert.equal(isLinkedMedia(null), false);
  assert.equal(isLinkedMedia(undefined), false);
});

test('isLinkedMedia is false for an uploaded media item (no url)', () => {
  assert.equal(isLinkedMedia({ format: 'video', fileName: 'v.mp4' }), false);
});

// ---------- isHttpsUrl ----------

test('isHttpsUrl accepts https', () => {
  assert.equal(isHttpsUrl('https://a.com'), true);
});

test('isHttpsUrl rejects http and dangerous / non-url schemes', () => {
  assert.equal(isHttpsUrl('http://a.com'), false);
  assert.equal(isHttpsUrl('javascript:alert(1)'), false);
  assert.equal(isHttpsUrl('data:x'), false);
  assert.equal(isHttpsUrl('nope'), false);
});
