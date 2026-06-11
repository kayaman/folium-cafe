import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, parseCookies } from '../src/auth.mjs';

const KEY = 'test-hmac-key-0123456789';

test('signSession then verifySession round-trips and is valid', () => {
  const token = signSession(KEY, 3600);
  assert.equal(typeof token, 'string');
  assert.equal(verifySession(KEY, token), true);
});

test('verifySession rejects a tampered token', () => {
  const token = signSession(KEY, 3600);
  const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  assert.equal(verifySession(KEY, tampered), false);
});

test('verifySession rejects a token signed with a different key', () => {
  const token = signSession(KEY, 3600);
  assert.equal(verifySession('a-different-key', token), false);
});

test('verifySession rejects an expired token', () => {
  const token = signSession(KEY, -10); // expired 10s ago
  assert.equal(verifySession(KEY, token), false);
});

test('verifySession rejects garbage', () => {
  assert.equal(verifySession(KEY, ''), false);
  assert.equal(verifySession(KEY, 'not.a.token'), false);
  assert.equal(verifySession(KEY, undefined), false);
});

test('parseCookies reads a named cookie from a Cookie header string', () => {
  const jar = parseCookies(['a=1; folio_session=abc.def; b=2']);
  assert.equal(jar.folio_session, 'abc.def');
  assert.equal(jar.a, '1');
});

test('parseCookies handles the Function URL cookies array', () => {
  const jar = parseCookies(['folio_session=xyz', 'other=1']);
  assert.equal(jar.folio_session, 'xyz');
});
