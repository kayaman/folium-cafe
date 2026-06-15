import {
  CognitoIdentityProviderClient, SignUpCommand, ConfirmSignUpCommand,
  ResendConfirmationCodeCommand, InitiateAuthCommand, RevokeTokenCommand,
  ForgotPasswordCommand, ConfirmForgotPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';

export function makeCognito({
  client = new CognitoIdentityProviderClient({}),
  clientId = process.env.USER_POOL_CLIENT_ID,
} = {}) {
  return {
    signUp: (username, password, email) => client.send(new SignUpCommand({
      ClientId: clientId, Username: username, Password: password,
      UserAttributes: [{ Name: 'email', Value: email }],
    })),
    confirm: (username, code) => client.send(new ConfirmSignUpCommand({
      ClientId: clientId, Username: username, ConfirmationCode: code,
    })),
    resend: (username) => client.send(new ResendConfirmationCodeCommand({
      ClientId: clientId, Username: username,
    })),
    login: async (username, password) => {
      const out = await client.send(new InitiateAuthCommand({
        ClientId: clientId, AuthFlow: 'USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: username, PASSWORD: password },
      }));
      return out.AuthenticationResult;
    },
    refresh: async (refreshToken) => {
      const out = await client.send(new InitiateAuthCommand({
        ClientId: clientId, AuthFlow: 'REFRESH_TOKEN_AUTH',
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }));
      return out.AuthenticationResult;
    },
    revoke: (refreshToken) => client.send(new RevokeTokenCommand({
      ClientId: clientId, Token: refreshToken,
    })),
    forgot: (username) => client.send(new ForgotPasswordCommand({
      ClientId: clientId, Username: username,
    })),
    confirmForgot: (username, code, password) => client.send(new ConfirmForgotPasswordCommand({
      ClientId: clientId, Username: username, ConfirmationCode: code, Password: password,
    })),
  };
}
