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

<<<<<<< HEAD
const json = (statusCode, body, cookies = []) => ({
=======
const COOKIE = 'folium_session';
const TTL = 60 * 60 * 24 * 30; // 30 days

const json = (statusCode, body, extra = {}) => ({
>>>>>>> origin/main
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
  ...(cookies.length ? { cookies } : {}),
});

<<<<<<< HEAD
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
    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
      } catch {
        return json(400, { error: 'invalid json' });
      }
    }

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
=======
function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

const PROGRESS_KINDS = new Set(['page', 'cfi', 'fraction', 'seconds']);

// Pure helper (unit-testable) that interprets a /progress request body.
// Returns one of:
//   { currentPage: number }            -- legacy contract, unchanged
//   { progress: { kind, value } }      -- generic multi-format progress
//   null                               -- invalid / unrecognized
export function parseProgressBody(body) {
  if (body && typeof body.currentPage === 'number') {
    return { currentPage: body.currentPage };
  }
  const p = body?.progress;
  if (p && PROGRESS_KINDS.has(p.kind) && p.value !== undefined && p.value !== null) {
    return { progress: { kind: p.kind, value: p.value } };
  }
  return null;
}

async function authed(event) {
  const { hmacKey } = await getConfig();
  const jar = parseCookies(event.cookies);
  return verifySession(hmacKey, jar[COOKIE]);
>>>>>>> origin/main
}

// Lazy so importing this module never constructs AWS clients in tests.
let live;
export async function handler(event) {
<<<<<<< HEAD
  if (!live) {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const s3 = new S3Client({});
    live = makeHandler({
      repo: makeRepo({ ddb, s3 }),
      cognito: makeCognito(),
      verifyAccess: makeVerifier(),
      allow: makeRateLimiter({ ddb }),
    });
=======
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
      const format = body.format ?? 'pdf';
      // Notes are created via a dedicated route (not built in Phase 0).
      if (!repo.FORMATS.has(format) || format === 'note') {
        return json(400, { error: 'bad format' });
      }
      const contentType = repo.chooseContentType(format, body.contentType);
      if (contentType === null) return json(400, { error: 'bad content type' });
      await repo.putBook({ ...body, format });
      const uploadUrl = await repo.presignPut(body.id, format, contentType);
      return json(200, { ok: true, uploadUrl, contentType });
    }

    const m = path.match(/^\/api\/books\/([^/]+)(\/url|\/progress)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2];

      if (method === 'GET' && sub === '/url') {
        const book = await repo.getBook(id);
        if (!book) return json(404, { error: 'not found' });
        return json(200, { url: await repo.presignGet(id, book.format) });
      }
      if (method === 'PUT' && sub === '/progress') {
        const parsed = parseProgressBody(body);
        if (!parsed) return json(400, { error: 'currentPage required' });
        const lastReadAt = body.lastReadAt ?? Date.now();
        if ('currentPage' in parsed) {
          // Legacy contract — unchanged.
          await repo.updateProgress(id, parsed.currentPage, lastReadAt);
        } else {
          await repo.updateProgressGeneric(id, parsed.progress, lastReadAt);
        }
        return json(200, { ok: true });
      }
      if (method === 'DELETE' && !sub) {
        await repo.deleteBook(id);
        return json(200, { ok: true });
      }
    }

    // --- clippings: /api/books/{id}/clips[/{clipId}] ---
    const cm = path.match(/^\/api\/books\/([^/]+)\/clips(?:\/([^/]+))?$/);
    if (cm) {
      const bookId = decodeURIComponent(cm[1]);
      const clipId = cm[2] ? decodeURIComponent(cm[2]) : null;

      if (method === 'GET' && !clipId) {
        return json(200, { clips: await repo.listClippings(bookId) });
      }
      if (method === 'POST' && !clipId) {
        if (!body.id || typeof body.page !== 'number' ||
            !Array.isArray(body.rects) || body.rects.length === 0) {
          return json(400, { error: 'invalid clip' });
        }
        await repo.putClipping(bookId, body);
        return json(200, { ok: true });
      }
      if (method === 'DELETE' && clipId) {
        await repo.deleteClipping(bookId, clipId);
        return json(200, { ok: true });
      }
    }

    // --- standalone notes: /api/notes[/{id}] ---
    // Note bodies (markdown) are stored server-side under notes/<id>.md; the
    // metadata item lives in DynamoDB with format:'note'.
    const NOTE_BODY_CAP = 256 * 1024; // hard cap on the markdown body

    if (method === 'POST' && path === '/api/notes') {
      if (!body.id) return json(400, { error: 'missing id' });
      if (!repo.isNoteId(body.id)) return json(400, { error: 'bad note id' });
      const noteBody = body.body ?? '';
      if (Buffer.byteLength(noteBody, 'utf8') > NOTE_BODY_CAP) {
        return json(400, { error: 'note too large' });
      }
      const now = Date.now();
      const item = {
        id: body.id,
        format: 'note',
        noteFormat: body.noteFormat ?? 'markdown',
        title: body.title ?? '',
        numPages: 1,
        currentPage: 1,
        cover: null,
        addedAt: now,
        lastReadAt: now,
        updatedAt: now,
      };
      await repo.putNote(item);
      await repo.putNoteBody(body.id, noteBody);
      return json(200, { ok: true, note: item });
    }

    const nm = path.match(/^\/api\/notes(?:\/([^/]+))?$/);
    if (nm && nm[1]) {
      const id = decodeURIComponent(nm[1]);

      if (method === 'GET') {
        const item = await repo.getBook(id);
        if (!item || item.format !== 'note') return json(404, { error: 'not found' });
        const noteBody = await repo.getNoteBody(id);
        return json(200, { body: noteBody, item });
      }
      if (method === 'PUT') {
        const item = await repo.getBook(id);
        if (!item || item.format !== 'note') return json(404, { error: 'not found' });
        if (body.body !== undefined) {
          if (Buffer.byteLength(body.body, 'utf8') > NOTE_BODY_CAP) {
            return json(400, { error: 'note too large' });
          }
          await repo.putNoteBody(id, body.body);
        }
        const now = Date.now();
        await repo.updateNoteMeta(id, {
          title: body.title,
          noteFormat: body.noteFormat,
          updatedAt: now,
          lastReadAt: now,
        });
        return json(200, { ok: true, updatedAt: now });
      }
      if (method === 'DELETE') {
        const item = await repo.getBook(id);
        if (!item || item.format !== 'note') return json(404, { error: 'not found' });
        // deleteBook resolves format -> deletes notes/<id>.md (best-effort S3).
        await repo.deleteBook(id);
        return json(200, { ok: true });
      }
    }

    return json(404, { error: 'no route' });
  } catch (err) {
    console.error('handler error', err);
    return json(500, { error: 'server error' });
>>>>>>> origin/main
  }
  return live(event);
}
