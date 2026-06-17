import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMATS, mediaKey, chooseContentType } from '../src/repo.mjs';
import { parseProgressBody } from '../src/handler.mjs';

const UID = 'user-abc';

// ---------- mediaKey ----------

test('mediaKey pdf is namespaced under the user prefix', () => {
  assert.equal(mediaKey(UID, 'b3k2', 'pdf'), 'u/user-abc/pdfs/b3k2.pdf');
});

test('mediaKey routes each format to its prefix under the user namespace', () => {
  assert.equal(mediaKey(UID, 'x', 'note'), 'u/user-abc/notes/x.md');
  assert.equal(mediaKey(UID, 'x', 'cbz'), 'u/user-abc/media/x.cbz');
  assert.equal(mediaKey(UID, 'x', 'epub'), 'u/user-abc/media/x.epub');
  assert.equal(mediaKey(UID, 'x', 'txt'), 'u/user-abc/media/x.txt');
  assert.equal(mediaKey(UID, 'x', 'md'), 'u/user-abc/media/x.md');
  assert.equal(mediaKey(UID, 'x', 'audio'), 'u/user-abc/media/x.audio');
  assert.equal(mediaKey(UID, 'x', 'video'), 'u/user-abc/media/x.video');
});

// ---------- chooseContentType ----------

test('chooseContentType pdf is fixed', () => {
  assert.equal(chooseContentType('pdf'), 'application/pdf');
});

test('chooseContentType md (our markdown enum) is markdown', () => {
  assert.equal(chooseContentType('md'), 'text/markdown; charset=utf-8');
});

test('chooseContentType cbz/epub/txt/note are fixed', () => {
  assert.equal(chooseContentType('cbz'), 'application/vnd.comicbook+zip');
  assert.equal(chooseContentType('epub'), 'application/epub+zip');
  assert.equal(chooseContentType('txt'), 'text/plain; charset=utf-8');
  assert.equal(chooseContentType('note'), 'text/markdown; charset=utf-8');
});

test('chooseContentType audio passes through an allowed type', () => {
  assert.equal(chooseContentType('audio', 'audio/mpeg'), 'audio/mpeg');
});

test('chooseContentType audio falls back for a disallowed type', () => {
  assert.equal(chooseContentType('audio', 'application/zip'), 'application/octet-stream');
});

test('chooseContentType video passes through an allowed type', () => {
  assert.equal(chooseContentType('video', 'video/mp4'), 'video/mp4');
});

test('chooseContentType video falls back for a disallowed type', () => {
  assert.equal(chooseContentType('video', 'audio/mpeg'), 'application/octet-stream');
});

test('chooseContentType unknown format returns null', () => {
  assert.equal(chooseContentType('markdown'), null); // not in our enum
  assert.equal(chooseContentType('zip'), null);
});

// ---------- FORMATS ----------

test('FORMATS membership', () => {
  for (const f of ['pdf', 'cbz', 'epub', 'txt', 'md', 'audio', 'video', 'note']) {
    assert.equal(FORMATS.has(f), true, `expected ${f} in FORMATS`);
  }
  assert.equal(FORMATS.has('markdown'), false);
  assert.equal(FORMATS.has('docx'), false);
});

// ---------- parseProgressBody ----------

test('parseProgressBody accepts legacy currentPage', () => {
  assert.deepEqual(parseProgressBody({ currentPage: 42 }), { currentPage: 42 });
});

test('parseProgressBody still accepts a small currentPage', () => {
  assert.deepEqual(parseProgressBody({ currentPage: 7 }), { currentPage: 7 });
});

test('parseProgressBody accepts a valid generic progress', () => {
  assert.deepEqual(
    parseProgressBody({ progress: { kind: 'cfi', value: 'epubcfi(x)' } }),
    { progress: { kind: 'cfi', value: 'epubcfi(x)' } }
  );
});

test('parseProgressBody rejects an unknown kind', () => {
  assert.equal(parseProgressBody({ progress: { kind: 'bogus', value: 1 } }), null);
});

test('parseProgressBody rejects a progress with no value', () => {
  assert.equal(parseProgressBody({ progress: { kind: 'cfi' } }), null);
});

test('parseProgressBody rejects an empty body', () => {
  assert.equal(parseProgressBody({}), null);
});
