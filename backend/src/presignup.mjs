import { validateHandle } from './handle.mjs';

// Cognito pre-sign-up trigger: backstop for the handle policy. Throwing makes
// Cognito reject the SignUp call with UserLambdaValidationException.
export async function handler(event) {
  const v = validateHandle(event.userName);
  if (!v.ok) throw new Error(v.reason);
  return event;
}
