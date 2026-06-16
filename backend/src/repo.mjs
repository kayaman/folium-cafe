import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, QueryCommand, PutCommand, GetCommand,
  UpdateCommand, DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TABLE = process.env.TABLE_NAME;
const BUCKET = process.env.PDF_BUCKET;
const PK = 'lib'; // single-user partition

export const FORMATS = new Set(['pdf', 'cbz', 'epub', 'txt', 'md', 'audio', 'video', 'note']);

// Resolve the S3 object key for a stored file. The `pdf` case MUST return the
// legacy `pdfs/<id>.pdf` key byte-for-byte (no data migration). `note` lives
// under `notes/`; everything else lands under `media/` with a cosmetic ext.
const MEDIA_EXT = { cbz: 'cbz', epub: 'epub', txt: 'txt', md: 'md', audio: 'audio', video: 'video' };
export function mediaKey(id, format) {
  if (format === 'pdf') return `pdfs/${id}.pdf`;
  if (format === 'note') return `notes/${id}.md`;
  return `media/${id}.${MEDIA_EXT[format] ?? 'bin'}`;
}

const FIXED_CONTENT_TYPE = {
  pdf: 'application/pdf',
  cbz: 'application/vnd.comicbook+zip',
  epub: 'application/epub+zip',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  note: 'text/markdown; charset=utf-8',
};
const AUDIO_ALLOW = new Set(
  ['mpeg', 'mp4', 'aac', 'ogg', 'webm', 'flac', 'wav'].map((t) => `audio/${t}`)
);
const VIDEO_ALLOW = new Set(
  ['mp4', 'webm', 'ogg', 'quicktime'].map((t) => `video/${t}`)
);

// Decide the Content-Type the browser will PUT with. Fixed per format for the
// document types; for audio/video the client's requested type passes through
// only if it is in the allowlist, otherwise application/octet-stream. Unknown
// format -> null (caller rejects with 400).
export function chooseContentType(format, requested) {
  if (format in FIXED_CONTENT_TYPE) return FIXED_CONTENT_TYPE[format];
  if (format === 'audio') return AUDIO_ALLOW.has(requested) ? requested : 'application/octet-stream';
  if (format === 'video') return VIDEO_ALLOW.has(requested) ? requested : 'application/octet-stream';
  return null;
}

// Clippings are sibling items under a composite range key. Book ids are
// `b<base36>` and never contain '#', so the separator is unambiguous.
const CLIP_SEP = '#hl#';
export const clipItemId = (bookId, clipId) => `${bookId}${CLIP_SEP}${clipId}`;
export const isClipItem = (id) => id.includes(CLIP_SEP);
export const parseClipId = (itemId) => {
  const i = itemId.indexOf(CLIP_SEP);
  return i < 0 ? null : { bookId: itemId.slice(0, i), clipId: itemId.slice(i + CLIP_SEP.length) };
};

// ---------- collections ----------
// Collection records share pk='lib' and live under ids `coll<base36>`. Each
// library item may carry a `collections: string[]` of collection ids (additive;
// legacy items have none).
export const COLL_PREFIX = 'coll';
export const isCollectionId = (id) => typeof id === 'string' && id.startsWith(COLL_PREFIX);
export const collItemId = (id) => id; // identity — collection records key on their own id

export function normalizeCollections(item) {
  return Array.isArray(item?.collections) ? item.collections : [];
}

export function stripFromCollections(arr, id) {
  return (arr || []).filter((c) => c !== id);
}

export async function listCollections() {
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(#id, :coll)',
    ExpressionAttributeNames: { '#id': 'id' },
    ExpressionAttributeValues: { ':pk': PK, ':coll': COLL_PREFIX },
  }));
  return (out.Items ?? []).map(({ id, name, createdAt }) => ({ id, name, createdAt }));
}

export async function putCollection(coll) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: PK, id: coll.id, name: coll.name, createdAt: coll.createdAt },
  }));
}

export async function renameCollection(id, name) {
  // `name` is a DynamoDB reserved word -> alias it.
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: PK, id },
    UpdateExpression: 'SET #name = :name',
    ConditionExpression: 'attribute_exists(id)',
    ExpressionAttributeNames: { '#name': 'name' },
    ExpressionAttributeValues: { ':name': name },
  }));
}

export async function setItemCollections(id, ids) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: PK, id },
    UpdateExpression: 'SET collections = :c',
    ConditionExpression: 'attribute_exists(id)',
    ExpressionAttributeValues: { ':c': ids },
  }));
}

export async function deleteCollection(id) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK, id } }));
  // Eager cleanup: strip this id from every item that references it.
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': PK },
  }));
  for (const item of out.Items ?? []) {
    const cols = normalizeCollections(item);
    if (cols.includes(id)) {
      await setItemCollections(item.id, stripFromCollections(cols, id));
    }
  }
}

// ---------- linked media ----------
// An item is linked (external) media when it carries a non-empty `url`; its
// bytes live elsewhere, so there is no S3 object and no presigned url.
export const isLinkedMedia = (item) => !!item && typeof item.url === 'string' && item.url.length > 0;

export async function listBooks() {
  // Query the whole partition (paginated) and exclude clip + collection records
  // in app code. A DynamoDB FilterExpression CANNOT reference `id` (the sort key)
  // — doing so throws ValidationException and 500s every GET /api/books.
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': PK },
      ExclusiveStartKey,
    }));
    items.push(...(out.Items ?? []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  // Books are `b…`, notes `n…`; drop clips (`#hl#`) and collection records (`coll…`).
  // Strip the partition key; default legacy items to pdf and normalize collections.
  return items
    .filter(({ id }) => !isClipItem(id) && !isCollectionId(id))
    .map(({ pk, ...rest }) => ({
      ...rest,
      format: rest.format ?? 'pdf',
      collections: normalizeCollections(rest),
    }));
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
  // Spread the clip FIRST, then set the authoritative keys — `clip` carries its
  // own `id`, and if it were spread last it would clobber the composite range key
  // with the bare clip id (no '#hl#'), which then leaks into listBooks as a
  // phantom, title-less "book". listClippings reconstructs clip.id via parseClipId.
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { ...clip, pk: PK, bookId, id: clipItemId(bookId, clip.id) },
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

// Notes are first-class library items with `format:'note'`. Their ids are
// `n<base36>` (so they never collide with book ids `b...` or carry the clip
// `#hl#` separator -> listBooks includes them, isClipItem rejects them).
export const isNoteId = (id) => typeof id === 'string' && id.startsWith('n');

// putBook already spreads arbitrary fields onto the item; putNote is an alias
// so callers read intent-first without duplicating the PutCommand.
export const putNote = putBook;

// Note bodies are written server-side (Lambda PutObject) rather than via a
// presigned PUT, so the markdown text travels in the request JSON.
export async function putNoteBody(id, bodyText) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: mediaKey(id, 'note'),
    Body: bodyText,
    ContentType: 'text/markdown; charset=utf-8',
  }));
}

export async function getNoteBody(id) {
  try {
    const out = await s3.send(new GetObjectCommand({
      Bucket: BUCKET, Key: mediaKey(id, 'note'),
    }));
    return await out.Body.transformToString();
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.Code === 'NoSuchKey') return '';
    throw err;
  }
}

// Update whichever of title/noteFormat/updatedAt/lastReadAt are present.
// Built dynamically so absent fields are left untouched.
export async function updateNoteMeta(id, fields) {
  const sets = [];
  const names = {};
  const values = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    values[`:${k}`] = v;
  }
  if (sets.length === 0) return;
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: PK, id },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ConditionExpression: 'attribute_exists(id)',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// Server-side allowlist for PATCH /api/books/{id}. Any key not here (or whose
// value is undefined) is dropped before building the UpdateExpression — the
// client can never set arbitrary attributes.
export const BOOK_META_FIELDS = new Set([
  'title', 'author', 'subtitle', 'authors', 'edition',
  'publisher', 'year', 'isbn', 'language', 'series', 'description',
  'collections',
]);

// Update whichever allowlisted book-metadata fields are present. Mirrors
// updateNoteMeta: dynamic `SET #k = :k` with name aliasing for every field
// (covers reserved words like `language`). No-ops when nothing is settable.
export async function updateBookMeta(id, fields) {
  const sets = [];
  const names = {};
  const values = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (!BOOK_META_FIELDS.has(k) || v === undefined) continue;
    sets.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    values[`:${k}`] = v;
  }
  if (sets.length === 0) return;
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: PK, id },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ConditionExpression: 'attribute_exists(id)',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

export async function getBook(id) {
  const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: PK, id } }));
  if (!out.Item) return null;
  const { pk, ...rest } = out.Item;
  return { ...rest, format: rest.format ?? 'pdf' };
}

// Pure, unit-testable: assemble the progress UpdateCommand input. posFrac is
// written ONLY when a finite frac is supplied, so an older client that omits it
// never clobbers a good stored value.
export function buildProgressUpdate(currentPage, lastReadAt, frac) {
  const values = { ':p': currentPage, ':t': lastReadAt };
  let expr = 'SET currentPage = :p, lastReadAt = :t';
  if (typeof frac === 'number' && Number.isFinite(frac)) {
    expr += ', posFrac = :f';
    values[':f'] = frac;
  }
  return { UpdateExpression: expr, ExpressionAttributeValues: values };
}

export async function updateProgress(id, currentPage, lastReadAt, frac) {
  const { UpdateExpression, ExpressionAttributeValues } = buildProgressUpdate(currentPage, lastReadAt, frac);
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: PK, id },
    UpdateExpression,
    ConditionExpression: 'attribute_exists(id)',
    ExpressionAttributeValues,
  }));
}

export async function updateProgressGeneric(id, progress, lastReadAt) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: PK, id },
    UpdateExpression: 'SET progress = :p, lastReadAt = :t',
    ConditionExpression: 'attribute_exists(id)',
    ExpressionAttributeValues: { ':p': progress, ':t': lastReadAt },
  }));
}

export async function deleteBook(id) {
  // Resolve the stored format so we delete the right S3 key (legacy items have
  // no `format` -> pdf). getBook already normalizes the default.
  const item = await getBook(id);
  const format = item?.format ?? 'pdf';
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK, id } }));
  // Linked media has no S3 object to remove; only delete real uploads.
  if (item && !isLinkedMedia(item)) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: mediaKey(id, format) })).catch(() => {});
  }
}

export function presignPut(id, format, contentType) {
  return getSignedUrl(s3, new PutObjectCommand({
    Bucket: BUCKET, Key: mediaKey(id, format), ContentType: contentType,
  }), { expiresIn: 900 });
}

export function presignGet(id, format = 'pdf') {
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: BUCKET, Key: mediaKey(id, format),
  }), { expiresIn: 900 });
}
