import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { validateHandle, isAllowed } from './handle.mjs';

// Cognito pre-sign-up trigger: enforce the handle policy AND the invite-only
// email allowlist. Throwing rejects the SignUp with UserLambdaValidationException.
// Factory form is unit-testable with an injected allowlist loader.
export function makePreSignUp({ loadAllowlist }) {
  return async function handler(event) {
    const v = validateHandle(event.userName);
    if (!v.ok) throw new Error(v.reason);
    const email = event.request?.userAttributes?.email;
    if (!isAllowed(email, await loadAllowlist())) {
      throw new Error('signups are invite-only right now');
    }
    return event;
  };
}

const ssm = new SSMClient({});
const ALLOWLIST_PARAM = process.env.ALLOWLIST_PARAM || '/folium-cafe/signup_allowlist';

// Runtime read so the owner can invite people via `aws ssm put-parameter`
// without redeploying. Fails closed (empty list) on any read/parse error.
async function ssmAllowlist() {
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: ALLOWLIST_PARAM, WithDecryption: true }));
    const v = JSON.parse(out.Parameter?.Value || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export const handler = makePreSignUp({ loadAllowlist: ssmAllowlist });
