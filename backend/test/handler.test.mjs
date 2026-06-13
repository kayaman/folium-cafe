import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler } from '../src/handler.mjs';

process.env.ORIGIN_SECRET = 'shh';

function mkEvent({ method = 'GET', path = '/', body, cookies, headers = {}, ip = '9.9.9.9' } = {}) {
  return {
    rawPath: path,
    cookies,
    headers: { 'x-origin-secret': 'shh', ...(method !== 'GET' ? { 'x-csrf': '1' } : {}), ...headers },
    requestContext: { http: { method, sourceIp: ip } },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function fakes(overrides = {}) {
  return {
    repo: {
      listBooks: async () => [],
      putBook: async () => ({ ok: true }),
      getBook: async () => null,
      updateProgress: async () => {},
      deleteBook: async () => {},
      presignDownload: async () => 'https://signed-get',
      presignUpload: async () => ({ url: 'https://post', fields: {} }),
      getMeta: async () => null,
      bumpTokensValidAfter: async () => {},
      ...overrides.repo,
    },
    cognito: {
      signUp: async () => ({}),
      confirm: async () => ({}),
      resend: async () => ({}),
      login: async () => ({ AccessToken: 'AT', RefreshToken: 'RT' }),
      refresh: async () => ({ AccessToken: 'AT2' }),
      revoke: async () => ({}),
      forgot: async () => ({}),
      confirmForgot: async () => ({}),
      ...overrides.cognito,
    },
    verifyAccess: overrides.verifyAccess ?? (async (t) => (t === 'AT' ? { sub: 'sub-1', username: 'marco', iat: Math.floor(Date.now() / 1000) } : null)),
    allow: overrides.allow ?? (async () => true),
  };
}

const AUTHED = { cookies: ['folio_at=AT'] };

test('rejects requests without the origin secret', async () => {
  const h = makeHandler(fakes());
  const res = await h({ ...mkEvent(), headers: {} });
  assert.equal(res.statusCode, 403);
});

test('rejects non-GET without the x-csrf header', async () => {
  const h = makeHandler(fakes());
  const res = await h(mkEvent({ method: 'POST', path: '/api/login', body: {}, headers: { 'x-csrf': undefined } }));
  assert.equal(res.statusCode, 403);
});

test('signup validates the handle and lowercases it', async () => {
  const calls = [];
  const h = makeHandler(fakes({ cognito: { signUp: async (u) => { calls.push(u); return {}; } } }));
  const bad = await h(mkEvent({ method: 'POST', path: '/api/signup', body: { username: 'admin', email: 'a@b.c', password: 'x'.repeat(12) } }));
  assert.equal(bad.statusCode, 400);
  const ok = await h(mkEvent({ method: 'POST', path: '/api/signup', body: { username: 'Marco', email: 'a@b.c', password: 'x'.repeat(12) } }));
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(calls, ['marco']);
});

test('signup maps cognito errors without leaking internals', async () => {
  const err = (name) => { const e = new Error(name); e.name = name; throw e; };
  const h = makeHandler(fakes({ cognito: { signUp: async () => err('UsernameExistsException') } }));
  const res = await h(mkEvent({ method: 'POST', path: '/api/signup', body: { username: 'marco', email: 'a@b.c', password: 'x'.repeat(12) } }));
  assert.equal(res.statusCode, 409);
});

test('signup is rate limited', async () => {
  const h = makeHandler(fakes({ allow: async () => false }));
  const res = await h(mkEvent({ method: 'POST', path: '/api/signup', body: { username: 'marco', email: 'a@b.c', password: 'x'.repeat(12) } }));
  assert.equal(res.statusCode, 429);
});

test('login sets both auth cookies; bad login is a generic 401', async () => {
  const h = makeHandler(fakes());
  const ok = await h(mkEvent({ method: 'POST', path: '/api/login', body: { username: 'marco', password: 'pw' } }));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.cookies.length, 2);
  assert.match(ok.cookies[0], /^folio_at=AT;/);
  const fail = makeHandler(fakes({ cognito: { login: async () => { const e = new Error('x'); e.name = 'NotAuthorizedException'; throw e; } } }));
  const bad = await fail(mkEvent({ method: 'POST', path: '/api/login', body: { username: 'marco', password: 'no' } }));
  assert.equal(bad.statusCode, 401);
});

test('authed route works with a valid access cookie and scopes by sub', async () => {
  const seen = [];
  const h = makeHandler(fakes({ repo: { listBooks: async (sub) => { seen.push(sub); return [{ id: 'b1' }]; } } }));
  const res = await h(mkEvent({ path: '/api/books', ...AUTHED }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen, ['sub-1']);
});

test('expired access token + refresh cookie => transparent refresh + new cookie', async () => {
  const h = makeHandler(fakes({
    verifyAccess: async (t) => (t === 'AT2' ? { sub: 'sub-1', username: 'marco', iat: Math.floor(Date.now() / 1000) } : null),
  }));
  const res = await h(mkEvent({ path: '/api/books', cookies: ['folio_at=stale', 'folio_rt=RT'] }));
  assert.equal(res.statusCode, 200);
  assert.match(res.cookies[0], /^folio_at=AT2;/);
});

test('tokensValidAfter newer than the token kills the session', async () => {
  const h = makeHandler(fakes({
    repo: { getMeta: async () => ({ tokensValidAfter: Date.now() + 60_000 }) },
  }));
  const res = await h(mkEvent({ path: '/api/books', ...AUTHED }));
  assert.equal(res.statusCode, 401);
});

test('logout revokes the refresh token, bumps tokensValidAfter, clears cookies', async () => {
  let revoked = null; let bumped = null;
  const h = makeHandler(fakes({
    cognito: { revoke: async (t) => { revoked = t; } },
    repo: { bumpTokensValidAfter: async (sub) => { bumped = sub; } },
  }));
  const res = await h(mkEvent({ method: 'POST', path: '/api/logout', cookies: ['folio_at=AT', 'folio_rt=RT'] }));
  assert.equal(res.statusCode, 200);
  assert.equal(revoked, 'RT');
  assert.equal(bumped, 'sub-1');
  for (const c of res.cookies) assert.match(c, /Max-Age=0$/);
});

test('GET /api/me returns the username', async () => {
  const h = makeHandler(fakes());
  const res = await h(mkEvent({ path: '/api/me', ...AUTHED }));
  assert.deepEqual(JSON.parse(res.body), { username: 'marco' });
});

test('POST /api/books returns the presigned POST and 403 on quota', async () => {
  const h = makeHandler(fakes());
  const ok = await h(mkEvent({ method: 'POST', path: '/api/books', body: { id: 'b1' }, ...AUTHED }));
  assert.deepEqual(JSON.parse(ok.body).upload, { url: 'https://post', fields: {} });
  const full = makeHandler(fakes({ repo: { putBook: async () => ({ ok: false, reason: 'shelf is full' }) } }));
  const res = await full(mkEvent({ method: 'POST', path: '/api/books', body: { id: 'b1' }, ...AUTHED }));
  assert.equal(res.statusCode, 403);
});

test('unauthenticated book routes return 401', async () => {
  const h = makeHandler(fakes());
  assert.equal((await h(mkEvent({ path: '/api/books' }))).statusCode, 401);
});
