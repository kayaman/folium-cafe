import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authCookies, refreshedCookie, clearedCookies, parseCookies,
  AT_COOKIE, RT_COOKIE,
} from '../src/session.mjs';

test('authCookies sets both tokens with strict flags', () => {
  const out = authCookies({ AccessToken: 'AT', RefreshToken: 'RT' });
  assert.equal(out.length, 2);
  assert.match(out[0], /^folio_at=AT; HttpOnly; Secure; SameSite=Strict; Path=\/api; Max-Age=7776000$/);
  assert.match(out[1], /^folio_rt=RT; HttpOnly; Secure; SameSite=Strict; Path=\/api; Max-Age=7776000$/);
});

test('refreshedCookie re-sets only the access token', () => {
  assert.match(refreshedCookie('NEW'), /^folio_at=NEW; /);
});

test('clearedCookies expires both', () => {
  for (const c of clearedCookies()) assert.match(c, /Max-Age=0$/);
});

test('parseCookies reads cookies from header string and array forms', () => {
  assert.equal(parseCookies(['a=1; folio_at=x.y.z']).folio_at, 'x.y.z');
  assert.equal(parseCookies(['folio_rt=r', 'b=2']).folio_rt, 'r');
  assert.deepEqual(parseCookies(undefined), {});
});

test('cookie name constants', () => {
  assert.equal(AT_COOKIE, 'folio_at');
  assert.equal(RT_COOKIE, 'folio_rt');
});
