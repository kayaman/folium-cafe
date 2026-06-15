import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePreSignUp } from '../src/presignup.mjs';

const allow = (list) => makePreSignUp({ loadAllowlist: async () => list });
const ev = (userName, email) => ({ userName, request: { userAttributes: { email } }, response: {} });

test('passes through for a valid handle + allowlisted email', async () => {
  const h = allow(['marco@example.com']);
  const event = ev('marco', 'marco@example.com');
  assert.equal(await h(event), event);
});

test('a domain entry admits any address at that domain', async () => {
  const h = allow(['@example.com']);
  const event = ev('bookworm', 'anyone@example.com');
  assert.equal(await h(event), event);
});

test('throws for an email not on the allowlist (invite-only)', async () => {
  const h = allow(['marco@example.com']);
  await assert.rejects(() => h(ev('marco', 'stranger@evil.com')), /invite-only/);
});

test('fails closed when the allowlist is empty', async () => {
  await assert.rejects(() => allow([])(ev('marco', 'marco@example.com')), /invite-only/);
});

test('throws for a reserved handle before the allowlist check', async () => {
  await assert.rejects(() => allow(['admin@example.com'])(ev('admin', 'admin@example.com')), /reserved/);
});

test('throws for a malformed handle', async () => {
  await assert.rejects(() => allow(['ab@example.com'])(ev('Ab', 'ab@example.com')), /./);
});
