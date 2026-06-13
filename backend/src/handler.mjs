import { getConfig } from './config.mjs';
import { signSession, verifySession, parseCookies, timingSafeEqualStr } from './auth.mjs';
import * as repo from './repo.mjs';

const COOKIE = 'folium_session';
const TTL = 60 * 60 * 24 * 30; // 30 days

const json = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
  ...extra,
});

function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function authed(event) {
  const { hmacKey } = await getConfig();
  const jar = parseCookies(event.cookies);
  return verifySession(hmacKey, jar[COOKIE]);
}

export async function handler(event) {
  // Gate: only CloudFront knows the origin secret, so a direct hit on the public
  // Function URL (which has AuthType=NONE) is rejected here.
  const headers = event.headers ?? {};
  if (!process.env.ORIGIN_SECRET || headers['x-origin-secret'] !== process.env.ORIGIN_SECRET) {
    return json(403, { error: 'forbidden' });
  }

  const method = event.requestContext?.http?.method ?? 'GET';
  const path = (event.rawPath ?? '/').replace(/\/+$/, '') || '/';
  const body = event.body
    ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body)
    : {};

  try {
    // --- login (unauthenticated) ---
    if (method === 'POST' && path === '/api/login') {
      const { password, hmacKey } = await getConfig();
      if (!password || !timingSafeEqualStr(body.password ?? '', password)) {
        return json(401, { error: 'bad password' });
      }
      const token = signSession(hmacKey, TTL);
      return json(200, { ok: true }, { cookies: [sessionCookie(token, TTL)] });
    }

    // --- everything below requires a valid session ---
    if (!(await authed(event))) return json(401, { error: 'unauthorized' });

    if (method === 'POST' && path === '/api/logout') {
      return json(200, { ok: true }, { cookies: [sessionCookie('', 0)] });
    }

    if (method === 'GET' && path === '/api/books') {
      return json(200, { books: await repo.listBooks() });
    }

    if (method === 'POST' && path === '/api/books') {
      // body: full Book metadata (without the file bytes)
      if (!body.id) return json(400, { error: 'missing id' });
      await repo.putBook(body);
      const uploadUrl = await repo.presignPut(body.id);
      return json(200, { ok: true, uploadUrl });
    }

    const m = path.match(/^\/api\/books\/([^/]+)(\/url|\/progress)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2];

      if (method === 'GET' && sub === '/url') {
        const book = await repo.getBook(id);
        if (!book) return json(404, { error: 'not found' });
        return json(200, { url: await repo.presignGet(id) });
      }
      if (method === 'PUT' && sub === '/progress') {
        if (typeof body.currentPage !== 'number') return json(400, { error: 'currentPage required' });
        await repo.updateProgress(id, body.currentPage, body.lastReadAt ?? Date.now());
        return json(200, { ok: true });
      }
      if (method === 'DELETE' && !sub) {
        await repo.deleteBook(id);
        return json(200, { ok: true });
      }
    }

    return json(404, { error: 'no route' });
  } catch (err) {
    console.error('handler error', err);
    return json(500, { error: 'server error' });
  }
}
