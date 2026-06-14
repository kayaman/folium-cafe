# Resume Exact Reading Position — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **⚠️ Serialization:** Tasks 4–6 all edit `project/app.ts` — execute sequentially, never two app.ts writers in parallel. Backend tasks 1–3 (`handler.mjs`/`repo.mjs`/`backend/test`) are independent and may run before/alongside.

**Goal:** Make PDF/CBZ resume the exact spot — right page, right place within the page, at your magnification — on the same device and across devices.

**Architecture:** Store a zoom-independent **within-page fraction** (`frac`, 0–1) that rides the existing progress pipeline and syncs server-side as a `posFrac` attribute; restore it after each page paint (mirroring `ScrollTextAdapter`'s proven whole-doc restore). Store **per-book zoom** locally and stop resetting zoom on open/width-toggle.

**Tech Stack:** Vanilla TS (esbuild) frontend; Node 20 ESM Lambda + `node:test` backend; DynamoDB. Frontend gates: `npx tsc --noEmit`, `node scripts/i18n-check.mjs`, `npm run build`. Backend: `cd backend && npm test`.

**Spec:** `docs/superpowers/specs/2026-06-14-resume-exact-position-design.md`
**Branch:** `feat/resume-exact-position` (holds the spec commit).

---

## Context

The app's purpose is resuming where you left off. At the high zoom a low-vision reader uses, a PDF page is taller than the screen, so today's "resume to page N" lands at the top of the page, and zoom resets to 1.0 on every open. This adds sub-page precision (synced) and per-book zoom memory (local).

## File map

- `backend/src/handler.mjs` — `parseProgressBody` accepts optional `frac`; `/progress` route forwards it. (Tasks 1, 3)
- `backend/src/repo.mjs` — pure `buildProgressUpdate()` helper + `updateProgress` writes `posFrac`. `listBooks`/`getBook` already spread `...rest`, so `posFrac` flows out with no change. (Task 2)
- `backend/test/progress.test.mjs` — **new**: unit tests for `parseProgressBody` (frac) and `buildProgressUpdate`. (Tasks 1, 2)
- `project/app.ts` — `DocPos.frac`, `Book.posFrac`, frac/zoom helpers, `PdfAdapter`/`CbzAdapter` capture+restore, `persistPos`/`progressBodyFor`/`openBook`/`renderAt`/zoom+width handlers. (Tasks 4–6)

## Verified anchors

- `parseProgressBody` `handler.mjs:26`; `/progress` route `:138`.
- `updateProgress` `repo.mjs:251`; `listBooks` `:140` / `getBook` `:244` spread `...rest`.
- `DocPos` `app.ts:92`; `PdfAdapter` `:1691` (`render` `:1715`); `CbzAdapter` `:1792`; `ScrollTextAdapter.attachScroll` `:1893` (pattern to mirror).
- `persistPos` `:2445`; `progressBodyFor` `:721`; `dbPutProgress` `:805`; `openBook` `:2263` (`reader.zoom = 1` `:2273`); `renderAt` `:2353` (builds `ctx.stage = el('r-stage')`); zoom buttons `:2978`; width-seg `reader.zoom = 1` `:2986`; `reader` state `:2237`; `LS` `:1041`.

---

## Task 1: Backend — `parseProgressBody` accepts a clamped `frac`

**Files:** Create `backend/test/progress.test.mjs`; Modify `backend/src/handler.mjs:26-36`

- [ ] **Step 1: Write failing tests** — create `backend/test/progress.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProgressBody } from '../src/handler.mjs';

test('parseProgressBody keeps the legacy currentPage shape', () => {
  assert.deepEqual(parseProgressBody({ currentPage: 50 }), { currentPage: 50 });
});

test('parseProgressBody carries an in-range frac alongside currentPage', () => {
  assert.deepEqual(parseProgressBody({ currentPage: 50, frac: 0.37 }), { currentPage: 50, frac: 0.37 });
});

test('parseProgressBody clamps frac into [0,1]', () => {
  assert.deepEqual(parseProgressBody({ currentPage: 1, frac: 1.8 }), { currentPage: 1, frac: 1 });
  assert.deepEqual(parseProgressBody({ currentPage: 1, frac: -0.5 }), { currentPage: 1, frac: 0 });
});

test('parseProgressBody omits a non-numeric or NaN frac', () => {
  assert.deepEqual(parseProgressBody({ currentPage: 1, frac: 'x' }), { currentPage: 1 });
  assert.deepEqual(parseProgressBody({ currentPage: 1, frac: NaN }), { currentPage: 1 });
});

test('parseProgressBody still returns the generic progress shape', () => {
  assert.deepEqual(parseProgressBody({ progress: { kind: 'cfi', value: 'epubcfi(/6/4)' } }),
    { progress: { kind: 'cfi', value: 'epubcfi(/6/4)' } });
});
```

- [ ] **Step 2: Run — expect FAIL** (frac not yet handled):
```bash
cd backend && node --test test/progress.test.mjs
```
Expected: the frac tests fail (frac dropped / not clamped).

- [ ] **Step 3: Implement** — replace the `currentPage` branch of `parseProgressBody` (`handler.mjs:27-29`):
```javascript
  if (body && typeof body.currentPage === 'number') {
    const out = { currentPage: body.currentPage };
    if (typeof body.frac === 'number' && Number.isFinite(body.frac)) {
      out.frac = Math.min(Math.max(body.frac, 0), 1);
    }
    return out;
  }
```

- [ ] **Step 4: Run — expect PASS:**
```bash
cd backend && node --test test/progress.test.mjs
```

- [ ] **Step 5: Commit**
```bash
git add backend/src/handler.mjs backend/test/progress.test.mjs
git commit -S -m "feat(progress): parse optional within-page frac (clamped 0-1)"
```

---

## Task 2: Backend — `buildProgressUpdate` writes `posFrac` only when present

**Files:** Modify `backend/src/repo.mjs:251-259`; Modify `backend/test/progress.test.mjs`

- [ ] **Step 1: Add failing tests** — append to `backend/test/progress.test.mjs`:
```javascript
import { buildProgressUpdate } from '../src/repo.mjs';

test('buildProgressUpdate sets currentPage + lastReadAt without frac', () => {
  const u = buildProgressUpdate(50, 1234, undefined);
  assert.equal(u.UpdateExpression, 'SET currentPage = :p, lastReadAt = :t');
  assert.deepEqual(u.ExpressionAttributeValues, { ':p': 50, ':t': 1234 });
});

test('buildProgressUpdate adds posFrac when frac is a number', () => {
  const u = buildProgressUpdate(50, 1234, 0.37);
  assert.equal(u.UpdateExpression, 'SET currentPage = :p, lastReadAt = :t, posFrac = :f');
  assert.deepEqual(u.ExpressionAttributeValues, { ':p': 50, ':t': 1234, ':f': 0.37 });
});
```

- [ ] **Step 2: Run — expect FAIL** (`buildProgressUpdate` undefined):
```bash
cd backend && node --test test/progress.test.mjs
```

- [ ] **Step 3: Implement** — replace `updateProgress` (`repo.mjs:251-259`) with a pure builder + thin wrapper:
```javascript
// Pure, unit-testable: assemble the progress UpdateCommand input. posFrac is
// written ONLY when a finite frac is supplied, so an older client that omits it
// never clobbers a good stored value.
export function buildProgressUpdate(currentPage, lastReadAt, frac) {
  const values = { ':p': currentPage, ':t': lastReadAt };
  let expr = 'SET currentPage = :p, lastReadAt = :t';
  if (typeof frac === 'number' && Number.isFinite(frac)) {
    expr += ', posFrac = :f';
    values[':f'] = frac;
  }
  return { UpdateExpression: expr, ExpressionAttributeValues: values };
}

export async function updateProgress(id, currentPage, lastReadAt, frac) {
  const { UpdateExpression, ExpressionAttributeValues } = buildProgressUpdate(currentPage, lastReadAt, frac);
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: PK, id },
    UpdateExpression,
    ConditionExpression: 'attribute_exists(id)',
    ExpressionAttributeValues,
  }));
}
```

- [ ] **Step 4: Run — expect PASS** (and the full backend suite stays green):
```bash
cd backend && node --test test/progress.test.mjs && npm test
```
Expected: new tests pass; the prior 46 still pass.

- [ ] **Step 5: Commit**
```bash
git add backend/src/repo.mjs backend/test/progress.test.mjs
git commit -S -m "feat(progress): write posFrac via pure buildProgressUpdate helper"
```

---

## Task 3: Backend — `/progress` route forwards `frac`

**Files:** Modify `backend/src/handler.mjs:142-145`

- [ ] **Step 1: Implement** — in the `currentPage` branch of the `/progress` route (`:142-145`), pass the parsed frac through:
```javascript
        if ('currentPage' in parsed) {
          // Legacy contract + optional within-page fraction.
          await repo.updateProgress(id, parsed.currentPage, lastReadAt, parsed.frac);
        } else {
```

- [ ] **Step 2: Verify the suite is green:**
```bash
cd backend && npm test
```
Expected: all pass (no behavior change when `frac` absent — `parsed.frac` is `undefined`).

- [ ] **Step 3: Commit**
```bash
git add backend/src/handler.mjs
git commit -S -m "feat(progress): forward frac from /progress route to repo"
```

---

## Task 4: Frontend — types, frac helpers, zoom storage

**Files:** Modify `project/app.ts` (`:92`, `:122-141`, `:1041`, near `:1027`)

- [ ] **Step 1: Extend `DocPos`** (`:92`) — add `frac`:
```typescript
interface DocPos {
  page?: number;
  cfi?: string;
  fraction?: number;   // whole-document scroll (txt/md)
  seconds?: number;
  frac?: number;       // within-page scroll fraction 0..1 (pdf/cbz), zoom-independent
}
```

- [ ] **Step 2: Extend `Book`** — after the `progress?` line (`:137`):
```typescript
  posFrac?: number;    // synced within-page fraction for paged formats
```

- [ ] **Step 3: Add LS keys** — inside the `LS` object (`:1041`):
```typescript
  zoom: 'folium.zoom',
  lastZoom: 'folium.lastZoom',
```

- [ ] **Step 4: Add frac + zoom helpers** — near the other small helpers (after `escapeHtml`, ~`:1027`):
```typescript
// Within-page scroll as a fraction of the page's scrollable height (zoom/screen
// independent). Mirrors ScrollTextAdapter's whole-doc math, applied per page.
function fracFromStage(stage: HTMLElement): number {
  const max = stage.scrollHeight - stage.clientHeight;
  return max > 0 ? Math.min(Math.max(stage.scrollTop / max, 0), 1) : 0;
}
function restoreFracToStage(stage: HTMLElement, frac: number): void {
  requestAnimationFrame(() => {
    const max = stage.scrollHeight - stage.clientHeight;
    stage.scrollTop = max > 0 ? Math.min(Math.max(frac, 0), 1) * max : 0;
  });
}
// Debounced within-page scroll capture for paged adapters. Returns a detach fn.
function attachPagedScroll(stage: HTMLElement): () => void {
  let timer = 0 as any;
  const handler = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      setReaderPos({ page: reader.pos.page, frac: fracFromStage(stage) });
      persistPos();
    }, 200);
  };
  stage.addEventListener('scroll', handler, { passive: true });
  return () => { stage.removeEventListener('scroll', handler); window.clearTimeout(timer); };
}

// Per-book zoom, per device. LRU-capped so the map can't grow without bound.
function getBookZoom(id: string): number | null {
  try {
    const m = JSON.parse(localStorage.getItem(LS.zoom) || '{}');
    return typeof m[id] === 'number' ? m[id] : null;
  } catch { return null; }
}
function setBookZoom(id: string, z: number): void {
  let m: Record<string, number>;
  try { m = JSON.parse(localStorage.getItem(LS.zoom) || '{}'); } catch { m = {}; }
  delete m[id]; m[id] = z;                       // move-to-end for LRU recency
  const keys = Object.keys(m);
  if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete m[k];
  localStorage.setItem(LS.zoom, JSON.stringify(m));
  localStorage.setItem(LS.lastZoom, String(z));
}
```

- [ ] **Step 5: Verify + commit**
```bash
cd /home/kayaman/Projects/folium-cafe && npx tsc --noEmit
git add project/app.ts && git commit -S -m "feat(reader): DocPos.frac, Book.posFrac, frac + per-book zoom helpers"
```
Expected: tsc clean (helpers reference `setReaderPos`/`persistPos`/`reader`, all in scope).

---

## Task 5: Frontend — `PdfAdapter` + `CbzAdapter` capture & restore frac

**Files:** Modify `project/app.ts` — `PdfAdapter` (`:1691`), `CbzAdapter` (`:1792`)

Apply the SAME three edits to BOTH adapter classes (they share the canvas/paged model).

- [ ] **Step 1: Add a detach field** — in each class, beside `private canvas` :
```typescript
  private detachScroll: (() => void) | null = null;
```

- [ ] **Step 2: Restore + re-attach after paint** — in each `render()`, immediately after the successful paint (PdfAdapter: after `renderTextLayerFor(...)` at `:1729`; CbzAdapter: the equivalent post-paint line), append:
```typescript
    this.detachScroll?.();
    restoreFracToStage(ctx.stage, pos.frac ?? 0);
    this.detachScroll = attachPagedScroll(ctx.stage);
```

- [ ] **Step 3: Clean up in `destroy()`** — in each class, prepend to the existing body:
```typescript
    this.detachScroll?.(); this.detachScroll = null;
```

- [ ] **Step 4: Verify + commit**
```bash
npx tsc --noEmit && npm run build
git add project/app.ts && git commit -S -m "feat(reader): paged adapters capture/restore within-page position"
```
Expected: tsc clean, build emits app.js. (Adapters now restore `pos.frac` after every paint and persist live scrolling.)

---

## Task 6: Frontend — persist frac, seed on open, preserve on zoom/width

**Files:** Modify `project/app.ts` — `persistPos` (`:2445`), `progressBodyFor` (`:721`), `openBook` (`:2263`), `renderAt` (`:2353`), zoom/width handlers (`:2978`/`:2986`)

- [ ] **Step 1: Capture `posFrac` in `persistPos`** — replace the paged branch (`:2453`) and extend the cached-sync line:
```typescript
  } else if (reader.pos.page != null) {
    b.currentPage = reader.pos.page;
    b.posFrac = reader.pos.frac ?? 0;
  }
  b.lastReadAt = Date.now();
  const cached = books.find(x => x.id === b.id);
  if (cached) { cached.currentPage = b.currentPage; cached.posFrac = b.posFrac; cached.progress = b.progress; cached.lastReadAt = b.lastReadAt; }
```

- [ ] **Step 2: Send `frac` in the paged wire payload** — replace `progressBodyFor` (`:721-725`). First widen its return type (`:717`) to allow `frac`:
```typescript
type ProgressBody =
  | { currentPage: number; frac?: number; lastReadAt: number }
  | { progress: { kind: 'page' | 'cfi' | 'fraction' | 'seconds'; value: number | string }; lastReadAt: number };

function progressBodyFor(b: Book): ProgressBody {
  const lastReadAt = b.lastReadAt || Date.now();
  if (b.progress) return { progress: b.progress, lastReadAt };
  const body: { currentPage: number; frac?: number; lastReadAt: number } = { currentPage: b.currentPage, lastReadAt };
  if (typeof b.posFrac === 'number') body.frac = b.posFrac;
  return body;
}
```

- [ ] **Step 3: Seed frac + per-book zoom in `openBook`** — replace the seed + zoom lines (`:2271-2273`):
```typescript
  setReaderPos({ page: Math.min(Math.max(1, b.currentPage || 1), b.numPages), frac: b.posFrac ?? 0 });
  reader.zoom = getBookZoom(id) ?? (Number(localStorage.getItem(LS.lastZoom)) || 1);
```

- [ ] **Step 4: Preserve the spot on keepScroll re-render** — in `renderAt` (`:2353`), right after the `if (pos.page != null) {…}` clamp block and before `setReaderPos(pos)`:
```typescript
  if (keepScroll && reader.adapter.caps.canvasPages) {
    pos = { ...pos, frac: fracFromStage(el('r-stage')) };
  }
```

- [ ] **Step 5: Persist zoom on the zoom buttons; stop resetting zoom** — replace the zoom button handlers (`:2978-2979`):
```typescript
  el('r-zoom-in').addEventListener('click', () => { reader.zoom = Math.min(reader.zoom + 0.15, 2.2); if (reader.book) setBookZoom(reader.book.id, reader.zoom); renderAt(reader.pos, true); });
  el('r-zoom-out').addEventListener('click', () => { reader.zoom = Math.max(reader.zoom - 0.15, 0.6); if (reader.book) setBookZoom(reader.book.id, reader.zoom); renderAt(reader.pos, true); });
```
and in the width-seg handler, **delete** the `reader.zoom = 1;` line (`:2986`) so switching width keeps magnification.

- [ ] **Step 6: Verify + commit**
```bash
npx tsc --noEmit && node scripts/i18n-check.mjs && npm run build
git add project/app.ts && git commit -S -m "feat(reader): persist within-page frac + per-book zoom; keep zoom on width toggle"
```

---

## Task 7: Full verification + PR

- [ ] **Step 1: All gates**
```bash
cd /home/kayaman/Projects/folium-cafe
npx tsc --noEmit && node scripts/i18n-check.mjs && npm run build && (cd backend && npm test)
```
Expected: tsc clean; i18n OK; build emits app.js/sw.js; backend tests pass (46 prior + new progress tests).

- [ ] **Step 2: Manual resume checklist** (run via the `run` skill / Playwright against a preview):
  1. Open a PDF, zoom ~1.8×, scroll mid-page, return to library, reopen → same page, same spot, same zoom.
  2. Change zoom and toggle comfort/full → the line stays put; zoom persists (no reset).
  3. Open a different book then return → each book keeps its own zoom; a brand-new book opens at last-used zoom, not 1.0.
  4. Cross-device: set position on device A; open on device B (different zoom) → same relative spot at B's zoom. (Confirm `posFrac` present in `GET /api/books`.)
  5. Offline: read offline, reconnect → `frac` replays via the progress queue (`flushProgressQueue`).

- [ ] **Step 3: Push + open PR**
```bash
git push -u origin feat/resume-exact-position
gh pr create --base main --title "feat: resume exact reading position + per-book zoom" --body "Within-page fraction (synced, zoom-independent) restores the exact spot in a PDF/CBZ; per-book per-device zoom stops resetting to 1.0. Backend posFrac is optional + backward-compatible. Spec: docs/superpowers/specs/2026-06-14-resume-exact-position-design.md"
```

- [ ] **Step 4: Watch CI green, then merge** (`gh pr merge --merge --delete-branch`) → auto-deploys.

---

## Self-review notes (done)

- **Spec coverage:** within-page frac sync (T1–T3 backend, T4–T6 frontend), per-book zoom (T4 helpers, T6 open/buttons), keepScroll preserve (T6 S4), remove resets (T6 S3+S5), backward-compat (`posFrac`/`frac` optional; absent → no clobber via T2), CBZ parity (T5 both classes). All mapped.
- **Type consistency:** `frac` (DocPos), `posFrac` (Book + wire), `buildProgressUpdate`/`updateProgress(…, frac)`, `fracFromStage`/`restoreFracToStage`/`attachPagedScroll`, `getBookZoom`/`setBookZoom` — names consistent across tasks.
- **Verify-on-execute (flagged, with fallbacks):** confirm `ctx.stage` (=`el('r-stage')`) is the scroll container in paged mode — if a tall zoomed page doesn't scroll the stage, capture/restore targets the actual overflow element instead (grep the `.rstage`/`.r-col` CSS for `overflow`); confirm `CbzAdapter` post-paint line for the T5 S2 insertion point; `caps.canvasPages` is true for both PDF and CBZ (used in T6 S4).
