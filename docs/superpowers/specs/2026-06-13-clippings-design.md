# Design: Clippings — highlight, snapshot, and share passages from Folium Café

**Date:** 2026-06-13
**Status:** Approved (design)
**Repo:** `kayaman/folium-cafe` · **Domain:** `folium.cafe`

## Goal

Let the reader capture a piece of a book — a **text passage** or an **image
region** — save it as a persistent **clipping**, and share it to social media as
a branded quote card. Works inside the existing canvas-based PDF reader, stays
offline-capable, and adds no new AWS infrastructure.

## Core concept: a "clipping"

A clipping is a saved selection from one page of one book. Two kinds, one stored
shape:

| Kind | How it's made | Card style |
|---|---|---|
| **Region** | Drag a rectangle over the page (works on any PDF, incl. scanned) | Pixel crop of the page, framed on paper |
| **Text** | Select words via a text layer (text PDFs only) | The quote re-typeset in the book's serif on paper |

Both reduce to: **`{ id, page, rects[], color, text?, note?, createdAt }`** where
`rects` are normalized page coordinates (fractions 0–1 of the unscaled page).
A region clipping has one rect; a text clipping has one rect per selected line
plus the captured `text` string. Normalized coordinates make clippings reflow
correctly across zoom, width mode, and window resize — PDFs are fixed-layout, so
the fractions never go stale.

## Delivery — two vertical slices (each its own PR)

Sliced by capability so each phase is a complete, persistent, shareable feature.

### Phase 1 — Image clippings (region). No text layer.

A **Snapshot** button in the reader bar enters capture mode → drag a rectangle →
a share sheet previews the branded card → **Web Share / download**. The region is
**persisted** as a clipping (full backend + offline queue + re-render on reopen +
tap-to-reshare/delete). Proves the entire vertical stack on the simplest geometry
and ships the headline "post to social media" goal end-to-end.

### Phase 2 — Text clippings (passage). Adds the text layer.

A PDF.js **text layer** over the canvas makes text selectable → select a passage →
the same share sheet → save/share. Reuses all of Phase 1's storage, render, card,
share, and offline machinery; adds only the text layer and selection→rects logic.
Because the actual selected text is captured, the card is set as crisp
**typography** (the book's serif on paper) rather than a screenshot of the page.

## Architecture

### Storage (backend) — no infra change

Same `folium-cafe-books` DynamoDB table (`pk='lib'` hash, `id` range). Clippings
are sibling items under a composite range key:

- Book item: `id = <bookId>`
- Clip item: `id = <bookId>#hl#<clipId>`, plus attributes `bookId`, and the clip
  fields.

`repo.mjs`:
- `listBooks()` — gains `FilterExpression: 'NOT contains(id, :sep)'` (`:sep='#hl#'`)
  so the existing all-of-partition query no longer returns clip items. Book ids
  are `b<base36>` and never contain `#`, so the filter is exact.
- `listClippings(bookId)` — Query `pk=:pk AND begins_with(id, '<bookId>#hl#')`,
  returns clip fields with `id` set back to the bare `clipId`.
- `putClipping(bookId, clip)` / `deleteClipping(bookId, clipId)`.

`handler.mjs` routes (all session-gated, JSON):
- `GET    /api/books/{id}/clips`
- `POST   /api/books/{id}/clips`          body = clip
- `DELETE /api/books/{id}/clips/{clipId}`

### Frontend (`project/app.ts`)

- `Clip` / `Rect` types; `clipsAll`/`clipPut`/`clipDel` over the existing `api()`.
- Reader state gains `clips: Clip[]`, loaded in `openBook` (cache fallback offline).
- `renderPage` appends a `.rclips` overlay positioned over the canvas; draws each
  current-page clip's rects scaled by the live `targetCSS`. Region clips render as
  bordered boxes; text clips (Phase 2) as translucent highlight fills. Tapping a
  clip opens the share sheet for it.
- **Snapshot mode** (Phase 1): the `#r-snap` reader-bar button toggles
  `reader.capturing`; a `.rcapture` overlay intercepts pointer events to draw a
  selection rectangle; wheel/click paging is suppressed while active; Esc exits.
- **Text selection** (Phase 2): always available once the text layer exists; a
  `selectionchange`/`pointerup` listener inside `#r-col` reads
  `getClientRects()` + `selection.toString()`, normalizes, and shows a floating
  toolbar (Highlight / Share).
- **Card composer** — offscreen canvas. Region: `drawImage` the page-canvas
  sub-rect onto a paper-framed card with the book title + Folium leaf mark +
  `folium.cafe`. Text (Phase 2): wrap the quote in the serif with quotation
  ornaments, title/author, leaf. `toBlob('image/png')`.
- **Share** — `const file = new File([blob], name, {type:'image/png'})`; if
  `navigator.canShare?.({files:[file]})` then `navigator.share({files:[file],
  title, text})`, else object-URL download fallback.

### Offline

Mirrors the existing progress-queue pattern exactly:
- `localStorage['folium.clipQueue']` holds `{op:'put'|'del', bookId, clip|clipId}`
  ops, applied optimistically and replayed by `flushClipQueue()` on the `online`
  event and at boot (next to `flushProgressQueue`).
- Per-book clip lists cached in the `folium-data` Cache under
  `/data-store/clips/<bookId>`; served when the network read fails.
- Card generation and Web Share are fully client-side and work offline.

### Cross-cutting

- **i18n** — every new UI string gets EN/pt-BR/es keys; the `i18n-check` CI guard
  and `tsc --noEmit` parity check enforce coverage.
- **No new deployed artifacts** → `deploy.yml`, `sw.ts` SHELL, and `manifest`
  are untouched. No Terraform change.

## Error handling

- API failures: network errors queue offline (create/delete); a 404 on delete is
  treated as already-gone. Toasts surface failures via the existing `toast()`.
- `navigator.share` rejection with `AbortError` (user cancelled) is swallowed;
  other failures fall back to download.
- Capture of an empty/zero-area rectangle is ignored.
- Clip rects clamp to [0,1]; out-of-range clips are skipped on render.

## Testing

- **Backend** — `repo.mjs` clip id composition/parsing is pure string logic; add a
  small `node:test` unit for the id round-trip and the `listBooks` filter
  predicate. Existing auth tests stay green.
- **Build gates** — `tsc --noEmit`, `i18n-check`, `npm run build`, backend tests
  in CI.
- **Manual (browser/phone)** — drag a region → card preview → Android share sheet;
  reopen book → saved clip re-renders → tap → reshare/delete; offline create →
  reconnect → syncs. Phase 2 adds: select text → highlight/share, text card
  typography, selection reflow at different zoom/width.

## Out of scope (YAGNI)

- Server-side storage of generated cards (cards are ephemeral, shared directly).
- Direct platform API posting / OAuth (Web Share API covers it).
- A global cross-book clippings gallery (per-book only for now).
- Notes/tags on clippings beyond an optional `note` field (UI deferred).
- Editing a clip's geometry after creation (delete + recreate).
