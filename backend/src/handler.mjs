import { getConfig } from './config.mjs';
import { signSession, verifySession, parseCookies, timingSafeEqualStr } from './auth.mjs';
import * as repo from './repo.mjs';
import { extractMetadata } from './bedrock.mjs';

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

// Pure helper (unit-testable): true only for an https:// URL.
export function isHttpsUrl(s) {
  try { return new URL(s).protocol === 'https:'; } catch { return false; }
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
      const [books, collections] = await Promise.all([
        repo.listBooks(), repo.listCollections(),
      ]);
      // Lazy self-heal: intersect each book's collections with the live set so
      // stale membership (e.g. a collection deleted out-of-band) never surfaces.
      const liveSet = new Set(collections.map((c) => c.id));
      for (const book of books) {
        book.collections = (book.collections || []).filter((c) => liveSet.has(c));
      }
      return json(200, { books, collections });
    }

    if (method === 'POST' && path === '/api/books') {
      // body: full Book metadata (without the file bytes)
      if (!body.id) return json(400, { error: 'missing id' });
      const format = body.format ?? 'pdf';
      // Notes are created via a dedicated route (not built in Phase 0).
      if (!repo.FORMATS.has(format) || format === 'note') {
        return json(400, { error: 'bad format' });
      }
      // Linked (external) media: no bytes to upload, so no presigned PUT.
      if (body.url != null && body.url !== '') {
        if (format !== 'audio' && format !== 'video') {
          return json(400, { error: 'url only valid for audio/video' });
        }
        if (!isHttpsUrl(body.url)) return json(400, { error: 'url must be https' });
        await repo.putBook({ ...body, format, provider: body.provider ?? null });
        return json(200, { ok: true });
      }
      const contentType = repo.chooseContentType(format, body.contentType);
      if (contentType === null) return json(400, { error: 'bad content type' });
      await repo.putBook({ ...body, format });
      const uploadUrl = await repo.presignPut(body.id, format, contentType);
      return json(200, { ok: true, uploadUrl, contentType });
    }

    // --- AI metadata enrichment (no persistence) ---
    if (method === 'POST' && path === '/api/enrich') {
      if (!body.coverImageB64 &&
          (!Array.isArray(body.pageImagesB64) || !body.pageImagesB64.length) &&
          !body.pagesText) {
        return json(400, { error: 'no input' });
      }
      try {
        const fields = await extractMetadata({
          coverImageB64: body.coverImageB64,
          coverMime: body.coverMime,
          pageImagesB64: body.pageImagesB64,
          pagesText: body.pagesText,
          formatHint: body.formatHint,
        });
        return json(200, { fields });
      } catch (err) {
        console.error('enrich error', err);
        return json(502, { error: 'enrich failed' });
      }
    }

    const m = path.match(/^\/api\/books\/([^/]+)(\/url|\/progress|\/collections)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2];

      if (method === 'GET' && sub === '/url') {
        const book = await repo.getBook(id);
        if (!book) return json(404, { error: 'not found' });
        if (repo.isLinkedMedia(book)) return json(400, { error: 'linked media has no presigned url' });
        return json(200, { url: await repo.presignGet(id, book.format) });
      }
      if (method === 'PUT' && sub === '/collections') {
        const ids = Array.isArray(body.collections) ? body.collections : [];
        try {
          await repo.setItemCollections(id, ids);
        } catch (err) {
          if (err?.name === 'ConditionalCheckFailedException') return json(404, { error: 'not found' });
          throw err;
        }
        return json(200, { ok: true });
      }
      if (method === 'PUT' && sub === '/progress') {
        const parsed = parseProgressBody(body);
        if (!parsed) return json(400, { error: 'currentPage required' });
        const lastReadAt = body.lastReadAt ?? Date.now();
        if ('currentPage' in parsed) {
          // Paged formats: currentPage + optional within-page frac (may be undefined).
          await repo.updateProgress(id, parsed.currentPage, lastReadAt, parsed.frac);
        } else {
          await repo.updateProgressGeneric(id, parsed.progress, lastReadAt);
        }
        return json(200, { ok: true });
      }
      if (method === 'PATCH' && !sub) {
        // Allowlisted metadata patch (repo.updateBookMeta drops unknown keys).
        try {
          await repo.updateBookMeta(id, body);
        } catch (err) {
          if (err?.name === 'ConditionalCheckFailedException') return json(404, { error: 'not found' });
          throw err;
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

    // --- collections: /api/collections[/{id}] ---
    if (method === 'POST' && path === '/api/collections') {
      if (!body.id || !repo.isCollectionId(body.id)) return json(400, { error: 'bad collection id' });
      const createdAt = Date.now();
      const name = body.name ?? '';
      await repo.putCollection({ id: body.id, name, createdAt });
      return json(200, { ok: true, collection: { id: body.id, name, createdAt } });
    }

    const colm = path.match(/^\/api\/collections(?:\/([^/]+))?$/);
    if (colm && colm[1]) {
      const id = decodeURIComponent(colm[1]);

      if (method === 'PATCH') {
        try {
          await repo.renameCollection(id, body.name ?? '');
        } catch (err) {
          if (err?.name === 'ConditionalCheckFailedException') return json(404, { error: 'not found' });
          throw err;
        }
        return json(200, { ok: true });
      }
      if (method === 'DELETE') {
        await repo.deleteCollection(id);
        return json(200, { ok: true });
      }
    }

    return json(404, { error: 'no route' });
  } catch (err) {
    console.error('handler error', err);
    return json(500, { error: 'server error' });
  }
}
