# Design: `read.magj.dev` — single-user stateful PDF reader on AWS

**Date:** 2026-06-10
**Status:** Approved (design); implementation pending
**Repo:** `kayaman/reader` · **AWS account:** `257394450889` · **Region:** `us-east-1`

## Goal

Host the Folio PDF reader at `https://read.magj.dev` on cheap AWS resources, with
**server-side state for a single user** so the library (PDFs) and per-book reading
position follow the user across devices and browsers. Provision everything with
Terraform and deploy via GitHub Actions.

## Background / current state

The app (`project/app.ts`, ~694 lines) is today a **pure client-side static site**:

- PDF blobs + per-book metadata (`numPages`, `currentPage`, `cover`) are stored in
  **IndexedDB** (`DB_NAME = 'folio'`, object store `books`). See `dbPut`/`dbAll`/
  `dbGet`/`dbDel`.
- View preferences live in `localStorage` (`LS` object).
- Reading position is persisted by `persistPage()` (debounced `dbPut`, line ~477).
- PDF.js is loaded from a CDN; a worker blob is spun up same-origin.

Consequence: state is **per-browser-profile**. Clearing site data or switching
device/browser loses everything. The user wants that state on the server instead.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Statefulness | Cross-device, **single user** (no multi-user accounts) |
| Domain | `read.magj.dev`, existing Route 53 hosted zone |
| Auth | One password → HMAC-signed httpOnly cookie |
| Region | `us-east-1` (cert must be here for CloudFront anyway) |
| Terraform state | Remote: S3 bucket + DynamoDB lock table |
| CI auth | GitHub OIDC role (no long-lived AWS keys in repo) |
| PDF delivery | Presigned S3 URLs (browser ↔ S3 direct), not a CDN-cached PDF behavior |

## Architecture

One CloudFront distribution fronts both the static site and the API, so the
browser stays same-origin (no CORS) and the auth cookie applies to both.

```
                         read.magj.dev
                              │
                     ┌────────▼─────────┐
                     │    CloudFront    │  ACM cert (us-east-1), Route53 alias A/AAAA
                     └───┬──────────┬───┘
          default /*     │          │   /api/*
                 ┌───────▼──┐   ┌───▼──────────────┐
                 │ S3 site  │   │ Lambda Func URL  │  AWS_IAM auth + CloudFront OAC
                 │ (static) │   │  Node.js 20      │  (not publicly reachable)
                 └──────────┘   └───┬──────────┬───┘
                                    │          │
                            ┌───────▼──┐   ┌───▼────────┐
                            │ DynamoDB │   │ S3 (pdfs)  │  presigned PUT/GET
                            │ metadata │   │  blobs     │  browser ↔ S3 direct
                            │ +progress│   └────────────┘
                            └──────────┘
```

### Components

1. **Frontend hosting** — private S3 bucket with the built assets
   (`index.html`, `app.js`, `styles.css`). Served via CloudFront with Origin
   Access Control (OAC); the bucket has no public access. PDF.js remains on its CDN.

2. **Backend** — a single Node.js 20 Lambda behind a **Lambda Function URL**.
   The Function URL auth type is `AWS_IAM`; CloudFront reaches it via OAC request
   signing, so the URL is not directly callable from the public internet. Exposed
   to the browser only through the CloudFront `/api/*` cache behavior.

3. **State store** — DynamoDB table (on-demand billing). Holds one item per book:
   `id`, `title`, `numPages`, `currentPage`, and a small JPEG cover thumbnail
   (data URL, kept well under the 400 KB item limit). A constant partition key
   (single user) keyed by book id.

4. **PDF blob store** — private S3 bucket, one object per book id. The browser
   **uploads and downloads directly to/from S3 via presigned URLs**; Lambda only
   ever moves small JSON, avoiding API/Lambda payload limits and keeping cost ~0.

5. **Auth** — one password stored as an SSM Parameter Store **SecureString**
   (never committed). `POST /api/login` verifies it and sets an HMAC-signed,
   httpOnly, Secure, SameSite cookie (`folio_session`) with an expiry. All other
   routes validate the cookie before acting. The HMAC signing key is a second SSM
   SecureString.

### API routes (all under `/api/`, JSON)

| Method & path | Purpose |
|---|---|
| `POST /api/login` | Verify password, set session cookie |
| `GET /api/books` | List book metadata (no blobs) |
| `POST /api/books` | Create metadata, return presigned **PUT** URL for the PDF |
| `GET /api/books/{id}/url` | Return presigned **GET** URL for the PDF |
| `PUT /api/books/{id}/progress` | Update `currentPage` (debounced from client) |
| `DELETE /api/books/{id}` | Delete metadata + S3 object |

## App code changes (`project/app.ts`)

- Replace the IndexedDB data layer (`dbPut`/`dbAll`/`dbGet`/`dbDel`, `openDB`,
  `tx`) with an API client module that calls the routes above.
- Remove the `localStorage` sample-seeding logic (`LS.seeded`, `seed()`); seeding,
  if kept, moves to a one-time server-side step or is dropped.
- Add a minimal **login gate**: if `GET /api/books` returns 401, show a password
  screen that posts to `/api/login`, then retry.
- **Upload flow**: parse PDF locally for `numPages`/cover (as today) → `POST
  /api/books` to get a presigned PUT → upload the file bytes to S3 → render shelf.
- **Open flow**: `GET /api/books/{id}/url` → hand the presigned URL to PDF.js
  (`getDocument`).
- **Progress**: `persistPage()` becomes a debounced `PUT /api/books/{id}/progress`.
- View preferences (`LS.view`, `LS.width`) may stay in `localStorage` (pure UI
  state, not worth a round-trip).

## Terraform layout

```
infra/
  bootstrap/            # run once, LOCAL state
    main.tf             # S3 state bucket + DynamoDB lock table
  backend.tf            # remote S3 backend config for the main stack
  providers.tf          # default us-east-1 + aliased us-east-1 for ACM (explicit)
  variables.tf
  dns_cert.tf           # ACM cert (DNS-validated) + Route53 validation + alias records
  frontend.tf           # site S3 bucket + bucket policy (OAC)
  cloudfront.tf         # distribution: default->S3, /api/*->Lambda FURL, both OAC
  lambda.tf             # Lambda, Function URL, IAM role/policy, log group
  data_stores.tf        # DynamoDB app table + S3 pdf bucket
  ssm.tf                # SecureString params (password, hmac key) — values out-of-band
  cicd.tf               # GitHub OIDC provider + CI role + scoped policy
  outputs.tf
```

- **Bootstrap** is a separate, tiny stack with local state because the remote
  backend can't store the bucket that holds it. Run once manually.
- Secret values (the app password, the HMAC key) are **not** in Terraform code or
  variables files. Terraform creates each `aws_ssm_parameter` (SecureString) with a
  throwaway placeholder value and `lifecycle { ignore_changes = [value] }`; the real
  values are written once out-of-band (`aws ssm put-parameter --overwrite`) and read
  by Lambda at runtime. This keeps secrets out of state diffs and the repo.

## CI/CD (`.github/workflows/`)

- **`ci.yml` on pull request**: `npm ci` → `npm run build` → `terraform fmt
  -check` → `terraform init` → `validate` → `plan` (read-only; uses OIDC role with
  plan permissions).
- **`deploy.yml` on push to `main`**: assume AWS role via **OIDC** →
  `terraform apply` → `aws s3 sync` built static assets to the site bucket → zip &
  `update-function-code` for the Lambda → `cloudfront create-invalidation`.
- GitHub repo variable: the CI role ARN. No AWS secret keys stored.

## Error handling

- Lambda returns proper status codes: `401` (bad/missing cookie), `404` (unknown
  book), `400` (bad input), `500` (unexpected). Client shows a toast (existing
  `toast()` helper) and, on 401, falls back to the login gate.
- Presigned URLs are short-lived (e.g. 5–15 min); the client requests a fresh one
  per open/upload rather than caching them.
- S3 delete and DynamoDB delete are best-effort paired; an orphaned S3 object is
  harmless and can be lifecycle-expired.

## Testing

- **Lambda**: unit tests for the cookie HMAC sign/verify and the router (mocked
  AWS SDK). A smoke test hitting each route locally with a fake event.
- **Terraform**: `fmt`, `validate`, and `plan` in CI; manual first `apply`.
- **End-to-end (manual)**: upload a PDF, reload in a different browser, confirm the
  library and last page survive; confirm unauthenticated access is blocked.

## Cost estimate

~**$0.50–1.50/month** at single-user scale: dominated by the Route 53 hosted-zone
share ($0.50) plus cents of S3 storage, CloudFront requests, DynamoDB on-demand,
and Lambda invocations — all effectively within free-tier/near-zero usage.

## Out of scope (YAGNI)

- Multi-user accounts, sharing, public links.
- A CDN cache behavior in front of the PDF bucket (can add later if re-read
  latency ever matters).
- Full-text search, annotations, sync of UI preferences across devices.
- Switching the operator's laptop off root credentials (recommended separately,
  not required for this work).
