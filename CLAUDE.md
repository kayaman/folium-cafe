# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Folium Café** — a single-user PDF reader PWA hosted at `https://folium.cafe` (tagline: "so you remember the page you were on"). Vanilla TypeScript frontend (no framework), Node.js 20 Lambda backend, all infra in Terraform, deployed via GitHub Actions on push to `main`.

The authoritative architecture document is `docs/superpowers/specs/2026-06-10-read-magj-dev-aws-hosting-design.md` (written under the app's previous name "Folio" / domain read.magj.dev — architecture still accurate, names are not). The implementation plan lives in `docs/superpowers/plans/`.

## Commands

```sh
# Frontend (repo root) — esbuild bundles app.ts → app.js and sw.ts → sw.js
npm run build          # BUILD_ID env versions the SW cache (CI passes the git SHA)
npm run watch          # rebuild app.ts on change (alias: npm run dev)
npm run icons          # re-render committed icon PNGs from project/icons/crest*.svg (sharp)

# i18n guards — run after touching UI strings (CI runs both)
npx tsc --noEmit               # EN/PT/ES dict key parity (typed off EN)
node scripts/i18n-check.mjs    # every t()/tn()/data-i18n* key exists; no markup in values

# Backend tests (from backend/) — node:test, no framework
cd backend && npm test
node --test test/auth.test.mjs                      # single file
node --test --test-name-pattern 'tampered' test/    # single test by name

# Terraform (from infra/) — CI runs fmt -check, validate, plan
terraform fmt -check -recursive
terraform validate
terraform plan
```

There is no local dev server: the frontend calls `/api/*` same-origin, which only exists behind CloudFront. Deployment happens exclusively via `.github/workflows/deploy.yml` (push to `main`): terraform apply → upload static artifacts to S3 → update Lambda zip → CloudFront invalidation. CI (`ci.yml`) runs on PRs. Deployed artifacts: `index.html`, `app.js` (built, gitignored), `sw.js` (built, gitignored), `styles.css`, `manifest.webmanifest`, `favicon.svg`, `favicon-32.png`, `icons/*`, `vendor/*` — adding a static file means touching BOTH the upload step and the invalidation list in deploy.yml, plus the `SHELL` precache list in `project/sw.ts`.

## Architecture

One CloudFront distribution serves everything same-origin (no CORS, one auth cookie):

- **`/*`** → private S3 site bucket (OAC).
- **`/api/*`** → Lambda Function URL, Node 20 ESM (`backend/src/handler.mjs` is the router).
- Lambda stores book metadata + reading progress in DynamoDB (single constant partition key — single user) and hands the browser **presigned S3 URLs**; PDF bytes go browser↔S3 directly, never through Lambda.

### Auth — three layers, and why the Function URL is public

The Function URL is `AuthType=NONE` **on purpose**: CloudFront OAC does not sign request bodies, so an IAM-auth Function URL rejects every browser POST/PUT (see the 2026-06-11 amendment in the spec). Instead:

1. CloudFront injects a secret `x-origin-secret` header on every origin request; the handler rejects requests without it (`handler.mjs` top), so the public URL is unusable directly.
2. Every route except `POST /api/login` requires an HMAC-signed httpOnly `folium_session` cookie (`backend/src/auth.mjs`).
3. Login checks one password.

Password and HMAC key are SSM SecureStrings (`/folium-cafe/app_password`, `/folium-cafe/hmac_key`), set **out-of-band** (`aws ssm put-parameter --overwrite`). Terraform creates them with placeholder values and `ignore_changes` — never put the real values in Terraform or commits.

### Frontend (`project/app.ts`, single file)

Organized by `// ---------- section ----------` comments. UI strings are localized (en/pt-BR/es) via the `// ---------- i18n ----------` section: `t()`/`tn()` for TS strings, `data-i18n*` attributes for static index.html markup, locale resolved from `localStorage['folium.lang']` override → `navigator.languages` → en, overridable in the Settings modal; the FOLIUM CAFÉ wordmark, `<title>`, meta description, and manifest are deliberately never translated. The data-layer functions keep their pre-migration IndexedDB names (`dbAll`/`dbPut`/`dbGet`/`dbDel`) but are fetch calls to `/api/*` — don't be misled by the names. Upload flow: parse PDF locally with PDF.js (self-hosted in `project/vendor/`, pinned 3.11.174; unpkg only for lazy fonts/cmaps) → `POST /api/books` returns a presigned PUT → browser uploads bytes to S3. `api()` throws typed errors: `ApiAuthError` (401 → login screen) vs `ApiNetworkError` (→ offline mode). View preferences stay in `localStorage` (`folium.*` keys; a one-time `folio.*` migration runs at startup — removable after a few releases).

### PWA / offline (`project/sw.ts` + app-layer caches)

Hand-rolled service worker, no Workbox. Cache inventory — the SW's activate handler deletes only stale `folium-(shell|cdn)-*` caches and must NEVER touch the app-owned ones:

| Cache | Owner | Contents |
|---|---|---|
| `folium-shell-<BUILD_ID>` | SW precache | app shell incl. vendor PDF.js |
| `folium-cdn-v1` | SW runtime | unpkg standard_fonts/cmaps |
| `folium-vendor-v1` | SW runtime | lazily-loaded `/vendor/*` libs not in SHELL (e.g. fflate for CBZ) |
| `folium-pdf` | app.ts | PDF/CBZ/txt/md bytes under synthetic `/pdf-store/{id}` keys (LRU-10, presigned URLs can't be cache keys — they expire) |
| `folium-data` | app.ts | `GET /api/books` snapshot for offline boot |
| `folium-shared` | SW | Android share-sheet PDFs awaiting post-login ingest |

The SW never intercepts `/api/*` (the app must distinguish 401 from offline) nor presigned S3 URLs. Offline progress updates queue in `localStorage['folium.progressQueue']` and replay on reconnect/boot. Logout wipes pdf/data/shared caches + queue keys. Update flow is `skipWaiting`+`clients.claim` with an informational toast — no forced reload. `sw.js` ships with `Cache-Control: no-cache` (critical: a cached SW delays every subsequent deploy by up to 24h).

`project/Folio.html` is the original design prototype from a claude.ai/design handoff bundle (`chats/` holds the transcript) under the app's old name; `project/index.html` is the live page. Edit `index.html`, not `Folio.html`.

### Terraform (`infra/`)

Split by concern, one stack — except `infra/bootstrap/`, a separate stack with **local state** that owns the S3 state bucket + lock table (run once, don't touch; deliberately keeps the legacy `folio-tfstate-*`/`folio-tflock` names — renaming state plumbing buys nothing). Main stack uses the S3 remote backend. Region is `us-east-1` everywhere (ACM for CloudFront requires it). CI authenticates via GitHub OIDC role (`cicd.tf`); no AWS keys in the repo. Resource names derive from `var.name_prefix` (`folium-cafe`) — changing it replaces buckets/table/Lambda and requires the data-migration runbook in `docs/superpowers/specs/`.
