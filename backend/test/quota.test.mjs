import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ddb, s3, USER_QUOTA_BYTES, sumSizes, exceedsQuota,
  usageBytes, setBookSize, headObjectSize,
} from '../src/repo.mjs';

// Per-user storage quota. Usage is computed from each book's stored `size`
// (bytes); enforcement is two-phase in the handler (declared-size admission at
// POST /api/books, true-size verification at POST /api/books/{id}/finalize).

const UID = 'user1';
const PK = 'u#user1';

test('USER_QUOTA_BYTES is 50 GiB', () => {
  assert.equal(USER_QUOTA_BYTES, 50 * 2 ** 30);
});

test('sumSizes adds book sizes, treating missing/invalid/negative as zero', () => {
  const books = [
    { id: 'b1', size: 100 },
    { id: 'b2', size: 250 },
    { id: 'b3' },               // no size -> 0
    { id: 'b4', size: -5 },     // negative -> 0
    { id: 'b5', size: 'huge' }, // non-numeric -> 0
  ];
  assert.equal(sumSizes(books), 350);
});

test('sumSizes excludes the given id (re-uploads count only the delta)', () => {
  const books = [{ id: 'b1', size: 100 }, { id: 'b2', size: 250 }];
  assert.equal(sumSizes(books, 'b2'), 100);
});

test('exceedsQuota is true only when usage + added bytes is strictly over the cap', () => {
  assert.equal(exceedsQuota(USER_QUOTA_BYTES, 0), false); // exactly at the cap is allowed
  assert.equal(exceedsQuota(USER_QUOTA_BYTES, 1), true);  // one byte over
  assert.equal(exceedsQuota(0, USER_QUOTA_BYTES + 1), true);
  assert.equal(exceedsQuota(10, 20), false);
});

test("usageBytes sums the user's stored book sizes, excluding one id", async (t) => {
  t.mock.method(ddb, 'send', async () => ({
    Items: [
      { pk: PK, id: 'b1', format: 'pdf', size: 1000 },
      { pk: PK, id: 'b2', format: 'pdf', size: 2000 },
      { pk: PK, id: 'b1#hl#c1', text: 'clip' }, // a clip -> excluded by listBooks
    ],
  }));
  assert.equal(await usageBytes(UID), 3000);
  assert.equal(await usageBytes(UID, 'b2'), 1000);
});

test('setBookSize writes an aliased #size (reserved word) guarded by attribute_exists', async (t) => {
  let input;
  t.mock.method(ddb, 'send', async (cmd) => { input = cmd.input; return {}; });
  await setBookSize(UID, 'b1', 4096);
  assert.equal(input.Key.pk, PK);
  assert.equal(input.Key.id, 'b1');
  assert.equal(input.ExpressionAttributeNames['#size'], 'size');
  assert.equal(input.ExpressionAttributeValues[':s'], 4096);
  assert.match(input.UpdateExpression, /#size = :s/);
  assert.equal(input.ConditionExpression, 'attribute_exists(id)');
});

test('headObjectSize returns the S3 object ContentLength', async (t) => {
  let input;
  t.mock.method(s3, 'send', async (cmd) => { input = cmd.input; return { ContentLength: 8192 }; });
  const size = await headObjectSize(UID, 'b1', 'pdf');
  assert.equal(size, 8192);
  assert.equal(input.Key, 'u/user1/pdfs/b1.pdf');
});

test('headObjectSize defaults to 0 when ContentLength is absent', async (t) => {
  t.mock.method(s3, 'send', async () => ({}));
  assert.equal(await headObjectSize(UID, 'b1', 'pdf'), 0);
});
