import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, QueryCommand, PutCommand, GetCommand,
  UpdateCommand, DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TABLE = process.env.TABLE_NAME;
const BUCKET = process.env.PDF_BUCKET;
const PK = 'lib'; // single-user partition

const pdfKey = (id) => `pdfs/${id}.pdf`;

// Clippings are sibling items under a composite range key. Book ids are
// `b<base36>` and never contain '#', so the separator is unambiguous.
const CLIP_SEP = '#hl#';
export const clipItemId = (bookId, clipId) => `${bookId}${CLIP_SEP}${clipId}`;
export const isClipItem = (id) => id.includes(CLIP_SEP);
export const parseClipId = (itemId) => {
  const i = itemId.indexOf(CLIP_SEP);
  return i < 0 ? null : { bookId: itemId.slice(0, i), clipId: itemId.slice(i + CLIP_SEP.length) };
};

export async function listBooks() {
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk',
    FilterExpression: 'NOT contains(#id, :sep)',
    ExpressionAttributeNames: { '#id': 'id' },
    ExpressionAttributeValues: { ':pk': PK, ':sep': CLIP_SEP },
  }));
  // Strip the partition key from the response.
  return (out.Items ?? []).map(({ pk, ...rest }) => rest);
}

export async function listClippings(bookId) {
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(#id, :pfx)',
    ExpressionAttributeNames: { '#id': 'id' },
    ExpressionAttributeValues: { ':pk': PK, ':pfx': clipItemId(bookId, '') },
  }));
  return (out.Items ?? []).map(({ pk, id, bookId: _b, ...rest }) => ({
    id: parseClipId(id)?.clipId ?? id,
    ...rest,
  }));
}

export async function putClipping(bookId, clip) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: PK, id: clipItemId(bookId, clip.id), bookId, ...clip },
  }));
}

export async function deleteClipping(bookId, clipId) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: PK, id: clipItemId(bookId, clipId) },
  }));
}

export async function putBook(book) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: PK, ...book } }));
}

export async function getBook(id) {
  const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: PK, id } }));
  if (!out.Item) return null;
  const { pk, ...rest } = out.Item;
  return rest;
}

export async function updateProgress(id, currentPage, lastReadAt) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: PK, id },
    UpdateExpression: 'SET currentPage = :p, lastReadAt = :t',
    ConditionExpression: 'attribute_exists(id)',
    ExpressionAttributeValues: { ':p': currentPage, ':t': lastReadAt },
  }));
}

export async function deleteBook(id) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK, id } }));
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: pdfKey(id) })).catch(() => {});
}

export function presignPut(id) {
  return getSignedUrl(s3, new PutObjectCommand({
    Bucket: BUCKET, Key: pdfKey(id), ContentType: 'application/pdf',
  }), { expiresIn: 900 });
}

export function presignGet(id) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: pdfKey(id) }), { expiresIn: 900 });
}
