import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCognito } from '../src/cognito.mjs';

function fakeClient(responses = {}) {
  const sent = [];
  return {
    sent,
    send: async (cmd) => {
      sent.push(cmd);
      return responses[cmd.constructor.name] ?? {};
    },
  };
}

test('signUp sends username, password and email attribute', async () => {
  const client = fakeClient();
  const c = makeCognito({ client, clientId: 'cid' });
  await c.signUp('marco', 'a-long-passphrase', 'm@rco.sh');
  const cmd = client.sent[0];
  assert.equal(cmd.constructor.name, 'SignUpCommand');
  assert.equal(cmd.input.ClientId, 'cid');
  assert.equal(cmd.input.Username, 'marco');
  assert.deepEqual(cmd.input.UserAttributes, [{ Name: 'email', Value: 'm@rco.sh' }]);
});

test('login uses USER_PASSWORD_AUTH and returns AuthenticationResult', async () => {
  const client = fakeClient({
    InitiateAuthCommand: { AuthenticationResult: { AccessToken: 'AT', RefreshToken: 'RT' } },
  });
  const c = makeCognito({ client, clientId: 'cid' });
  const out = await c.login('marco', 'pw');
  assert.equal(client.sent[0].input.AuthFlow, 'USER_PASSWORD_AUTH');
  assert.deepEqual(client.sent[0].input.AuthParameters, { USERNAME: 'marco', PASSWORD: 'pw' });
  assert.equal(out.AccessToken, 'AT');
});

test('refresh uses REFRESH_TOKEN_AUTH', async () => {
  const client = fakeClient({
    InitiateAuthCommand: { AuthenticationResult: { AccessToken: 'AT2' } },
  });
  const c = makeCognito({ client, clientId: 'cid' });
  const out = await c.refresh('RT');
  assert.equal(client.sent[0].input.AuthFlow, 'REFRESH_TOKEN_AUTH');
  assert.deepEqual(client.sent[0].input.AuthParameters, { REFRESH_TOKEN: 'RT' });
  assert.equal(out.AccessToken, 'AT2');
});

test('confirm, resend, revoke, forgot, confirmForgot map to their commands', async () => {
  const client = fakeClient();
  const c = makeCognito({ client, clientId: 'cid' });
  await c.confirm('marco', '123456');
  await c.resend('marco');
  await c.revoke('RT');
  await c.forgot('marco');
  await c.confirmForgot('marco', '654321', 'new-passphrase');
  assert.deepEqual(client.sent.map((s) => s.constructor.name), [
    'ConfirmSignUpCommand', 'ResendConfirmationCodeCommand', 'RevokeTokenCommand',
    'ForgotPasswordCommand', 'ConfirmForgotPasswordCommand',
  ]);
});
