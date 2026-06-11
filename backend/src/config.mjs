import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});
let cached = null;

// Reads the app password and HMAC key from SSM SecureString params once per
// container. Param names come from env so Terraform owns them.
export async function getConfig() {
  if (cached) return cached;
  const names = [process.env.PASSWORD_PARAM, process.env.HMAC_PARAM];
  const out = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const map = {};
  for (const p of out.Parameters ?? []) map[p.Name] = p.Value;
  cached = {
    password: map[process.env.PASSWORD_PARAM] ?? '',
    hmacKey: map[process.env.HMAC_PARAM] ?? '',
  };
  return cached;
}
