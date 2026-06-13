# Multi-User Cognito Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Folium's shared-password auth with Cognito multi-user auth (DNS-safe handles, email OTP, 90-day BFF cookie sessions) and scope all data per user.

**Architecture:** Cognito Lite user pool + a pre-sign-up trigger enforcing handle rules. The existing Lambda becomes a BFF: it proxies signup/login/refresh to Cognito and keeps tokens in HttpOnly cookies; every authed request verifies the access JWT locally (`aws-jwt-verify`) and scopes DynamoDB (`pk = USER#<sub>`) and S3 (`users/<sub>/pdfs/`). Spec: `docs/plan-multi-user-cognito.md`.

**Tech Stack:** Terraform (existing `infra/`), Node 20 Lambda (ESM, `node:test`), vanilla TS SPA (esbuild), `aws-jwt-verify`, `@aws-sdk/client-cognito-identity-provider`, `@aws-sdk/s3-presigned-post`.

**Conventions:** All paths relative to repo root. Backend tests run with `cd backend && npm test`. Every module that talks to AWS is a `make*` factory taking injectable clients so tests use fakes — follow this pattern exactly. Commit after every green test run.

---

### Task 0: Branch

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b feat/multi-user-cognito
```

---

### Task 1: Infra prep — CI permissions, encryption, TTL, CORS

**Files:**
- Modify: `infra/cicd.tf` (ManageStack statement, ~line 61)
- Modify: `infra/data_stores.tf`

The CI role cannot create Cognito/SES resources today — without this, the first CI `terraform apply` fails. Encryption blocks come from security-review blocker #4. The DynamoDB TTL block is needed by the rate limiter (Task 9). CORS `POST` is needed by presigned-POST uploads (Task 10).

- [ ] **Step 1: Extend the CI ManageStack actions** in `infra/cicd.tf` — change the Action list of the `ManageStack` statement to:

```hcl
        Action = [
          "cloudfront:*", "s3:*", "lambda:*", "dynamodb:*", "iam:*",
          "acm:*", "route53:*", "ssm:*", "logs:*",
          "cognito-idp:*", "ses:*"
        ]
```

- [ ] **Step 2: Add encryption + TTL to `infra/data_stores.tf`** — inside `resource "aws_dynamodb_table" "books"` (after the `attribute` blocks):

```hcl
  server_side_encryption {
    enabled = true
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
```

and append a new resource after the public-access block:

```hcl
resource "aws_s3_bucket_server_side_encryption_configuration" "pdfs" {
  bucket = aws_s3_bucket.pdfs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
```

- [ ] **Step 3: Allow POST in the PDF bucket CORS** — in `aws_s3_bucket_cors_configuration.pdfs` change:

```hcl
    allowed_methods = ["GET", "PUT", "POST"]
```

- [ ] **Step 4: Validate and commit**

```bash
terraform -chdir=infra init -backend=false -input=false >/dev/null && terraform -chdir=infra validate
```
Expected: `Success! The configuration is valid.`

```bash
git add infra/cicd.tf infra/data_stores.tf
git commit -m "feat(infra): CI perms for cognito/ses, explicit SSE, DDB TTL, CORS POST"
```

---

### Task 2: SES domain identity + DNS

**Files:**
- Create: `infra/ses.tf`

SES production access is already granted (per Marco). This wires the `folium.cafe` identity with DKIM, custom MAIL FROM (SPF alignment), DMARC, and the identity policy that lets Cognito send through it.

- [ ] **Step 1: Create `infra/ses.tf`**

```hcl
# Email identity for Cognito verification mail. Production access already
# granted on this account; sandbox would silently break open signup.
resource "aws_ses_domain_identity" "folium" {
  domain = var.domain_name
}

resource "aws_route53_record" "ses_verification" {
  zone_id = aws_route53_zone.folium.zone_id
  name    = "_amazonses.${var.domain_name}"
  type    = "TXT"
  ttl     = 600
  records = [aws_ses_domain_identity.folium.verification_token]
}

resource "aws_ses_domain_identity_verification" "folium" {
  domain     = aws_ses_domain_identity.folium.id
  depends_on = [aws_route53_record.ses_verification]
}

resource "aws_ses_domain_dkim" "folium" {
  domain = aws_ses_domain_identity.folium.domain
}

resource "aws_route53_record" "ses_dkim" {
  count   = 3
  zone_id = aws_route53_zone.folium.zone_id
  name    = "${aws_ses_domain_dkim.folium.dkim_tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_ses_domain_dkim.folium.dkim_tokens[count.index]}.dkim.amazonses.com"]
}

# Custom MAIL FROM so SPF aligns with the From domain (DMARC).
resource "aws_ses_domain_mail_from" "folium" {
  domain           = aws_ses_domain_identity.folium.domain
  mail_from_domain = "mail.${var.domain_name}"
}

resource "aws_route53_record" "mail_from_mx" {
  zone_id = aws_route53_zone.folium.zone_id
  name    = aws_ses_domain_mail_from.folium.mail_from_domain
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.us-east-1.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  zone_id = aws_route53_zone.folium.zone_id
  name    = aws_ses_domain_mail_from.folium.mail_from_domain
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "dmarc" {
  zone_id = aws_route53_zone.folium.zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 600
  records = ["v=DMARC1; p=none;"]
}

# Cognito (DEVELOPER email sending) needs explicit permission on the identity.
resource "aws_ses_identity_policy" "cognito_send" {
  identity = aws_ses_domain_identity.folium.arn
  name     = "${var.name_prefix}-cognito-send"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = ["cognito-idp.amazonaws.com", "email.cognito-idp.amazonaws.com"] }
      Action    = ["ses:SendEmail", "ses:SendRawEmail"]
      Resource  = aws_ses_domain_identity.folium.arn
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}
```

- [ ] **Step 2: Validate and commit**

```bash
terraform -chdir=infra validate
```
Expected: `Success! The configuration is valid.`

```bash
git add infra/ses.tf
git commit -m "feat(infra): SES identity for folium.cafe with DKIM, MAIL FROM, DMARC"
```

---

### Task 3: Cognito user pool, app client, trigger wiring

**Files:**
- Create: `infra/cognito.tf`
- Modify: `infra/lambda.tf` (env vars ~line 74, IAM policy ~line 20)
- Modify: `infra/outputs.tf`

The pre-sign-up function reuses the existing backend zip (`src/presignup.handler` — code arrives in Task 6; Terraform won't be applied until then, only validated). Design decisions from the spec: LITE tier, immutable handle = username, email alias, 30-min access / 90-day refresh, `USER_PASSWORD_AUTH` (BFF terminates TLS; no SRP library needed in Lambda), `prevent_user_existence_errors`.

- [ ] **Step 1: Create `infra/cognito.tf`**

```hcl
resource "aws_cognito_user_pool" "users" {
  name                = "${var.name_prefix}-users"
  user_pool_tier      = "LITE" # OTP verification is in Lite; Essentials is 2.7x the price
  deletion_protection = "ACTIVE"

  # Handle (username) is immutable; email is a sign-in alias and must be verified.
  alias_attributes         = ["email"]
  auto_verified_attributes = ["email"]

  username_configuration {
    case_sensitive = false
  }

  password_policy {
    minimum_length    = 12
    require_lowercase = false
    require_numbers   = false
    require_symbols   = false
    require_uppercase = false
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 3
      max_length = 254
    }
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your Folium verification code"
    email_message        = "Welcome to the reading room. Your verification code is {####}."
  }

  email_configuration {
    email_sending_account = "DEVELOPER"
    source_arn            = aws_ses_domain_identity.folium.arn
    from_email_address    = "Folium <no-reply@${var.domain_name}>"
  }

  lambda_config {
    pre_sign_up = aws_lambda_function.presignup.arn
  }
}

resource "aws_cognito_user_pool_client" "bff" {
  name            = "${var.name_prefix}-bff"
  user_pool_id    = aws_cognito_user_pool.users.id
  generate_secret = false

  # Password transits browser -> TLS -> BFF -> TLS -> Cognito; SRP would require
  # an SRP math library in the Lambda for no transport-security gain here.
  explicit_auth_flows = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = 30
  id_token_validity      = 30
  refresh_token_validity = 90
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

# Same artifact as the API function; only the handler entrypoint differs.
resource "aws_lambda_function" "presignup" {
  function_name    = "${var.name_prefix}-presignup"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "src/presignup.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 5
  memory_size      = 128
}

resource "aws_lambda_permission" "cognito_presignup" {
  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.presignup.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.users.arn
}
```

- [ ] **Step 2: Add env vars to the API function** in `infra/lambda.tf` (inside `environment.variables`, keep the existing entries for now — they go away in Task 14):

```hcl
      USER_POOL_ID        = aws_cognito_user_pool.users.id
      USER_POOL_CLIENT_ID = aws_cognito_user_pool_client.bff.id
```

- [ ] **Step 3: Add the Cognito IAM statement** in `infra/lambda.tf` to `aws_iam_role_policy.lambda`'s Statement list. Deliberately NO `cognito-idp:Admin*` (enumeration/least-privilege — security review #12):

```hcl
      {
        Effect = "Allow"
        Action = [
          "cognito-idp:SignUp",
          "cognito-idp:ConfirmSignUp",
          "cognito-idp:ResendConfirmationCode",
          "cognito-idp:InitiateAuth",
          "cognito-idp:RevokeToken",
          "cognito-idp:ForgotPassword",
          "cognito-idp:ConfirmForgotPassword"
        ]
        Resource = aws_cognito_user_pool.users.arn
      },
```

- [ ] **Step 4: Add outputs** to `infra/outputs.tf`:

```hcl
output "user_pool_id" {
  value = aws_cognito_user_pool.users.id
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.bff.id
}
```

- [ ] **Step 5: Validate and commit**

```bash
terraform -chdir=infra validate
```
Expected: `Success! The configuration is valid.`

```bash
git add infra/cognito.tf infra/lambda.tf infra/outputs.tf
git commit -m "feat(infra): Cognito Lite user pool, BFF client, pre-sign-up trigger"
```

---

### Task 4: Backend dependencies

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Install**

```bash
cd backend && npm install aws-jwt-verify @aws-sdk/client-cognito-identity-provider @aws-sdk/s3-presigned-post
```

- [ ] **Step 2: Verify existing tests still pass**

```bash
cd backend && npm test
```
Expected: all existing tests PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "feat(backend): add cognito, jwt-verify, presigned-post deps"
```

---

### Task 5: Handle validation module (`handle.mjs`)

**Files:**
- Create: `backend/src/handle.mjs`
- Test: `backend/test/handle.test.mjs`

Pure function. Used by BOTH the pre-sign-up trigger and the BFF signup route (the trigger is a backstop, not the boundary — review #7). Reserved list is the one adopted in the spec appendix; exact match only.

- [ ] **Step 1: Write the failing test** — `backend/test/handle.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHandle } from '../src/handle.mjs';

test('accepts a plain 4-12 char lowercase handle', () => {
  assert.equal(validateHandle('marco').ok, true);
  assert.equal(validateHandle('ab12').ok, true);
  assert.equal(validateHandle('twelve-chars').ok, true); // exactly 12
});

test('rejects too short / too long', () => {
  assert.equal(validateHandle('abc').ok, false);
  assert.equal(validateHandle('thirteenchars').ok, false);
});

test('rejects uppercase (BFF normalizes before calling; trigger is strict)', () => {
  assert.equal(validateHandle('Marco').ok, false);
});

test('rejects leading/trailing hyphen and bad chars', () => {
  assert.equal(validateHandle('-abc').ok, false);
  assert.equal(validateHandle('abc-').ok, false);
  assert.equal(validateHandle('a_bc').ok, false);
  assert.equal(validateHandle('a.bc').ok, false);
  assert.equal(validateHandle('ab cd').ok, false);
});

test('rejects reserved names, exact match only', () => {
  assert.equal(validateHandle('admin').ok, false);
  assert.equal(validateHandle('folium').ok, false);
  assert.equal(validateHandle('books').ok, false);
  assert.equal(validateHandle('bookworm').ok, true); // substring is fine
});

test('rejects null/undefined/non-string garbage', () => {
  assert.equal(validateHandle(undefined).ok, false);
  assert.equal(validateHandle(null).ok, false);
  assert.equal(validateHandle(42).ok, false);
});

test('failures carry a human reason', () => {
  assert.equal(typeof validateHandle('abc').reason, 'string');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd backend && npm test
```
Expected: FAIL — `Cannot find module '../src/handle.mjs'`.

- [ ] **Step 3: Implement `backend/src/handle.mjs`**

```js
// Handle policy: 4-12 chars, DNS-label-safe, lowercase, exact-match blocklist.
// Enforced in the BFF signup route AND the Cognito pre-sign-up trigger.
// Spec: docs/plan-multi-user-cognito.md (appendix).
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'security', 'abuse', 'postmaster',
  'webmaster', 'hostmaster', 'noreply', 'no-reply', 'mailer-daemon', 'support',
  'help', 'info', 'contact', 'billing', 'payments', 'legal', 'privacy', 'terms',
  'about', 'team', 'staff', 'official', 'moderator',
  'www', 'mail', 'smtp', 'imap', 'pop3', 'ftp', 'sftp', 'ns1', 'ns2', 'dns',
  'mx', 'cdn', 'static', 'assets', 'img', 'images', 'media', 'files', 'api',
  'app', 'web', 'dev', 'test', 'testing', 'staging', 'prod', 'production',
  'demo', 'beta', 'status', 'docs', 'blog', 'news',
  'login', 'logout', 'signin', 'signout', 'signup', 'register', 'auth', 'oauth',
  'account', 'accounts', 'settings', 'profile', 'profiles', 'user', 'users',
  'username', 'guest', 'anonymous', 'nobody',
  'folium', 'cafe', 'foliumcafe', 'library', 'shelf', 'shelves', 'book',
  'books', 'reader', 'read', 'reading', 'folio', 'leaf',
]);

const HANDLE_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export function validateHandle(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'username required' };
  if (raw.length < 4 || raw.length > 12) {
    return { ok: false, reason: 'username must be 4-12 characters' };
  }
  if (!HANDLE_RE.test(raw)) {
    return { ok: false, reason: 'lowercase letters, digits and inner hyphens only' };
  }
  if (RESERVED.has(raw)) return { ok: false, reason: 'that username is reserved' };
  return { ok: true };
}
```

- [ ] **Step 4: Run tests — PASS expected**

```bash
cd backend && npm test
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/handle.mjs backend/test/handle.test.mjs
git commit -m "feat(backend): handle validation with reserved-name blocklist"
```

---

### Task 6: Pre-sign-up trigger (`presignup.mjs`)

**Files:**
- Create: `backend/src/presignup.mjs`
- Test: `backend/test/presignup.test.mjs`

- [ ] **Step 1: Write the failing test** — `backend/test/presignup.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../src/presignup.mjs';

test('passes the event through for a valid handle', async () => {
  const event = { userName: 'marco', response: {} };
  const out = await handler(event);
  assert.equal(out, event);
  assert.equal(out.response.autoConfirmUser, undefined); // OTP flow stays on
});

test('throws for a reserved handle', async () => {
  await assert.rejects(() => handler({ userName: 'admin', response: {} }), /reserved/);
});

test('throws for a malformed handle', async () => {
  await assert.rejects(() => handler({ userName: 'Ab', response: {} }), /./);
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && npm test` → FAIL (module not found).

- [ ] **Step 3: Implement `backend/src/presignup.mjs`**

```js
import { validateHandle } from './handle.mjs';

// Cognito pre-sign-up trigger: backstop for the handle policy. Throwing makes
// Cognito reject the SignUp call with UserLambdaValidationException.
export async function handler(event) {
  const v = validateHandle(event.userName);
  if (!v.ok) throw new Error(v.reason);
  return event;
}
```

- [ ] **Step 4: Run tests — PASS expected.**

- [ ] **Step 5: Commit**

```bash
git add backend/src/presignup.mjs backend/test/presignup.test.mjs
git commit -m "feat(backend): cognito pre-sign-up trigger enforcing handle policy"
```

---

### Task 7: Session cookies module (`session.mjs`)

**Files:**
- Create: `backend/src/session.mjs`
- Test: `backend/test/session.test.mjs`

Replaces the cookie half of `auth.mjs` (`parseCookies` moves here verbatim; HMAC code dies in Task 14). `SameSite=Strict` + `Path=/api` per security review #2/#17. Cookie Max-Age = refresh lifetime; an expired access JWT inside a live cookie triggers a server-side refresh.

- [ ] **Step 1: Write the failing test** — `backend/test/session.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authCookies, refreshedCookie, clearedCookies, parseCookies,
  AT_COOKIE, RT_COOKIE,
} from '../src/session.mjs';

test('authCookies sets both tokens with strict flags', () => {
  const out = authCookies({ AccessToken: 'AT', RefreshToken: 'RT' });
  assert.equal(out.length, 2);
  assert.match(out[0], /^folio_at=AT; HttpOnly; Secure; SameSite=Strict; Path=\/api; Max-Age=7776000$/);
  assert.match(out[1], /^folio_rt=RT; HttpOnly; Secure; SameSite=Strict; Path=\/api; Max-Age=7776000$/);
});

test('refreshedCookie re-sets only the access token', () => {
  assert.match(refreshedCookie('NEW'), /^folio_at=NEW; /);
});

test('clearedCookies expires both', () => {
  for (const c of clearedCookies()) assert.match(c, /Max-Age=0$/);
});

test('parseCookies reads cookies from header string and array forms', () => {
  assert.equal(parseCookies(['a=1; folio_at=x.y.z']).folio_at, 'x.y.z');
  assert.equal(parseCookies(['folio_rt=r', 'b=2']).folio_rt, 'r');
  assert.deepEqual(parseCookies(undefined), {});
});

test('cookie name constants', () => {
  assert.equal(AT_COOKIE, 'folio_at');
  assert.equal(RT_COOKIE, 'folio_rt');
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && npm test` → FAIL.

- [ ] **Step 3: Implement `backend/src/session.mjs`**

```js
export const AT_COOKIE = 'folio_at';
export const RT_COOKIE = 'folio_rt';

// Cookie lifetime = refresh-token lifetime (90 d). The access JWT inside
// expires after 30 min; the handler refreshes it transparently.
const TTL = 60 * 60 * 24 * 90;

const cookie = (name, value, maxAge) =>
  `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${maxAge}`;

export function authCookies({ AccessToken, RefreshToken }) {
  return [cookie(AT_COOKIE, AccessToken, TTL), cookie(RT_COOKIE, RefreshToken, TTL)];
}

export function refreshedCookie(accessToken) {
  return cookie(AT_COOKIE, accessToken, TTL);
}

export function clearedCookies() {
  return [cookie(AT_COOKIE, '', 0), cookie(RT_COOKIE, '', 0)];
}

// Lambda Function URL delivers cookies as an array of "name=value" strings.
// Accept that, or a single "a=1; b=2" header string.
export function parseCookies(cookies) {
  const jar = {};
  if (!cookies) return jar;
  const parts = Array.isArray(cookies) ? cookies.flatMap((c) => c.split(';')) : String(cookies).split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) jar[k] = v;
  }
  return jar;
}
```

- [ ] **Step 4: Run tests — PASS expected.**

- [ ] **Step 5: Commit**

```bash
git add backend/src/session.mjs backend/test/session.test.mjs
git commit -m "feat(backend): strict BFF session cookies"
```

---

### Task 8: Cognito client wrapper (`cognito.mjs`)

**Files:**
- Create: `backend/src/cognito.mjs`
- Test: `backend/test/cognito.test.mjs`

Thin command mapper; tests assert the right Command type/input is sent via an injected fake client.

- [ ] **Step 1: Write the failing test** — `backend/test/cognito.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify it fails** — FAIL (module not found).

- [ ] **Step 3: Implement `backend/src/cognito.mjs`**

```js
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
```

- [ ] **Step 4: Run tests — PASS expected.**

- [ ] **Step 5: Commit**

```bash
git add backend/src/cognito.mjs backend/test/cognito.test.mjs
git commit -m "feat(backend): cognito client wrapper"
```

---

### Task 9: Rate limiter (`ratelimit.mjs`)

**Files:**
- Create: `backend/src/ratelimit.mjs`
- Test: `backend/test/ratelimit.test.mjs`

Fixed-window counters in the existing table (`pk = RL#<scope>#<key>#<window>`), expired by the TTL added in Task 1. This is the launch abuse control (WAF deliberately deferred — spec trade-offs).

- [ ] **Step 1: Write the failing test** — `backend/test/ratelimit.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement `backend/src/ratelimit.mjs`**

```js
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

// Per-IP fixed-window counters living in the books table; the table TTL
// sweeps the rows. Launch abuse control — WAF deliberately deferred
// (docs/plan-multi-user-cognito.md, trade-offs).
export const LIMITS = {
  signup:  { limit: 5,  windowSeconds: 3600 },
  login:   { limit: 10, windowSeconds: 900 },
  confirm: { limit: 10, windowSeconds: 3600 },
  forgot:  { limit: 5,  windowSeconds: 3600 },
};

export function makeRateLimiter({
  ddb, table = process.env.TABLE_NAME, now = () => Date.now(),
} = {}) {
  return async function allow(scope, key, { limit, windowSeconds }) {
    const windowId = Math.floor(now() / 1000 / windowSeconds);
    const out = await ddb.send(new UpdateCommand({
      TableName: table,
      Key: { pk: `RL#${scope}#${key}#${windowId}`, id: 'rl' },
      UpdateExpression: 'ADD #c :one SET #t = if_not_exists(#t, :exp)',
      ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':exp': Math.floor(now() / 1000) + windowSeconds * 2,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return (out.Attributes?.count ?? 1) <= limit;
  };
}
```

- [ ] **Step 4: Run tests — PASS expected.**

- [ ] **Step 5: Commit**

```bash
git add backend/src/ratelimit.mjs backend/test/ratelimit.test.mjs
git commit -m "feat(backend): per-IP fixed-window rate limiter on the books table"
```

---

### Task 10: Sub-scoped repository (`repo.mjs` rewrite)

**Files:**
- Modify: `backend/src/repo.mjs` (full rewrite)
- Test: `backend/test/repo.test.mjs`

Every method takes `sub` first; `pk = USER#<sub>`; S3 keys `users/<sub>/pdfs/<id>.pdf`; presigned **POST** with `content-length-range` (PUT cannot enforce size — review #11); `_meta` item carries `tokensValidAfter` (revocation — review #1) and is excluded from listings; quota `MAX_BOOKS`.

- [ ] **Step 1: Write the failing test** — `backend/test/repo.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, MAX_BOOKS, MAX_PDF_BYTES } from '../src/repo.mjs';

// Fake DocumentClient: routes by command name, records inputs.
function fakeDdb(handlers) {
  const sent = [];
  return {
    sent,
    send: async (cmd) => {
      sent.push(cmd);
      const h = handlers[cmd.constructor.name];
      return h ? h(cmd.input) : {};
    },
  };
}

const noS3 = { send: async () => ({}) };

test('listBooks queries USER#<sub> and hides the _meta item', async () => {
  const ddb = fakeDdb({
    QueryCommand: () => ({ Items: [
      { pk: 'USER#abc', id: '_meta', tokensValidAfter: 1 },
      { pk: 'USER#abc', id: 'b1', title: 'Aeneid' },
    ] }),
  });
  const repo = makeRepo({ ddb, s3: noS3, table: 't', bucket: 'b' });
  const books = await repo.listBooks('abc');
  assert.deepEqual(books, [{ id: 'b1', title: 'Aeneid' }]);
  assert.equal(ddb.sent[0].input.ExpressionAttributeValues[':pk'], 'USER#abc');
});

test('putBook enforces the shelf quota for new books only', async () => {
  let getResult = {};
  const ddb = fakeDdb({
    GetCommand: () => getResult,
    QueryCommand: () => ({ Count: MAX_BOOKS }),
    PutCommand: () => ({}),
  });
  const repo = makeRepo({ ddb, s3: noS3, table: 't', bucket: 'b' });
  const blocked = await repo.putBook('abc', { id: 'new' });
  assert.equal(blocked.ok, false);
  getResult = { Item: { pk: 'USER#abc', id: 'new' } }; // existing book: update allowed
  const updated = await repo.putBook('abc', { id: 'new' });
  assert.equal(updated.ok, true);
});

test('putBook writes under USER#<sub>', async () => {
  const ddb = fakeDdb({
    GetCommand: () => ({}),
    QueryCommand: () => ({ Count: 0 }),
    PutCommand: () => ({}),
  });
  const repo = makeRepo({ ddb, s3: noS3, table: 't', bucket: 'b' });
  await repo.putBook('abc', { id: 'b1', title: 'T' });
  const put = ddb.sent.at(-1);
  assert.equal(put.input.Item.pk, 'USER#abc');
  assert.equal(put.input.Item.id, 'b1');
});

test('presignUpload uses presigned POST with size and type conditions', async () => {
  let captured;
  const presignPost = async (_s3, params) => { captured = params; return { url: 'https://x', fields: { k: 'v' } }; };
  const repo = makeRepo({ ddb: fakeDdb({}), s3: noS3, table: 't', bucket: 'b', presignPost });
  const out = await repo.presignUpload('abc', 'b1');
  assert.equal(captured.Key, 'users/abc/pdfs/b1.pdf');
  assert.deepEqual(captured.Conditions[0], ['content-length-range', 1, MAX_PDF_BYTES]);
  assert.equal(captured.Fields['Content-Type'], 'application/pdf');
  assert.deepEqual(out, { url: 'https://x', fields: { k: 'v' } });
});

test('presignDownload signs the caller-scoped key only', async () => {
  let key;
  const presignGet = async (_s3, cmd) => { key = cmd.input.Key; return 'https://signed'; };
  const repo = makeRepo({ ddb: fakeDdb({}), s3: noS3, table: 't', bucket: 'b', presignGet });
  assert.equal(await repo.presignDownload('abc', 'b1'), 'https://signed');
  assert.equal(key, 'users/abc/pdfs/b1.pdf');
});

test('deleteBook removes the row and the scoped object', async () => {
  const deleted = [];
  const s3 = { send: async (cmd) => { deleted.push(cmd.input.Key); return {}; } };
  const ddb = fakeDdb({ DeleteCommand: () => ({}) });
  const repo = makeRepo({ ddb, s3, table: 't', bucket: 'b' });
  await repo.deleteBook('abc', 'b1');
  assert.deepEqual(deleted, ['users/abc/pdfs/b1.pdf']);
});

test('getMeta and bumpTokensValidAfter round-trip the _meta item', async () => {
  let stored;
  const ddb = fakeDdb({
    PutCommand: (input) => { stored = input.Item; return {}; },
    GetCommand: () => ({ Item: stored }),
  });
  const repo = makeRepo({ ddb, s3: noS3, table: 't', bucket: 'b' });
  await repo.bumpTokensValidAfter('abc', 1234);
  const meta = await repo.getMeta('abc');
  assert.equal(meta.tokensValidAfter, 1234);
  assert.equal(stored.pk, 'USER#abc');
  assert.equal(stored.id, '_meta');
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (`makeRepo` not exported).

- [ ] **Step 3: Rewrite `backend/src/repo.mjs`**

```js
import {
  QueryCommand, PutCommand, GetCommand, UpdateCommand, DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

export const MAX_BOOKS = 100;
export const MAX_PDF_BYTES = 100 * 1024 * 1024; // 100 MB

const META_ID = '_meta'; // per-user item: tokensValidAfter (session revocation)

export function makeRepo({
  ddb, s3,
  table = process.env.TABLE_NAME,
  bucket = process.env.PDF_BUCKET,
  presignGet = getSignedUrl,
  presignPost = createPresignedPost,
} = {}) {
  const userPk = (sub) => `USER#${sub}`;
  const pdfKey = (sub, id) => `users/${sub}/pdfs/${id}.pdf`;

  return {
    async listBooks(sub) {
      const out = await ddb.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': userPk(sub) },
      }));
      return (out.Items ?? [])
        .filter((i) => i.id !== META_ID)
        .map(({ pk, ...rest }) => rest);
    },

    async putBook(sub, book) {
      const existing = await ddb.send(new GetCommand({
        TableName: table, Key: { pk: userPk(sub), id: book.id },
      }));
      if (!existing.Item) {
        const count = await ddb.send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :pk',
          FilterExpression: 'id <> :meta',
          Select: 'COUNT',
          ExpressionAttributeValues: { ':pk': userPk(sub), ':meta': META_ID },
        }));
        if ((count.Count ?? 0) >= MAX_BOOKS) {
          return { ok: false, reason: `shelf is full (${MAX_BOOKS} books max)` };
        }
      }
      await ddb.send(new PutCommand({ TableName: table, Item: { pk: userPk(sub), ...book } }));
      return { ok: true };
    },

    async getBook(sub, id) {
      const out = await ddb.send(new GetCommand({
        TableName: table, Key: { pk: userPk(sub), id },
      }));
      if (!out.Item) return null;
      const { pk, ...rest } = out.Item;
      return rest;
    },

    async updateProgress(sub, id, currentPage, lastReadAt) {
      await ddb.send(new UpdateCommand({
        TableName: table,
        Key: { pk: userPk(sub), id },
        UpdateExpression: 'SET currentPage = :p, lastReadAt = :t',
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeValues: { ':p': currentPage, ':t': lastReadAt },
      }));
    },

    async deleteBook(sub, id) {
      await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: userPk(sub), id } }));
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: pdfKey(sub, id) })).catch(() => {});
    },

    presignDownload(sub, id) {
      return presignGet(s3, new GetObjectCommand({ Bucket: bucket, Key: pdfKey(sub, id) }), { expiresIn: 900 });
    },

    // Presigned POST (not PUT): only POST policies can cap the upload size.
    presignUpload(sub, id) {
      return presignPost(s3, {
        Bucket: bucket,
        Key: pdfKey(sub, id),
        Conditions: [
          ['content-length-range', 1, MAX_PDF_BYTES],
          { 'Content-Type': 'application/pdf' },
        ],
        Fields: { 'Content-Type': 'application/pdf' },
        Expires: 900,
      });
    },

    async getMeta(sub) {
      const out = await ddb.send(new GetCommand({
        TableName: table, Key: { pk: userPk(sub), id: META_ID },
      }));
      return out.Item ?? null;
    },

    async bumpTokensValidAfter(sub, now = Date.now()) {
      await ddb.send(new PutCommand({
        TableName: table,
        Item: { pk: userPk(sub), id: META_ID, tokensValidAfter: now },
      }));
    },
  };
}
```

- [ ] **Step 4: Run tests** — `repo.test.mjs` passes. The old `handler.mjs` still imports `* as repo` (named functions that no longer exist) — that breaks at runtime, not at test time; the handler is rewritten next task.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo.mjs backend/test/repo.test.mjs
git commit -m "feat(backend): sub-scoped repo with presigned POST, quota, session meta"
```

---

### Task 11: JWT verifier (`jwt.mjs`)

**Files:**
- Create: `backend/src/jwt.mjs`
- Test: `backend/test/jwt.test.mjs`

Pinning per security review #3: `tokenUse: "access"` + `clientId`, fail closed.

- [ ] **Step 1: Write the failing test** — `backend/test/jwt.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVerifier } from '../src/jwt.mjs';

test('returns null (fails closed) for garbage tokens', async () => {
  const verify = makeVerifier({ userPoolId: 'us-east-1_FAKEFAKE', clientId: 'fakeclient' });
  assert.equal(await verify('not-a-jwt'), null);
  assert.equal(await verify(''), null);
  assert.equal(await verify(undefined), null);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement `backend/src/jwt.mjs`**

```js
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
```

- [ ] **Step 4: Run tests — PASS expected** (garbage fails JWT parsing before any network call).

- [ ] **Step 5: Commit**

```bash
git add backend/src/jwt.mjs backend/test/jwt.test.mjs
git commit -m "feat(backend): pinned cognito access-token verifier"
```

---

### Task 12: Handler rewrite (`handler.mjs`)

**Files:**
- Modify: `backend/src/handler.mjs` (full rewrite)
- Test: `backend/test/handler.test.mjs`

`makeHandler(deps)` factory + lazily-constructed default export (so importing the module in tests never builds real AWS clients). CSRF = required custom header `x-csrf: 1` on every non-GET (review #2 — cross-site fetch can't set custom headers without a CORS preflight we never grant). Session check order: verify AT → `tokensValidAfter` gate (2 s grace for iat second-precision) → fall back to RT refresh.

- [ ] **Step 1: Write the failing test** — `backend/test/handler.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler } from '../src/handler.mjs';

process.env.ORIGIN_SECRET = 'shh';

function mkEvent({ method = 'GET', path = '/', body, cookies, headers = {}, ip = '9.9.9.9' } = {}) {
  return {
    rawPath: path,
    cookies,
    headers: { 'x-origin-secret': 'shh', ...(method !== 'GET' ? { 'x-csrf': '1' } : {}), ...headers },
    requestContext: { http: { method, sourceIp: ip } },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function fakes(overrides = {}) {
  return {
    repo: {
      listBooks: async () => [],
      putBook: async () => ({ ok: true }),
      getBook: async () => null,
      updateProgress: async () => {},
      deleteBook: async () => {},
      presignDownload: async () => 'https://signed-get',
      presignUpload: async () => ({ url: 'https://post', fields: {} }),
      getMeta: async () => null,
      bumpTokensValidAfter: async () => {},
      ...overrides.repo,
    },
    cognito: {
      signUp: async () => ({}),
      confirm: async () => ({}),
      resend: async () => ({}),
      login: async () => ({ AccessToken: 'AT', RefreshToken: 'RT' }),
      refresh: async () => ({ AccessToken: 'AT2' }),
      revoke: async () => ({}),
      forgot: async () => ({}),
      confirmForgot: async () => ({}),
      ...overrides.cognito,
    },
    verifyAccess: overrides.verifyAccess ?? (async (t) => (t === 'AT' ? { sub: 'sub-1', username: 'marco', iat: Math.floor(Date.now() / 1000) } : null)),
    allow: overrides.allow ?? (async () => true),
  };
}

const AUTHED = { cookies: ['folio_at=AT'] };

test('rejects requests without the origin secret', async () => {
  const h = makeHandler(fakes());
  const res = await h({ ...mkEvent(), headers: {} });
  assert.equal(res.statusCode, 403);
});

test('rejects non-GET without the x-csrf header', async () => {
  const h = makeHandler(fakes());
  const res = await h(mkEvent({ method: 'POST', path: '/api/login', body: {}, headers: { 'x-csrf': undefined } }));
  assert.equal(res.statusCode, 403);
});

test('signup validates the handle and lowercases it', async () => {
  const calls = [];
  const h = makeHandler(fakes({ cognito: { signUp: async (u) => { calls.push(u); return {}; } } }));
  const bad = await h(mkEvent({ method: 'POST', path: '/api/signup', body: { username: 'admin', email: 'a@b.c', password: 'x'.repeat(12) } }));
  assert.equal(bad.statusCode, 400);
  const ok = await h(mkEvent({ method: 'POST', path: '/api/signup', body: { username: 'Marco', email: 'a@b.c', password: 'x'.repeat(12) } }));
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(calls, ['marco']);
});

test('signup maps cognito errors without leaking internals', async () => {
  const err = (name) => { const e = new Error(name); e.name = name; throw e; };
  const h = makeHandler(fakes({ cognito: { signUp: async () => err('UsernameExistsException') } }));
  const res = await h(mkEvent({ method: 'POST', path: '/api/signup', body: { username: 'marco', email: 'a@b.c', password: 'x'.repeat(12) } }));
  assert.equal(res.statusCode, 409);
});

test('signup is rate limited', async () => {
  const h = makeHandler(fakes({ allow: async () => false }));
  const res = await h(mkEvent({ method: 'POST', path: '/api/signup', body: { username: 'marco', email: 'a@b.c', password: 'x'.repeat(12) } }));
  assert.equal(res.statusCode, 429);
});

test('login sets both auth cookies; bad login is a generic 401', async () => {
  const h = makeHandler(fakes());
  const ok = await h(mkEvent({ method: 'POST', path: '/api/login', body: { username: 'marco', password: 'pw' } }));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.cookies.length, 2);
  assert.match(ok.cookies[0], /^folio_at=AT;/);
  const fail = makeHandler(fakes({ cognito: { login: async () => { const e = new Error('x'); e.name = 'NotAuthorizedException'; throw e; } } }));
  const bad = await fail(mkEvent({ method: 'POST', path: '/api/login', body: { username: 'marco', password: 'no' } }));
  assert.equal(bad.statusCode, 401);
});

test('authed route works with a valid access cookie and scopes by sub', async () => {
  const seen = [];
  const h = makeHandler(fakes({ repo: { listBooks: async (sub) => { seen.push(sub); return [{ id: 'b1' }]; } } }));
  const res = await h(mkEvent({ path: '/api/books', ...AUTHED }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen, ['sub-1']);
});

test('expired access token + refresh cookie => transparent refresh + new cookie', async () => {
  const h = makeHandler(fakes({
    verifyAccess: async (t) => (t === 'AT2' ? { sub: 'sub-1', username: 'marco', iat: Math.floor(Date.now() / 1000) } : null),
  }));
  const res = await h(mkEvent({ path: '/api/books', cookies: ['folio_at=stale', 'folio_rt=RT'] }));
  assert.equal(res.statusCode, 200);
  assert.match(res.cookies[0], /^folio_at=AT2;/);
});

test('tokensValidAfter newer than the token kills the session', async () => {
  const h = makeHandler(fakes({
    repo: { getMeta: async () => ({ tokensValidAfter: Date.now() + 60_000 }) },
  }));
  const res = await h(mkEvent({ path: '/api/books', ...AUTHED }));
  assert.equal(res.statusCode, 401);
});

test('logout revokes the refresh token, bumps tokensValidAfter, clears cookies', async () => {
  let revoked = null; let bumped = null;
  const h = makeHandler(fakes({
    cognito: { revoke: async (t) => { revoked = t; } },
    repo: { bumpTokensValidAfter: async (sub) => { bumped = sub; } },
  }));
  const res = await h(mkEvent({ method: 'POST', path: '/api/logout', cookies: ['folio_at=AT', 'folio_rt=RT'] }));
  assert.equal(res.statusCode, 200);
  assert.equal(revoked, 'RT');
  assert.equal(bumped, 'sub-1');
  for (const c of res.cookies) assert.match(c, /Max-Age=0$/);
});

test('GET /api/me returns the username', async () => {
  const h = makeHandler(fakes());
  const res = await h(mkEvent({ path: '/api/me', ...AUTHED }));
  assert.deepEqual(JSON.parse(res.body), { username: 'marco' });
});

test('POST /api/books returns the presigned POST and 403 on quota', async () => {
  const h = makeHandler(fakes());
  const ok = await h(mkEvent({ method: 'POST', path: '/api/books', body: { id: 'b1' }, ...AUTHED }));
  assert.deepEqual(JSON.parse(ok.body).upload, { url: 'https://post', fields: {} });
  const full = makeHandler(fakes({ repo: { putBook: async () => ({ ok: false, reason: 'shelf is full' }) } }));
  const res = await full(mkEvent({ method: 'POST', path: '/api/books', body: { id: 'b1' }, ...AUTHED }));
  assert.equal(res.statusCode, 403);
});

test('unauthenticated book routes return 401', async () => {
  const h = makeHandler(fakes());
  assert.equal((await h(mkEvent({ path: '/api/books' }))).statusCode, 401);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (`makeHandler` not exported).

- [ ] **Step 3: Rewrite `backend/src/handler.mjs`**

```js
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { makeRepo } from './repo.mjs';
import { makeCognito } from './cognito.mjs';
import { makeVerifier } from './jwt.mjs';
import { makeRateLimiter, LIMITS } from './ratelimit.mjs';
import {
  parseCookies, authCookies, refreshedCookie, clearedCookies, AT_COOKIE, RT_COOKIE,
} from './session.mjs';
import { validateHandle } from './handle.mjs';

const json = (statusCode, body, cookies = []) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
  ...(cookies.length ? { cookies } : {}),
});

export function makeHandler({ repo, cognito, verifyAccess, allow }) {
  // 2s grace: JWT iat has second precision; a login in the same second as a
  // logout-everywhere bump must not be rejected.
  async function passesRevocationGate(claims) {
    const meta = await repo.getMeta(claims.sub);
    return !meta?.tokensValidAfter || claims.iat * 1000 >= meta.tokensValidAfter - 2000;
  }

  // -> { sub, username, setCookies } | null. Verifies the access token; if
  // stale, transparently refreshes from the refresh-token cookie.
  async function getSession(jar) {
    const claims = await verifyAccess(jar[AT_COOKIE]);
    if (claims) {
      return (await passesRevocationGate(claims)) ? { ...claims, setCookies: [] } : null;
    }
    if (!jar[RT_COOKIE]) return null;
    let result;
    try { result = await cognito.refresh(jar[RT_COOKIE]); } catch { return null; }
    const fresh = await verifyAccess(result?.AccessToken);
    if (!fresh || !(await passesRevocationGate(fresh))) return null;
    return { ...fresh, setCookies: [refreshedCookie(result.AccessToken)] };
  }

  return async function handler(event) {
    // Gate: only CloudFront knows the origin secret (Function URL is public).
    const headers = event.headers ?? {};
    if (!process.env.ORIGIN_SECRET || headers['x-origin-secret'] !== process.env.ORIGIN_SECRET) {
      return json(403, { error: 'forbidden' });
    }

    const method = event.requestContext?.http?.method ?? 'GET';
    const path = (event.rawPath ?? '/').replace(/\/+$/, '') || '/';
    const ip = event.requestContext?.http?.sourceIp ?? 'unknown';
    const jar = parseCookies(event.cookies);
    const body = event.body
      ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body)
      : {};

    // CSRF: cross-site fetch cannot send custom headers without a CORS
    // preflight, which this API never grants. Required on every mutation.
    if (method !== 'GET' && headers['x-csrf'] !== '1') {
      return json(403, { error: 'missing csrf header' });
    }

    try {
      // ---------- public auth routes ----------
      if (method === 'POST' && path === '/api/signup') {
        if (!(await allow('signup', ip, LIMITS.signup))) return json(429, { error: 'too many attempts' });
        const username = String(body.username ?? '').toLowerCase();
        const v = validateHandle(username);
        if (!v.ok) return json(400, { error: v.reason });
        if (!body.email || !body.password) return json(400, { error: 'email and passphrase required' });
        try {
          await cognito.signUp(username, body.password, body.email);
        } catch (err) {
          if (err.name === 'UsernameExistsException') return json(409, { error: 'that username or email is unavailable' });
          if (err.name === 'InvalidPasswordException') return json(400, { error: 'passphrase must be at least 12 characters' });
          if (err.name === 'UserLambdaValidationException') return json(400, { error: 'that username is not allowed' });
          throw err;
        }
        return json(200, { ok: true });
      }

      if (method === 'POST' && path === '/api/confirm') {
        if (!(await allow('confirm', ip, LIMITS.confirm))) return json(429, { error: 'too many attempts' });
        try {
          await cognito.confirm(String(body.username ?? '').toLowerCase(), String(body.code ?? ''));
        } catch {
          return json(400, { error: 'that code did not match' });
        }
        return json(200, { ok: true });
      }

      if (method === 'POST' && path === '/api/resend') {
        if (!(await allow('confirm', ip, LIMITS.confirm))) return json(429, { error: 'too many attempts' });
        try { await cognito.resend(String(body.username ?? '').toLowerCase()); } catch { /* no enumeration */ }
        return json(200, { ok: true });
      }

      if (method === 'POST' && path === '/api/login') {
        if (!(await allow('login', ip, LIMITS.login))) return json(429, { error: 'too many attempts' });
        try {
          const result = await cognito.login(String(body.username ?? '').toLowerCase(), body.password ?? '');
          return json(200, { ok: true }, authCookies(result));
        } catch (err) {
          if (err.name === 'UserNotConfirmedException') return json(403, { error: 'unconfirmed' });
          return json(401, { error: 'invalid credentials' });
        }
      }

      if (method === 'POST' && path === '/api/forgot') {
        if (!(await allow('forgot', ip, LIMITS.forgot))) return json(429, { error: 'too many attempts' });
        try { await cognito.forgot(String(body.username ?? '').toLowerCase()); } catch { /* no enumeration */ }
        return json(200, { ok: true });
      }

      if (method === 'POST' && path === '/api/forgot/confirm') {
        if (!(await allow('forgot', ip, LIMITS.forgot))) return json(429, { error: 'too many attempts' });
        try {
          await cognito.confirmForgot(
            String(body.username ?? '').toLowerCase(), String(body.code ?? ''), body.password ?? '',
          );
        } catch {
          return json(400, { error: 'could not reset the passphrase' });
        }
        return json(200, { ok: true });
      }

      // ---------- session routes ----------
      const session = await getSession(jar);

      if (method === 'POST' && path === '/api/logout') {
        if (jar[RT_COOKIE]) { try { await cognito.revoke(jar[RT_COOKIE]); } catch { /* already dead */ } }
        if (session) await repo.bumpTokensValidAfter(session.sub);
        return json(200, { ok: true }, clearedCookies());
      }

      if (!session) return json(401, { error: 'unauthorized' });
      const { sub, setCookies } = session;

      if (method === 'GET' && path === '/api/me') {
        return json(200, { username: session.username }, setCookies);
      }

      if (method === 'GET' && path === '/api/books') {
        return json(200, { books: await repo.listBooks(sub) }, setCookies);
      }

      if (method === 'POST' && path === '/api/books') {
        if (!body.id) return json(400, { error: 'missing id' });
        const put = await repo.putBook(sub, body);
        if (!put.ok) return json(403, { error: put.reason }, setCookies);
        const upload = await repo.presignUpload(sub, body.id);
        return json(200, { ok: true, upload }, setCookies);
      }

      const m = path.match(/^\/api\/books\/([^/]+)(\/url|\/progress)?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const sub2 = m[2];

        if (method === 'GET' && sub2 === '/url') {
          const book = await repo.getBook(sub, id);
          if (!book) return json(404, { error: 'not found' }, setCookies);
          return json(200, { url: await repo.presignDownload(sub, id) }, setCookies);
        }
        if (method === 'PUT' && sub2 === '/progress') {
          if (typeof body.currentPage !== 'number') return json(400, { error: 'currentPage required' }, setCookies);
          await repo.updateProgress(sub, id, body.currentPage, body.lastReadAt ?? Date.now());
          return json(200, { ok: true }, setCookies);
        }
        if (method === 'DELETE' && !sub2) {
          await repo.deleteBook(sub, id);
          return json(200, { ok: true }, setCookies);
        }
      }

      return json(404, { error: 'no route' }, setCookies);
    } catch (err) {
      console.error('handler error', err);
      return json(500, { error: 'server error' });
    }
  };
}

// Lazy so importing this module never constructs AWS clients in tests.
let live;
export async function handler(event) {
  if (!live) {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const s3 = new S3Client({});
    live = makeHandler({
      repo: makeRepo({ ddb, s3 }),
      cognito: makeCognito(),
      verifyAccess: makeVerifier(),
      allow: makeRateLimiter({ ddb }),
    });
  }
  return live(event);
}
```

- [ ] **Step 4: Run the full suite — all PASS expected**

```bash
cd backend && npm test
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/handler.mjs backend/test/handler.test.mjs
git commit -m "feat(backend): BFF handler — cognito auth routes, csrf, refresh, sub-scoped data"
```

---

### Task 13: Frontend — signup/confirm UI and auth flow

**Files:**
- Modify: `project/index.html` (login section, lines 12-30)
- Modify: `project/styles.css` (append)
- Modify: `project/app.ts` (API client ~line 64-130, AUTH section ~line 628-677, init ~line 718-741)

- [ ] **Step 1: Replace the login section** in `project/index.html` (the whole `<section id="login">…</section>`):

```html
<!-- ============ LOGIN ============ -->
<section id="login">
  <div class="vignette"></div>
  <div class="login-card">
    <div class="crest">F</div>
    <h1>FOLIUM</h1>
    <p class="tag">a private reading room</p>
    <div class="auth-tabs">
      <button id="tab-signin" type="button" class="active">Sign in</button>
      <button id="tab-join" type="button">Join</button>
    </div>
    <form id="login-form" autocomplete="on">
      <div class="field">
        <label for="login-user">Username or email</label>
        <input id="login-user" type="text" autocomplete="username" required>
      </div>
      <div class="field">
        <label for="login-pass">Passphrase</label>
        <input id="login-pass" type="password" autocomplete="current-password" required>
      </div>
      <button class="btn-primary" type="submit">Enter the reading room</button>
    </form>
    <form id="signup-form" class="hidden" autocomplete="on">
      <div class="field">
        <label for="su-user">Username</label>
        <input id="su-user" type="text" minlength="4" maxlength="12" autocomplete="username"
               pattern="[a-zA-Z0-9][a-zA-Z0-9\-]{2,10}[a-zA-Z0-9]" required>
        <p class="hint">4–12 characters: letters, digits, hyphens</p>
      </div>
      <div class="field">
        <label for="su-email">Email</label>
        <input id="su-email" type="email" autocomplete="email" required>
      </div>
      <div class="field">
        <label for="su-pass">Passphrase</label>
        <input id="su-pass" type="password" minlength="12" autocomplete="new-password" required>
        <p class="hint">at least 12 characters</p>
      </div>
      <button class="btn-primary" type="submit">Request a reading card</button>
    </form>
    <form id="confirm-form" class="hidden">
      <p class="confirm-note">A six-digit code is on its way to <strong id="confirm-email"></strong>.</p>
      <div class="field">
        <label for="cf-code">Verification code</label>
        <input id="cf-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required>
      </div>
      <button class="btn-primary" type="submit">Open my reading card</button>
      <button class="linklike" id="cf-resend" type="button">Resend the code</button>
    </form>
    <p class="login-note">Your shelf follows you to any device.</p>
  </div>
</section>
```

- [ ] **Step 2: Append auth styles** to `project/styles.css` (match the existing warm-paper variables already used in the file — inspect the `.login-card` rules and reuse their color tokens; these rules only add layout):

```css
/* ---- auth tabs & confirm step ---- */
.auth-tabs { display: flex; gap: 0; margin: 0 0 18px; border-bottom: 1px solid rgba(0,0,0,.15); }
.auth-tabs button {
  flex: 1; padding: 10px 0; background: none; border: none; cursor: pointer;
  font: inherit; letter-spacing: .08em; text-transform: uppercase; font-size: 12px;
  opacity: .55; border-bottom: 2px solid transparent;
}
.auth-tabs button.active { opacity: 1; border-bottom-color: currentColor; }
.field .hint { margin: 4px 0 0; font-size: 11.5px; opacity: .6; }
.confirm-note { font-size: 13.5px; line-height: 1.5; margin: 0 0 14px; }
.linklike {
  display: block; margin: 12px auto 0; background: none; border: none; cursor: pointer;
  font: inherit; font-size: 12.5px; text-decoration: underline; opacity: .7;
}
.linklike:hover { opacity: 1; }
```

- [ ] **Step 3: Update the API client in `project/app.ts`** — replace the `api()` helper (lines 68-76) so every request carries the CSRF header:

```ts
async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  const res = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf': '1', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) { onUnauthorized(); throw new Error('unauthorized'); }
  return res;
}
```

- [ ] **Step 4: Switch `dbPut` to presigned POST** — replace the upload half of `dbPut` (lines 90-103):

```ts
async function dbPut(b: Book): Promise<void> {
  const meta: BookMeta = stripData(b);
  const res = await api('/books', { method: 'POST', body: JSON.stringify(meta) });
  if (res.status === 403) { const { error } = await res.json(); toast(error || 'Shelf is full'); throw new Error('quota'); }
  if (!res.ok) throw new Error('save failed');
  const { upload } = await res.json();
  if (b.data && upload) {
    const form = new FormData();
    for (const [k, v] of Object.entries(upload.fields as Record<string, string>)) form.append(k, v);
    form.append('file', new Blob([b.data], { type: 'application/pdf' }));
    const post = await fetch(upload.url, { method: 'POST', body: form });
    if (!post.ok) throw new Error('upload failed');
  }
}
```

- [ ] **Step 5: Rewrite the AUTH section** — replace `showApp`/`wireAuth` (lines 631-677) with:

```ts
function showApp(name: string): void {
  el('login').classList.add('hidden');
  el('app').classList.remove('hidden');
  const initial = (name.trim()[0] || 'R').toUpperCase();
  el('avatar-initial').textContent = initial;
  el('user-name').textContent = name.trim() || 'Reader';
}

function fieldValue(id: string): string {
  return (el(id) as HTMLInputElement).value.trim();
}

function wireAuth(): void {
  const showForm = (which: 'login' | 'signup' | 'confirm') => {
    el('login-form').classList.toggle('hidden', which !== 'login');
    el('signup-form').classList.toggle('hidden', which !== 'signup');
    el('confirm-form').classList.toggle('hidden', which !== 'confirm');
    el('tab-signin').classList.toggle('active', which === 'login');
    el('tab-join').classList.toggle('active', which !== 'login');
  };
  el('tab-signin').addEventListener('click', () => showForm('login'));
  el('tab-join').addEventListener('click', () => showForm('signup'));

  // Held between signup and confirm so we can auto-login after the OTP.
  let pending: { username: string; password: string } | null = null;

  const post = (path: string, body: unknown) =>
    fetch('/api' + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf': '1' },
      body: JSON.stringify(body),
    });

  async function finishLogin(username: string, password: string): Promise<void> {
    const res = await post('/login', { username, password });
    if (res.status === 403) { toast('Confirm your email first'); return; }
    if (!res.ok) { toast('Wrong username or passphrase'); return; }
    const me = await (await api('/me')).json();
    showApp(me.username);
    await boot();
  }

  el<HTMLFormElement>('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await finishLogin(fieldValue('login-user'), (el('login-pass') as HTMLInputElement).value); }
    catch { toast('Could not reach the server'); }
  });

  el<HTMLFormElement>('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = fieldValue('su-user').toLowerCase();
    const password = (el('su-pass') as HTMLInputElement).value;
    const email = fieldValue('su-email');
    try {
      const res = await post('/signup', { username, email, password });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: 'Signup failed' }));
        toast(error || 'Signup failed');
        return;
      }
      pending = { username, password };
      el('confirm-email').textContent = email;
      showForm('confirm');
    } catch { toast('Could not reach the server'); }
  });

  el<HTMLFormElement>('confirm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pending) { showForm('login'); return; }
    try {
      const res = await post('/confirm', { username: pending.username, code: fieldValue('cf-code') });
      if (!res.ok) { toast('That code did not match'); return; }
      await finishLogin(pending.username, pending.password);
      pending = null;
    } catch { toast('Could not reach the server'); }
  });

  el('cf-resend').addEventListener('click', async () => {
    if (!pending) return;
    try { await post('/resend', { username: pending.username }); toast('Code re-sent'); } catch {}
  });

  el('avatar').addEventListener('click', (e) => {
    e.stopPropagation();
    el('dropdown').classList.toggle('hidden');
  });
  document.addEventListener('click', () => el('dropdown').classList.add('hidden'));
  el('dropdown').addEventListener('click', (e) => e.stopPropagation());
  el('btn-logout').addEventListener('click', async () => {
    try { await post('/logout', {}); } catch {}
    el('app').classList.add('hidden');
    el('login').classList.remove('hidden');
    el('dropdown').classList.add('hidden');
    (el('login-pass') as HTMLInputElement).value = '';
    booted = false;
    books = [];
  });
  el('brand').addEventListener('click', () => { if (el('reader').classList.contains('show')) closeReader(); });
}
```

- [ ] **Step 6: Cookie-based session restore in `init()`** — replace the `// restore session` block (the `localStorage.getItem(LS.user)` part at the end of `init()`):

```ts
  // restore session from the HttpOnly cookie (the server refreshes if stale)
  (async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      if (res.ok) {
        const me = await res.json();
        showApp(me.username);
        boot();
      }
    } catch { /* show login */ }
  })();
```

Also delete the `user: 'folium.user'` entry from the `LS` object (line ~134) and the `localStorage.setItem(LS.user, ...)` / `removeItem(LS.user)` calls inside `_onUnauthorized` (keep the rest of `_onUnauthorized` unchanged).

- [ ] **Step 7: Build and commit**

```bash
npm run build
```
Expected: esbuild completes with no TypeScript errors.

```bash
git add project/index.html project/styles.css project/app.ts
git commit -m "feat(frontend): signup, email OTP confirm, cookie session restore"
```

---

### Task 14: Retire legacy auth

**Files:**
- Delete: `backend/src/auth.mjs`, `backend/src/config.mjs`, `backend/test/auth.test.mjs`, `infra/ssm.tf`
- Modify: `infra/lambda.tf`, `backend/package.json`, `README.md`

Security review #15: leaving a readable `app_password` around is residual attack surface.

- [ ] **Step 1: Delete dead modules and tests**

```bash
git rm backend/src/auth.mjs backend/src/config.mjs backend/test/auth.test.mjs infra/ssm.tf
```

- [ ] **Step 2: Clean `infra/lambda.tf`** — remove the SSM statement from `aws_iam_role_policy.lambda` (the block whose Action is `["ssm:GetParameters"]`) and remove these two lines from the function env:

```hcl
      PASSWORD_PARAM = aws_ssm_parameter.password.name
      HMAC_PARAM     = aws_ssm_parameter.hmac_key.name
```

- [ ] **Step 3: Drop the SSM SDK dep**

```bash
cd backend && npm uninstall @aws-sdk/client-ssm
```

- [ ] **Step 4: Update `README.md`** — replace the feature bullet `**Classy login gate** — remembers you on this device` with:

```markdown
- **Reading cards** — personal accounts (Cognito): pick a handle, verify your email, stay signed in for 90 days
```

- [ ] **Step 5: Verify everything still passes**

```bash
cd backend && npm test && cd .. && npm run build && terraform -chdir=infra validate
```
Expected: tests PASS, build clean, `Success! The configuration is valid.`

Note: `terraform apply` will DELETE the two SSM parameters — that is intentional and irreversible; the old shared password stops working at the same deploy that enables Cognito login. Single cutover, no dual-auth window (acceptable: user base is one person until migration).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat!: retire shared-password auth (SSM params, HMAC sessions)"
```

---

### Task 15: Migration script (single-user library → owner account)

**Files:**
- Create: `backend/scripts/migrate-lib-to-user.mjs`

Idempotent, dry-run by default, copy-verify (no source deletes — old `pdfs/*` objects stay until manually removed after verification; review #14). Run AFTER deploy + owner signup.

- [ ] **Step 1: Create `backend/scripts/migrate-lib-to-user.mjs`**

```js
// One-off: reassign the single-user library (pk='lib', s3://.../pdfs/*) to a
// real account. Dry-run by default; pass --apply to write.
//
// Usage:
//   aws cognito-idp list-users --user-pool-id <pool> \
//     --query 'Users[].{u:Username,sub:Attributes[?Name==`sub`].Value|[0]}'
//   TABLE_NAME=folio-books PDF_BUCKET=folio-pdfs-<acct> \
//     node scripts/migrate-lib-to-user.mjs --sub <owner-sub> [--apply]
//
// Idempotent: re-runs skip items/objects that already exist at the target.
// Old pk='lib' rows and pdfs/* objects are left in place; delete them by hand
// after verifying the app works for the owner account.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TABLE = process.env.TABLE_NAME;
const BUCKET = process.env.PDF_BUCKET;
const sub = process.argv[process.argv.indexOf('--sub') + 1];
const apply = process.argv.includes('--apply');

if (!TABLE || !BUCKET || !sub || sub.startsWith('--')) {
  console.error('need TABLE_NAME, PDF_BUCKET env and --sub <cognito-sub>');
  process.exit(1);
}

const out = await ddb.send(new QueryCommand({
  TableName: TABLE,
  KeyConditionExpression: 'pk = :pk',
  ExpressionAttributeValues: { ':pk': 'lib' },
}));
const books = out.Items ?? [];
console.log(`${books.length} legacy books; target pk USER#${sub}${apply ? '' : ' (dry run)'}`);

for (const item of books) {
  const { pk, ...book } = item;
  const target = { pk: `USER#${sub}`, ...book };

  const existing = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { pk: target.pk, id: book.id },
  }));
  if (existing.Item) { console.log(`= ${book.id} (row already migrated)`); }
  else if (apply) {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: target }));
    console.log(`+ ${book.id} row copied`);
  } else console.log(`~ ${book.id} row would copy`);

  const srcKey = `pdfs/${book.id}.pdf`;
  const dstKey = `users/${sub}/pdfs/${book.id}.pdf`;
  const dstExists = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: dstKey }))
    .then(() => true).catch(() => false);
  if (dstExists) { console.log(`= ${dstKey} (object already migrated)`); continue; }
  const srcExists = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: srcKey }))
    .then(() => true).catch(() => false);
  if (!srcExists) { console.log(`! ${srcKey} missing in S3 — skipping object`); continue; }
  if (apply) {
    await s3.send(new CopyObjectCommand({
      Bucket: BUCKET, Key: dstKey, CopySource: `${BUCKET}/${encodeURIComponent(srcKey)}`,
    }));
    console.log(`+ ${dstKey} object copied`);
  } else console.log(`~ ${dstKey} object would copy`);
}
console.log('done. verify in the app, then delete pk=lib rows and pdfs/* objects manually.');
```

- [ ] **Step 2: Syntax-check (no AWS calls without env, so just parse)**

```bash
cd backend && node --check scripts/migrate-lib-to-user.mjs
```
Expected: exits 0, no output.

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/migrate-lib-to-user.mjs
git commit -m "feat(backend): idempotent legacy-library migration script"
```

---

### Task 16: Final verification

- [ ] **Step 1: Full local verification**

```bash
cd backend && npm test
cd .. && npm run build
terraform -chdir=infra validate
```
Expected: every test PASS, clean build, valid config.

- [ ] **Step 2: Review the diff against the spec** (`docs/plan-multi-user-cognito.md`) — confirm: Lite tier set, no `cognito-idp:Admin*` IAM, presigned POST not PUT, `SameSite=Strict`, `x-csrf` on all mutations, `tokensValidAfter` enforced, reserved list matches the appendix, SSM params gone.

- [ ] **Step 3: Merge/PR per repo convention** (use superpowers:finishing-a-development-branch).

**Post-merge operational sequence (manual, in order):**
1. CI applies Terraform (Cognito pool, SES identity + DNS, presignup fn, env/IAM).
2. Wait for SES identity to show "verified" (DKIM records propagate, ~minutes).
3. Sign up the owner account in the live app; verify email OTP arrives.
4. `aws cognito-idp list-users --user-pool-id <pool>` → grab the owner `sub`.
5. Run migration dry-run, then `--apply`; verify shelf loads under the owner login.
6. After a comfortable soak: manually delete `pk=lib` rows and `pdfs/*` objects.
