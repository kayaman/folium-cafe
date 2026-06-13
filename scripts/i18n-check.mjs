// i18n guardrail: every key referenced via t()/tn() or data-i18n* must exist
// in the EN dict, and no dictionary value may contain HTML-significant chars
// (translations land in textContent/confirm/toast or pre-escaped templates).
// Key parity across EN/PT/ES is enforced separately by `tsc --noEmit`.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appTs = await readFile(path.join(root, 'project', 'app.ts'), 'utf8');
const indexHtml = await readFile(path.join(root, 'project', 'index.html'), 'utf8');

const enBlock = appTs.slice(appTs.indexOf('const EN = {'), appTs.indexOf('} as const;'));
const enKeys = new Set([...enBlock.matchAll(/'([^']+)':/g)].map(m => m[1]));
if (enKeys.size === 0) { console.error('i18n-check: could not locate the EN dict'); process.exit(1); }

const dictsBlock = appTs.slice(appTs.indexOf('const EN = {'), appTs.indexOf('const DICTS'));
const errors = [];

for (const m of dictsBlock.matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) {
  if (/[<>&"]/.test(m[1])) errors.push(`markup char in dict value: ${m[1].slice(0, 60)}…`);
}

const used = new Set();
for (const m of appTs.matchAll(/\bt\('([^']+)'/g)) used.add(m[1]);
for (const m of appTs.matchAll(/\btn\('([^']+)'/g)) { used.add(m[1] + '.one'); used.add(m[1] + '.other'); }
for (const m of indexHtml.matchAll(/data-i18n(?:-title|-placeholder|-aria)?="([^"]+)"/g)) used.add(m[1]);

for (const k of used) if (!enKeys.has(k)) errors.push(`referenced key missing from EN dict: ${k}`);

const unused = [...enKeys].filter(k => !used.has(k));
if (unused.length) console.warn(`i18n-check: ${unused.length} unused key(s): ${unused.join(', ')}`);

if (errors.length) {
  for (const e of errors) console.error('i18n-check ERROR: ' + e);
  process.exit(1);
}
console.log(`i18n-check OK: ${enKeys.size} keys, ${used.size} referenced, ${unused.length} unused`);
