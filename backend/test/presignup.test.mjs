import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../src/presignup.mjs';

const ev = (userName) => ({ userName, request: { userAttributes: { email: 'test@example.com' } }, response: {} });

test('passes through for a valid handle (open signup)', async () => {
  const event = ev('marco');
  assert.equal(await handler(event), event);
});

test('admits any well-formed handle regardless of email', async () => {
  const event = ev('bookworm');
  assert.equal(await handler(event), event);
});

test('throws for a reserved handle', async () => {
  await assert.rejects(() => handler(ev('admin')), /reserved/);
});

test('throws for a handle that is too short', async () => {
  await assert.rejects(() => handler(ev('ab')), /4-12/);
});

test('throws for a handle with uppercase', async () => {
  await assert.rejects(() => handler(ev('Marco')), /lowercase/);
});

test('throws for a handle with invalid chars', async () => {
  await assert.rejects(() => handler(ev('my_handle')), /lowercase/);
});
