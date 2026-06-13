// Renders the committed PNG icon set from the SVG masters in project/icons/.
// Run locally with `npm run icons` after changing a master; CI never runs this.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const icons = (f) => path.join(root, 'project', 'icons', f);

const SHORTCUT_CONTINUE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#5e261d"/>
  <path d="M26 20l18 12-18 12V20z" fill="#dcb064"/>
</svg>`;

async function render(svgPath, outName, size) {
  const png = await sharp(await readFile(svgPath), { density: 300 })
    .resize(size, size)
    .png()
    .toBuffer();
  await writeFile(icons(outName), png);
  console.log(`${outName} ${size}x${size} (${png.length} bytes)`);
}

await render(icons('crest.svg'), 'icon-192.png', 192);
await render(icons('crest.svg'), 'icon-512.png', 512);
await render(icons('crest-maskable.svg'), 'icon-maskable-192.png', 192);
await render(icons('crest-maskable.svg'), 'icon-maskable-512.png', 512);
await render(icons('crest-maskable.svg'), 'apple-touch-icon.png', 180);
await render(icons('crest.svg'), 'favicon-32.png', 32);

const shortcut = await sharp(Buffer.from(SHORTCUT_CONTINUE), { density: 300 })
  .resize(96, 96).png().toBuffer();
await writeFile(icons('shortcut-continue.png'), shortcut);
console.log(`shortcut-continue.png 96x96 (${shortcut.length} bytes)`);

// favicon.svg at the site root is the crest master verbatim
await copyFile(icons('crest.svg'), path.join(root, 'project', 'favicon.svg'));
await copyFile(icons('favicon-32.png'), path.join(root, 'project', 'favicon-32.png'));
console.log('favicon.svg + favicon-32.png copied to project/');
