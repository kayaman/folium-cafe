# Whole-App Theming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **⚠️ Serialization:** Tasks 2–8 edit `project/app.ts` and/or `project/styles.css` — run sequentially (never two writers on the same file in parallel). One branch, one PR.

**Goal:** A theme picker — **System · Paper · Sepia · Dark · High-contrast** — that re-skins the whole app (masthead, library, login, modals, reader) plus a PDF night-mode invert, persisted per device, honoring the OS preference, with no light-flash on load.

**Architecture:** Today's `:root` color tokens are the **Paper baseline**; three `[data-theme="sepia"|"dark"|"hc"]` blocks override token values. The ~30 *opaque* hardcoded colors that assume a light/dark base get tokenized (translucent rgba overlays are left as-is — they layer over any theme). A JS resolver maps the stored pref (incl. `system` via `matchMedia`) to `documentElement.dataset.theme`; an inline `<head>` script applies it pre-paint to avoid FOUC. EPUB themes its iframe via epub.js `rendition.themes`; PDF canvas inverts via CSS filter (CBZ excluded).

**Tech Stack:** Vanilla TS (esbuild), no framework, no frontend unit harness. Per-task gates: `npx tsc --noEmit`, `node scripts/i18n-check.mjs`, `npm run build`. Backend untouched (`npm test` stays green).

**Spec:** `docs/superpowers/specs/2026-06-15-app-theming-design.md`
**Branch:** `feat/app-theming` (holds the spec commit).

---

## Context

Folium Café is light-only (`color-scheme: only light`, styles.css:6). For a low-vision reader (memory `low-vision-reading-priority`), dark + high-contrast reduce glare and sharpen edges. This is the next step after per-book zoom (#16) and reading-comfort controls (#17). The user chose **one branch, all surfaces** (not phased). Palette hex values below are a tuned starting point — refined by eye during the Task 9 manual matrix.

## Verified anchors (HEAD)

- `index.html`: `<head>` meta `theme-color` (:8) + `color-scheme` (:9), stylesheet link (:11); `#settings` modal (:204-238) — Language `<select id="lang-select">` then a Reading stepper section, then `#settings-done`.
- `styles.css`: `:root{color-scheme:only light}` (:6); token block (:10-39); opaque offenders — `.login-card` grad `#f8f1e3/#f1e7d2` (:78), `.field input` `#fdfaf2` (:98), `.masthead color #f3e6cd` (:118), `.brand .mark #f7ecd5` (:123), `.continue .cv #fff` (:184), `.book .cover #efe2c5` (:217), `.row .rcv #efe2c5` (:250), `#reader #2c2218 + #3a2c1d/#241a11` (:296-297), `.rbar rgba(50,30,18,.96)/rgba(40,24,14,.96) + #ecdcbf` (:301-302), `.rbar .ico/.pageinput/.seg` inks `#ecdcbf/#b9a886/#cbb78f` (:305-319), `.rpage #fff` (:329), `.doc-scroll`/`.epub-stage` token-w/-fallbacks (:334,:353), `.markdown-body pre #2c2218/#ecdcbf` (:593), `.settings-card`/`.clip-card` grad `#f8f1e3/#f1e7d2` (:438,:486), `.settings-card select #fdfaf2` (:456), `.stepper-btn #fdfaf2/#fff` (:642-643), `#note-editor`/`.nbar` grads (:547,:550).
- `app.ts`: `LS` (:1194-1208); `setLanguage()` (:680); `applyI18n()` (:672); `applyReaderType()` model (:1217-1223); `init()` boot calls `applyI18n();applyReaderType()` (:3963-3964); `wireSettings()` (:3933-3958) — open-restore at :3946, change-applies-live at :3952; `EN as const` start (:190), `MsgKey` (:339), `PT` (:341), `ES` (:491); `EpubAdapter` `private rendition` (:2349) + `applyType()` (:2364-2370); `paintCanvasPage()` builds `.rpage` wrapper (:1919-1926); `reader.adapter.format` available at render.
- `sw.ts` SHELL already includes `/index.html`; deploy.yml ships index.html no-cache. **An inline `<head>` script needs no SW/deploy change.**

## Token vocabulary

Existing tokens are **overridden** per theme. New **opaque-surface** tokens (added to `:root` at today's values, then overridden):

`--app-bg`, `--surface-grad-top`, `--surface-grad-bot`, `--input-bg`, `--page-bg`, `--cover-bg`, `--chrome-ink`, `--reader-bg`, `--reader-grad-1`, `--reader-grad-2`, `--rbar-grad-top`, `--rbar-grad-bot`, `--rbar-ink`, `--rbar-muted`, `--code-bg`, `--code-ink`.

### Palette table (starting values; Paper column == today)

| token | Paper (`:root`) | `[data-theme=sepia]` | `[data-theme=dark]` | `[data-theme=hc]` |
|---|---|---|---|---|
| `--paper` | `#efe6d2` | `#f2e8d0` | `#211b14` | `#000` |
| `--paper-2` | `#e7dabd` | `#ead da8`→`#eadda8` | `#2a2219` | `#0c0c0c` |
| `--card` | `#f6efe0` | `#f3e7cc` | `#241d15` | `#0c0c0c` |
| `--ink` | `#2a2018` | `#3a2c18` | `#e8dcc4` | `#fff` |
| `--ink-2` | `#4b3f31` | `#564832` | `#cdbfa3` | `#f0f0f0` |
| `--muted` | `#6f6147` | `#7a6a43` | `#b6a685` | `#d8d8d8` |
| `--rule` | `#c9b88f` | `#cdba8c` | `#4a3f2e` | `#fff` |
| `--rule-soft` | `#d8caa6` | `#dccca0` | `#3a3024` | `#cfcfcf` |
| `--leather` | `#5e261d` | `#5e261d` | `#7c3327` | `#000` |
| `--leather-2` | `#7c3327` | `#7c3327` | `#5e261d` | `#1a1a1a` |
| `--brass` | `#b3853a` | `#b3853a` | `#caa24e` | `#ffd24a` |
| `--brass-hi` | `#dcb064` | `#dcb064` | `#e6c074` | `#ffe08a` |
| `--app-bg` | `#efe6d2` | `#efe2c8` | `#1a1510` | `#000` |
| `--surface-grad-top` | `#f8f1e3` | `#f5ebd0` | `#2a2219` | `#101010` |
| `--surface-grad-bot` | `#f1e7d2` | `#eee0c2` | `#221b13` | `#0a0a0a` |
| `--input-bg` | `#fdfaf2` | `#fbf3df` | `#2c2419` | `#0a0a0a` |
| `--page-bg` | `#fff` | `#f6ecd6` | `#211b14` | `#0a0a0a` |
| `--cover-bg` | `#efe2c5` | `#eaddbf` | `#2a2219` | `#141414` |
| `--chrome-ink` | `#f3e6cd` | `#f3e6cd` | `#f3e6cd` | `#fff` |
| `--reader-bg` | `#2c2218` | `#e9dcc0` | `#161109` | `#000` |
| `--reader-grad-1` | `#3a2c1d` | `#efe2c4` | `#221a11` | `#0a0a0a` |
| `--reader-grad-2` | `#241a11` | `#e3d4b2` | `#100c07` | `#000` |
| `--rbar-grad-top` | `rgba(50,30,18,.96)` | `#f1e7d2` | `#1d160d` | `#000` |
| `--rbar-grad-bot` | `rgba(40,24,14,.96)` | `#e9dcc0` | `#161109` | `#000` |
| `--rbar-ink` | `#ecdcbf` | `#3a2410` | `#ecdcbf` | `#fff` |
| `--rbar-muted` | `#b9a886` | `#7a6a43` | `#b9a886` | `#cfcfcf` |
| `--code-bg` | `#2c2218` | `#2c2218` | `#0e0b07` | `#000` |
| `--code-ink` | `#ecdcbf` | `#ecdcbf` | `#ecdcbf` | `#fff` |

(Two cells above contain a deliberate typo-guard `→` showing the intended value; use the value AFTER the arrow. Fix any stray space when typing, e.g. `--paper-2` sepia = `#eadda8`.)

---

## Task 1: Token scaffold + theme override blocks (CSS, no behavior change)

**Files:** Modify `project/styles.css` (`:root` :10-39, line 6).

- [ ] **Step 1: Add the new opaque-surface tokens** to the `:root` block (after `--green:` ~:28), at today's values:
```css
  --app-bg:#efe6d2;
  --surface-grad-top:#f8f1e3; --surface-grad-bot:#f1e7d2;
  --input-bg:#fdfaf2; --page-bg:#fff; --cover-bg:#efe2c5; --chrome-ink:#f3e6cd;
  --reader-bg:#2c2218; --reader-grad-1:#3a2c1d; --reader-grad-2:#241a11;
  --rbar-grad-top:rgba(50,30,18,.96); --rbar-grad-bot:rgba(40,24,14,.96);
  --rbar-ink:#ecdcbf; --rbar-muted:#b9a886; --code-bg:#2c2218; --code-ink:#ecdcbf;
```

- [ ] **Step 2: Replace** `:root{color-scheme:only light}` (line 6) with `:root{color-scheme:light}` and add per-theme scheme + the three override blocks right after the `:root{…}` token block. Use the palette table values (one block per theme). Example shape (fill ALL overridden tokens from the table):
```css
html[data-theme="sepia"]{color-scheme:light;
  --paper:#f2e8d0; --paper-2:#eadda8; --card:#f3e7cc; --ink:#3a2c18; --ink-2:#564832;
  --muted:#7a6a43; --rule:#cdba8c; --rule-soft:#dccca0;
  --app-bg:#efe2c8; --surface-grad-top:#f5ebd0; --surface-grad-bot:#eee0c2; --input-bg:#fbf3df;
  --page-bg:#f6ecd6; --cover-bg:#eaddbf;
  --reader-bg:#e9dcc0; --reader-grad-1:#efe2c4; --reader-grad-2:#e3d4b2;
  --rbar-grad-top:#f1e7d2; --rbar-grad-bot:#e9dcc0; --rbar-ink:#3a2410; --rbar-muted:#7a6a43;}
html[data-theme="dark"]{color-scheme:dark;
  --paper:#211b14; --paper-2:#2a2219; --card:#241d15; --ink:#e8dcc4; --ink-2:#cdbfa3;
  --muted:#b6a685; --rule:#4a3f2e; --rule-soft:#3a3024; --leather:#7c3327; --leather-2:#5e261d;
  --brass:#caa24e; --brass-hi:#e6c074;
  --app-bg:#1a1510; --surface-grad-top:#2a2219; --surface-grad-bot:#221b13; --input-bg:#2c2419;
  --page-bg:#211b14; --cover-bg:#2a2219;
  --reader-bg:#161109; --reader-grad-1:#221a11; --reader-grad-2:#100c07;
  --rbar-grad-top:#1d160d; --rbar-grad-bot:#161109; --code-bg:#0e0b07;}
html[data-theme="hc"]{color-scheme:dark;
  --paper:#000; --paper-2:#0c0c0c; --card:#0c0c0c; --ink:#fff; --ink-2:#f0f0f0;
  --muted:#d8d8d8; --rule:#fff; --rule-soft:#cfcfcf; --leather:#000; --leather-2:#1a1a1a;
  --brass:#ffd24a; --brass-hi:#ffe08a;
  --app-bg:#000; --surface-grad-top:#101010; --surface-grad-bot:#0a0a0a; --input-bg:#0a0a0a;
  --page-bg:#0a0a0a; --cover-bg:#141414; --chrome-ink:#fff;
  --reader-bg:#000; --reader-grad-1:#0a0a0a; --reader-grad-2:#000;
  --rbar-grad-top:#000; --rbar-grad-bot:#000; --rbar-ink:#fff; --rbar-muted:#cfcfcf; --code-bg:#000;}
```

- [ ] **Step 3: Verify + commit** (no visual change yet — nothing references the new tokens):
```bash
cd /home/kayaman/Projects/folium-cafe && npm run build
git add project/styles.css && git commit -S -m "feat(theme): token scaffold + sepia/dark/hc override blocks"
```

---

## Task 2: Theme switch JS — state, resolver, setTheme, boot, picker wiring

**Files:** Modify `project/app.ts` (`LS` :1204, near `applyReaderType` :1217, `init` :3963, `wireSettings` :3933).

- [ ] **Step 1: Add LS key** in the `LS` object after `lang:`:
```typescript
  theme: 'folium.theme',
```

- [ ] **Step 2: Add state + resolver + apply + setter** near `applyReaderType()`:
```typescript
type ThemePref = 'system' | 'paper' | 'sepia' | 'dark' | 'hc';
let themePref: ThemePref = (localStorage.getItem(LS.theme) as ThemePref) || 'system';
const prefersDark = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
function resolveTheme(p: ThemePref): 'paper' | 'sepia' | 'dark' | 'hc' {
  if (p === 'system') return prefersDark() ? 'dark' : 'paper';
  return p;
}
// theme-color meta per resolved theme (address bar / PWA chrome).
const THEME_COLOR: Record<string, string> = { paper: '#5e261d', sepia: '#7c3327', dark: '#161109', hc: '#000000' };
function applyTheme(): void {
  const resolved = resolveTheme(themePref);
  document.documentElement.dataset.theme = resolved;
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', THEME_COLOR[resolved]);
  const a = reader.adapter as any;
  if (a && typeof a.applyTheme === 'function') a.applyTheme(resolved);
}
function setTheme(p: ThemePref): void {
  themePref = p;
  localStorage.setItem(LS.theme, p);
  applyTheme();
}
// Re-resolve when the OS theme flips and the user is on 'system'.
if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePref === 'system') applyTheme(); });
```

- [ ] **Step 3: Apply on boot** — in `init()` after `applyReaderType();`:
```typescript
  applyTheme();
```

- [ ] **Step 4: Wire the picker** in `wireSettings()`. Add alongside the language wiring:
```typescript
  const themeSel = el<HTMLSelectElement>('theme-select');
  themeSel.addEventListener('change', () => setTheme(themeSel.value as ThemePref));
```
and in the `btn-settings` open handler (after `sel.value = …`), add:
```typescript
    themeSel.value = themePref;
```

- [ ] **Step 5: Verify + commit:**
```bash
npx tsc --noEmit
git add project/app.ts && git commit -S -m "feat(theme): pref state, resolver, setTheme, boot apply, picker wiring"
```
(`el('theme-select')` and `a.applyTheme` are forward refs satisfied in Tasks 4/8; tsc is fine — `el` returns `T`, duck-typed call guarded.)

---

## Task 3: i18n keys for the theme picker

**Files:** Modify `project/app.ts` — `EN` (:190), `PT` (:341), `ES` (:491). Same keys in all three; no `<>&"`.

- [ ] **Step 1: EN** (before `} as const;`):
```typescript
  'settings.theme': 'Theme',
  'theme.system': 'System default',
  'theme.paper': 'Paper',
  'theme.sepia': 'Sepia',
  'theme.dark': 'Dark',
  'theme.hc': 'High contrast',
```

- [ ] **Step 2: PT:**
```typescript
  'settings.theme': 'Tema',
  'theme.system': 'Padrão do sistema',
  'theme.paper': 'Papel',
  'theme.sepia': 'Sépia',
  'theme.dark': 'Escuro',
  'theme.hc': 'Alto contraste',
```

- [ ] **Step 3: ES:**
```typescript
  'settings.theme': 'Tema',
  'theme.system': 'Predeterminado del sistema',
  'theme.paper': 'Papel',
  'theme.sepia': 'Sepia',
  'theme.dark': 'Oscuro',
  'theme.hc': 'Alto contraste',
```

- [ ] **Step 4: Verify + commit:**
```bash
npx tsc --noEmit && node scripts/i18n-check.mjs
git add project/app.ts && git commit -S -m "feat(i18n): theme picker keys (en/pt-BR/es)"
```
Expected: i18n-check OK; new keys "unused" until Task 4 (warning, not failure).

---

## Task 4: Theme `<select>` in Settings + anti-FOUC head script

**Files:** Modify `project/index.html` (`#settings` :208, `<head>` :10).

- [ ] **Step 1: Insert the Theme field** into `#settings`, between the Language `.field` (closes ~:216) and the Reading `.field`:
```html
    <div class="field">
      <label for="theme-select" data-i18n="settings.theme">Theme</label>
      <select id="theme-select">
        <option value="system" data-i18n="theme.system">System default</option>
        <option value="paper" data-i18n="theme.paper">Paper</option>
        <option value="sepia" data-i18n="theme.sepia">Sepia</option>
        <option value="dark" data-i18n="theme.dark">Dark</option>
        <option value="hc" data-i18n="theme.hc">High contrast</option>
      </select>
    </div>
```

- [ ] **Step 2: Add the anti-FOUC inline script** in `<head>`, immediately BEFORE the stylesheet `<link rel="stylesheet" href="styles.css">` (line 11). Plain ES (no bundler; the LS key string is inlined):
```html
<script>(function(){try{var p=localStorage.getItem('folium.theme')||'system';var r=p==='system'?(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'paper'):p;document.documentElement.dataset.theme=r;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',{paper:'#5e261d',sepia:'#7c3327',dark:'#161109',hc:'#000000'}[r]||'#5e261d');}catch(e){}})();</script>
```

- [ ] **Step 3: Verify + commit:**
```bash
npx tsc --noEmit && node scripts/i18n-check.mjs && npm run build
git add project/index.html && git commit -S -m "feat(theme): Settings theme picker + anti-FOUC head script"
```
Expected: i18n-check now 0-unused for theme keys. Manual: changing the picker flips `data-theme`; reload in Dark shows no light flash. (Hardcoded surfaces still look light in Dark until Tasks 5–7.)

---

## Task 5: Tokenize app chrome — masthead, library, login, modals, notes

**Files:** Modify `project/styles.css`. Replace **opaque** literals with the tokens. Leave translucent `rgba()` overlays (shadows, hover tints, inset highlights) untouched.

- [ ] **Step 1: Masthead + library** — apply these substitutions:
  - `.masthead{…color:#f3e6cd}` → `color:var(--chrome-ink)` (:118); `.brand .mark{color:#f7ecd5}` → `var(--chrome-ink)` (:123); `.mast-btn{…color:#f3e6cd}` → `var(--chrome-ink)` (:140); `.viewswitch button{…color:#e9d6b3}` → `var(--chrome-ink)` (:130).
  - `.continue{background:linear-gradient(180deg,#f6efe0,#efe3ca)}` → `linear-gradient(180deg,var(--surface-grad-top),var(--surface-grad-bot))` (:177); `.continue .cv{background:#fff}` → `var(--page-bg)` (:184).
  - `.book .cover{background:#efe2c5}` → `var(--cover-bg)` (:217); `.row .rcv{background:#efe2c5}` → `var(--cover-bg)` (:250); `.row .rresume{background:#f3ead6}` → `var(--input-bg)` (:260).

- [ ] **Step 2: Login + modals + notes** — substitutions:
  - `.login-card{background:linear-gradient(180deg,#f8f1e3,#f1e7d2)}` → `var(--surface-grad-top),var(--surface-grad-bot)` (:78); `.field input{background:#fdfaf2}` → `var(--input-bg)` (:98).
  - `.settings-card{background:linear-gradient(180deg,#f8f1e3,#f1e7d2)}` (:438) and `.clip-card{…#f8f1e3,#f1e7d2}` (:486) → surface-grad tokens; `.settings-card select{background:#fdfaf2}` (:456) and `.stepper-btn{background:#fdfaf2}` (:642) → `var(--input-bg)`.
  - `#note-editor{…radial-gradient(120% 90% at 50% 0%,#f3ecda,#e7dec4)}` (:547) → use `var(--surface-grad-top),var(--surface-grad-bot)`; `.nbar{background:linear-gradient(180deg,#f8f1e3,#efe3ca)}` (:550) → surface-grad tokens; `.nbar .ico{background:#fdfaf2}` (:553) → `var(--input-bg)`.

- [ ] **Step 3: Verify + commit:**
```bash
npm run build
git add project/styles.css && git commit -S -m "style(theme): tokenize masthead, library, login, modals, notes"
```

---

## Task 6: Tokenize reader chrome + code blocks

**Files:** Modify `project/styles.css` (reader region ~:296-396, code block :593).

- [ ] **Step 1: Reader surface + bar** — substitutions:
  - `#reader{background:#2c2218}` → `var(--reader-bg)`; `#reader{…radial-gradient(120% 90% at 50% 0%,#3a2c1d,#241a11)}` → `var(--reader-grad-1),var(--reader-grad-2)` (:296-297).
  - `.rbar{background:linear-gradient(180deg,rgba(50,30,18,.96),rgba(40,24,14,.96))}` → `var(--rbar-grad-top),var(--rbar-grad-bot)`; `.rbar{…color:#ecdcbf}` → `var(--rbar-ink)` (:301-302).
  - `.rbar .ico{…color:#ecdcbf}` (:305), `.rbar .pageinput{color:#f3e6cd}` (:315) → `var(--rbar-ink)`; `.rbar .rtitle .a{color:#b9a886}` (:311), `.rbar .pgtotal{color:#b9a886}` (:317), `.rbar .seg button{color:#cbb78f}` (:319) → `var(--rbar-muted)`.
  - `.rpage{background:#fff}` → `var(--page-bg)` (:329).

- [ ] **Step 2: Code blocks** — `.markdown-body pre{background:#2c2218;color:#ecdcbf}` (:593) → `background:var(--code-bg);color:var(--code-ink)`.

- [ ] **Step 3: Verify + commit:**
```bash
npm run build
git add project/styles.css && git commit -S -m "style(theme): tokenize reader chrome + code blocks"
```

---

## Task 7: PDF night-mode invert (CBZ excluded)

**Files:** Modify `project/app.ts` (`paintCanvasPage` :1922), `project/styles.css`.

- [ ] **Step 1: Mark the page wrapper by format** — in `paintCanvasPage()`, after `wrap.className = 'rpage';`:
```typescript
  const fmt = reader.adapter?.format;
  if (fmt) wrap.setAttribute('data-fmt', fmt);
```

- [ ] **Step 2: Invert only the PDF canvas under dark/hc** — append to `styles.css`. Invert the canvas element only; the `.textLayer` and `.rclips` siblings are NOT inside the canvas, so they are unaffected:
```css
html[data-theme="dark"] .rpage[data-fmt="pdf"] canvas,
html[data-theme="hc"] .rpage[data-fmt="pdf"] canvas{filter:invert(1) hue-rotate(180deg)}
```
(CBZ has `data-fmt="cbz"` → not matched → comics render true.)

- [ ] **Step 3: Verify + commit:**
```bash
npx tsc --noEmit && npm run build
git add project/app.ts project/styles.css && git commit -S -m "feat(theme): PDF night-mode canvas invert (CBZ excluded)"
```
Expected: in Dark/HC a PDF page renders inverted (dark page, light text) while selectable text overlay + clips stay correctly oriented; CBZ stays normal.

---

## Task 8: EPUB iframe theming

**Files:** Modify `project/app.ts` — `EpubAdapter` (:2349-2370, `render()`).

- [ ] **Step 1: Add `applyTheme` to `EpubAdapter`** (mirrors `applyType`, uses the same `this.rendition.themes` hook). Maps the resolved theme to bg/ink:
```typescript
  applyTheme(theme: string): void {
    if (!this.rendition) return;
    const map: Record<string, { bg: string; fg: string; link: string }> = {
      paper: { bg: '#efe6d2', fg: '#2a2018', link: '#5e261d' },
      sepia: { bg: '#f2e8d0', fg: '#3a2c18', link: '#7c3327' },
      dark:  { bg: '#211b14', fg: '#e8dcc4', link: '#caa24e' },
      hc:    { bg: '#000000', fg: '#ffffff', link: '#ffd24a' },
    };
    const c = map[theme] || map.paper;
    try {
      this.rendition.themes.override('background', c.bg, true);
      this.rendition.themes.override('color', c.fg, true);
      this.rendition.themes.override('a', c.link, true);
    } catch { /* themes API best-effort */ }
  }
```
(If `themes.override` can't target `a` color this way on the vendored epub.js, fall back to `this.rendition.themes.registerRules?.('folium', { body:{background:c.bg,color:c.fg}, a:{color:c.link} })` + `this.rendition.themes.select?.('folium')` — verify the API at edit time.)

- [ ] **Step 2: Apply on initial render** — in `EpubAdapter.render()`, right after the existing `this.applyType(readerFontScale, readerLineHeight);` call (added in #17):
```typescript
    this.applyTheme(resolveTheme(themePref));
```
And in the re-render `else` branch (after its `this.rendition.display(...)`), add the same line for robustness.

- [ ] **Step 3: Verify + commit:**
```bash
npx tsc --noEmit && npm run build
git add project/app.ts && git commit -S -m "feat(theme): EPUB iframe theming via epub.js themes"
```

---

## Task 9: Straggler sweep, full verification, PR

- [ ] **Step 1: Find opaque stragglers** — grep for remaining opaque light/dark literals that should be tokens (translucent rgba overlays are fine to keep):
```bash
cd /home/kayaman/Projects/folium-cafe
grep -nE "#(fff|fdfaf2|f8f1e3|f1e7d2|efe2c5|2c2218|ecdcbf|f3e6cd|241a11|3a2c1d)" project/styles.css
```
Tokenize any remaining hits using the established tokens; commit if changes:
```bash
git add project/styles.css && git commit -S -m "style(theme): tokenize straggler opaque colors" || true
```

- [ ] **Step 2: All gates**
```bash
npx tsc --noEmit && node scripts/i18n-check.mjs && npm run build && (cd backend && npm test)
```
Expected: tsc clean; i18n 0-unused; build emits app.js/sw.js; backend tests green.

- [ ] **Step 3: Manual theme matrix** (run via the `run` skill / Playwright against a preview). For EACH theme {Paper, Sepia, Dark, HC} verify legibility (no light-on-light / dark-on-dark patches) on: login, masthead + Add menu, library (shelf/grid/list) + continue card, Settings (incl. picker + steppers), a txt, a md, an EPUB, a PDF, a CBZ, the notes editor, a media item. Plus: **no light-flash** on reload in Dark; **System** flips when the OS theme toggles; choice **persists** across reload; **PDF inverts** in Dark/HC with its text layer/clips correctly oriented; **CBZ does NOT invert**; EPUB iframe recolors.

- [ ] **Step 4: Push + PR**
```bash
git push -u origin feat/app-theming
gh pr create --base main --title "feat: whole-app theming (system/paper/sepia/dark/high-contrast)" --body "Theme picker re-skinning the whole app + PDF night-mode + EPUB iframe theming; persisted, OS-aware, no-FOUC. Spec/plan in docs/superpowers/. Tune palettes per the manual matrix."
```

- [ ] **Step 5: Watch CI green, then merge** (`gh pr merge --merge --delete-branch`) → auto-deploys.

---

## Self-review notes (done)

- **Spec coverage:** theme set + System/OS (T2 resolver+listener), no-FOUC (T4 head script), token strategy + ~25 tokens (T1), per-surface re-skin (T5/T6), PDF invert CBZ-excluded (T7), EPUB iframe (T8), picker + i18n (T3/T4), persistence (T2 LS), per-theme `color-scheme` + `theme-color` (T1/T2). Mapped.
- **Type consistency:** `ThemePref`, `themePref`, `resolveTheme`, `applyTheme`, `setTheme`, `THEME_COLOR` consistent across T2/T4/T8; `data-fmt` set in T7 and consumed by T7 CSS; tokens defined in T1 and consumed in T5/T6/T7.
- **Verify-on-execute (flagged, with fallbacks):** epub.js `themes.override`/`registerRules` API names — confirm on the vendored build (T8 fallback given); `.rpage` invert must not catch `.textLayer`/`.rclips` (verify DOM nesting — they're siblings appended to `wrap`, canvas is the inverted node); palette hexes are starting values, tuned in T9; the two `→` typo-guard cells in the palette table use the post-arrow value.
- **Out of scope:** per-book theme, time-scheduled dark, custom palettes, backend changes.
```
