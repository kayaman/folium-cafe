# Folium — a private reading room

**folium.cafe** · A literary PDF library that remembers exactly where you stopped reading.

*Folium* is Latin for "leaf" — the root of *folio*, the numbered leaf of a
manuscript. This app is a quiet, warm-paper reading room for your personal
PDFs: shelve them, read them, and pick up on the exact page you left,
on a classic bookshelf interface.

## Features

- **Reading cards** — personal accounts (Cognito): pick a handle, verify your email, stay signed in for 90 days
- **Three library layouts**, switchable live: Shelf (covers on wooden planks), Covers (gallery grid), List (editorial rows with progress and last-read time)
- **Real PDF rendering** in the browser via pdf.js — fit-to-width with Comfort ↔ Full toggle and zoom
- **Page memory per book** — resumes exactly where you left off, synced across devices, with a "Continue reading" hero
- **Distraction-free mode** — press **F** for fullscreen reading; Esc to return
- **Drag-and-drop uploads** — books live in your private AWS backend (S3 + DynamoDB), behind a login
- Keyboard: ←/→ or Space to turn pages, type a page number to jump, Home/End

## Development

```sh
npm install
npm run build    # compile project/app.ts → project/app.js (esbuild)
npm run watch    # recompile on change
```

Serve the `project/` directory with any static file server and open `index.html`:

```sh
npx serve project
```

Requires a network connection to fetch pdf.js (CDN) on first load.

## Project layout

```
project/
├── index.html   # entry point
├── app.ts       # TypeScript source (app.js is built in CI)
├── styles.css   # literary theme: warm paper, slab serifs, leather & wood
├── samples/     # sample volumes
└── Folio.html   # original Claude Design prototype (pre-rename reference)
backend/         # Lambda API (login, books, progress)
infra/           # Terraform: Route53, ACM, CloudFront, S3, DynamoDB, Lambda
chats/           # design-session transcripts from Claude Design
```
