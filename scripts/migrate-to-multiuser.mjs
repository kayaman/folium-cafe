#!/usr/bin/env node
// One-time migration: copy the legacy single-user pk='lib' DynamoDB items to a
// per-user partition (pk='u#<sub>'), and re-prefix the S3 objects under
// u/<sub>/. Old items are left in place — delete them manually once the new
// account is verified working.
//
// Usage:
//   USER_SUB=<cognito-sub-uuid> \
//   TABLE_NAME=folium-cafe-books \
//   PDF_BUCKET=folium-cafe-pdfs \
//   node scripts/migrate-to-multiuser.mjs
//
// Dry run (read-only — prints what would happen, writes nothing):
//   DRY_RUN=1 USER_SUB=... TABLE_NAME=... PDF_BUCKET=... node scripts/migrate-to-multiuser.mjs

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command, CopyObjectCommand } from '@aws-sdk/client-s3';

const userId = process.env.USER_SUB;
const TABLE = process.env.TABLE_NAME;
const BUCKET = process.env.PDF_BUCKET;
const DRY_RUN = process.env.DRY_RUN === '1';

if (!userId || !TABLE || !BUCKET) {
  console.error('Set USER_SUB, TABLE_NAME, and PDF_BUCKET env vars');
  process.exit(1);
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const newPk = 'u#' + userId;

console.log(`Migrating pk='lib' -> pk='${newPk}'${DRY_RUN ? '  (DRY RUN — no writes)' : ''}`);

// --- DynamoDB: copy every pk='lib' item under the new partition key ---
let ddbCount = 0;
let ExclusiveStartKey;
do {
  const out = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: 'pk = :old',
    ExpressionAttributeValues: { ':old': 'lib' },
    ExclusiveStartKey,
  }));
  for (const item of out.Items ?? []) {
    if (DRY_RUN) {
      console.log('  DDB would copy:', item.id);
    } else {
      await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...item, pk: newPk } }));
      console.log('  DDB copied:', item.id);
    }
    ddbCount++;
  }
  ExclusiveStartKey = out.LastEvaluatedKey;
} while (ExclusiveStartKey);
console.log(`DynamoDB: ${ddbCount} item(s) ${DRY_RUN ? 'would be ' : ''}migrated`);

// --- S3: copy legacy keys (pdfs/ notes/ media/) under u/<sub>/ ---
let s3Count = 0;
let ContinuationToken;
do {
  const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken }));
  for (const obj of out.Contents ?? []) {
    const key = obj.Key;
    if (key.startsWith('u/')) continue; // already namespaced — skip
    const newKey = `u/${userId}/${key}`;
    if (DRY_RUN) {
      console.log(`  S3 would copy: ${key} -> ${newKey}`);
    } else {
      await s3.send(new CopyObjectCommand({
        Bucket: BUCKET,
        CopySource: encodeURIComponent(`${BUCKET}/${key}`),
        Key: newKey,
      }));
      console.log(`  S3 copied: ${key} -> ${newKey}`);
    }
    s3Count++;
  }
  ContinuationToken = out.NextContinuationToken;
} while (ContinuationToken);
console.log(`S3: ${s3Count} object(s) ${DRY_RUN ? 'would be ' : ''}migrated`);

console.log('Done. Old pk=\'lib\' items and un-prefixed S3 keys remain; delete them once verified.');
