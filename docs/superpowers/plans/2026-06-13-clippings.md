# Implementation Plan: Clippings

Spec: `docs/superpowers/specs/2026-06-13-clippings-design.md`
Two PRs, region-first. Each ships green CI (tsc, i18n-check, build, backend tests)
and deploys via push to `main`.

## Shared data shapes

```ts
type Rect = { x: number; y: number; w: number; h: number };   // fractions 0..1
interface Clip {
  id: string; page: number; rects: Rect[]; color: string;
  text?: string; note?: string; createdAt: number;
}
```
DDB clip item: `{ pk:'lib', id:'<bookId>#hl#<clipId>', bookId, ...clip }`.
Colors: small palette keyed to the theme — brass `#dcb064` (default), leather
`#5e261d`, green `#3c5340`, classic `#e8c34a`.

## Phase 1 — Image clippings (region)  [branch: feat/clippings-region]

### Backend
1. `repo.mjs`
   - `listBooks()`: add `FilterExpression: 'NOT contains(id, :sep)'`,
     `:sep='#hl#'`.
   - `listClippings(bookId)`: Query `pk=:pk AND begins_with(id, :pfx)`,
     `:pfx='<bookId>#hl#'`; map items → `{ id: clipId, page, rects, color, text,
     note, createdAt }` (parse clipId after `#hl#`).
   - `putClipping(bookId, clip)`: Put `{ pk, id:'<bookId>#hl#'+clip.id, bookId,
     ...clip }`.
   - `deleteClipping(bookId, clipId)`: Delete Key `{ pk, id:'<bookId>#hl#'+clipId }`.
2. `handler.mjs`: replace the `/url|/progress` regex with one that also matches
   `/clips` and `/clips/<clipId>`; add GET/POST `/clips`, DELETE `/clips/{clipId}`.
   Validate body has `page` + non-empty `rects` on POST.
3. `backend/test/clips.test.mjs`: unit-test the id compose/parse helpers and the
   `#hl#` filter predicate (pure functions extracted into `repo.mjs` or a tiny
   `ids.mjs`). Keep auth tests green.

### Frontend
4. `app.ts` i18n: add `clip.*` keys (snapshot, captureHint, save, share, download,
   delete, saved, removed, color, sheetTitle, shareFailed, emptyRegion) to EN/PT/ES.
5. `app.ts` API + offline: `clipsAll/clipPut/clipDel`; `LS.clipQueue =
   'folium.clipQueue'`; `enqueueClip/flushClipQueue` (mirror progress queue);
   cache list in `folium-data` under `/data-store/clips/<id>`; call
   `flushClipQueue()` in `boot()` and the `online` listener.
6. `app.ts` reader state: `reader.clips`, `reader.capturing`, `reader.capRect`.
   Load clips in `openBook`. Clear in `closeReader`.
7. `app.ts` render overlay: in `renderPage`, after the canvas, append
   `.rclips` and draw boxes for `reader.clips` on the current page (rect × current
   page CSS size). Each box `data-clip=<id>`; click → `openClipSheet(clip)`.
8. `app.ts` snapshot mode: `#r-snap` button toggles `reader.capturing`; render a
   `.rcapture` overlay over the page; pointerdown/move/up draws `reader.capRect`;
   on up with area > threshold → `openClipSheet({adhoc region})`. Suppress wheel +
   click paging while capturing; Esc/back exits.
9. `app.ts` card composer `composeRegionCard(srcCanvas, rect, book)`: offscreen
   canvas (target ~1080 wide, 4:5), paper fill + texture, drawImage crop with
   border/shadow, book title (serif), leaf glyph + `folium.cafe`; `toBlob`.
10. `app.ts` share `shareCard(blob, book)`: `File` + `navigator.canShare` →
    `navigator.share`; else download. Swallow `AbortError`.
11. `app.ts` `openClipSheet(clip|adhoc)`: modal `#clip-sheet` with `<img>` preview,
    color swatches, Save / Share / Download / Delete / Close. Save → `clipPut` +
    push to `reader.clips` + re-render. Delete → `clipDel` + remove + re-render.
12. `index.html`: `#r-snap` button in the reader bar (before `#r-focus`);
    `#clip-sheet` modal markup before `#toast`.
13. `styles.css`: `.rclips`/`.rclip` boxes, `.rcapture` + `.capsel` selection rect,
    `#clip-sheet`/`.clip-card` modal + swatches, `#r-snap.active`.

### Verify
`npm run build` · `npx tsc --noEmit` · `node scripts/i18n-check.mjs` ·
`cd backend && npm test` · `terraform fmt -check`. PR → merge → watch Deploy →
curl `/api/books/.../clips` returns 401 unauthenticated. Manual phone QA per spec.

## Phase 2 — Text clippings  [branch: feat/clippings-text, after Phase 1 ships]

14. `renderPage`: after canvas, render a PDF.js text layer into an absolutely
    positioned `.textLayer` div sharing the page viewport
    (`page.getTextContent()` → `pdfjsLib.renderTextLayer({...})`).
15. `styles.css`: `.textLayer` rules (transparent glyphs, `user-select:text`,
    selection color).
16. `app.ts`: on `pointerup`/`selectionchange` inside `#r-col` with a non-empty
    selection, compute normalized rects from `getClientRects()` vs the canvas box,
    capture `selection.toString()`; show a floating `.sel-toolbar` (Highlight /
    Share). Highlight → save text clip (rects + text + color). Coexists with
    click-paging (already bails on active selection).
17. `app.ts` `composeTextCard(clip, book)`: typography card — wrap `clip.text` in
    the serif with quote ornaments, title + author, leaf; no pixel crop. Route
    text clips here, region clips to `composeRegionCard`.
18. Render text clips as translucent highlight fills (vs region boxes).
19. i18n: `clip.highlight`, `clip.selectHint`, text-card strings. Verify gates.
    PR → merge → deploy → manual QA (selection, highlight persistence, card,
    reflow at zoom/width).
