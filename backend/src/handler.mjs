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
  }
}
