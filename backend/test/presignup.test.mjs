import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../src/presignup.mjs';

test('passes the event through for a valid handle', async () => {
  const event = { userName: 'marco', response: {} };
  const out = await handler(event);
  assert.equal(out, event);
  assert.equal(out.response.autoConfirmUser, undefined); // OTP flow stays on
});

test('throws for a reserved handle', async () => {
  await assert.rejects(() => handler({ userName: 'admin', response: {} }), /reserved/);
});

test('throws for a malformed handle', async () => {
  await assert.rejects(() => handler({ userName: 'Ab', response: {} }), /./);
});
