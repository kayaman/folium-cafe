import {
  QueryCommand, PutCommand, GetCommand, UpdateCommand, DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

export const MAX_BOOKS = 100;
export const MAX_PDF_BYTES = 100 * 1024 * 1024; // 100 MB

const META_ID = '_meta'; // per-user item: tokensValidAfter (session revocation)

export function makeRepo({
  ddb, s3,
  table = process.env.TABLE_NAME,
  bucket = process.env.PDF_BUCKET,
  presignGet = getSignedUrl,
  presignPost = createPresignedPost,
} = {}) {
  const userPk = (sub) => `USER#${sub}`;
  const pdfKey = (sub, id) => `users/${sub}/pdfs/${id}.pdf`;

  return {
    async listBooks(sub) {
      const out = await ddb.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': userPk(sub) },
      }));
      return (out.Items ?? [])
        .filter((i) => i.id !== META_ID)
        .map(({ pk, ...rest }) => rest);
    },

    async putBook(sub, book) {
      const existing = await ddb.send(new GetCommand({
        TableName: table, Key: { pk: userPk(sub), id: book.id },
      }));
      if (!existing.Item) {
        const count = await ddb.send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :pk',
          FilterExpression: 'id <> :meta',
          Select: 'COUNT',
          ExpressionAttributeValues: { ':pk': userPk(sub), ':meta': META_ID },
        }));
        if ((count.Count ?? 0) >= MAX_BOOKS) {
          return { ok: false, reason: `shelf is full (${MAX_BOOKS} books max)` };
        }
      }
      await ddb.send(new PutCommand({ TableName: table, Item: { pk: userPk(sub), ...book } }));
      return { ok: true };
    },

    async getBook(sub, id) {
      const out = await ddb.send(new GetCommand({
        TableName: table, Key: { pk: userPk(sub), id },
      }));
      if (!out.Item) return null;
      const { pk, ...rest } = out.Item;
      return rest;
    },

    async updateProgress(sub, id, currentPage, lastReadAt) {
      await ddb.send(new UpdateCommand({
        TableName: table,
        Key: { pk: userPk(sub), id },
        UpdateExpression: 'SET currentPage = :p, lastReadAt = :t',
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeValues: { ':p': currentPage, ':t': lastReadAt },
      }));
    },

    async deleteBook(sub, id) {
      await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: userPk(sub), id } }));
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: pdfKey(sub, id) })).catch(() => {});
    },

    presignDownload(sub, id) {
      return presignGet(s3, new GetObjectCommand({ Bucket: bucket, Key: pdfKey(sub, id) }), { expiresIn: 900 });
    },

    // Presigned POST (not PUT): only POST policies can cap the upload size.
    presignUpload(sub, id) {
      return presignPost(s3, {
        Bucket: bucket,
        Key: pdfKey(sub, id),
        Conditions: [
          ['content-length-range', 1, MAX_PDF_BYTES],
          { 'Content-Type': 'application/pdf' },
        ],
        Fields: { 'Content-Type': 'application/pdf' },
        Expires: 900,
      });
    },

    async getMeta(sub) {
      const out = await ddb.send(new GetCommand({
        TableName: table, Key: { pk: userPk(sub), id: META_ID },
      }));
      return out.Item ?? null;
    },

    async bumpTokensValidAfter(sub, now = Date.now()) {
      await ddb.send(new PutCommand({
        TableName: table,
        Item: { pk: userPk(sub), id: META_ID, tokensValidAfter: now },
      }));
    },
  };
}
