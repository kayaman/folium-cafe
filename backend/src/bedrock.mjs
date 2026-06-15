import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

// Module-level client; region is inherited from the Lambda env (us-east-1).
// Injectable into extractMetadata so tests can pass a fake { send }.
const defaultClient = new BedrockRuntimeClient({});

const TOOL_NAME = 'record_book_metadata';

const SYSTEM_PROMPT =
  'You extract bibliographic metadata from a book\'s cover image and its ' +
  'copyright/title pages (or early page text). Only fill a field when the ' +
  'evidence is clear; leave anything uncertain blank. Prefer the ISBN-13 when ' +
  'multiple ISBNs are present. Return year as an integer. Return authors as an ' +
  'array of individual person names. Never invent or guess data. Always call ' +
  'the record_book_metadata tool with what you can confirm.';

const TOOL_CONFIG = {
  tools: [
    {
      toolSpec: {
        name: TOOL_NAME,
        description: 'Record the extracted bibliographic metadata.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              subtitle: { type: 'string' },
              authors: { type: 'array', items: { type: 'string' } },
              edition: { type: 'string' },
              publisher: { type: 'string' },
              year: { type: 'integer' },
              isbn: { type: 'string' },
              language: { type: 'string' },
              series: { type: 'string' },
              description: { type: 'string' },
            },
            required: [],
          },
        },
      },
    },
  ],
  toolChoice: { tool: { name: TOOL_NAME } },
};

// Trim a string; undefined when empty/blank or not a string.
function str(v) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

// PURE, exported for testing. Coerce a raw (model-supplied) record into the
// canonical metadata shape. Every field is normalized to either a clean value
// or undefined.
export function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};

  let year;
  if (typeof r.year === 'number' && Number.isFinite(r.year)) {
    year = Math.trunc(r.year);
  } else if (typeof r.year === 'string') {
    const m = r.year.trim().match(/^(\d{4})$/);
    if (m) year = parseInt(m[1], 10);
  }

  let authors;
  if (Array.isArray(r.authors)) {
    const cleaned = r.authors
      .map((a) => str(a))
      .filter((a) => a !== undefined);
    if (cleaned.length) authors = cleaned;
  }

  let isbn;
  if (typeof r.isbn === 'string') {
    const digits = r.isbn.replace(/[^0-9Xx]/g, '').toUpperCase();
    if (digits.length) isbn = digits;
  }

  return {
    title: str(r.title),
    subtitle: str(r.subtitle),
    authors,
    edition: str(r.edition),
    publisher: str(r.publisher),
    year,
    isbn,
    language: str(r.language),
    series: str(r.series),
    description: str(r.description),
  };
}

// async; `client` is injectable (default = module-level BedrockRuntimeClient)
// so tests can pass a fake { send }. Builds a Converse request that forces the
// record_book_metadata tool and returns a normalized metadata record.
export async function extractMetadata(
  {
    coverImageB64,
    coverMime,
    pageImagesB64 = [],
    pagesText = '',
    formatHint = 'pdf',
  },
  client = defaultClient,
) {
  const content = [];

  if (coverImageB64) {
    const format = typeof coverMime === 'string' && coverMime.includes('png') ? 'png' : 'jpeg';
    content.push({ text: 'COVER IMAGE:' });
    content.push({
      image: { format, source: { bytes: Buffer.from(coverImageB64, 'base64') } },
    });
  }

  for (const b64 of (Array.isArray(pageImagesB64) ? pageImagesB64 : []).slice(0, 3)) {
    if (!b64) continue;
    content.push({
      image: { format: 'jpeg', source: { bytes: Buffer.from(b64, 'base64') } },
    });
  }

  if (pagesText) {
    content.push({ text: 'EARLY PAGE TEXT:\n' + String(pagesText).slice(0, 12000) });
  }

  content.push({
    text: 'Format hint: ' + formatHint + '. Call record_book_metadata with what you can confirm.',
  });

  const command = new ConverseCommand({
    modelId: process.env.BEDROCK_MODEL_ID,
    system: [{ text: SYSTEM_PROMPT }],
    messages: [{ role: 'user', content }],
    toolConfig: TOOL_CONFIG,
    inferenceConfig: { maxTokens: 1024, temperature: 0 },
  });

  const out = await client.send(command);

  const blocks = out?.output?.message?.content ?? [];
  const use = blocks.find((b) => b.toolUse)?.toolUse;
  let raw = use?.input;

  if (!raw) {
    // Defensive fallback: the model returned text instead of a tool call.
    const textBlock = blocks.find((b) => typeof b.text === 'string')?.text;
    if (textBlock) {
      const match = textBlock.match(/\{[\s\S]*\}/);
      if (match) {
        try { raw = JSON.parse(match[0]); } catch { raw = {}; }
      }
    }
  }

  return normalize(raw);
}
