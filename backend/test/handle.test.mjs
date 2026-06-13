import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHandle } from '../src/handle.mjs';

test('accepts a plain 4-12 char lowercase handle', () => {
  assert.equal(validateHandle('marco').ok, true);
  assert.equal(validateHandle('ab12').ok, true);
  assert.equal(validateHandle('twelve-chars').ok, true); // exactly 12
});

test('rejects too short / too long', () => {
  assert.equal(validateHandle('abc').ok, false);
  assert.equal(validateHandle('thirteenchars').ok, false);
});

test('rejects uppercase (BFF normalizes before calling; trigger is strict)', () => {
  assert.equal(validateHandle('Marco').ok, false);
});

test('rejects leading/trailing hyphen and bad chars', () => {
  assert.equal(validateHandle('-abc').ok, false);
  assert.equal(validateHandle('abc-').ok, false);
  assert.equal(validateHandle('a_bc').ok, false);
  assert.equal(validateHandle('a.bc').ok, false);
  assert.equal(validateHandle('ab cd').ok, false);
});

test('rejects reserved names, exact match only', () => {
  assert.equal(validateHandle('admin').ok, false);
  assert.equal(validateHandle('folium').ok, false);
  assert.equal(validateHandle('books').ok, false);
  assert.equal(validateHandle('bookworm').ok, true); // substring is fine
});

test('rejects null/undefined/non-string garbage', () => {
  assert.equal(validateHandle(undefined).ok, false);
  assert.equal(validateHandle(null).ok, false);
  assert.equal(validateHandle(42).ok, false);
});

test('failures carry a human reason', () => {
  assert.equal(typeof validateHandle('abc').reason, 'string');
});
