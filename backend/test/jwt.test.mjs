import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVerifier } from '../src/jwt.mjs';

test('returns null (fails closed) for garbage tokens', async () => {
  const verify = makeVerifier({ userPoolId: 'us-east-1_FAKEFAKE', clientId: 'fakeclient' });
  assert.equal(await verify('not-a-jwt'), null);
  assert.equal(await verify(''), null);
  assert.equal(await verify(undefined), null);
});
