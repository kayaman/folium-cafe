# Folium Café ☕🍂

> *so you remember the page you were on*

A private, single-user PDF reading room at [folium.cafe](https://folium.cafe). Upload books, read them anywhere, and your shelf — including the exact page you were on — follows you across devices. Installable as an Android PWA with offline reading.

*Folium* is Latin for a leaf — of a tree, or of a book.

## Features

- **Cross-device library** — book metadata and reading progress live server-side behind one passphrase
- **PWA** — installs to the Android home screen (leaf crest, splash, edge-to-edge leather theming, "Continue reading" shortcut)
- **Offline reading** — opened books are cached on-device (LRU, 10 books); page turns made offline sync back when you reconnect
- **Share-sheet ingestion** — share a PDF from any Android app straight onto your shelf
- **PDF printing** — print the current page, one page, or an inclusive range in color or grayscale with fit/actual sizing
- **A quiet reader** — comfort/full width, zoom, zen mode, edge-aware wheel page turns

## Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla TypeScript + esbuild, hand-rolled service worker, PDF.js (self-hosted) |
| Backend | Node.js 20 Lambda (Function URL) behind CloudFront `/api/*` |
| State | DynamoDB (metadata + progress), S3 (PDF bytes via presigned URLs) |
| Infra | Terraform — CloudFront, S3 (OAC), ACM, Route 53, SSM, IAM/OIDC |
| CI/CD | GitHub Actions: PR → build/test/plan · main → apply/deploy/invalidate |

## Development

```sh
npm ci
npm ci --prefix backend
npm run check               # typecheck, i18n coverage, and all tests
npm run build               # bundle app.ts + sw.ts
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra validate
```

Use Node.js 20 or newer (the repository includes an `.nvmrc`). Run
`npm run icons` to re-render icon PNGs from the SVG crest masters.

There's no local dev server — the API only exists behind CloudFront. Push to a branch for CI; merge to `main` to deploy.

See `CLAUDE.md` for architecture details and `docs/superpowers/specs/` for the design documents.
