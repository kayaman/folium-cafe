import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, MAX_BOOKS, MAX_PDF_BYTES } from '../src/repo.mjs';

// Fake DocumentClient: routes by command name, records inputs.
function fakeDdb(handlers) {
  const sent = [];
  return {
    sent,
    send: async (cmd) => {
      sent.push(cmd);
      const h = handlers[cmd.constructor.name];
      return h ? h(cmd.input) : {};
    },
  };
}

const noS3 = { send: async () => ({}) };

test('listBooks queries USER#<sub> and hides the _meta item', async () => {
  const ddb = fakeDdb({
    QueryCommand: () => ({ Items: [
      { pk: 'USER#abc', id: '_meta', tokensValidAfter: 1 },
      { pk: 'USER#abc', id: 'b1', title: 'Aeneid' },
    ] }),
  });
  const repo = makeRepo({ ddb, s3: noS3, table: 't', bucket: 'b' });
  const books = await repo.listBooks('abc');
  assert.deepEqual(books, [{ id: 'b1', title: 'Aeneid' }]);
  assert.equal(ddb.sent[0].input.ExpressionAttributeValues[':pk'], 'USER#abc');
});

test('putBook enforces the shelf quota for new books only', async () => {
  let getResult = {};
  const ddb = fakeDdb({
    GetCommand: () => getResult,
    QueryCommand: () => ({ Count: MAX_BOOKS }),
    PutCommand: () => ({}),
  });
  const repo = makeRepo({ ddb, s3: noS3, table: 't', bucket: 'b' });
  const blocked = await repo.putBook('abc', { id: 'new' });
  assert.equal(blocked.ok, false);
  getResult = { Item: { pk: 'USER#abc', id: 'new' } }; // existing book: update allowed
  const updated = await repo.putBook('abc', { id: 'new' });
  assert.equal(updated.ok, true);
});

test('putBook writes under USER#<sub>', async () => {
  const ddb = fakeDdb({
    GetCommand: () => ({}),
    QueryCommand: () => ({ Count: 0 }),
    PutCommand: () => ({}),
  });
  const repo = makeRepo({ ddb, s3: noS3, table: 't', bucket: 'b' });
  await repo.putBook('abc', { id: 'b1', title: 'T' });
  const put = ddb.sent.at(-1);
  assert.equal(put.input.Item.pk, 'USER#abc');
  assert.equal(put.input.Item.id, 'b1');
});

test('presignUpload uses presigned POST with size and type conditions', async () => {
  let captured;
  const presignPost = async (_s3, params) => { captured = params; return { url: 'https://x', fields: { k: 'v' } }; };
  const repo = makeRepo({ ddb: fakeDdb({}), s3: noS3, table: 't', bucket: 'b', presignPost });
  const out = await repo.presignUpload('abc', 'b1');
  assert.equal(captured.Key, 'users/abc/pdfs/b1.pdf');
  assert.deepEqual(captured.Conditions[0], ['content-length-range', 1, MAX_PDF_BYTES]);
  assert.equal(captured.Fields['Content-Type'], 'application/pdf');
  assert.deepEqual(out, { url: 'https://x', fields: { k: 'v' } });
});

test('presignDownload signs the caller-scoped key only', async () => {
  let key;
  const presignGet = async (_s3, cmd) => { key = cmd.input.Key; return 'https://signed'; };
  const repo = makeRepo({ ddb: fakeDdb({}), s3: noS3, table: 't', bucket: 'b', presignGet });
  assert.equal(await repo.presignDownload('abc', 'b1'), 'https://signed');
  assert.equal(key, 'users/abc/pdfs/b1.pdf');
});

test('deleteBook removes the row and the scoped object', async () => {
  const deleted = [];
  const s3 = { send: async (cmd) => { deleted.push(cmd.input.Key); return {}; } };
  const ddb = fakeDdb({ DeleteCommand: () => ({}) });
  const repo = makeRepo({ ddb, s3, table: 't', bucket: 'b' });
  await repo.deleteBook('abc', 'b1');
  assert.deepEqual(deleted, ['users/abc/pdfs/b1.pdf']);
});

test('getMeta and bumpTokensValidAfter round-trip the _meta item', async () => {
  let stored;
  const ddb = fakeDdb({
    PutCommand: (input) => { stored = input.Item; return {}; },
    GetCommand: () => ({ Item: stored }),
  });
  const repo = makeRepo({ ddb, s3: noS3, table: 't', bucket: 'b' });
  await repo.bumpTokensValidAfter('abc', 1234);
  const meta = await repo.getMeta('abc');
  assert.equal(meta.tokensValidAfter, 1234);
  assert.equal(stored.pk, 'USER#abc');
  assert.equal(stored.id, '_meta');
});
