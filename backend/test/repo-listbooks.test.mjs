import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ddb, listBooks } from '../src/repo.mjs';

// A DynamoDB FilterExpression may not reference the `id` sort key — doing so
// throws ValidationException and 500s every GET /api/books. listBooks must query
// the partition plainly and exclude clip/collection records in app code.

const MIXED = [
  { pk: 'lib', id: 'bmq1', title: 'Legacy PDF' },            // legacy book: no format
  { pk: 'lib', id: 'bmq2', format: 'pdf', title: 'A PDF' },
  { pk: 'lib', id: 'nmq1', format: 'note', title: 'A note' },// notes belong in the library
  { pk: 'lib', id: 'bmq1#hl#c1', text: 'a clip' },           // clip -> excluded
  { pk: 'lib', id: 'collmq1', name: 'A collection' },        // collection -> excluded
];

test('listBooks sends no FilterExpression (never reference the id sort key)', async (t) => {
  const inputs = [];
  t.mock.method(ddb, 'send', async (cmd) => {
    inputs.push(cmd.input);
    return { Items: MIXED };
  });

  const books = await listBooks();

  // Regression guard: the query must not carry a FilterExpression at all.
  assert.ok(inputs.length >= 1);
  for (const inp of inputs) assert.equal(inp.FilterExpression, undefined);
  assert.equal(inputs[0].KeyConditionExpression, 'pk = :pk');

  // Clips and collections excluded; books + notes kept.
  assert.deepEqual(books.map((b) => b.id).sort(), ['bmq1', 'bmq2', 'nmq1']);
  // Legacy item defaults to pdf; the note keeps its format.
  assert.equal(books.find((b) => b.id === 'bmq1').format, 'pdf');
  assert.equal(books.find((b) => b.id === 'nmq1').format, 'note');
  // Partition key stripped; collections normalized to an array.
  assert.ok(books.every((b) => !('pk' in b) && Array.isArray(b.collections)));
});

test('listBooks paginates over LastEvaluatedKey', async (t) => {
  let call = 0;
  t.mock.method(ddb, 'send', async (cmd) => {
    call += 1;
    if (call === 1) {
      assert.equal(cmd.input.ExclusiveStartKey, undefined);
      return { Items: [{ pk: 'lib', id: 'bmq1', format: 'pdf' }], LastEvaluatedKey: { pk: 'lib', id: 'bmq1' } };
    }
    assert.deepEqual(cmd.input.ExclusiveStartKey, { pk: 'lib', id: 'bmq1' });
    return { Items: [{ pk: 'lib', id: 'bmq2', format: 'pdf' }] };
  });

  const books = await listBooks();
  assert.equal(call, 2);
  assert.deepEqual(books.map((b) => b.id).sort(), ['bmq1', 'bmq2']);
});
