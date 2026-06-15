import { CognitoJwtVerifier } from 'aws-jwt-verify';

// Pinned to tokenUse=access + our app client: an ID token, or a token minted
// for another client of the same pool, must NOT authenticate (the sub claim is
// the tenant-isolation boundary). Fails closed on any verification error.
export function makeVerifier({
  userPoolId = process.env.USER_POOL_ID,
  clientId = process.env.USER_POOL_CLIENT_ID,
} = {}) {
  const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'access', clientId });
  return async function verifyAccess(token) {
    if (!token) return null;
    try {
      const p = await verifier.verify(token);
      return { sub: p.sub, username: p.username, iat: p.iat };
    } catch {
      return null;
    }
  };
}
