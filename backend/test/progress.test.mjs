import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProgressBody } from '../src/handler.mjs';

test('parseProgressBody keeps the legacy currentPage shape', () => {
  assert.deepEqual(parseProgressBody({ currentPage: 50 }), { currentPage: 50 });
});

test('parseProgressBody carries an in-range frac alongside currentPage', () => {
  assert.deepEqual(parseProgressBody({ currentPage: 50, frac: 0.37 }), { currentPage: 50, frac: 0.37 });
});

test('parseProgressBody clamps frac into [0,1]', () => {
  assert.deepEqual(parseProgressBody({ currentPage: 1, frac: 1.8 }), { currentPage: 1, frac: 1 });
  assert.deepEqual(parseProgressBody({ currentPage: 1, frac: -0.5 }), { currentPage: 1, frac: 0 });
});

test('parseProgressBody omits a non-numeric or NaN frac', () => {
  assert.deepEqual(parseProgressBody({ currentPage: 1, frac: 'x' }), { currentPage: 1 });
  assert.deepEqual(parseProgressBody({ currentPage: 1, frac: NaN }), { currentPage: 1 });
});

test('parseProgressBody still returns the generic progress shape', () => {
  assert.deepEqual(parseProgressBody({ progress: { kind: 'cfi', value: 'epubcfi(/6/4)' } }),
    { progress: { kind: 'cfi', value: 'epubcfi(/6/4)' } });
});

import { buildProgressUpdate } from '../src/repo.mjs';

test('buildProgressUpdate sets currentPage + lastReadAt without frac', () => {
  const u = buildProgressUpdate(50, 1234, undefined);
  assert.equal(u.UpdateExpression, 'SET currentPage = :p, lastReadAt = :t');
  assert.deepEqual(u.ExpressionAttributeValues, { ':p': 50, ':t': 1234 });
});

test('buildProgressUpdate adds posFrac when frac is a number', () => {
  const u = buildProgressUpdate(50, 1234, 0.37);
  assert.equal(u.UpdateExpression, 'SET currentPage = :p, lastReadAt = :t, posFrac = :f');
  assert.deepEqual(u.ExpressionAttributeValues, { ':p': 50, ':t': 1234, ':f': 0.37 });
});
