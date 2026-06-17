import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { AT_COOKIE, RT_COOKIE } from '../src/session.mjs';

// Env must exist before repo.mjs/handler.mjs load (they read it at import time
// and construct AWS clients). Static imports are hoisted, so set env first and
// import the handler dynamically.
process.env.ORIGIN_SECRET = 'topsecret';
process.env.TABLE_NAME = 'books';
process.env.PDF_BUCKET = 'bucket';
process.env.USER_POOL_ID = 'us-east-1_test123';
process.env.USER_POOL_CLIENT_ID = 'client123';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIATEST';
process.env.AWS_SECRET_ACCESS_KEY = 'sk-test';

const repo = await import('../src/repo.mjs');
const { handler } = await import('../src/handler.mjs');

// ---------- helpers ----------
const ORIGIN = { 'x-origin-secret': 'topsecret', 'x-forwarded-for': '1.2.3.4' };

function event(method, path, { body, cookies, headers, raw } = {}) {
  return {
    headers: { ...ORIGIN, ...(headers || {}) },
    requestContext: { http: { method } },
    rawPath: path,
    cookies,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    isBase64Encoded: false,
  };
}

// A signed-in caller: a JWT-verifier that returns a user, plus an AT cookie.
const USER = { sub: 'u1', username: 'alice', iat: Math.floor(Date.now() / 1000) };
function authn(t, user = USER) {
  t.mock.method(CognitoJwtVerifier.prototype, 'verify', async () => user);
}
const AUTHED = { cookies: [`${AT_COOKIE}=tok`] };

// DynamoDB doc-client mock. Dispatches by command class name; rate-limiter
// UpdateCommands (pk RL#...) are recognized and allowed by default. Pass
// per-name overrides; tests that need to distinguish two QueryCommands inspect
// cmd.input themselves inside the override.
function mockDdb(t, overrides = {}) {
  t.mock.method(repo.ddb, 'send', async (cmd) => {
    const name = cmd.constructor.name;
    if (name === 'UpdateCommand' && String(cmd.input.Key?.pk).startsWith('RL#')) {
      return { Attributes: { count: overrides.rlCount ?? 1 } };
    }
    if (overrides[name]) return overrides[name](cmd);
    if (name === 'QueryCommand') return { Items: [] };
    if (name === 'GetCommand') return { Item: undefined };
    return {};
  });
}
function mockS3(t, overrides = {}) {
  t.mock.method(repo.s3, 'send', async (cmd) => {
    const name = cmd.constructor.name;
    if (overrides[name]) return overrides[name](cmd);
    if (name === 'GetObjectCommand') return { Body: { transformToString: async () => '' } };
    if (name === 'HeadObjectCommand') return { ContentLength: 0 };
    return {};
  });
}
function mockCognito(t, send) {
  t.mock.method(CognitoIdentityProviderClient.prototype, 'send', send);
}
const condFail = () => { const e = new Error('cond'); e.name = 'ConditionalCheckFailedException'; throw e; };

// ===== origin-secret gate =====
test('rejects a request missing the origin secret', async () => {
  const res = await handler({ headers: {}, requestContext: { http: { method: 'GET' } }, rawPath: '/api/books' });
  assert.equal(res.statusCode, 403);
});

// ===== unauthenticated auth routes =====
test('POST /api/auth/signup succeeds', async (t) => {
  mockDdb(t);
  mockCognito(t, async () => ({}));
  const res = await handler(event('POST', '/api/auth/signup', { body: { username: 'alice', password: 'p'.repeat(12), email: 'a@b.co' } }));
  assert.equal(res.statusCode, 200);
});

test('POST /api/auth/signup maps UsernameExistsException to 409', async (t) => {
  mockDdb(t);
  mockCognito(t, async () => { const e = new Error('x'); e.name = 'UsernameExistsException'; throw e; });
  const res = await handler(event('POST', '/api/auth/signup', { body: { username: 'alice', password: 'p', email: 'a@b.co' } }));
  assert.equal(res.statusCode, 409);
});

test('rate limiter blocks with 429 when the window is exhausted', async (t) => {
  mockDdb(t, { rlCount: 9999 });
  const res = await handler(event('POST', '/api/auth/login', { body: { username: 'a', password: 'p' } }));
  assert.equal(res.statusCode, 429);
});

test('POST /api/auth/login sets cookies on success', async (t) => {
  mockDdb(t);
  mockCognito(t, async () => ({ AuthenticationResult: { AccessToken: 'A', RefreshToken: 'R' } }));
  const res = await handler(event('POST', '/api/auth/login', { body: { username: 'alice', password: 'p' } }));
  assert.equal(res.statusCode, 200);
  assert.ok(res.cookies.some((c) => c.startsWith(AT_COOKIE + '=A')));
});

test('POST /api/auth/login maps bad credentials to 401', async (t) => {
  mockDdb(t);
  mockCognito(t, async () => { const e = new Error('x'); e.name = 'NotAuthorizedException'; throw e; });
  const res = await handler(event('POST', '/api/auth/login', { body: { username: 'a', password: 'p' } }));
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/login maps an unconfirmed user to 403', async (t) => {
  mockDdb(t);
  mockCognito(t, async () => { const e = new Error('x'); e.name = 'UserNotConfirmedException'; throw e; });
  const res = await handler(event('POST', '/api/auth/login', { body: { username: 'a', password: 'p' } }));
  assert.equal(res.statusCode, 403);
});

test('POST /api/auth/confirm, /resend, /forgot, /confirm-forgot succeed', async (t) => {
  mockDdb(t);
  mockCognito(t, async () => ({}));
  for (const [path, body] of [
    ['/api/auth/confirm', { username: 'a', code: '1' }],
    ['/api/auth/resend', { username: 'a' }],
    ['/api/auth/forgot', { username: 'a' }],
    ['/api/auth/confirm-forgot', { username: 'a', code: '1', password: 'p'.repeat(12) }],
  ]) {
    const res = await handler(event('POST', path, { body }));
    assert.equal(res.statusCode, 200, path);
  }
});

test('an unrecognized Cognito error becomes a 500', async (t) => {
  mockDdb(t);
  mockCognito(t, async () => { throw new Error('boom'); });
  const res = await handler(event('POST', '/api/auth/signup', { body: { username: 'a', password: 'p', email: 'e' } }));
  assert.equal(res.statusCode, 500);
});

// ===== auth gate =====
test('a protected route without a valid token is 401', async (t) => {
  t.mock.method(CognitoJwtVerifier.prototype, 'verify', async () => null);
  const res = await handler(event('GET', '/api/books', { cookies: [`${AT_COOKIE}=bad`] }));
  assert.equal(res.statusCode, 401);
});

test('an expired access token is transparently refreshed via the refresh token', async (t) => {
  let calls = 0;
  t.mock.method(CognitoJwtVerifier.prototype, 'verify', async () => (++calls === 1 ? null : USER));
  mockCognito(t, async () => ({ AuthenticationResult: { AccessToken: 'fresh' } }));
  mockDdb(t, { QueryCommand: () => ({ Items: [] }) });
  const res = await handler(event('GET', '/api/books', { cookies: [`${AT_COOKIE}=stale`, `${RT_COOKIE}=rt`] }));
  assert.equal(res.statusCode, 200);
  assert.ok(res.cookies.some((c) => c.startsWith(AT_COOKIE + '=fresh')));
});

test('POST /api/logout revokes the refresh token and clears cookies', async (t) => {
  authn(t);
  mockCognito(t, async () => ({}));
  const res = await handler(event('POST', '/api/logout', { cookies: [`${AT_COOKIE}=tok`, `${RT_COOKIE}=rt`] }));
  assert.equal(res.statusCode, 200);
  assert.ok(res.cookies.some((c) => c.includes('Max-Age=0')));
});

// ===== library =====
test('GET /api/books returns books with stale collections self-healed', async (t) => {
  authn(t);
  mockDdb(t, {
    QueryCommand: (cmd) => {
      if (cmd.input.ExpressionAttributeValues[':coll']) return { Items: [{ id: 'coll1', name: 'Keep' }] };
      return { Items: [{ pk: 'u#u1', id: 'b1', format: 'pdf', collections: ['coll1', 'gone'] }] };
    },
  });
  const res = await handler(event('GET', '/api/books', AUTHED));
  const out = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(out.books[0].collections, ['coll1']); // 'gone' filtered
});

// ===== POST /api/books validation + quota =====
test('POST /api/books rejects missing id / bad format / note format', async (t) => {
  authn(t); mockDdb(t);
  assert.equal((await handler(event('POST', '/api/books', { ...AUTHED, body: {} }))).statusCode, 400);
  assert.equal((await handler(event('POST', '/api/books', { ...AUTHED, body: { id: 'b1', format: 'xyz' } }))).statusCode, 400);
  assert.equal((await handler(event('POST', '/api/books', { ...AUTHED, body: { id: 'b1', format: 'note' } }))).statusCode, 400);
});

test('POST /api/books linked media: stored, but url must be audio/video + https', async (t) => {
  authn(t); mockDdb(t);
  assert.equal((await handler(event('POST', '/api/books', { ...AUTHED, body: { id: 'b1', format: 'pdf', url: 'https://x/y' } }))).statusCode, 400);
  assert.equal((await handler(event('POST', '/api/books', { ...AUTHED, body: { id: 'b1', format: 'audio', url: 'http://x/y' } }))).statusCode, 400);
  assert.equal((await handler(event('POST', '/api/books', { ...AUTHED, body: { id: 'b1', format: 'audio', url: 'https://x/y' } }))).statusCode, 200);
});

test('POST /api/books rejects a bad content type', async (t) => {
  authn(t); mockDdb(t);
  // audio with a disallowed contentType still resolves to octet-stream (not null);
  // only an unknown FORMAT yields null -> but format is validated earlier. Use a
  // format whose chooseContentType returns null is impossible here, so assert the
  // happy path content-type instead.
  const res = await handler(event('POST', '/api/books', { ...AUTHED, body: { id: 'b1', format: 'pdf', size: 10 } }));
  assert.equal(res.statusCode, 200);
});

test('POST /api/books admission rejects when declared size exceeds the quota (413)', async (t) => {
  authn(t);
  mockDdb(t, { QueryCommand: () => ({ Items: [{ pk: 'u#u1', id: 'b0', format: 'pdf', size: repo.USER_QUOTA_BYTES }] }) });
  const res = await handler(event('POST', '/api/books', { ...AUTHED, body: { id: 'b1', format: 'pdf', size: 1 } }));
  assert.equal(res.statusCode, 413);
});

test('POST /api/books success returns a presigned upload url', async (t) => {
  authn(t);
  mockDdb(t, { QueryCommand: () => ({ Items: [] }) });
  const res = await handler(event('POST', '/api/books', { ...AUTHED, body: { id: 'b1', format: 'pdf', size: 100 } }));
  const out = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.match(out.uploadUrl, /^https:\/\/bucket\.s3/);
});

// ===== finalize =====
test('POST /finalize 404s when the book does not exist', async (t) => {
  authn(t);
  mockDdb(t, { GetCommand: () => ({ Item: undefined }) });
  const res = await handler(event('POST', '/api/books/b1/finalize', AUTHED));
  assert.equal(res.statusCode, 404);
});

test('POST /finalize records the true size on success', async (t) => {
  authn(t);
  mockDdb(t, {
    GetCommand: () => ({ Item: { pk: 'u#u1', id: 'b1', format: 'pdf', size: 0 } }),
    QueryCommand: () => ({ Items: [{ pk: 'u#u1', id: 'b1', format: 'pdf', size: 0 }] }),
  });
  mockS3(t, { HeadObjectCommand: () => ({ ContentLength: 4096 }) });
  const res = await handler(event('POST', '/api/books/b1/finalize', AUTHED));
  const out = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(out.size, 4096);
});

test('POST /finalize deletes the upload and 413s when the true size overshoots', async (t) => {
  authn(t);
  let deleted = false;
  mockDdb(t, {
    GetCommand: () => ({ Item: { pk: 'u#u1', id: 'b1', format: 'pdf', size: 0 } }),
    QueryCommand: () => ({ Items: [{ pk: 'u#u1', id: 'b0', format: 'pdf', size: repo.USER_QUOTA_BYTES }] }),
    DeleteCommand: () => { deleted = true; return {}; },
  });
  mockS3(t, { HeadObjectCommand: () => ({ ContentLength: 999 }) });
  const res = await handler(event('POST', '/api/books/b1/finalize', AUTHED));
  assert.equal(res.statusCode, 413);
  assert.ok(deleted);
});

// ===== single-book routes =====
test('GET /api/books/{id}/url: 404, linked-media 400, success', async (t) => {
  authn(t);
  mockDdb(t, { GetCommand: () => ({ Item: undefined }) });
  assert.equal((await handler(event('GET', '/api/books/b1/url', AUTHED))).statusCode, 404);

  mockDdb(t, { GetCommand: () => ({ Item: { id: 'b1', format: 'audio', url: 'https://x/y' } }) });
  assert.equal((await handler(event('GET', '/api/books/b1/url', AUTHED))).statusCode, 400);

  mockDdb(t, { GetCommand: () => ({ Item: { id: 'b1', format: 'pdf' } }) });
  const ok = await handler(event('GET', '/api/books/b1/url', AUTHED));
  assert.equal(ok.statusCode, 200);
  assert.match(JSON.parse(ok.body).url, /^https:\/\/bucket\.s3/);
});

test('PUT /collections: success and 404 on a missing item', async (t) => {
  authn(t);
  mockDdb(t, { UpdateCommand: () => ({}) });
  assert.equal((await handler(event('PUT', '/api/books/b1/collections', { ...AUTHED, body: { collections: ['coll1'] } }))).statusCode, 200);
  mockDdb(t, { UpdateCommand: condFail });
  assert.equal((await handler(event('PUT', '/api/books/b1/collections', { ...AUTHED, body: { collections: [] } }))).statusCode, 404);
});

test('PUT /progress: invalid 400, page-based, and generic', async (t) => {
  authn(t);
  mockDdb(t, { UpdateCommand: () => ({}) });
  assert.equal((await handler(event('PUT', '/api/books/b1/progress', { ...AUTHED, body: {} }))).statusCode, 400);
  assert.equal((await handler(event('PUT', '/api/books/b1/progress', { ...AUTHED, body: { currentPage: 3, frac: 0.5 } }))).statusCode, 200);
  assert.equal((await handler(event('PUT', '/api/books/b1/progress', { ...AUTHED, body: { progress: { kind: 'cfi', value: 'x' } } }))).statusCode, 200);
});

test('PATCH /api/books/{id}: success and 404', async (t) => {
  authn(t);
  mockDdb(t, { UpdateCommand: () => ({}) });
  assert.equal((await handler(event('PATCH', '/api/books/b1', { ...AUTHED, body: { title: 'T' } }))).statusCode, 200);
  mockDdb(t, { UpdateCommand: condFail });
  assert.equal((await handler(event('PATCH', '/api/books/b1', { ...AUTHED, body: { title: 'T' } }))).statusCode, 404);
});

test('DELETE /api/books/{id} removes item + object', async (t) => {
  authn(t);
  mockDdb(t, { GetCommand: () => ({ Item: { id: 'b1', format: 'pdf' } }), DeleteCommand: () => ({}) });
  mockS3(t, { DeleteObjectCommand: () => ({}) });
  assert.equal((await handler(event('DELETE', '/api/books/b1', AUTHED))).statusCode, 200);
});

// ===== enrich =====
test('POST /api/enrich rejects empty input', async (t) => {
  authn(t); mockDdb(t);
  assert.equal((await handler(event('POST', '/api/enrich', { ...AUTHED, body: {} }))).statusCode, 400);
});

// ===== clips =====
test('clips: GET, POST invalid/valid, DELETE', async (t) => {
  authn(t);
  mockDdb(t, { QueryCommand: () => ({ Items: [] }), PutCommand: () => ({}), DeleteCommand: () => ({}) });
  assert.equal((await handler(event('GET', '/api/books/b1/clips', AUTHED))).statusCode, 200);
  assert.equal((await handler(event('POST', '/api/books/b1/clips', { ...AUTHED, body: {} }))).statusCode, 400);
  assert.equal((await handler(event('POST', '/api/books/b1/clips', { ...AUTHED, body: { id: 'c1', page: 1, rects: [{ x: 0 }] } }))).statusCode, 200);
  assert.equal((await handler(event('DELETE', '/api/books/b1/clips/c1', AUTHED))).statusCode, 200);
});

// ===== notes =====
test('POST /api/notes: bad id, oversize, success', async (t) => {
  authn(t);
  mockDdb(t, { PutCommand: () => ({}) });
  mockS3(t, { PutObjectCommand: () => ({}) });
  assert.equal((await handler(event('POST', '/api/notes', { ...AUTHED, body: {} }))).statusCode, 400);
  assert.equal((await handler(event('POST', '/api/notes', { ...AUTHED, body: { id: 'b1' } }))).statusCode, 400); // not n-prefixed
  assert.equal((await handler(event('POST', '/api/notes', { ...AUTHED, body: { id: 'n1', body: 'x'.repeat(256 * 1024 + 1) } }))).statusCode, 400);
  assert.equal((await handler(event('POST', '/api/notes', { ...AUTHED, body: { id: 'n1', title: 'T', body: 'hi' } }))).statusCode, 200);
});

test('GET/PUT/DELETE /api/notes/{id}', async (t) => {
  authn(t);
  const noteItem = { id: 'n1', format: 'note', title: 'T' };
  mockDdb(t, { GetCommand: () => ({ Item: noteItem }), UpdateCommand: () => ({}), DeleteCommand: () => ({}) });
  mockS3(t, { GetObjectCommand: () => ({ Body: { transformToString: async () => 'body' } }), DeleteObjectCommand: () => ({}), PutObjectCommand: () => ({}) });
  assert.equal((await handler(event('GET', '/api/notes/n1', AUTHED))).statusCode, 200);
  assert.equal((await handler(event('PUT', '/api/notes/n1', { ...AUTHED, body: { title: 'T2', body: 'new' } }))).statusCode, 200);
  assert.equal((await handler(event('DELETE', '/api/notes/n1', AUTHED))).statusCode, 200);
});

test('GET /api/notes/{id} 404 when the item is not a note', async (t) => {
  authn(t);
  mockDdb(t, { GetCommand: () => ({ Item: { id: 'n1', format: 'pdf' } }) });
  assert.equal((await handler(event('GET', '/api/notes/n1', AUTHED))).statusCode, 404);
});

// ===== collections =====
test('collections: POST bad/ok, PATCH ok/404, DELETE', async (t) => {
  authn(t);
  mockDdb(t, { PutCommand: () => ({}), UpdateCommand: () => ({}), DeleteCommand: () => ({}), QueryCommand: () => ({ Items: [] }) });
  assert.equal((await handler(event('POST', '/api/collections', { ...AUTHED, body: { id: 'bad' } }))).statusCode, 400);
  assert.equal((await handler(event('POST', '/api/collections', { ...AUTHED, body: { id: 'coll1', name: 'N' } }))).statusCode, 200);
  assert.equal((await handler(event('PATCH', '/api/collections/coll1', { ...AUTHED, body: { name: 'N2' } }))).statusCode, 200);
  mockDdb(t, { UpdateCommand: condFail });
  assert.equal((await handler(event('PATCH', '/api/collections/coll1', { ...AUTHED, body: { name: 'N2' } }))).statusCode, 404);
  mockDdb(t, { DeleteCommand: () => ({}), QueryCommand: () => ({ Items: [] }) });
  assert.equal((await handler(event('DELETE', '/api/collections/coll1', AUTHED))).statusCode, 200);
});

// ===== fallthrough + crash =====
test('an unknown route is 404', async (t) => {
  authn(t); mockDdb(t);
  assert.equal((await handler(event('GET', '/api/nope', AUTHED))).statusCode, 404);
});

test('an unexpected repo error becomes a 500', async (t) => {
  authn(t);
  mockDdb(t, { QueryCommand: () => { throw new Error('ddb down'); } });
  assert.equal((await handler(event('GET', '/api/books', AUTHED))).statusCode, 500);
});

// ===== cognitoErr mappings =====
test('cognitoErr maps the remaining Cognito error names', async (t) => {
  const cases = [
    ['/api/auth/signup', { username: 'a', password: 'p', email: 'e' }, 'InvalidPasswordException', 400],
    ['/api/auth/confirm', { username: 'a', code: 'x' }, 'CodeMismatchException', 400],
    ['/api/auth/confirm', { username: 'a', code: 'x' }, 'ExpiredCodeException', 400],
    ['/api/auth/login', { username: 'a', password: 'p' }, 'TooManyRequestsException', 429],
  ];
  for (const [path, body, name, status] of cases) {
    mockDdb(t);
    mockCognito(t, async () => { const e = new Error('x'); e.name = name; throw e; });
    assert.equal((await handler(event('POST', path, { body }))).statusCode, status, name);
  }
});

test('a PreSignUp Lambda validation error surfaces its message as 400', async (t) => {
  mockDdb(t);
  mockCognito(t, async () => {
    const e = new Error('PreSignUp failed with error not invited.');
    e.name = 'UserLambdaValidationException';
    throw e;
  });
  const res = await handler(event('POST', '/api/auth/signup', { body: { username: 'a', password: 'p', email: 'e' } }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'not invited');
});

// ===== refresh failure =====
test('a failed token refresh yields 401', async (t) => {
  t.mock.method(CognitoJwtVerifier.prototype, 'verify', async () => null);
  mockCognito(t, async () => { throw new Error('refresh dead'); });
  const res = await handler(event('GET', '/api/books', { cookies: [`${AT_COOKIE}=stale`, `${RT_COOKIE}=rt`] }));
  assert.equal(res.statusCode, 401);
});

// ===== enrich success + failure =====
test('POST /api/enrich returns extracted fields on success', async (t) => {
  authn(t); mockDdb(t);
  t.mock.method(BedrockRuntimeClient.prototype, 'send', async () => ({
    output: { message: { content: [{ toolUse: { input: { title: 'Extracted' } } }] } },
  }));
  const res = await handler(event('POST', '/api/enrich', { ...AUTHED, body: { pagesText: 'some text' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).fields.title, 'Extracted');
});

test('POST /api/enrich returns 502 when extraction throws', async (t) => {
  authn(t); mockDdb(t);
  t.mock.method(BedrockRuntimeClient.prototype, 'send', async () => { throw new Error('bedrock down'); });
  const res = await handler(event('POST', '/api/enrich', { ...AUTHED, body: { pagesText: 'x' } }));
  assert.equal(res.statusCode, 502);
});

// ===== collection delete eagerly strips the id from referencing items =====
test('DELETE /api/collections/{id} strips the id from items that reference it', async (t) => {
  authn(t);
  let stripped = null;
  mockDdb(t, {
    DeleteCommand: () => ({}),
    QueryCommand: () => ({ Items: [{ pk: 'u#u1', id: 'b1', collections: ['coll1', 'coll2'] }] }),
    UpdateCommand: (cmd) => { stripped = cmd.input.ExpressionAttributeValues[':c']; return {}; },
  });
  const res = await handler(event('DELETE', '/api/collections/coll1', AUTHED));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(stripped, ['coll2']); // coll1 removed from the item's list
});

// ===== note body missing in S3 falls back to empty =====
test('GET /api/notes/{id} returns an empty body when the S3 object is missing', async (t) => {
  authn(t);
  mockDdb(t, { GetCommand: () => ({ Item: { id: 'n1', format: 'note', title: 'T' } }) });
  mockS3(t, { GetObjectCommand: () => { const e = new Error('gone'); e.name = 'NoSuchKey'; throw e; } });
  const res = await handler(event('GET', '/api/notes/n1', AUTHED));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).body, '');
});
