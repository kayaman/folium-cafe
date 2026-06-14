# Reading-Comfort Controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **Canonical copy:** on execution, copy this plan to `docs/superpowers/plans/2026-06-14-reading-comfort-controls.md` (plan mode restricts edits to this scratch file).
> **⚠️ Serialization:** Tasks touching `project/app.ts` run sequentially (never two app.ts writers). The CSS (Task 1) and index.html (Task 4a) edits can interleave safely.

**Goal:** Let the reader adjust **text size** and **line spacing** for reflowable formats (txt / Markdown / EPUB) from Settings — applied live, remembered across sessions, and injected into the EPUB iframe. This completes the "make text bigger" story for the formats that PDF/CBZ zoom (already shipped) doesn't cover.

**Architecture:** Two CSS custom properties (`--reader-font-scale`, `--reader-line-height`) drive the scroll/markdown surfaces; a JS `applyReaderType()` sets them on `<html>` and is the single apply-point (mirrors `setLanguage()`/`applyI18n()`). EPUB renders in an iframe, so its scale/line-height go through epub.js `rendition.themes`. Settings gets a "Reading" section with two stepper rows.

**Tech Stack:** Vanilla TS (esbuild), no framework, no frontend unit-test harness. Gates per task: `npx tsc --noEmit`, `node scripts/i18n-check.mjs`, `npm run build`. Backend untouched.

---

## Context

The repo owner reads with heavy glasses; legibility is a first-class constraint (memory `low-vision-reading-priority`). PDFs/CBZ already remember per-book zoom (shipped). But txt/Markdown/EPUB have **fixed** typography — 18px / line-height 1.75, no user control (audited: `.doc-scroll.markdown-body`, `.doc-plain pre`, EPUB rendition has no theme injected). This adds adjustable size + spacing for exactly those formats. Themes (dark/sepia/high-contrast) are a separate, larger effort and remain out of scope.

## Current state (verified, HEAD = abd4976)

- Settings modal `#settings` — `project/index.html:196-211` (only a Language `<select>` today).
- `wireSettings()` — `project/app.ts:3853`; live-apply pattern via `setLanguage()` `app.ts:659`; universal applier `applyI18n()` `app.ts:651`; focus trap `trapFocus()`.
- `LS` keys object — `app.ts:1175-1187`.
- Reflowable CSS — `styles.css`: `.doc-scroll` (327), `.doc-scroll.markdown-body{font-size:18px;line-height:1.75}` (330), `.doc-plain pre{font-size:17px;line-height:1.7}` (331-332), `.markdown-body` base + headings h1 30 / h2 24 / h3 20 (581-590).
- EPUB rendition setup — `app.ts:2335-2341` (`this.rendition = this.epub.renderTo(...)`); `EpubAdapter` class ~`app.ts:2300+`. epub.js exposes `rendition.themes.fontSize('120%')` and `rendition.themes.override('line-height','1.75', true)`.
- `:root` tokens — `styles.css:10-37`. `.field`/`.field label` — `styles.css:91-96`. `.settings-card` — `styles.css:437-458`.
- i18n: `EN` `as const` (~`app.ts:171`), `PT`/`ES` typed `Record<MsgKey,string>`; `i18n-check` forbids `<>&"` in values; tsc enforces EN/PT/ES key parity.

## Design constants

- `readerFontScale`: default **1.0**, step **0.1**, clamp **0.8–2.0** (shown as a percentage, e.g. 120%).
- `readerLineHeight`: default **1.75**, step **0.15**, clamp **1.4–2.3** (shown as e.g. 1.75).
- Defaults reproduce today's look (md is already 1.75; txt nudges 1.7→1.75, slightly airier — fine for low vision).

---

## Task 1: CSS — drive reflowable typography from variables

**Files:** Modify `project/styles.css` (`:root` ~`:10`, `.doc-scroll.markdown-body` ~`:330`, `.doc-plain pre` ~`:331`, markdown headings ~`:583`)

- [ ] **Step 1: Declare defaults** in `:root` (add near the other tokens, ~`:36`):
```css
  --reader-font-scale:1;
  --reader-line-height:1.75;
```

- [ ] **Step 2: Scale the scroll/markdown reading surface.** Replace the existing rule
`.doc-scroll.markdown-body{font-family:var(--read);font-size:18px;line-height:1.75}` with:
```css
.doc-scroll.markdown-body{font-family:var(--read);font-size:calc(18px * var(--reader-font-scale));line-height:var(--reader-line-height)}
```
and replace `.doc-plain pre{...font-size:17px;line-height:1.7;...}` so its size/line-height read the vars:
```css
.doc-plain pre{white-space:pre-wrap;word-wrap:break-word;margin:0;font-family:var(--read);font-size:calc(17px * var(--reader-font-scale));line-height:var(--reader-line-height);color:inherit}
```

- [ ] **Step 3: Make markdown headings scale with the body** — convert the fixed px heading sizes to `em` so they track the scaled base (preserves today's ratios: 30/18, 24/18, 20/18). Replace
`.markdown-body h1{font-size:30px}.markdown-body h2{font-size:24px}.markdown-body h3{font-size:20px}` with:
```css
.markdown-body h1{font-size:1.667em}.markdown-body h2{font-size:1.333em}.markdown-body h3{font-size:1.111em}
```
(Note: the standalone `.markdown-body` used by the note editor keeps its fixed 18px base, so note headings render identically — they're now `em` of an unchanged 18px.)

- [ ] **Step 4: Verify + commit** (defaults reproduce current look):
```bash
cd /home/kayaman/Projects/folium-cafe && npm run build
git add project/styles.css && git commit -S -m "feat(reader): drive reflowable type from --reader-font-scale/--reader-line-height"
```

---

## Task 2: State + `applyReaderType()` + boot apply

**Files:** Modify `project/app.ts` — `LS` (`:1175`), add state + helpers near other reader prefs, boot sequence

- [ ] **Step 1: Add LS keys** inside the `LS` object (`:1175`):
```typescript
  readerFontScale: 'folium.readerFontScale',
  readerLineHeight: 'folium.readerLineHeight',
```

- [ ] **Step 2: Add state + clamps + applier.** Place near the other reader view-pref code (e.g. just after the `LS` object or beside `setLanguage`):
```typescript
const TYPE_LIMITS = { scaleMin: 0.8, scaleMax: 2.0, scaleStep: 0.1, lhMin: 1.4, lhMax: 2.3, lhStep: 0.15 };
const clampType = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
let readerFontScale = clampType(Number(localStorage.getItem(LS.readerFontScale)) || 1, TYPE_LIMITS.scaleMin, TYPE_LIMITS.scaleMax);
let readerLineHeight = clampType(Number(localStorage.getItem(LS.readerLineHeight)) || 1.75, TYPE_LIMITS.lhMin, TYPE_LIMITS.lhMax);

// Single apply-point: set the CSS vars (instant reflow for scroll/markdown) and,
// if an EPUB is open, push the values into its iframe via epub.js themes.
function applyReaderType(): void {
  const root = document.documentElement.style;
  root.setProperty('--reader-font-scale', String(readerFontScale));
  root.setProperty('--reader-line-height', String(readerLineHeight));
  const a = reader.adapter as any;
  if (a && typeof a.applyType === 'function') a.applyType(readerFontScale, readerLineHeight);
}
function setReaderFontScale(v: number): void {
  readerFontScale = clampType(Number(v.toFixed(2)), TYPE_LIMITS.scaleMin, TYPE_LIMITS.scaleMax);
  localStorage.setItem(LS.readerFontScale, String(readerFontScale));
  applyReaderType();
}
function setReaderLineHeight(v: number): void {
  readerLineHeight = clampType(Number(v.toFixed(2)), TYPE_LIMITS.lhMin, TYPE_LIMITS.lhMax);
  localStorage.setItem(LS.readerLineHeight, String(readerLineHeight));
  applyReaderType();
}
```

- [ ] **Step 3: Apply on boot.** In the startup sequence where other prefs/wiring run (near where `wireSettings()`/`applyI18n()` are called during init), add a call:
```typescript
  applyReaderType();
```
(Setting the CSS vars at boot is harmless before any reader opens; it just primes `<html>`.)

- [ ] **Step 4: Verify + commit:**
```bash
npx tsc --noEmit
git add project/app.ts && git commit -S -m "feat(reader): reader-type state, applyReaderType(), boot apply"
```
Expected: tsc clean. (`a.applyType` is duck-typed; the EpubAdapter method lands in Task 5 — until then the optional-call is a no-op for other adapters.)

---

## Task 3: i18n keys for the Reading settings section

**Files:** Modify `project/app.ts` — `EN` (`:171`), `PT`, `ES` (add identical keys to all three; values only, no `<>&"`).

- [ ] **Step 1: Append to `EN`** (before its closing `} as const`):
```typescript
  'settings.reading': 'Reading',
  'settings.textSize': 'Text size',
  'settings.lineSpacing': 'Line spacing',
  'settings.decrease': 'Decrease',
  'settings.increase': 'Increase',
```

- [ ] **Step 2: Append to `PT`:**
```typescript
  'settings.reading': 'Leitura',
  'settings.textSize': 'Tamanho do texto',
  'settings.lineSpacing': 'Espaçamento',
  'settings.decrease': 'Diminuir',
  'settings.increase': 'Aumentar',
```

- [ ] **Step 3: Append to `ES`:**
```typescript
  'settings.reading': 'Lectura',
  'settings.textSize': 'Tamaño del texto',
  'settings.lineSpacing': 'Interlineado',
  'settings.decrease': 'Disminuir',
  'settings.increase': 'Aumentar',
```

- [ ] **Step 4: Verify + commit:**
```bash
npx tsc --noEmit && node scripts/i18n-check.mjs
git add project/app.ts && git commit -S -m "feat(i18n): settings.reading/textSize/lineSpacing keys (en/pt-BR/es)"
```
Expected: tsc parity OK; i18n-check OK (new keys "unused" until Task 4 references them — a warning, not a failure).

---

## Task 4: Settings UI — two stepper rows + wiring + styles

**Files:** Modify `project/index.html` (`#settings` `:196-211`), `project/app.ts` (`wireSettings()` `:3853`), `project/styles.css` (new stepper styles)

- [ ] **Step 1: Add the Reading section to `#settings`** — between the Language `.field` and the `#settings-done` button:
```html
    <div class="field">
      <label data-i18n="settings.reading">Reading</label>
      <div class="stepper-row">
        <span class="stepper-label" data-i18n="settings.textSize">Text size</span>
        <div class="stepper">
          <button type="button" id="type-size-dec" class="stepper-btn" data-i18n-aria="settings.decrease" aria-label="Decrease">A−</button>
          <span class="stepper-val" id="type-size-val" aria-live="polite">100%</span>
          <button type="button" id="type-size-inc" class="stepper-btn" data-i18n-aria="settings.increase" aria-label="Increase">A+</button>
        </div>
      </div>
      <div class="stepper-row">
        <span class="stepper-label" data-i18n="settings.lineSpacing">Line spacing</span>
        <div class="stepper">
          <button type="button" id="type-lh-dec" class="stepper-btn" data-i18n-aria="settings.decrease" aria-label="Decrease">≡−</button>
          <span class="stepper-val" id="type-lh-val" aria-live="polite">1.75</span>
          <button type="button" id="type-lh-inc" class="stepper-btn" data-i18n-aria="settings.increase" aria-label="Increase">≡+</button>
        </div>
      </div>
    </div>
```

- [ ] **Step 2: Add stepper styles to `styles.css`** (reuse tokens; ~44px tap targets for low vision):
```css
.stepper-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px}
.stepper-label{font-family:var(--read);font-size:14px;color:var(--ink)}
.stepper{display:flex;align-items:center;gap:8px}
.stepper-btn{min-width:44px;height:40px;padding:0 12px;border:1px solid var(--rule);border-radius:4px;
  background:#fdfaf2;color:var(--ink);font-family:var(--display);font-weight:600;font-size:15px;transition:var(--t-fast) var(--ease)}
.stepper-btn:hover{border-color:var(--leather-2);background:#fff}
.stepper-val{min-width:54px;text-align:center;font-family:var(--read);font-size:14px;color:var(--muted)}
```

- [ ] **Step 3: Wire the steppers in `wireSettings()`.** Add a small refresh helper + listeners. On open, also sync the readouts. Insert inside `wireSettings()` alongside the language wiring:
```typescript
  const syncTypeReadout = () => {
    el('type-size-val').textContent = Math.round(readerFontScale * 100) + '%';
    el('type-lh-val').textContent = readerLineHeight.toFixed(2);
  };
  el('type-size-dec').addEventListener('click', () => { setReaderFontScale(readerFontScale - TYPE_LIMITS.scaleStep); syncTypeReadout(); });
  el('type-size-inc').addEventListener('click', () => { setReaderFontScale(readerFontScale + TYPE_LIMITS.scaleStep); syncTypeReadout(); });
  el('type-lh-dec').addEventListener('click', () => { setReaderLineHeight(readerLineHeight - TYPE_LIMITS.lhStep); syncTypeReadout(); });
  el('type-lh-inc').addEventListener('click', () => { setReaderLineHeight(readerLineHeight + TYPE_LIMITS.lhStep); syncTypeReadout(); });
```
Then in the existing `el('btn-settings').addEventListener('click', ...)` open handler, add `syncTypeReadout();` after the language `sel.value = ...` line so the readouts reflect current values each open.

- [ ] **Step 4: Verify + commit:**
```bash
npx tsc --noEmit && node scripts/i18n-check.mjs && npm run build
git add project/index.html project/app.ts project/styles.css && git commit -S -m "feat(reader): Reading settings — text-size + line-spacing steppers"
```
Expected: tsc clean; i18n-check OK (keys now referenced, 0 unused); build emits app.js. Manual: open Settings, step text size/spacing while a txt/md doc is open in another nothing-needed — the CSS vars reflow it live.

---

## Task 5: EPUB live application via epub.js themes

**Files:** Modify `project/app.ts` — `EpubAdapter` (rendition setup `:2335`, `render()`)

- [ ] **Step 1: Add an `applyType` method to `EpubAdapter`.** It pushes scale (as a %) and line-height into the iframe through epub.js themes:
```typescript
  applyType(scale: number, lineHeight: number): void {
    if (!this.rendition) return;
    try {
      this.rendition.themes.fontSize(Math.round(scale * 100) + '%');
      this.rendition.themes.override('line-height', String(lineHeight), true);
    } catch { /* themes API best-effort */ }
  }
```
(Field/property names: use the class's existing `this.rendition` reference — confirm its exact name when editing.)

- [ ] **Step 2: Apply on initial render.** In `EpubAdapter.render()`, right after the rendition has displayed the content (after the `await this.rendition.display(...)` call), invoke:
```typescript
    this.applyType(readerFontScale, readerLineHeight);
```
(`readerFontScale`/`readerLineHeight` are module-scope — in scope from the adapter.)

- [ ] **Step 3: Verify + commit:**
```bash
npx tsc --noEmit && npm run build
git add project/app.ts && git commit -S -m "feat(reader): apply text size + line spacing to EPUB via epub.js themes"
```
Expected: tsc clean; build OK. (Now changing the steppers while an EPUB is open reflows the iframe through `applyReaderType` → `adapter.applyType`.)

---

## Task 6: Full verification + PR

- [ ] **Step 1: All gates**
```bash
cd /home/kayaman/Projects/folium-cafe
npx tsc --noEmit && node scripts/i18n-check.mjs && npm run build && (cd backend && npm test)
```
Expected: tsc clean; i18n 0-unused; build emits app.js/sw.js; backend tests unchanged-green.

- [ ] **Step 2: Manual checklist** (run via the `run` skill / Playwright against a preview):
  1. Settings → Reading: stepping **Text size** changes the readout (e.g. 100%→120%) and **persists** across reload.
  2. Open a `.md` and a `.txt`: increasing size/spacing reflows the text **live** (no reopen); reopening keeps the chosen size.
  3. Open an `.epub`: size/spacing apply inside the reader; changing them while open reflows the iframe; reopening keeps them.
  4. Headings in Markdown scale with body; the **note editor** preview is unchanged (still 18px base).
  5. Defaults (100% / 1.75) reproduce the pre-change appearance.
  6. Clamp: can't go below 80% / 1.40 or above 200% / 2.30.

- [ ] **Step 3: Push + PR**
```bash
git push -u origin feat/reading-comfort-controls
gh pr create --base main --title "feat: reading-comfort controls (text size + line spacing)" --body "Adjustable text size + line spacing for txt/Markdown/EPUB, in Settings, applied live and remembered (EPUB via epub.js themes). PDF/CBZ already have zoom. Spec/plan: docs/superpowers/plans/2026-06-14-reading-comfort-controls.md"
```

- [ ] **Step 4: Watch CI green, then merge** (`gh pr merge --merge --delete-branch`) → auto-deploys.

---

## Notes / verify-on-execute (flagged, with fallbacks)

- **Branch:** create `feat/reading-comfort-controls` off `main` before Task 1.
- **EPUB `this.rendition` field name** (Task 5): confirm the exact property on `EpubAdapter` when editing; if epub.js `themes.override` misbehaves on the vendored version, fall back to `this.rendition.themes.default({ 'body': { 'line-height': String(lineHeight) + ' !important', 'font-size': Math.round(scale*100)+'% !important' } })`.
- **Boot apply-point** (Task 2 Step 3): place `applyReaderType()` wherever `wireSettings()`/init wiring runs; exact line is the implementer's to find (it's idempotent and order-independent).
- **No backend changes**; these are local view preferences (per-device, like language/width), so they intentionally do **not** sync across devices.
```
