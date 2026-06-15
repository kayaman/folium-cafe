# Whole-App Theming — Design

Date: 2026-06-15
Status: Approved (brainstorming)
Branch: `feat/app-theming`

## Purpose

Folium Café is light-only today (`color-scheme: only light`). For a low-vision
reader, glare and contrast matter: a dark surface and a high-contrast option
reduce eye-strain and sharpen edges. This adds a **theme picker** — **System ·
Paper · Sepia · Dark · High-contrast** — that re-skins the **entire app**
(masthead, library, login, modals, reader) plus a **night-mode invert for PDF
pages**, persisted per device and honoring the OS preference.

Builds on the low-vision line already shipped (per-book zoom + exact resume #16,
reading-comfort font/line controls #17; memory `low-vision-reading-priority`).
Decided in brainstorming: **one branch, all surfaces** (not phased).

## Theme set

| Pref | Resolves to | Notes |
|---|---|---|
| **System** (default) | Paper or Dark, via `prefers-color-scheme` | live OS-change listener |
| **Paper** | light, today's warm palette | the current look (baseline tokens) |
| **Sepia** | warm low-blue light | gentle, reduced glare |
| **Dark** | warm-neutral dark | low light reading |
| **High-contrast** | white-on-black, strong borders | max edge definition |

`themePref` ∈ {system,paper,sepia,dark,hc} in `localStorage['folium.theme']`. The
**resolved** theme (paper/sepia/dark/hc) is written to
`document.documentElement.dataset.theme`.

## Architecture

### Switching + no-flash boot
- A resolver: `system` → `matchMedia('(prefers-color-scheme: dark)').matches ?
  'dark' : 'paper'`; explicit prefs pass through. A `matchMedia` `change`
  listener re-resolves when pref is `system`.
- `setTheme(pref)`: persist → resolve → set `data-theme` → if a reader is open,
  call `reader.adapter.applyTheme?.(resolved)` (EPUB). Mirrors `setLanguage()`.
- **Anti-FOUC:** a tiny inline script in `index.html <head>` (NOT in the esbuild
  bundle — `app.js` loads too late) reads `localStorage['folium.theme']`,
  resolves system, and sets `documentElement.dataset.theme` before `styles.css`
  paints. ~6 lines, sets only the attribute.
- Replace `color-scheme: only light` (styles.css:6 + the `<meta>` at
  index.html:9) with per-theme `color-scheme` (`light` for paper/sepia, `dark`
  for dark/hc) so native form controls, scrollbars, and the URL bar match. Update
  the `<meta name="theme-color">` per theme via JS in `setTheme`.

### Token strategy
Today's `:root` color tokens (styles.css:10-39) remain the **Paper baseline**.
Add three override blocks: `[data-theme="sepia"]`, `[data-theme="dark"]`,
`[data-theme="hc"]`, each redefining the token values. Surfaces already using
`var(--…)` (reading column `.doc-scroll`, modals, fields) re-theme for free.

**Tokenize the hardcoded colors** the audit flagged (the cost center). Introduce
semantic tokens, defaulted in `:root` to today's exact values, then replace the
literals and override per theme:

| New token | Replaces (current literal) | Used by |
|---|---|---|
| `--app-bg` | `body` `--paper` + noise gradient | page background |
| `--masthead-grad` | `linear-gradient(var(--leather-2),var(--leather))` | `.masthead` |
| `--masthead-ink` | `#f3e6cd` / `#f7ecd5` | masthead text/brand |
| `--reader-bg` | `#2c2218` + `#3a2c1d`/`#241a11` radial | `#reader` |
| `--rbar-bg` | `rgba(50,30,18,.96)`→`rgba(40,24,14,.96)` | `.rbar` |
| `--rbar-ink` / `--rbar-muted` | `#ecdcbf` / `#cbb78f` / `#b9a886` | reader bar text/buttons |
| `--page-bg` | `.rpage` `#fff` | PDF/CBZ/scroll page surface |
| `--login-grad-top/bot` | `#f8f1e3` / `#f1e7d2` | `.login-card`, `.nbar` |
| `--code-bg` / `--code-ink` | `#2c2218` / `#ecdcbf` | markdown `pre` |

(Masthead may keep the leather identity in Paper/Sepia and darken for Dark/HC —
a per-theme value of `--masthead-grad`, not necessarily a neutral.)

### Per-surface behavior
- **Reading column** (txt/md): token-driven already → recolors via `--paper`/`--ink`.
- **Reader chrome** follows the theme (approved): Paper→light bar, Sepia→warm,
  Dark→current dark, HC→black. Driven by `--reader-bg`/`--rbar-*`.
- **PDF night mode:** under `dark`/`hc`, invert the **PDF page canvas** with
  `filter: invert(1) hue-rotate(180deg)`. Apply to the `<canvas>` only — the
  `.textLayer` and `.rclips` overlay are sibling elements over it and must NOT be
  inverted (verify they sit outside the filtered node; if the filter must go on
  the wrapper, counter-invert the overlays). **CBZ comics are excluded** (artwork
  renders true) — gate via a format marker (`data-fmt="pdf"`) on the page wrapper
  so only PDF inverts.
- **EPUB:** `EpubAdapter.applyTheme(resolved)` registers `body { background; color }`
  (and link color) into the iframe via epub.js `rendition.themes.override` /
  `register`, reusing the hook added for `applyType`. Called after display and on
  theme change.
- **Media (audio/video):** chrome themes; the `<video>` stays black — fine.

### Settings UI
A `<select id="theme-select">` in the Settings modal, directly above the existing
Language control (mirrors its open-populate + change-applies-live pattern in
`wireSettings()`). Options localized.

## Starting palettes (tunable at review/implementation)

Core token values per theme — a **starting point**, expected to be tuned by eye:

| token | Paper (base) | Sepia | Dark | High-contrast |
|---|---|---|---|---|
| `--app-bg` | `#efe6d2` | `#efe2c8` | `#1a1510` | `#000000` |
| `--card` | `#f6efe0` | `#f3e7cc` | `#241d15` | `#0c0c0c` |
| `--paper` (page) | `#efe6d2` | `#f2e8d0` | `#211b14` | `#000000` |
| `--ink` | `#2a2018` | `#3a2c18` | `#e8dcc4` | `#ffffff` |
| `--muted` | `#6f6147` | `#7a6a43` | `#b6a685` | `#d8d8d8` |
| `--rule` | `#c9b88f` | `#cdba8c` | `#4a3f2e` | `#ffffff` |
| `--reader-bg` | `#e7dabd` | `#e9dcc0` | `#161109` | `#000000` |
| `--rbar-bg` | `#efe2c4` | `#ece0c2` | `#241a11` | `#000000` |
| `--rbar-ink` | `#3a2410` | `#3a2410` | `#ecdcbf` | `#ffffff` |
| `--page-bg` | `#ffffff` | `#f6ecd6` | `#211b14` | `#0a0a0a` |
| `--code-bg` | `#2c2218` | `#2c2218` | `#0e0b07` | `#000000` |
| accent (`--brass`/`--leather`) | unchanged | unchanged | brighten ~10% for contrast | `#ffd24a` / borders `#fff` |

HC additionally: bump border widths/contrast on focus rings and `.rule` to ensure
≥7:1 text and visible edges.

## i18n

New keys in all three dicts (en/pt-BR/es), values-only (no `<>&"`):
`settings.theme`, `theme.system`, `theme.paper`, `theme.sepia`, `theme.dark`,
`theme.highContrast`.

## Files touched (approach; exact anchors confirmed in the plan)

- `project/styles.css` — `:root` token additions + 3 `[data-theme=…]` override
  blocks; replace ~25 hardcoded literals with `var(--…)`; PDF-canvas invert rule;
  per-theme `color-scheme`.
- `project/index.html` — anti-FOUC `<head>` script; theme `<select>` in
  `#settings`; per-format marker on the reader page wrapper if needed; drop the
  `only light` meta.
- `project/app.ts` — `LS.theme`; `themePref` state + resolver + `matchMedia`
  listener; `setTheme()`; boot apply; `EpubAdapter.applyTheme()`; theme `<select>`
  wiring in `wireSettings()`; set `data-fmt`/`<meta theme-color>`; i18n keys.

## Testing

No frontend unit harness. Gates: `npx tsc --noEmit`, `node scripts/i18n-check.mjs`,
`npm run build`; backend `npm test` stays green (untouched). **Manual matrix** —
each theme {Paper, Sepia, Dark, HC} × each surface {login, masthead, library
(shelf/grid/list), continue card, Settings, add-menu, txt, md, EPUB, PDF, CBZ,
notes editor, media}: verify legibility/contrast, no unreadable hardcoded patches,
focus rings visible. Plus: no light-flash on reload in Dark; **System** flips when
the OS theme toggles; choice persists across reload; PDF inverts in Dark/HC while
its text layer/clips stay correctly oriented; CBZ does **not** invert; EPUB iframe
recolors.

## Risks / non-goals

- **Risk:** broad CSS refactor across nearly every surface in one branch — the
  manual matrix is the safety net; missed hardcoded colors show as wrong-theme
  patches. Mitigate by grepping for hex literals in `styles.css` after tokenizing.
- **Non-goal:** per-book theme, scheduled/auto-dark-by-time, custom user palettes,
  theming the epub's own embedded styles beyond bg/text/link. Single global theme
  pref only.
- **No backend changes** — theme is a local view preference (per device), like
  language and reader-type.
