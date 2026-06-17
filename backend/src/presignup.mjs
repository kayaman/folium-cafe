import { validateHandle } from './handle.mjs';

// Cognito pre-sign-up trigger: enforce the handle policy (open signup — no allowlist).
// Throwing rejects the SignUp with UserLambdaValidationException.
export async function handler(event) {
  const v = validateHandle(event.userName);
  if (!v.ok) throw new Error(v.reason);
  return event;
}
