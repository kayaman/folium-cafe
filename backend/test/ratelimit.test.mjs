import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRateLimiter, LIMITS } from '../src/ratelimit.mjs';

function fakeDdb() {
  const counts = new Map();
  return {
    counts,
    send: async (cmd) => {
      const k = cmd.input.Key.pk;
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return { Attributes: { count: n } };
    },
  };
}

test('allows up to the limit, then blocks within the same window', async () => {
  const ddb = fakeDdb();
  const allow = makeRateLimiter({ ddb, table: 't', now: () => 1_000_000_000 });
  const policy = { limit: 3, windowSeconds: 900 };
  assert.equal(await allow('login', '1.2.3.4', policy), true);
  assert.equal(await allow('login', '1.2.3.4', policy), true);
  assert.equal(await allow('login', '1.2.3.4', policy), true);
  assert.equal(await allow('login', '1.2.3.4', policy), false);
});

test('a new window resets the counter', async () => {
  const ddb = fakeDdb();
  let t = 1_000_000_000;
  const allow = makeRateLimiter({ ddb, table: 't', now: () => t });
  const policy = { limit: 1, windowSeconds: 900 };
  assert.equal(await allow('login', 'ip', policy), true);
  assert.equal(await allow('login', 'ip', policy), false);
  t += 900_001; // next window
  assert.equal(await allow('login', 'ip', policy), true);
});

test('scopes and keys are isolated', async () => {
  const ddb = fakeDdb();
  const allow = makeRateLimiter({ ddb, table: 't', now: () => 1_000_000_000 });
  const policy = { limit: 1, windowSeconds: 900 };
  assert.equal(await allow('login', 'ip-a', policy), true);
  assert.equal(await allow('login', 'ip-b', policy), true);
  assert.equal(await allow('signup', 'ip-a', policy), true);
});

test('LIMITS covers the public auth routes', () => {
  for (const k of ['signup', 'login', 'confirm', 'forgot']) {
    assert.ok(LIMITS[k].limit > 0 && LIMITS[k].windowSeconds > 0);
  }
});
