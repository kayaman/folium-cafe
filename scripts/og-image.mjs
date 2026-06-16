// Renders the 1200x630 Open Graph / Twitter card image from an inline SVG.
// Run locally with `npm run og-image` after changing the brand; CI never runs this.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'project', 'og-image.png');

// Brand palette: cream #efe6d2, leather #5e261d, brass #dcb064, ink #2a2018.
// Crest paths are reused verbatim from project/icons/crest.svg.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="bg" cx="38%" cy="34%" r="80%">
      <stop offset="0%" stop-color="#f4ecda"/>
      <stop offset="100%" stop-color="#efe6d2"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="28" y="28" width="1144" height="574" rx="18" fill="none" stroke="#5e261d" stroke-width="3"/>
  <rect x="44" y="44" width="1112" height="542" rx="12" fill="none" stroke="#5e261d" stroke-width="1" opacity="0.35"/>

  <!-- crest, centred at (260, 315), scaled from the 64-unit master -->
  <g transform="translate(260 315) scale(3.35) translate(-32 -32)">
    <circle cx="32" cy="32" r="31" fill="#efe6d2"/>
    <circle cx="32" cy="32" r="29.5" fill="none" stroke="#5e261d" stroke-width="2"/>
    <circle cx="32" cy="32" r="26" fill="none" stroke="#5e261d" stroke-width="1" opacity="0.4"/>
    <g fill="none" stroke="#5e261d" stroke-linecap="round" stroke-linejoin="round" transform="translate(32 32) scale(0.72) translate(-32 -32)">
      <path d="M45 13C52 24 46 42 26 49C17 39 24 21 45 13Z" stroke-width="2.5"/>
      <path d="M26 49C33 39 39 28 45 13" stroke-width="2.5"/>
      <path d="M26 49L21 55" stroke-width="2.5"/>
      <path d="M34 38C37 37 40 35 42 32" stroke-width="1.8"/>
      <path d="M32 31C35 30 38 28 40 25" stroke-width="1.8"/>
      <path d="M31 43C33 43 36 42 38 40" stroke-width="1.8"/>
    </g>
  </g>

  <!-- wordmark + tagline -->
  <g font-family="'Zilla Slab', Georgia, 'Times New Roman', serif">
    <text x="486" y="294" font-size="84" font-weight="700" letter-spacing="2.5" fill="#2a2018">FOLIUM CAFÉ</text>
    <rect x="488" y="326" width="180" height="6" rx="3" fill="#dcb064"/>
    <text x="488" y="388" font-size="38" font-style="italic" fill="#6f6147">so you remember the page you were on</text>
  </g>
</svg>`;

const png = await sharp(Buffer.from(SVG), { density: 300 })
  .resize(1200, 630)
  .png()
  .toBuffer();
await writeFile(out, png);

const meta = await sharp(png).metadata();
console.log(`og-image.png ${meta.width}x${meta.height} (${png.length} bytes)`);
