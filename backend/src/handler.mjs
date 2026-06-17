import { makeCognito } from './cognito.mjs';
import { makeVerifier } from './jwt.mjs';
import { parseCookies, authCookies, refreshedCookie, clearedCookies, AT_COOKIE, RT_COOKIE } from './session.mjs';
import { makeRateLimiter, LIMITS } from './ratelimit.mjs';
import * as repo from './repo.mjs';
import { extractMetadata } from './bedrock.mjs';

// Lazily constructed so importing this module for its pure helpers (the unit
// tests do this) never touches Cognito config / env vars. makeVerifier throws
// at construction time when USER_POOL_ID is absent.
let _cognito;
let _verifier;
let _limiter;
const cognito = () => (_cognito ??= makeCognito());
const verifier = () => (_verifier ??= makeVerifier());
const limiter = () => (_limiter ??= makeRateLimiter({ ddb: repo.ddb }));

const json = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
  ...extra,
});

// Attach a (possibly null) refreshed-access-token cookie to a response without
// clobbering any cookies it already carries.
function withCookie(res, cookie) {
  if (!cookie) return res;
  return { ...res, cookies: [...(res.cookies ?? []), cookie] };
}

const PROGRESS_KINDS = new Set(['page', 'cfi', 'fraction', 'seconds']);

// Pure helper (unit-testable) that interprets a /progress request body.
export function parseProgressBody(body) {
  if (body && typeof body.currentPage === 'number') {
    const out = { currentPage: body.currentPage };
    if (typeof body.frac === 'number' && Number.isFinite(body.frac)) {
      out.frac = Math.min(Math.max(body.frac, 0), 1);
    }
    return out;
  }
  const p = body?.progress;
  if (p && PROGRESS_KINDS.has(p.kind) && p.value !== undefined && p.value !== null) {
    return { progress: { kind: p.kind, value: p.value } };
  }
  return null;
}

// Pure, unit-testable: true only for an https:// URL.
export function isHttpsUrl(s) {
  try { return new URL(s).protocol === 'https:'; } catch { return false; }
}

// Resolve the caller from the access-token cookie. If the access token is
// expired but a refresh token is present, transparently mint a fresh one and
// hand back a Set-Cookie to install it (server-side silent refresh). Returns
// { sub, username, cookie } or null. `cookie` is the refreshed AT cookie or null.
async function authed(event) {
  const jar = parseCookies(event.cookies);
  const at = jar[AT_COOKIE];
  const rt = jar[RT_COOKIE];

  const claims = await verifier()(at);
  if (claims) return { sub: claims.sub, username: claims.username, cookie: null };

  if (!rt) return null;
  try {
    const result = await cognito().refresh(rt);
    const fresh = await verifier()(result.AccessToken);
    if (!fresh) return null;
    return { sub: fresh.sub, username: fresh.username, cookie: refreshedCookie(result.AccessToken) };
  } catch {
    return null;
  }
}

// Map a Cognito SDK error to an HTTP response. Returns null when unrecognized
// (caller falls back to 500). Credential errors are deliberately uniform to
// avoid user enumeration.
function cognitoErr(err) {
  const n = err?.name;
  if (n === 'NotAuthorizedException' || n === 'UserNotFoundException') {
    return json(401, { error: 'bad credentials' });
  }
  if (n === 'UserNotConfirmedException') {
    return json(403, { error: 'email not confirmed' });
  }
  if (n === 'UsernameExistsException') {
    return json(409, { error: 'username taken' });
  }
  if (n === 'InvalidPasswordException') {
    return json(400, { error: 'password does not meet requirements' });
  }
  if (n === 'CodeMismatchException' || n === 'ExpiredCodeException') {
    return json(400, { error: 'invalid or expired code' });
  }
  if (n === 'UserLambdaValidationException') {
    const msg = err.message?.replace(/^PreSignUp failed with error\s*/i, '').replace(/\.$/, '') || 'signup rejected';
    return json(400, { error: msg });
  }
  if (n === 'TooManyRequestsException' || n === 'LimitExceededException') {
    return json(429, { error: 'too many requests' });
  }
  return null;
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
  const ip = headers['x-forwarded-for']?.split(',')[0]?.trim() ?? 'unknown';

  try {
    // ===== unauthenticated auth routes =====
    if (method === 'POST' && path === '/api/auth/signup') {
      if (!(await limiter()('signup', ip, LIMITS.signup))) return json(429, { error: 'too many requests' });
      try {
        await cognito().signUp(body.username, body.password, body.email);
        return json(200, { ok: true });
      } catch (err) {
        return cognitoErr(err) ?? json(500, { error: 'server error' });
      }
    }

    if (method === 'POST' && path === '/api/auth/confirm') {
      if (!(await limiter()('confirm', ip, LIMITS.confirm))) return json(429, { error: 'too many requests' });
      try {
        await cognito().confirm(body.username, body.code);
        return json(200, { ok: true });
      } catch (err) {
        return cognitoErr(err) ?? json(500, { error: 'server error' });
      }
    }

    if (method === 'POST' && path === '/api/auth/resend') {
      if (!(await limiter()('confirm', ip, LIMITS.confirm))) return json(429, { error: 'too many requests' });
      try {
        await cognito().resend(body.username);
        return json(200, { ok: true });
      } catch (err) {
        return cognitoErr(err) ?? json(500, { error: 'server error' });
      }
    }

    if (method === 'POST' && path === '/api/auth/login') {
      if (!(await limiter()('login', ip, LIMITS.login))) return json(429, { error: 'too many requests' });
      try {
        const result = await cognito().login(body.username, body.password);
        return json(200, { ok: true, username: body.username }, { cookies: authCookies(result) });
      } catch (err) {
        return cognitoErr(err) ?? json(500, { error: 'server error' });
      }
    }

    if (method === 'POST' && path === '/api/auth/forgot') {
      if (!(await limiter()('forgot', ip, LIMITS.forgot))) return json(429, { error: 'too many requests' });
      try {
        await cognito().forgot(body.username);
        return json(200, { ok: true });
      } catch (err) {
        // Don't leak whether the user exists — forgot always reports success.
        if (err?.name === 'UserNotFoundException') return json(200, { ok: true });
        return cognitoErr(err) ?? json(500, { error: 'server error' });
      }
    }

    if (method === 'POST' && path === '/api/auth/confirm-forgot') {
      if (!(await limiter()('forgot', ip, LIMITS.forgot))) return json(429, { error: 'too many requests' });
      try {
        await cognito().confirmForgot(body.username, body.code, body.password);
        return json(200, { ok: true });
      } catch (err) {
        return cognitoErr(err) ?? json(500, { error: 'server error' });
      }
    }

    // ===== everything below requires a valid session =====
    const auth = await authed(event);
    if (!auth) return json(401, { error: 'unauthorized' });
    const { sub: userId, cookie: refreshCookie } = auth;
    // ok() stamps the (possibly refreshed) access-token cookie on the response.
    const ok = (res) => withCookie(res, refreshCookie);

    if (method === 'POST' && path === '/api/logout') {
      const jar = parseCookies(event.cookies);
      const rt = jar[RT_COOKIE];
      try { if (rt) await cognito().revoke(rt); } catch {}
      return json(200, { ok: true }, { cookies: clearedCookies() });
    }

    if (method === 'GET' && path === '/api/books') {
      const [books, collections] = await Promise.all([
        repo.listBooks(userId), repo.listCollections(userId),
      ]);
      // Lazy self-heal: intersect each book's collections with the live set so
      // stale membership (e.g. a collection deleted out-of-band) never surfaces.
      const liveSet = new Set(collections.map((c) => c.id));
      for (const book of books) {
        book.collections = (book.collections || []).filter((c) => liveSet.has(c));
      }
      return ok(json(200, { books, collections }));
    }

    if (method === 'POST' && path === '/api/books') {
      // body: full Book metadata (without the file bytes)
      if (!body.id) return ok(json(400, { error: 'missing id' }));
      const format = body.format ?? 'pdf';
      // Notes are created via a dedicated route.
      if (!repo.FORMATS.has(format) || format === 'note') {
        return ok(json(400, { error: 'bad format' }));
      }
      // Linked (external) media: no bytes to upload, so no presigned PUT.
      if (body.url != null && body.url !== '') {
        if (format !== 'audio' && format !== 'video') {
          return ok(json(400, { error: 'url only valid for audio/video' }));
        }
        if (!isHttpsUrl(body.url)) return ok(json(400, { error: 'url must be https' }));
        await repo.putBook(userId, { ...body, format, provider: body.provider ?? null });
        return ok(json(200, { ok: true }));
      }
      const contentType = repo.chooseContentType(format, body.contentType);
      if (contentType === null) return ok(json(400, { error: 'bad content type' }));
      await repo.putBook(userId, { ...body, format });
      const uploadUrl = await repo.presignPut(userId, body.id, format, contentType);
      return ok(json(200, { ok: true, uploadUrl, contentType }));
    }

    // --- AI metadata enrichment (no persistence) ---
    if (method === 'POST' && path === '/api/enrich') {
      if (!body.coverImageB64 &&
          (!Array.isArray(body.pageImagesB64) || !body.pageImagesB64.length) &&
          !body.pagesText) {
        return ok(json(400, { error: 'no input' }));
      }
      try {
        const fields = await extractMetadata({
          coverImageB64: body.coverImageB64,
          coverMime: body.coverMime,
          pageImagesB64: body.pageImagesB64,
          pagesText: body.pagesText,
          formatHint: body.formatHint,
        });
        return ok(json(200, { fields }));
      } catch (err) {
        console.error('enrich error', err);
        return ok(json(502, { error: 'enrich failed' }));
      }
    }

    const m = path.match(/^\/api\/books\/([^/]+)(\/url|\/progress|\/collections)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2];

      if (method === 'GET' && sub === '/url') {
        const book = await repo.getBook(userId, id);
        if (!book) return ok(json(404, { error: 'not found' }));
        if (repo.isLinkedMedia(book)) return ok(json(400, { error: 'linked media has no presigned url' }));
        return ok(json(200, { url: await repo.presignGet(userId, id, book.format) }));
      }
      if (method === 'PUT' && sub === '/collections') {
        const ids = Array.isArray(body.collections) ? body.collections : [];
        try {
          await repo.setItemCollections(userId, id, ids);
        } catch (err) {
          if (err?.name === 'ConditionalCheckFailedException') return ok(json(404, { error: 'not found' }));
          throw err;
        }
        return ok(json(200, { ok: true }));
      }
      if (method === 'PUT' && sub === '/progress') {
        const parsed = parseProgressBody(body);
        if (!parsed) return ok(json(400, { error: 'currentPage required' }));
        const lastReadAt = body.lastReadAt ?? Date.now();
        if ('currentPage' in parsed) {
          // Paged formats: currentPage + optional within-page frac (may be undefined).
          await repo.updateProgress(userId, id, parsed.currentPage, lastReadAt, parsed.frac);
        } else {
          await repo.updateProgressGeneric(userId, id, parsed.progress, lastReadAt);
        }
        return ok(json(200, { ok: true }));
      }
      if (method === 'PATCH' && !sub) {
        // Allowlisted metadata patch (repo.updateBookMeta drops unknown keys).
        try {
          await repo.updateBookMeta(userId, id, body);
        } catch (err) {
          if (err?.name === 'ConditionalCheckFailedException') return ok(json(404, { error: 'not found' }));
          throw err;
        }
        return ok(json(200, { ok: true }));
      }
      if (method === 'DELETE' && !sub) {
        await repo.deleteBook(userId, id);
        return ok(json(200, { ok: true }));
      }
    }

    // --- clippings: /api/books/{id}/clips[/{clipId}] ---
    const cm = path.match(/^\/api\/books\/([^/]+)\/clips(?:\/([^/]+))?$/);
    if (cm) {
      const bookId = decodeURIComponent(cm[1]);
      const clipId = cm[2] ? decodeURIComponent(cm[2]) : null;

      if (method === 'GET' && !clipId) {
        return ok(json(200, { clips: await repo.listClippings(userId, bookId) }));
      }
      if (method === 'POST' && !clipId) {
        if (!body.id || typeof body.page !== 'number' ||
            !Array.isArray(body.rects) || body.rects.length === 0) {
          return ok(json(400, { error: 'invalid clip' }));
        }
        await repo.putClipping(userId, bookId, body);
        return ok(json(200, { ok: true }));
      }
      if (method === 'DELETE' && clipId) {
        await repo.deleteClipping(userId, bookId, clipId);
        return ok(json(200, { ok: true }));
      }
    }

    // --- standalone notes: /api/notes[/{id}] ---
    // Note bodies (markdown) are stored server-side under u/<sub>/notes/<id>.md;
    // the metadata item lives in DynamoDB with format:'note'.
    const NOTE_BODY_CAP = 256 * 1024; // hard cap on the markdown body

    if (method === 'POST' && path === '/api/notes') {
      if (!body.id) return ok(json(400, { error: 'missing id' }));
      if (!repo.isNoteId(body.id)) return ok(json(400, { error: 'bad note id' }));
      const noteBody = body.body ?? '';
      if (Buffer.byteLength(noteBody, 'utf8') > NOTE_BODY_CAP) {
        return ok(json(400, { error: 'note too large' }));
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
      await repo.putNote(userId, item);
      await repo.putNoteBody(userId, body.id, noteBody);
      return ok(json(200, { ok: true, note: item }));
    }

    const nm = path.match(/^\/api\/notes(?:\/([^/]+))?$/);
    if (nm && nm[1]) {
      const id = decodeURIComponent(nm[1]);

      if (method === 'GET') {
        const item = await repo.getBook(userId, id);
        if (!item || item.format !== 'note') return ok(json(404, { error: 'not found' }));
        const noteBody = await repo.getNoteBody(userId, id);
        return ok(json(200, { body: noteBody, item }));
      }
      if (method === 'PUT') {
        const item = await repo.getBook(userId, id);
        if (!item || item.format !== 'note') return ok(json(404, { error: 'not found' }));
        if (body.body !== undefined) {
          if (Buffer.byteLength(body.body, 'utf8') > NOTE_BODY_CAP) {
            return ok(json(400, { error: 'note too large' }));
          }
          await repo.putNoteBody(userId, id, body.body);
        }
        const now = Date.now();
        await repo.updateNoteMeta(userId, id, {
          title: body.title,
          noteFormat: body.noteFormat,
          updatedAt: now,
          lastReadAt: now,
        });
        return ok(json(200, { ok: true, updatedAt: now }));
      }
      if (method === 'DELETE') {
        const item = await repo.getBook(userId, id);
        if (!item || item.format !== 'note') return ok(json(404, { error: 'not found' }));
        // deleteBook resolves format -> deletes notes/<id>.md (best-effort S3).
        await repo.deleteBook(userId, id);
        return ok(json(200, { ok: true }));
      }
    }

    // --- collections: /api/collections[/{id}] ---
    if (method === 'POST' && path === '/api/collections') {
      if (!body.id || !repo.isCollectionId(body.id)) return ok(json(400, { error: 'bad collection id' }));
      const createdAt = Date.now();
      const name = body.name ?? '';
      await repo.putCollection(userId, { id: body.id, name, createdAt });
      return ok(json(200, { ok: true, collection: { id: body.id, name, createdAt } }));
    }

    const colm = path.match(/^\/api\/collections(?:\/([^/]+))?$/);
    if (colm && colm[1]) {
      const id = decodeURIComponent(colm[1]);

      if (method === 'PATCH') {
        try {
          await repo.renameCollection(userId, id, body.name ?? '');
        } catch (err) {
          if (err?.name === 'ConditionalCheckFailedException') return ok(json(404, { error: 'not found' }));
          throw err;
        }
        return ok(json(200, { ok: true }));
      }
      if (method === 'DELETE') {
        await repo.deleteCollection(userId, id);
        return ok(json(200, { ok: true }));
      }
    }

    return ok(json(404, { error: 'no route' }));
  } catch (err) {
    console.error('handler error', err);
    return json(500, { error: 'server error' });
  }
}
