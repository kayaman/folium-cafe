// One-off: reassign the single-user library (pk='lib', s3://.../pdfs/*) to a
// real account. Dry-run by default; pass --apply to write.
//
// Usage:
//   aws cognito-idp list-users --user-pool-id <pool> \
//     --query 'Users[].{u:Username,sub:Attributes[?Name==`sub`].Value|[0]}'
//   TABLE_NAME=folio-books PDF_BUCKET=folio-pdfs-<acct> \
//     node scripts/migrate-lib-to-user.mjs --sub <owner-sub> [--apply]
//
// Idempotent: re-runs skip items/objects that already exist at the target.
// Old pk='lib' rows and pdfs/* objects are left in place; delete them by hand
// after verifying the app works for the owner account.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TABLE = process.env.TABLE_NAME;
const BUCKET = process.env.PDF_BUCKET;
const sub = process.argv[process.argv.indexOf('--sub') + 1];
const apply = process.argv.includes('--apply');

if (!TABLE || !BUCKET || !sub || sub.startsWith('--')) {
  console.error('need TABLE_NAME, PDF_BUCKET env and --sub <cognito-sub>');
  process.exit(1);
}

const out = await ddb.send(new QueryCommand({
  TableName: TABLE,
  KeyConditionExpression: 'pk = :pk',
  ExpressionAttributeValues: { ':pk': 'lib' },
}));
const books = out.Items ?? [];
console.log(`${books.length} legacy books; target pk USER#${sub}${apply ? '' : ' (dry run)'}`);

for (const item of books) {
  const { pk, ...book } = item;
  const target = { pk: `USER#${sub}`, ...book };

  const existing = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { pk: target.pk, id: book.id },
  }));
  if (existing.Item) { console.log(`= ${book.id} (row already migrated)`); }
  else if (apply) {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: target }));
    console.log(`+ ${book.id} row copied`);
  } else console.log(`~ ${book.id} row would copy`);

  const srcKey = `pdfs/${book.id}.pdf`;
  const dstKey = `users/${sub}/pdfs/${book.id}.pdf`;
  const dstExists = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: dstKey }))
    .then(() => true).catch(() => false);
  if (dstExists) { console.log(`= ${dstKey} (object already migrated)`); continue; }
  const srcExists = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: srcKey }))
    .then(() => true).catch(() => false);
  if (!srcExists) { console.log(`! ${srcKey} missing in S3 — skipping object`); continue; }
  if (apply) {
    await s3.send(new CopyObjectCommand({
      Bucket: BUCKET, Key: dstKey, CopySource: `${BUCKET}/${encodeURIComponent(srcKey)}`,
    }));
    console.log(`+ ${dstKey} object copied`);
  } else console.log(`~ ${dstKey} object would copy`);
}
console.log('done. verify in the app, then delete pk=lib rows and pdfs/* objects manually.');
