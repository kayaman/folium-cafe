# Collections + Linked Media — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Canonical copy:** on execution, copy this plan to `docs/superpowers/plans/2026-06-14-collections-linked-media-frontend.md` (plan mode currently restricts edits to this scratch file).
> **⚠️ Serialization:** nearly every task edits the single file `project/app.ts`. Do **not** run two app.ts-writing tasks in parallel (per project convention — never two writers on app.ts). Execute app.ts tasks sequentially. The CSS task (8) and index.html part of task 7 can overlap with app.ts work safely.

**Goal:** Make the already-shipped (dormant) collections + linked-media backend user-visible: a filter-chip bar, per-card collection assignment, and an "Upload | Link" add path — all localized.

**Architecture:** All work lands in `project/app.ts` (logic + render), `project/index.html` (add-panel toggle + link form markup), `project/styles.css` (chip bar, ⋮ menu, checklist modal, link form). No new build deps. The backend contract is fixed (PR #11). Reuse existing seams: `api()`, `dbPut()`, `ingest()`/`ingestMedia()`, `renderLibrary()`/`coverMarkup()`/`wireLibrary()`, `applyI18n()`/`t()`/`tn()`, `toast()`, `el()`.

**Tech Stack:** Vanilla TypeScript (esbuild), no framework. Verification gates (no unit-test harness for frontend): `npx tsc --noEmit` (EN/PT/ES dict parity), `node scripts/i18n-check.mjs` (key existence + no markup), `npm run build`, plus manual checks.

**Spec:** `docs/superpowers/specs/2026-06-14-collections-linked-media-frontend-design.md`
**Branch:** `feat/collections-linked-media-ui` (already created; holds the spec commit `d6a9d26`).

---

## Context

PR #11 shipped the collections + linked-media **backend** to production, but no UI calls it — the endpoints are dormant. This plan is the fast-follow that exposes them. Decisions settled in brainstorming: filter-chip bar above the shelf, per-card `⋮` overflow menu → collections checklist, `Upload | Link` toggle in the add panel. One PR, fully localized (en/pt-BR/es). It targets the current single-user repo; the Cognito #6 rework will later replay the backend onto per-user scoping (out of scope here).

## Backend contract (fixed — frontend consumes as-is)

| Route | Body | Response |
|---|---|---|
| `GET /api/books` | — | `{ books, collections }`; each book has `collections: string[]` |
| `POST /api/collections` | `{ id, name }` | `{ ok, collection }` |
| `PATCH /api/collections/{id}` | `{ name }` | `{ ok }` (404 if missing) |
| `DELETE /api/collections/{id}` | — | `{ ok }` |
| `PUT /api/books/{id}/collections` | `{ collections: string[] }` | `{ ok }` (404 if book missing) |
| `POST /api/books` (linked) | `{ id, title, author, fileName, format:'audio'\|'video', url(https), provider? }` | `{ ok:true }` (no uploadUrl) |

## Key existing anchors (verified by exploration)

- `Book` interface — `project/app.ts:122-138`
- i18n: `EN` (`:171` `as const`), `MsgKey = keyof typeof EN` (`:279`), `PT` (`:281`), `ES` (`:390`), `DICTS` (`:499`), `t()` (`:504`), `tn()` (`:512`), `applyI18n()` (`:530`)
- `api()` (`:563`), `ApiAuthError`/`ApiNetworkError` (`:560-561`), `toast()` (`:546`), `el()` (`:160`)
- `dbAll()` (`:689` — already returns `body.books`), boot load `books = (await dbAll())` (`:3129`)
- `LS` keys object (`:941`), `let books` (`:952`), `let viewMode` (`:953`), `uid()` (`:956`)
- `dbPut()` (`:706`), `dbDel()` (`:756`), `ingest()` (`:1179`), `ingestMedia()` (`:1165`), `addFiles()` (`:1216`), `detectFormat()` (`:967`), `mimeFor()` (`:992`)
- `coverMarkup()` (`:1249`), `bookCard()` (`:1277`), `renderShelf/Grid/List` (`:1284-1323`), `renderLibrary()` (`:1341`), `wireLibrary()` (`:1375`), `confirmDelete()` (uses `window.confirm`)
- index.html: `#btn-upload` (`:58`), `#file-input` (`:60`), `#drop` (`:156`); `wireUpload()` (`app.ts:3094`)
- CSS reuse: `.mast-btn`/`.brass`, `.dropdown` (popover), `.settings-card`/`.clip-card` (modal overlay pattern), `.field`, `.btn-primary`, `.smallcaps`, `.seg button.active`

---

## Task 1: Types + state scaffolding

**Files:** Modify `project/app.ts` (`:122-138`, `:941-953`, near `:956`)

- [ ] **Step 1: Extend the `Book` interface** — after the `progress?` line (`:138`):
```typescript
  collections?: string[];     // collection ids this book belongs to
  url?: string;               // linked external media: https stream URL (no stored bytes)
  provider?: string | null;   // linked media: free-text provider passthrough
```

- [ ] **Step 2: Add the `Collection` type** — right after the `Book` interface block:
```typescript
type Collection = { id: string; name: string; createdAt: number };
```

- [ ] **Step 3: Add the LS key** — inside the `LS` object (`:941`), add a line:
```typescript
  activeCollection: 'folium.activeCollection',
```

- [ ] **Step 4: Add module-level state** — after `let viewMode...` (`:953`):
```typescript
let collections: Collection[] = [];
let activeCollection: string | null = localStorage.getItem(LS.activeCollection) || null;
```

- [ ] **Step 5: Add `collId()`** — next to `uid()` (`:956`):
```typescript
function collId(): string { return 'coll' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
```

- [ ] **Step 6: Verify + commit**
```bash
cd /home/kayaman/Projects/folium-cafe && npx tsc --noEmit
git add project/app.ts && git commit -S -m "feat(collections): types + state scaffolding"
```
Expected: tsc passes (no key changes yet, so i18n-check unaffected).

---

## Task 2: Capture collections from GET /api/books (data layer)

**Files:** Modify `project/app.ts` — `dbAll()` (`:689-703`) and boot (`:3129`)

Rationale: `dbAll()` already extracts `body.books`. We must also surface `collections`, keep the offline cache working, and stay backward-compatible with an old cached bare-array snapshot.

- [ ] **Step 1: Replace `dbAll()` body** so it captures collections into the module global and tolerates the legacy shape:
```typescript
async function dbAll(): Promise<BookMeta[]> {
  const cache = await caches.open(DATA_CACHE);
  const take = (body: any): BookMeta[] => {
    if (Array.isArray(body)) { collections = []; return body as BookMeta[]; } // legacy cached shape
    collections = Array.isArray(body.collections) ? body.collections : [];
    return (body.books ?? []) as BookMeta[];
  };
  try {
    const res = await api('/books');
    if (!res.ok) throw new ApiNetworkError('list ' + res.status);
    const body = await res.json();
    await cache.put('/data-store/books', new Response(JSON.stringify(body))).catch(() => {});
    return take(body);
  } catch (e) {
    if (e instanceof ApiAuthError) throw e;
    const hit = await cache.match('/data-store/books');
    if (hit) { setOffline(true); return take(await hit.json()); }
    throw e;
  }
}
```

- [ ] **Step 2: Self-heal `activeCollection` at boot** — immediately after `books = (await dbAll()) ...` (`:3129`):
```typescript
  if (activeCollection && !collections.some(c => c.id === activeCollection)) {
    activeCollection = null; localStorage.removeItem(LS.activeCollection);
  }
```

- [ ] **Step 3: Verify + commit**
```bash
npx tsc --noEmit
git add project/app.ts && git commit -S -m "feat(collections): parse {books,collections} with legacy-cache fallback"
```

---

## Task 3: Collection CRUD + membership API helpers

**Files:** Modify `project/app.ts` — add a `// ---------- collections (data) ----------` section near the other data helpers (after `dbDel`, ~`:760`)

- [ ] **Step 1: Add the four API helpers** (mirror `dbDel()` error semantics — let `ApiNetworkError` propagate to callers that toast):
```typescript
// ---------- collections (data) ----------
async function apiCreateCollection(name: string): Promise<Collection> {
  const c: Collection = { id: collId(), name, createdAt: Date.now() };
  const res = await api('/collections', { method: 'POST', body: JSON.stringify(c) });
  if (!res.ok) throw new Error('create failed');
  return c;
}
async function apiRenameCollection(id: string, name: string): Promise<void> {
  const res = await api('/collections/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error('rename failed');
}
async function apiDeleteCollection(id: string): Promise<void> {
  const res = await api('/collections/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!res.ok) throw new Error('delete failed');
}
async function apiSetBookCollections(bookId: string, ids: string[]): Promise<void> {
  const res = await api('/books/' + encodeURIComponent(bookId) + '/collections', { method: 'PUT', body: JSON.stringify({ collections: ids }) });
  if (!res.ok) throw new Error('set failed');
}
```

- [ ] **Step 2: Verify + commit**
```bash
npx tsc --noEmit
git add project/app.ts && git commit -S -m "feat(collections): CRUD + membership API helpers"
```

---

## Task 4: i18n keys (coll.* + media.link.*) in all three dicts

**Files:** Modify `project/app.ts` — `EN` (`:171`), `PT` (`:281`), `ES` (`:390`)

Add the SAME keys to all three dicts (tsc enforces parity). Values only, no markup chars `<>&"`.

- [ ] **Step 1: Append to `EN`** (before its closing `} as const`):
```typescript
  'coll.all': 'All',
  'coll.new': 'New collection',
  'coll.namePrompt': 'Name this collection',
  'coll.renamePrompt': 'Rename collection',
  'coll.rename': 'Rename',
  'coll.delete': 'Delete',
  'coll.confirmDelete': 'Delete the collection “{name}”? Your books stay; only the grouping is removed.',
  'coll.assign': 'Collections…',
  'coll.assignTitle': 'Add to collections',
  'coll.save': 'Save',
  'coll.none': 'No collections yet — create one to group your books.',
  'coll.empty': 'Nothing in this collection yet.',
  'menu.open': 'Open',
  'card.menu': 'More actions',
  'media.link.tabUpload': 'Upload',
  'media.link.tabLink': 'Link',
  'media.link.url': 'Media URL',
  'media.link.urlPh': 'https://example.com/audio.mp3',
  'media.link.titleField': 'Title',
  'media.link.authorField': 'Author',
  'media.link.kindAudio': 'Audio',
  'media.link.kindVideo': 'Video',
  'media.link.add': 'Add link',
  'media.link.badUrl': 'Enter a valid https URL',
  'media.link.added': 'Linked media added',
```

- [ ] **Step 2: Append the same keys to `PT`** with pt-BR values:
```typescript
  'coll.all': 'Todas',
  'coll.new': 'Nova coleção',
  'coll.namePrompt': 'Nomeie esta coleção',
  'coll.renamePrompt': 'Renomear coleção',
  'coll.rename': 'Renomear',
  'coll.delete': 'Excluir',
  'coll.confirmDelete': 'Excluir a coleção “{name}”? Seus livros permanecem; só o agrupamento é removido.',
  'coll.assign': 'Coleções…',
  'coll.assignTitle': 'Adicionar às coleções',
  'coll.save': 'Salvar',
  'coll.none': 'Nenhuma coleção ainda — crie uma para agrupar seus livros.',
  'coll.empty': 'Nada nesta coleção ainda.',
  'menu.open': 'Abrir',
  'card.menu': 'Mais ações',
  'media.link.tabUpload': 'Enviar',
  'media.link.tabLink': 'Link',
  'media.link.url': 'URL da mídia',
  'media.link.urlPh': 'https://exemplo.com/audio.mp3',
  'media.link.titleField': 'Título',
  'media.link.authorField': 'Autor',
  'media.link.kindAudio': 'Áudio',
  'media.link.kindVideo': 'Vídeo',
  'media.link.add': 'Adicionar link',
  'media.link.badUrl': 'Insira uma URL https válida',
  'media.link.added': 'Mídia vinculada adicionada',
```

- [ ] **Step 3: Append the same keys to `ES`** with es values:
```typescript
  'coll.all': 'Todas',
  'coll.new': 'Nueva colección',
  'coll.namePrompt': 'Nombra esta colección',
  'coll.renamePrompt': 'Renombrar colección',
  'coll.rename': 'Renombrar',
  'coll.delete': 'Eliminar',
  'coll.confirmDelete': '¿Eliminar la colección “{name}”? Tus libros permanecen; solo se quita la agrupación.',
  'coll.assign': 'Colecciones…',
  'coll.assignTitle': 'Añadir a colecciones',
  'coll.save': 'Guardar',
  'coll.none': 'Aún no hay colecciones — crea una para agrupar tus libros.',
  'coll.empty': 'Nada en esta colección todavía.',
  'menu.open': 'Abrir',
  'card.menu': 'Más acciones',
  'media.link.tabUpload': 'Subir',
  'media.link.tabLink': 'Enlace',
  'media.link.url': 'URL del medio',
  'media.link.urlPh': 'https://ejemplo.com/audio.mp3',
  'media.link.titleField': 'Título',
  'media.link.authorField': 'Autor',
  'media.link.kindAudio': 'Audio',
  'media.link.kindVideo': 'Vídeo',
  'media.link.add': 'Añadir enlace',
  'media.link.badUrl': 'Introduce una URL https válida',
  'media.link.added': 'Medio enlazado añadido',
```

- [ ] **Step 4: Verify + commit** (note `’`/`…`/`“”` are fine — i18n-check only forbids `<>&"`):
```bash
npx tsc --noEmit && node scripts/i18n-check.mjs
git add project/app.ts && git commit -S -m "feat(i18n): coll.* + media.link.* keys (en/pt-BR/es)"
```
Expected: tsc passes (parity), i18n-check OK with new keys reported as *unused* (until later tasks reference them) — unused is a warning, not a failure.

---

## Task 5: Chip bar render + filter + chip interactions

**Files:** Modify `project/app.ts` — `renderLibrary()` (`:1341`), `wireLibrary()` (`:1375`); add `renderChips()` and chip handlers

- [ ] **Step 1: Add `renderChips()`** above `renderLibrary()`:
```typescript
function renderChips(): string {
  const chip = (id: string | null, label: string, extra = '') =>
    `<button class="chip${activeCollection === id ? ' active' : ''}" data-chip="${id ?? ''}">${escapeHtml(label)}${extra}</button>`;
  const editTools = activeCollection
    ? `<button class="chip-edit" data-chip-rename="${activeCollection}" title="${t('coll.rename')}">${ICON.pencil}</button>` +
      `<button class="chip-edit" data-chip-del="${activeCollection}" title="${t('coll.delete')}">${ICON.trash}</button>`
    : '';
  return `<div class="chipbar">` +
    chip(null, t('coll.all')) +
    collections.map(c => chip(c.id, c.name || t('coll.new'))).join('') +
    `<button class="chip chip-add" data-chip-new title="${t('coll.new')}">+</button>` +
    editTools +
    `</div>`;
}
```
Note: if `ICON.pencil` does not exist, reuse an existing icon (e.g. `ICON.note`) — grep `const ICON` to confirm available glyphs and substitute; do not invent a missing identifier.

- [ ] **Step 2: Inject chips + filter in `renderLibrary()`** — replace the tail (from `const list = books.slice()...` to the view switch) with:
```typescript
  let list = books.slice().sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt));
  if (activeCollection) list = list.filter(b => (b.collections || []).includes(activeCollection!));
  const chips = collections.length || true ? renderChips() : '';
  let view: string;
  if (!list.length && activeCollection) view = `<div class="empty"><p>${t('coll.empty')}</p></div>`;
  else if (viewMode === 'shelf') view = renderShelf(list);
  else if (viewMode === 'grid') view = renderGrid(list);
  else view = renderList(list);
  body.innerHTML = chips + view;
```
(Keep the existing `if (!books.length) { ...empty... return; }` block above unchanged — the no-books-at-all empty state still wins.)

- [ ] **Step 3: Add chip delegation in `wireLibrary()`** — inside the `el('library').addEventListener('click', ...)` handler, before the `data-del` check, add:
```typescript
    const chipNew = (t as HTMLElement).closest('[data-chip-new]');
    if (chipNew) { e.preventDefault(); createCollectionFlow(); return; }
    const chipRen = (t as HTMLElement).closest('[data-chip-rename]') as HTMLElement | null;
    if (chipRen) { e.preventDefault(); renameCollectionFlow(chipRen.dataset.chipRename!); return; }
    const chipDel = (t as HTMLElement).closest('[data-chip-del]') as HTMLElement | null;
    if (chipDel) { e.preventDefault(); deleteCollectionFlow(chipDel.dataset.chipDel!); return; }
    const chipBtn = (t as HTMLElement).closest('[data-chip]') as HTMLElement | null;
    if (chipBtn) {
      e.preventDefault();
      activeCollection = chipBtn.dataset.chip || null;
      if (activeCollection) localStorage.setItem(LS.activeCollection, activeCollection);
      else localStorage.removeItem(LS.activeCollection);
      renderLibrary();
      return;
    }
```
(The inner variable is named `t` in the existing handler — it shadows the i18n `t()`. Use `(t as HTMLElement)` for DOM as the existing code does, and call collection flows that internally use the module-scope `t()` — those flow functions are defined at module scope so they see the real `t()`.)

- [ ] **Step 4: Add the three flow functions** (use `window.prompt`/`window.confirm`, matching `confirmDelete`'s style; toast on offline):
```typescript
async function createCollectionFlow(): Promise<void> {
  const name = (window.prompt(t('coll.namePrompt')) || '').trim();
  if (!name) return;
  try { const c = await apiCreateCollection(name); collections.push(c); activeCollection = c.id; localStorage.setItem(LS.activeCollection, c.id); renderLibrary(); }
  catch (e) { if (e instanceof ApiNetworkError) toast(t('toast.offlineRetry')); else throw e; }
}
async function renameCollectionFlow(id: string): Promise<void> {
  const cur = collections.find(c => c.id === id); if (!cur) return;
  const name = (window.prompt(t('coll.renamePrompt'), cur.name) || '').trim();
  if (!name || name === cur.name) return;
  try { await apiRenameCollection(id, name); cur.name = name; renderLibrary(); }
  catch (e) { if (e instanceof ApiNetworkError) toast(t('toast.offlineRetry')); else throw e; }
}
async function deleteCollectionFlow(id: string): Promise<void> {
  const cur = collections.find(c => c.id === id); if (!cur) return;
  if (!window.confirm(t('coll.confirmDelete', { name: cur.name }))) return;
  try { await apiDeleteCollection(id); } catch (e) { if (e instanceof ApiNetworkError) { toast(t('toast.offlineRetry')); return; } throw e; }
  collections = collections.filter(c => c.id !== id);
  for (const b of books) if (b.collections) b.collections = b.collections.filter(x => x !== id);
  if (activeCollection === id) { activeCollection = null; localStorage.removeItem(LS.activeCollection); }
  renderLibrary();
}
```

- [ ] **Step 5: Verify + commit**
```bash
npx tsc --noEmit && node scripts/i18n-check.mjs && npm run build
git add project/app.ts && git commit -S -m "feat(collections): chip bar filter + create/rename/delete"
```

---

## Task 6: Per-card ⋮ menu + collections checklist modal

**Files:** Modify `project/app.ts` — `coverMarkup()` (`:1249`), `renderList()` rows (`:1297`), `wireLibrary()`; add `showBookMenu()` + `openCollectionPicker()`. Add a hidden modal container to `project/index.html`.

- [ ] **Step 1: Add the ⋮ button to cards.** In each `return` of `coverMarkup()` (cover, generated-cover, note branches) and in the `renderList()` row markup, add a menu button next to the existing `.del` button:
```typescript
`<button class="cardmenu" data-menu="${b.id}" title="${t('card.menu')}">${ICON.dots ?? '⋮'}</button>`
```
Grep `const ICON` first; if no dots glyph exists, use the literal `⋮` as shown.

- [ ] **Step 2: Add a reusable picker modal to `index.html`** near the other modals (after `#clip-sheet` / `#settings`):
```html
<div id="coll-picker" class="modal-overlay hidden">
  <div class="settings-card">
    <div class="smallcaps" data-i18n="coll.assignTitle">Add to collections</div>
    <div id="coll-picker-list"></div>
    <div class="coll-picker-actions">
      <button class="mast-btn" id="coll-picker-cancel" data-i18n="clip.close">Close</button>
      <button class="mast-btn brass" id="coll-picker-save" data-i18n="coll.save">Save</button>
    </div>
  </div>
</div>
```
(`clip.close` already exists in the dicts; reuse it for Cancel.)

- [ ] **Step 3: Add menu delegation in `wireLibrary()`** before the `data-del` check:
```typescript
    const menu = (t as HTMLElement).closest('[data-menu]') as HTMLElement | null;
    if (menu) { e.preventDefault(); e.stopPropagation(); openCollectionPicker(menu.dataset.menu!); return; }
```
(For YAGNI, the ⋮ opens the collection picker directly — a single action. No intermediate popover needed since "Collections…" is the only item.)

- [ ] **Step 4: Add `openCollectionPicker()`** at module scope:
```typescript
let pickerBookId: string | null = null;
function openCollectionPicker(bookId: string): void {
  const b = books.find(x => x.id === bookId); if (!b) return;
  pickerBookId = bookId;
  const cur = new Set(b.collections || []);
  const listEl = el('coll-picker-list');
  listEl.innerHTML = collections.length
    ? collections.map(c => `<label class="coll-check"><input type="checkbox" value="${c.id}" ${cur.has(c.id) ? 'checked' : ''}> ${escapeHtml(c.name || t('coll.new'))}</label>`).join('')
    : `<p class="coll-none">${t('coll.none')}</p>`;
  el('coll-picker').classList.remove('hidden');
}
async function saveCollectionPicker(): Promise<void> {
  if (!pickerBookId) return;
  const ids = Array.from(el('coll-picker-list').querySelectorAll('input:checked')).map(i => (i as HTMLInputElement).value);
  try { await apiSetBookCollections(pickerBookId, ids); }
  catch (e) { if (e instanceof ApiNetworkError) { toast(t('toast.offlineRetry')); return; } throw e; }
  const b = books.find(x => x.id === pickerBookId); if (b) b.collections = ids;
  el('coll-picker').classList.add('hidden'); pickerBookId = null;
  renderLibrary();
}
```

- [ ] **Step 5: Wire the picker buttons** — in the init/wire section alongside `wireLibrary()` / `wireUpload()`:
```typescript
  el('coll-picker-save').addEventListener('click', saveCollectionPicker);
  el('coll-picker-cancel').addEventListener('click', () => { el('coll-picker').classList.add('hidden'); pickerBookId = null; });
  el('coll-picker').addEventListener('click', (e) => { if (e.target === el('coll-picker')) { el('coll-picker').classList.add('hidden'); pickerBookId = null; } });
```

- [ ] **Step 6: Verify + commit**
```bash
npx tsc --noEmit && node scripts/i18n-check.mjs && npm run build
git add project/app.ts project/index.html && git commit -S -m "feat(collections): per-card menu + checklist picker"
```

---

## Task 7: Linked external media — Upload | Link add path

**Files:** Modify `project/index.html` (add panel near `:58-60`), `project/app.ts` — add `ingestLinkedMedia()`, `submitLinkedMedia()`, and the toggle wiring; extend `dbPut()` to pass `url`/`provider`.

- [ ] **Step 1: Add the Link form + toggle to `index.html`.** Add a hidden panel (a small modal reusing `.settings-card`) opened by a new mode, plus an entry. Minimal approach — add a second masthead button `#btn-link` next to `#btn-upload`:
```html
<button class="mast-btn" id="btn-link" title="Add a media link" data-i18n-title="media.link.tabLink"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg><span data-i18n="media.link.tabLink">Link</span></button>
```
and the modal (after the add controls):
```html
<div id="link-sheet" class="modal-overlay hidden">
  <div class="settings-card">
    <div class="smallcaps" data-i18n="media.link.tabLink">Link</div>
    <div class="field"><label data-i18n="media.link.url">Media URL</label><input id="link-url" type="url" data-i18n-placeholder="media.link.urlPh" placeholder="https://…"></div>
    <div class="field"><label data-i18n="media.link.titleField">Title</label><input id="link-title" type="text"></div>
    <div class="field"><label data-i18n="media.link.authorField">Author</label><input id="link-author" type="text"></div>
    <div class="seg" id="link-kind"><button data-kind="audio" class="active" data-i18n="media.link.kindAudio">Audio</button><button data-kind="video" data-i18n="media.link.kindVideo">Video</button></div>
    <div class="link-actions">
      <button class="mast-btn" id="link-cancel" data-i18n="clip.close">Close</button>
      <button class="mast-btn brass" id="link-add" data-i18n="media.link.add">Add link</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add `ingestLinkedMedia()`** in app.ts (mirror `ingestMedia()` `:1165`, but carries `url`/`provider`, never caches bytes):
```typescript
function ingestLinkedMedia(url: string, title: string, author: string, format: 'audio' | 'video'): Book {
  let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
  return {
    id: uid(), title: title.trim() || host || t('lib.unknown'), author: author.trim(),
    fileName: url, data: new ArrayBuffer(0), numPages: 1, currentPage: 1, cover: null,
    addedAt: Date.now(), lastReadAt: 0, format, url, provider: host || null,
  };
}
```

- [ ] **Step 3: Ensure `dbPut()` forwards `url`/`provider`.** `stripData()` produces `BookMeta`; confirm `url`/`provider` survive (they're plain fields on `Book`). If `stripData`/`BookMeta` is a typed pick that drops them, add `url` and `provider` to `BookMeta`. The backend branches on `body.url`, so when `url` is present `dbPut`'s response has no `uploadUrl` and the existing `if (b.data && uploadUrl)` guard already skips the S3 PUT — no other change needed.

- [ ] **Step 4: Add `submitLinkedMedia()` + toggle wiring**:
```typescript
let linkKind: 'audio' | 'video' = 'audio';
async function submitLinkedMedia(): Promise<void> {
  const url = (el<HTMLInputElement>('link-url').value || '').trim();
  let ok = false; try { ok = new URL(url).protocol === 'https:'; } catch {}
  if (!ok) { toast(t('media.link.badUrl')); return; }
  const b = ingestLinkedMedia(url, el<HTMLInputElement>('link-title').value, el<HTMLInputElement>('link-author').value, linkKind);
  try { await dbPut(b); }
  catch (e) { if (e instanceof ApiNetworkError) { toast(t('toast.offlineAdd')); return; } toast(t('toast.cantRead', { name: url })); return; }
  b.data = new ArrayBuffer(0); books.unshift(b);
  el('link-sheet').classList.add('hidden'); renderLibrary(); toast(t('media.link.added'));
}
```
Wiring (next to `wireUpload()` at `:3094`):
```typescript
  el('btn-link').addEventListener('click', () => { el('link-sheet').classList.remove('hidden'); });
  el('link-cancel').addEventListener('click', () => el('link-sheet').classList.add('hidden'));
  el('link-add').addEventListener('click', submitLinkedMedia);
  el('link-kind').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button') as HTMLElement | null; if (!btn) return;
    linkKind = btn.dataset.kind as 'audio' | 'video';
    el('link-kind').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === btn));
  });
```

- [ ] **Step 5: Verify + commit**
```bash
npx tsc --noEmit && node scripts/i18n-check.mjs && npm run build
git add project/app.ts project/index.html && git commit -S -m "feat(media): linked external audio/video add-by-URL"
```

---

## Task 8: Styles (chip bar, ⋮ menu, modals, link form)

**Files:** Modify `project/styles.css` (can run anytime — does not touch app.ts)

- [ ] **Step 1: Add styles**, reusing existing tokens (`--brass`, `--rule`, `--card`, `--muted`, `--shadow-3`, `var(--display)`):
```css
/* collections chip bar */
.chipbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 18px}
.chip{border:1px solid var(--rule);background:var(--card);color:var(--ink);border-radius:999px;
  padding:6px 14px;font-family:var(--display);font-size:12px;font-weight:600;letter-spacing:.04em;cursor:pointer;transition:.15s}
.chip:hover{border-color:var(--leather-2)}
.chip.active{background:linear-gradient(180deg,var(--brass-hi),var(--brass));color:#3a2410;border-color:var(--wood-2)}
.chip-add{font-size:15px;line-height:1;padding:5px 12px}
.chip-edit{border:0;background:transparent;color:var(--muted);cursor:pointer;padding:4px;border-radius:4px}
.chip-edit:hover{background:rgba(110,74,41,.10);color:var(--leather)}
.chip-edit svg{width:15px;height:15px}
/* per-card menu button (sits beside .del) */
.cardmenu{position:absolute;top:6px;left:6px;border:0;border-radius:4px;background:rgba(28,17,10,.55);
  color:#f3e6cd;cursor:pointer;width:24px;height:24px;font-size:16px;line-height:1;opacity:0;transition:.15s}
.book:hover .cardmenu,.row:hover .cardmenu{opacity:1}
.cardmenu svg{width:15px;height:15px}
/* shared modal overlay (collection picker, link sheet) */
.modal-overlay{position:fixed;inset:0;z-index:56;display:grid;place-items:center;background:rgba(28,17,10,.55);padding:20px}
.modal-overlay.hidden{display:none}
.coll-check{display:flex;align-items:center;gap:9px;padding:8px 4px;font-family:var(--read);font-size:15px;color:var(--ink);cursor:pointer}
.coll-none{color:var(--muted);font-style:italic;padding:8px 4px}
.coll-picker-actions,.link-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
```
(Verify `.cardmenu` positioning works against the existing `.cover`/`.del` rules; `.del` is top-right, this sits top-left. Adjust offsets if they collide with `.spine`/`.pct`.)

- [ ] **Step 2: Verify + commit**
```bash
npm run build
git add project/styles.css && git commit -S -m "style(collections): chip bar, card menu, picker + link modals"
```

---

## Task 9: Full verification, PR, deploy

- [ ] **Step 1: Run all gates**
```bash
cd /home/kayaman/Projects/folium-cafe
npx tsc --noEmit && node scripts/i18n-check.mjs && npm run build && (cd backend && npm test)
```
Expected: tsc clean, i18n-check OK (new keys now referenced, not "unused"), build emits `app.js`/`sw.js`, backend 46 tests still green.

- [ ] **Step 2: Manual smoke (describe for reviewer / run via the `run` skill or Playwright MCP against a preview):**
  - Create a collection via `+`; it appears as an active chip.
  - Filter by a chip across shelf/grid/list; `All` resets.
  - Open a card's ⋮ → check 2 collections → Save; re-open shows them checked; chip filter includes the book.
  - Rename + delete a collection; books remain, membership clears, active filter resets.
  - Add an `https` audio link; it appears in the library and streams; a non-https URL shows `media.link.badUrl`.
  - Reload offline (DevTools offline) → chip bar still renders from the cached snapshot.

- [ ] **Step 3: Push + open PR**
```bash
git push -u origin feat/collections-linked-media-ui
gh pr create --base main --title "feat: collections + linked media (frontend)" --body "Fast-follow to #11 — makes the dormant backend user-visible. Chip-bar filter, per-card collection picker, Upload|Link add path. Localized en/pt-BR/es. Spec: docs/superpowers/specs/2026-06-14-collections-linked-media-frontend-design.md"
```

- [ ] **Step 4: Watch CI green, then merge** (`gh pr merge --merge --delete-branch`) → auto-deploys via `deploy.yml`.

---

## Self-review notes (done)

- **Spec coverage:** chip bar (T5), assignment via ⋮ checklist (T6), Upload|Link (T7), i18n all-locale (T4), offline-snapshot resilience (T2), error handling via `api()` typed errors (T3/T5/T6/T7), YAGNI (no bulk-select/reorder/colors). All mapped.
- **Type consistency:** `Collection` defined T1, used T2/T3/T5; `apiSetBookCollections`/`openCollectionPicker`/`saveCollectionPicker`/`createCollectionFlow`/`renameCollectionFlow`/`deleteCollectionFlow` names consistent across tasks; `activeCollection`/`collections`/`LS.activeCollection` consistent.
- **Known verify-on-execute points (flagged inline, not placeholders):** `ICON.pencil`/`ICON.dots` may not exist → grep `const ICON` and substitute (fallback literals given); `stripData`/`BookMeta` may need `url`/`provider` added (T7 S3); `.cardmenu` offsets vs `.del`/`.pct` (T8). Each has a concrete fallback.
