import { test } from 'node:test';
import assert from 'node:assert/strict';

// extractMetadata builds a ConverseCommand referencing process.env.BEDROCK_MODEL_ID,
// so set it before importing/using. The fake client never touches AWS.
process.env.BEDROCK_MODEL_ID = 'test-model';

import { normalize, extractMetadata } from '../src/bedrock.mjs';

// ---------- normalize (pure) ----------

test('normalize keeps an integer year', () => {
  assert.equal(normalize({ year: 2019 }).year, 2019);
});

test('normalize coerces a 4-digit string year to an integer', () => {
  assert.equal(normalize({ year: '2019' }).year, 2019);
});

test('normalize drops a non-numeric year', () => {
  assert.equal(normalize({ year: 'abc' }).year, undefined);
});

test('normalize trims empty/whitespace strings to undefined', () => {
  const r = normalize({ title: '   ', publisher: '', subtitle: ' Hi ' });
  assert.equal(r.title, undefined);
  assert.equal(r.publisher, undefined);
  assert.equal(r.subtitle, 'Hi');
});

test('normalize filters blank authors and drops an all-blank list', () => {
  assert.deepEqual(normalize({ authors: ['A B', '', '  ', 'C D'] }).authors, ['A B', 'C D']);
  assert.equal(normalize({ authors: ['', '   '] }).authors, undefined);
  assert.equal(normalize({ authors: [] }).authors, undefined);
});

test('normalize strips ISBN separators to digits/X', () => {
  assert.equal(normalize({ isbn: '978-0-13-468599-1' }).isbn, '9780134685991');
  assert.equal(normalize({ isbn: '0-13-468599-X' }).isbn, '013468599X');
  assert.equal(normalize({ isbn: '   ' }).isbn, undefined);
});

test('normalize returns undefined for every missing field', () => {
  const r = normalize({});
  for (const k of ['title', 'subtitle', 'authors', 'edition', 'publisher', 'year', 'isbn', 'language', 'series', 'description']) {
    assert.equal(r[k], undefined, `${k} should be undefined`);
  }
});

test('normalize tolerates a null/garbage raw', () => {
  assert.deepEqual(normalize(null), normalize({}));
  assert.deepEqual(normalize('nope'), normalize({}));
});

// ---------- extractMetadata (fake client) ----------

test('extractMetadata returns normalized fields from a toolUse block', async () => {
  const fake = {
    send: async () => ({
      output: { message: { content: [
        { toolUse: { input: { title: 'X', authors: ['A B'], year: 2019 } } },
      ] } },
    }),
  };
  const out = await extractMetadata({ pagesText: 'cover text' }, fake);
  assert.equal(out.title, 'X');
  assert.deepEqual(out.authors, ['A B']);
  assert.equal(out.year, 2019);
  assert.equal(out.publisher, undefined);
});

test('extractMetadata falls back to parsing JSON from a text block', async () => {
  const fake = {
    send: async () => ({
      output: { message: { content: [
        { text: 'Sure, here is the data: {"title":"Y","year":"2020"} done.' },
      ] } },
    }),
  };
  const out = await extractMetadata({ pagesText: 'cover text' }, fake);
  assert.equal(out.title, 'Y');
  assert.equal(out.year, 2020);
});

test('extractMetadata passes the env model id into the command', async () => {
  let seen;
  const fake = {
    send: async (cmd) => {
      seen = cmd.input;
      return { output: { message: { content: [{ toolUse: { input: { title: 'Z' } } }] } } };
    },
  };
  await extractMetadata({ coverImageB64: Buffer.from('hi').toString('base64'), coverMime: 'image/png' }, fake);
  assert.equal(seen.modelId, 'test-model');
  assert.equal(seen.toolConfig.toolChoice.tool.name, 'record_book_metadata');
  // cover image becomes a png image block plus the label + trailing instruction
  const types = seen.messages[0].content.map((c) => (c.image ? 'image' : 'text'));
  assert.ok(types.includes('image'));
  assert.equal(seen.messages[0].content.find((c) => c.image).image.format, 'png');
});
