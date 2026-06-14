# Resume Exactly Where You Were — Design

Date: 2026-06-14
Status: Approved (brainstorming)
Branch: `feat/resume-exact-position`

## Purpose

Folium Café's reason to exist is "so you remember the page you were on." For a
PDF/comic read at high magnification — the normal case for a low-vision reader —
a page is taller than the screen, so today's "resume to page N" drops you at the
*top* of page N, not the line you left, and your zoom is thrown away on every
open. This change makes the reader resume the **exact spot at your magnification**,
on the same device and across devices.

Two stated north-star priorities this serves (see memory `low-vision-reading-priority`):
remember the page across devices, and an easy, seamless, legible reading experience.

## Scope

In: PDF + CBZ (the paged/canvas formats). Three mechanisms — within-page position
(synced), per-book zoom (per-device), and zoom/width re-render that preserves the
spot. Out: reading-comfort font/line controls, dark/high-contrast themes, larger
controls, and server-side write-conflict detection (last-write-wins stays — fine
for the current single-user app). Those are later phases.

## Current behavior (verified)

- `DocPos` (`app.ts:92`) carries `page` for paged formats; `PdfAdapter`
  (`:1691`) / `CbzAdapter` persist only `pos.page`.
- `persistPos()` (`:2445`) sets `b.currentPage = pos.page` for paged mode and
  debounces a write (350 ms) through `dbPutProgress()` (`:805`); offline writes
  queue via `enqueueProgress()` (`:727`) and replay in `flushProgressQueue()`
  (`:735`).
- `openBook()` (`:2263`) seeds `setReaderPos({ page: … })` from
  `b.currentPage`, then `renderAt()`.
- Zoom lives in reader state, default `1` (`:2243`), and is **reset to 1** on book
  open (`:2273`) and on the comfort/full width toggle (`:2986`); zoom buttons step
  ±0.15, clamp 0.6–2.2 (`:2978`). Width persists to `folium.readerWidth`
  (`:2242`/`:2985`); zoom persists nowhere.
- Precedent for fraction restore: `ScrollTextAdapter` restores whole-document
  scroll via `stage.scrollTop = frac * (scrollHeight - clientHeight)` after a RAF
  (`:1883`). We apply the same trick **per page**.
- Backend: `parseProgressBody()` (`handler.mjs:21`) accepts `{currentPage}` or
  `{progress:{kind,value}}`; `updateProgress()` (`repo.mjs:251`) writes
  `currentPage`+`lastReadAt`.

## Design

### 1. Within-page position — synced across devices

Add `frac?: number` (0–1) to `DocPos`: the fraction of the **current page's own
scrollable height** that is above the viewport top. It is zoom- and
screen-independent, because the page's rendered height scales linearly with zoom
and the *content* fraction is invariant — so "0.37 on page 50" restores to the
same line on a phone at 2.2× and a laptop at 1.6×.

- **Capture (`PdfAdapter`/`CbzAdapter`):** attach a debounced (≈150 ms) `scroll`
  listener to `ctx.stage` (mirroring `ScrollTextAdapter.attachScroll`,
  `:1893`). On scroll, compute `frac = max>0 ? stage.scrollTop / max : 0` where
  `max = stage.scrollHeight - stage.clientHeight`, set `reader.pos.frac`, and call
  `persistPos()`. Also recompute `frac` on page turn (new page starts at
  `frac = 0`).
- **Restore:** in the adapter `render()`, after the canvas is painted, if
  `pos.frac` is set, `requestAnimationFrame(() => { const max =
  stage.scrollHeight - stage.clientHeight; stage.scrollTop = max > 0 ? pos.frac *
  max : 0; })`. Guard against `max <= 0` (page shorter than viewport → top).
- **Persist:** extend the paged branch of `persistPos()` to also set
  `reader.pos.frac` onto the book and include it in the wire payload. Keep
  `b.currentPage` exactly as today so every library view (`pct()`, continue card,
  list progress) is unchanged.

### 2. Per-book zoom — per device (localStorage)

- New LS key `folium.zoom` holding `{ [bookId]: number }`, **LRU-capped at 50
  entries** (drop oldest; mirrors the `folium.pdfLru` pattern) so it can't grow
  unbounded.
- New helpers `getBookZoom(id): number | null` and `setBookZoom(id, z)`.
- A `folium.lastZoom` scalar records the most recent zoom used.
- `openBook()`: replace `reader.zoom = 1` (`:2273`) with
  `reader.zoom = getBookZoom(id) ?? Number(localStorage.getItem(LS.lastZoom)) || 1`.
- Zoom button handler (`:2978`): after clamping, `setBookZoom(book.id, reader.zoom)`
  and `localStorage.setItem(LS.lastZoom, String(reader.zoom))`.
- Width toggle (`:2986`): **delete** the `reader.zoom = 1` line — switching
  comfort/full must keep the reader's magnification.

### 3. Zoom/width re-render preserves the spot

`renderAt(pos, keepScroll=true)` on zoom/width change currently keeps the *pixel*
`scrollTop`, which points at the wrong content after the page height changes.
Instead, capture `frac` immediately before re-render and restore from `frac` after
(same RAF restore as §1). Net effect: enlarging text keeps your line centered
instead of jumping.

### Data model + wire format

- Frontend `DocPos`: add `frac?: number`.
- Frontend `Book`: add `posFrac?: number` (mirrors `currentPage`; read in
  `openBook` to seed `pos.frac`).
- Wire `ProgressBody` paged variant: `{ currentPage: number; frac?: number;
  lastReadAt: number }` (`progressBodyFor`, `:721`). `enqueueProgress` last-write
  resolution by `lastReadAt` is unchanged.
- Backend `parseProgressBody`: on the `currentPage` branch, accept optional
  `frac` when it is a finite number; **clamp to [0,1]**; omit otherwise.
- Backend `updateProgress(id, currentPage, lastReadAt, frac)`: when `frac` is
  provided, `SET currentPage, lastReadAt, posFrac`; when absent, leave `posFrac`
  untouched (so a client that doesn't send it never clobbers a good value). Keep
  `ConditionExpression: attribute_exists(id)`.
- `getBook`/`listBooks`: pass `posFrac` through (no transform).

### Backward compatibility

- All new fields optional. Books with no `posFrac` restore to page-top (today's
  behavior). Old app builds ignore `posFrac` and send no `frac` — the server
  preserves any existing `posFrac` rather than wiping it (because absent `frac`
  is a no-op on that attribute).
- Zoom is local-only; nothing to migrate.

### Edge cases

- Page shorter than viewport (no scroll): `max <= 0` → `frac = 0`, restore to top.
- Rapid page-turns: `frac` resets to 0 on turn; the debounced scroll write coalesces.
- Reader close mid-page: `persistPos()` already fires on the last scroll; add an
  explicit final `persistPos()` on reader teardown to flush the latest `frac`.
- CBZ identical to PDF (shared paged model).
- DPR/zoom crispness is unchanged by this work (separate concern, noted for a
  later phase).

## Testing

- **Backend (`node:test`, `backend/test/`):** extend the progress tests —
  `parseProgressBody` accepts `{currentPage, frac:0.37}`, clamps `frac` outside
  [0,1], and omits non-numeric `frac`; `updateProgress` builds the right
  UpdateExpression with and without `frac`. Keep all 46 existing tests green.
- **Frontend gates:** `npx tsc --noEmit`, `node scripts/i18n-check.mjs`,
  `npm run build`.
- **Manual resume checklist (run via the `run` skill / Playwright):**
  1. Open a PDF, zoom to ~1.8×, scroll to mid-page, go back to library, reopen →
     same page, same spot, same zoom.
  2. Toggle comfort/full and change zoom → the line stays put; zoom persists.
  3. Open a *different* book then return → each book keeps its own zoom; a
     brand-new book opens at last-used zoom, not 1.0.
  4. Cross-device: set position on device A; load on device B (different zoom) →
     lands at the same relative spot at B's zoom.
  5. Offline: read offline, reconnect → `frac` replays via the progress queue.

## Out of scope (future phases, tracked)

Reading-comfort font/line controls (txt/md/epub), dark + sepia + high-contrast
themes, WCAG-sized controls, and server-side conflict detection / sync indicator.
