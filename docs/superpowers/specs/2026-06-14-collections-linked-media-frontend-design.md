# Collections + Linked Media — Frontend Design

Date: 2026-06-14
Status: Approved (brainstorming)
Backend: shipped in PR #11 (`feat: collections + linked external media (backend)`),
on `main` as of `ae882b7`. The endpoints are live but **dormant** — this is the
fast-follow that makes them user-visible.

## Purpose

Give the library two capabilities the backend already exposes:

1. **Collections** — user-defined groupings ("Sci-Fi", "Work", "Audiobooks") that
   filter the shelf and can be created, renamed, and deleted from the library
   itself. A book can belong to many collections.
2. **Linked external media** — add an audio/video item by **https URL** (no file
   upload), so streamed media lives in the library alongside uploaded books.

Single-user app, vanilla TS, no framework. Everything lands in `project/app.ts`
+ `project/index.html` + `project/styles.css`, fully localized (en / pt-BR / es).

## Backend contract (already shipped — frontend consumes as-is)

| Route | Purpose |
|---|---|
| `GET /api/books` | now returns `{ books, collections }`; each book carries `collections: string[]` (live-set self-healed server-side) |
| `POST /api/collections` `{ id, name }` | create (id is `coll`-prefixed; client generates) |
| `PATCH /api/collections/{id}` `{ name }` | rename |
| `DELETE /api/collections/{id}` | delete |
| `PUT /api/books/{id}/collections` `{ collections: string[] }` | set a book's membership |
| `POST /api/books` `{ url, provider, format, title, author }` | linked media: `format` ∈ {audio, video}, `url` https-only, **no presigned PUT returned** |
| `GET /api/books/{id}/url` | returns **400** for linked media (no presigned url) |

A collection id looks like `coll<random>`; the client mints it (mirrors how book
ids are minted today) and sends it on create.

## UX decisions (settled in brainstorming)

- **Surface:** a horizontal **filter-chip bar** between the masthead and the
  shelf — `( All ) ( Sci-Fi ) ( Work ) … ( + )`. Tapping a chip filters the
  current view (shelf/grid/list all honor it); `All` resets. The `+` chip creates
  a collection. Editing/deleting a collection happens from the active chip
  (long-press / a small inline control — see Components).
- **Assignment:** each book card gains a **`⋮` overflow menu** next to the
  existing trash (`.del`) button. `Collections…` opens a small **checklist** of
  all collections (multi-check), `Save` calls `PUT /api/books/{id}/collections`.
- **Linked media:** the add panel gains an **`Upload | Link` toggle**. `Link`
  mode reveals `URL` + `Title` + `Author` + an `audio | video` choice; submit
  calls `POST /api/books` with `{ url, provider, format }` and **no** file ingest.

## Data flow & state

- New module-level state (near the `// state` section, ~line 940):
  - `let collections: Collection[]` — mirror of the server list.
  - `let activeCollection: string | null` — current chip filter (persisted in
    `localStorage['folium.collection']`; cleared if the id no longer exists).
- `Book` interface (~line 130) gains: `collections?: string[]`, and for linked
  media `url?: string`, `provider?: string | null`. Add
  `type Collection = { id: string; name: string; createdAt: number }`.
- `dbAll()` / the boot fetch now reads `{ books, collections }` from
  `GET /api/books`; the `folium-data` offline snapshot stores both so the chip bar
  survives offline boot (today it caches only the books array — extend the shape,
  keep backward-compatible parse for an old cached array).
- `renderLibrary()` (~line 1341): after computing the newest-first `list`, apply
  `if (activeCollection) list = list.filter(b => (b.collections||[]).includes(activeCollection))`,
  then render the chip bar + the chosen view. Empty-collection state reuses the
  existing empty block with a collection-specific message.

## Components

1. **Chip bar** — `renderChips()` returns the chip row; wired through the existing
   delegated `wireLibrary()` click handler (chip click → set `activeCollection` →
   `renderLibrary()`; `+` → create flow; active chip's edit control → rename/delete).
   Create/rename use a prompt-style inline input; delete confirms (reuses the
   `window.confirm` pattern from `confirmDelete`). All three call the API then
   refresh local `collections` and re-render.
2. **Card overflow menu** — extend `coverMarkup()` / `renderList()` rows to add a
   `⋮` button (`data-menu="<id>"`) beside `.del`. Click opens a small popover with
   `Collections…`; that opens the checklist (a lightweight modal reusing existing
   modal/overlay styling). Save → `PUT …/collections` → update the in-memory book's
   `collections` → re-render (respects the active filter).
3. **Add panel Upload/Link toggle** — in `index.html` near `#btn-upload` /
   `#dropdown` (line ~58–63) add the toggle + the link form fields (hidden by
   default). A `submitLinkedMedia()` validates a non-empty https URL client-side
   (mirror of backend `isHttpsUrl`) before POST; on success, push the returned
   book into `books` and `renderLibrary()`. Reuse `toast()` for feedback/errors.

## i18n

New `coll.*` and `media.link.*` keys added to **all three** dicts (en is the typed
source; pt-BR + es follow). Keys are values-only (no markup) so
`node scripts/i18n-check.mjs` and `npx tsc --noEmit` stay green. Indicative set:
`coll.all`, `coll.new`, `coll.namePrompt`, `coll.rename`, `coll.delete`,
`coll.confirmDelete`, `coll.assign`, `coll.save`, `coll.empty`,
`media.link.tabUpload`, `media.link.tabLink`, `media.link.url`,
`media.link.kindAudio`, `media.link.kindVideo`, `media.link.badUrl`,
`media.link.add`.

## Error handling

- All new API calls go through the existing `api()` client: `ApiAuthError` →
  login screen (unchanged), `ApiNetworkError` → `toast(t('toast.offlineRetry'))`
  and no local mutation (same pattern as `confirmDelete`).
- Linked-media URL validated client-side (https, parseable) before POST; server
  re-validates. Bad URL → inline `media.link.badUrl` toast, no request.
- Collection delete is server-authoritative for membership cleanup (books
  self-heal on next `GET /api/books`); client also strips the id from any
  in-memory `book.collections` and clears `activeCollection` if it was active, so
  the UI is correct without a reload.

## Testing

- Backend already covered (PR #11). Frontend is vanilla TS with no test harness;
  guards are `npx tsc --noEmit` (dict parity, typed off EN) and
  `node scripts/i18n-check.mjs` (every `t()`/`data-i18n*` key exists, no markup).
  Both MUST pass. Manual verification: create/rename/delete a collection, filter
  by chip across all three views, assign a book to multiple collections via the
  `⋮` menu, add an https audio link and confirm it streams (online-only), and an
  offline boot that still shows the chip bar from the cached snapshot.

## Scope / YAGNI

- One PR. No drag-to-reorder collections, no nested collections, no bulk
  multi-select mode (rejected in brainstorming in favor of the per-card menu), no
  collection covers/colors. Linked-media provider is a free passthrough string,
  not a curated provider list.

## Out of scope (deferred)

- **Cognito #6 rework.** This frontend targets the current single-user repo. When
  multi-user lands, the collections backend is replayed onto per-user scoping
  (tracked separately); this UI should need only the auth/session changes already
  implied by #6, not collection-logic changes.
