import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { makeRepo } from './repo.mjs';
import { makeCognito } from './cognito.mjs';
import { makeVerifier } from './jwt.mjs';
import { makeRateLimiter, LIMITS } from './ratelimit.mjs';
import {
  parseCookies, authCookies, refreshedCookie, clearedCookies, AT_COOKIE, RT_COOKIE,
} from './session.mjs';
import { validateHandle } from './handle.mjs';

const json = (statusCode, body, cookies = []) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
  ...(cookies.length ? { cookies } : {}),
});

export function makeHandler({ repo, cognito, verifyAccess, allow }) {
  // 2s grace: JWT iat has second precision; a login in the same second as a
  // logout-everywhere bump must not be rejected.
  async function passesRevocationGate(claims) {
    const meta = await repo.getMeta(claims.sub);
    return !meta?.tokensValidAfter || claims.iat * 1000 >= meta.tokensValidAfter - 2000;
  }

  // -> { sub, username, setCookies } | null. Verifies the access token; if
  // stale, transparently refreshes from the refresh-token cookie.
  async function getSession(jar) {
    const claims = await verifyAccess(jar[AT_COOKIE]);
    if (claims) {
      return (await passesRevocationGate(claims)) ? { ...claims, setCookies: [] } : null;
    }
    if (!jar[RT_COOKIE]) return null;
    let result;
    try { result = await cognito.refresh(jar[RT_COOKIE]); } catch { return null; }
    const fresh = await verifyAccess(result?.AccessToken);
    if (!fresh || !(await passesRevocationGate(fresh))) return null;
    return { ...fresh, setCookies: [refreshedCookie(result.AccessToken)] };
  }

  return async function handler(event) {
    // Gate: only CloudFront knows the origin secret (Function URL is public).
    const headers = event.headers ?? {};
    if (!process.env.ORIGIN_SECRET || headers['x-origin-secret'] !== process.env.ORIGIN_SECRET) {
      return json(403, { error: 'forbidden' });
    }

    const method = event.requestContext?.http?.method ?? 'GET';
    const path = (event.rawPath ?? '/').replace(/\/+$/, '') || '/';
    const ip = event.requestContext?.http?.sourceIp ?? 'unknown';
    const jar = parseCookies(event.cookies);
    const body = event.body
      ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body)
      : {};

    // CSRF: cross-site fetch cannot send custom headers without a CORS
    // preflight, which this API never grants. Required on every mutation.
    if (method !== 'GET' && headers['x-csrf'] !== '1') {
      return json(403, { error: 'missing csrf header' });
    }

    try {
      // ---------- public auth routes ----------
      if (method === 'POST' && path === '/api/signup') {
        if (!(await allow('signup', ip, LIMITS.signup))) return json(429, { error: 'too many attempts' });
        const username = String(body.username ?? '').toLowerCase();
        const v = validateHandle(username);
        if (!v.ok) return json(400, { error: v.reason });
        if (!body.email || !body.password) return json(400, { error: 'email and passphrase required' });
        try {
          await cognito.signUp(username, body.password, body.email);
        } catch (err) {
          if (err.name === 'UsernameExistsException') return json(409, { error: 'that username or email is unavailable' });
          if (err.name === 'InvalidPasswordException') return json(400, { error: 'passphrase must be at least 12 characters' });
          if (err.name === 'UserLambdaValidationException') return json(400, { error: 'that username is not allowed' });
          throw err;
        }
        return json(200, { ok: true });
      }

      if (method === 'POST' && path === '/api/confirm') {
        if (!(await allow('confirm', ip, LIMITS.confirm))) return json(429, { error: 'too many attempts' });
        try {
          await cognito.confirm(String(body.username ?? '').toLowerCase(), String(body.code ?? ''));
        } catch {
          return json(400, { error: 'that code did not match' });
        }
        return json(200, { ok: true });
      }

      if (method === 'POST' && path === '/api/resend') {
        if (!(await allow('confirm', ip, LIMITS.confirm))) return json(429, { error: 'too many attempts' });
        try { await cognito.resend(String(body.username ?? '').toLowerCase()); } catch { /* no enumeration */ }
        return json(200, { ok: true });
      }

      if (method === 'POST' && path === '/api/login') {
        if (!(await allow('login', ip, LIMITS.login))) return json(429, { error: 'too many attempts' });
        try {
          const result = await cognito.login(String(body.username ?? '').toLowerCase(), body.password ?? '');
          return json(200, { ok: true }, authCookies(result));
        } catch (err) {
          if (err.name === 'UserNotConfirmedException') return json(403, { error: 'unconfirmed' });
          return json(401, { error: 'invalid credentials' });
        }
      }

      if (method === 'POST' && path === '/api/forgot') {
        if (!(await allow('forgot', ip, LIMITS.forgot))) return json(429, { error: 'too many attempts' });
        try { await cognito.forgot(String(body.username ?? '').toLowerCase()); } catch { /* no enumeration */ }
        return json(200, { ok: true });
      }

      if (method === 'POST' && path === '/api/forgot/confirm') {
        if (!(await allow('forgot', ip, LIMITS.forgot))) return json(429, { error: 'too many attempts' });
        try {
          await cognito.confirmForgot(
            String(body.username ?? '').toLowerCase(), String(body.code ?? ''), body.password ?? '',
          );
        } catch {
          return json(400, { error: 'could not reset the passphrase' });
        }
        return json(200, { ok: true });
      }

      // ---------- session routes ----------
      const session = await getSession(jar);

      if (method === 'POST' && path === '/api/logout') {
        if (jar[RT_COOKIE]) { try { await cognito.revoke(jar[RT_COOKIE]); } catch { /* already dead */ } }
        if (session) await repo.bumpTokensValidAfter(session.sub);
        return json(200, { ok: true }, clearedCookies());
      }

      if (!session) return json(401, { error: 'unauthorized' });
      const { sub, setCookies } = session;

      if (method === 'GET' && path === '/api/me') {
        return json(200, { username: session.username }, setCookies);
      }

      if (method === 'GET' && path === '/api/books') {
        return json(200, { books: await repo.listBooks(sub) }, setCookies);
      }

      if (method === 'POST' && path === '/api/books') {
        if (!body.id) return json(400, { error: 'missing id' });
        const put = await repo.putBook(sub, body);
        if (!put.ok) return json(403, { error: put.reason }, setCookies);
        const upload = await repo.presignUpload(sub, body.id);
        return json(200, { ok: true, upload }, setCookies);
      }

      const m = path.match(/^\/api\/books\/([^/]+)(\/url|\/progress)?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const sub2 = m[2];

        if (method === 'GET' && sub2 === '/url') {
          const book = await repo.getBook(sub, id);
          if (!book) return json(404, { error: 'not found' }, setCookies);
          return json(200, { url: await repo.presignDownload(sub, id) }, setCookies);
        }
        if (method === 'PUT' && sub2 === '/progress') {
          if (typeof body.currentPage !== 'number') return json(400, { error: 'currentPage required' }, setCookies);
          await repo.updateProgress(sub, id, body.currentPage, body.lastReadAt ?? Date.now());
          return json(200, { ok: true }, setCookies);
        }
        if (method === 'DELETE' && !sub2) {
          await repo.deleteBook(sub, id);
          return json(200, { ok: true }, setCookies);
        }
      }

      return json(404, { error: 'no route' }, setCookies);
    } catch (err) {
      console.error('handler error', err);
      return json(500, { error: 'server error' });
    }
  };
}

// Lazy so importing this module never constructs AWS clients in tests.
let live;
export async function handler(event) {
  if (!live) {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const s3 = new S3Client({});
    live = makeHandler({
      repo: makeRepo({ ddb, s3 }),
      cognito: makeCognito(),
      verifyAccess: makeVerifier(),
      allow: makeRateLimiter({ ddb }),
    });
  }
  return live(event);
}
