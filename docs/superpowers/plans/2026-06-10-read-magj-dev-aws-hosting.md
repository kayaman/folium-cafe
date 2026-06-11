# read.magj.dev — Stateful PDF Reader on AWS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host the Folio PDF reader at `https://read.magj.dev` on cheap AWS, with single-user server-side state (library + reading position) provisioned by Terraform and deployed by GitHub Actions.

**Architecture:** One CloudFront distribution serves the static site from a private S3 bucket (default behavior) and routes `/api/*` to a Node.js 20 Lambda Function URL (OAC-signed, not public). The Lambda stores book metadata + current page in DynamoDB and hands the browser presigned S3 URLs to upload/download PDF bytes directly. A single password (SSM SecureString) gates access via an HMAC-signed httpOnly cookie.

**Tech Stack:** Terraform 1.10, AWS (CloudFront, S3, Lambda Function URL, DynamoDB, ACM, Route 53, SSM, IAM/OIDC), Node.js 20 ESM + AWS SDK v3, esbuild (existing), GitHub Actions.

**Reference spec:** `docs/superpowers/specs/2026-06-10-read-magj-dev-aws-hosting-design.md`

---

## Conventions used throughout

- **AWS account:** `257394450889` · **Region:** `us-east-1` · **Domain:** `read.magj.dev` · **Hosted zone:** `magj.dev` (existing) · **GitHub repo:** `kayaman/reader`.
- Run all `terraform` commands from inside the stack directory (`infra/bootstrap` or `infra`).
- Run all `node`/`npm` commands for the backend from inside `backend/`.
- Commit messages use Conventional Commits. Commit after every task.
- Where a step says `terraform apply`, you may inspect the plan first; this plan assumes you approve.

## File structure (what gets created)

```
.gitignore                         # add TF/build artifacts
backend/
  package.json                     # Lambda deps (AWS SDK v3), ESM, test script
  src/auth.mjs                     # cookie HMAC sign/verify, cookie parsing
  src/config.mjs                   # cached SSM param loader (password, hmac key)
  src/repo.mjs                     # DynamoDB + S3 data access (presign, CRUD)
  src/handler.mjs                  # Function URL router (the Lambda entry point)
  test/auth.test.mjs               # node:test unit tests for auth.mjs
infra/
  bootstrap/main.tf                # one-time: TF state bucket + lock table (local state)
  versions.tf                      # required_providers + terraform version
  backend.tf                       # remote S3 backend for the main stack
  providers.tf                     # aws provider (us-east-1)
  variables.tf                     # inputs (domain, repo, etc.)
  data.tf                          # route53 zone + caller identity data sources
  data_stores.tf                   # DynamoDB table + private PDF S3 bucket (+CORS)
  ssm.tf                           # SecureString params (placeholder values)
  lambda.tf                        # Lambda + Function URL + role + log group
  frontend.tf                      # private site S3 bucket
  dns_cert.tf                      # ACM cert (DNS-validated) + Route53 records
  cloudfront.tf                    # distribution: default->S3, /api/*->Lambda, OAC
  cicd.tf                          # GitHub OIDC provider + CI role + policy
  outputs.tf                       # names/ids the deploy workflow needs
.github/workflows/
  ci.yml                           # PR: build + terraform fmt/validate/plan
  deploy.yml                       # main: terraform apply + upload site + lambda + invalidate
project/app.ts                     # swap IndexedDB layer for API client; real login
```

---

## Phase 0 — Repo hygiene

### Task 0: Ignore generated artifacts

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Append Terraform and backend build artifacts to `.gitignore`**

Append these lines to `.gitignore` (it currently only has `node_modules/`):

```gitignore
# Terraform
**/.terraform/*
*.tfstate
*.tfstate.*
crash.log
*.tfplan
.terraform.lock.hcl

# Backend build
backend/node_modules/
backend/dist/
backend/function.zip

# Built frontend (built in CI; keep source app.ts)
project/app.js
```

> Note: `.terraform.lock.hcl` is ignored here for simplicity since this is a solo project; if you later want reproducible provider pins in CI, remove that one line and commit the lock file.

- [ ] **Step 2: Verify nothing already-tracked is now ignored unexpectedly**

Run: `git status --short`
Expected: clean working tree except the modified `.gitignore`. (`project/app.js` exists on disk but is untracked — confirm with `git ls-files project/app.js` printing nothing.)

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore terraform and backend build artifacts"
```

---

## Phase 1 — Terraform state backend (bootstrap)

This is a separate stack with **local** state because it creates the bucket that will hold everyone else's remote state.

### Task 1: Bootstrap the remote-state bucket + lock table

**Files:**
- Create: `infra/bootstrap/main.tf`

- [ ] **Step 1: Write the bootstrap stack**

Create `infra/bootstrap/main.tf`:

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

locals {
  state_bucket = "folio-tfstate-257394450889"
  lock_table   = "folio-tflock"
}

resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "lock" {
  name         = local.lock_table
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"
  attribute {
    name = "LockID"
    type = "S"
  }
}

output "state_bucket" { value = aws_s3_bucket.state.bucket }
output "lock_table" { value = aws_dynamodb_table.lock.name }
```

- [ ] **Step 2: Init and apply the bootstrap stack**

Run:
```bash
cd infra/bootstrap
terraform init
terraform apply
```
Expected: prompts `yes`, then creates `aws_s3_bucket.state`, versioning, encryption, public-access-block, and `aws_dynamodb_table.lock`. Outputs `state_bucket = "folio-tfstate-257394450889"` and `lock_table = "folio-tflock"`.

- [ ] **Step 3: Commit (state file is gitignored)**

```bash
cd ../..
git add infra/bootstrap/main.tf
git commit -m "feat(infra): bootstrap terraform remote state bucket and lock table"
```

---

## Phase 2 — Lambda backend (with unit tests)

Build the backend before the main Terraform stack so the deployable zip and its contract exist. The security-critical cookie HMAC gets real TDD; data access is integration-level and verified end-to-end in Phase 7.

### Task 2: Backend package manifest

**Files:**
- Create: `backend/package.json`

- [ ] **Step 1: Write the manifest**

Create `backend/package.json`:

```json
{
  "name": "folio-backend",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Folio reader Lambda backend (Function URL)",
  "scripts": {
    "test": "node --test",
    "zip": "rm -f function.zip && zip -rq function.zip src node_modules package.json"
  },
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.600.0",
    "@aws-sdk/lib-dynamodb": "^3.600.0",
    "@aws-sdk/client-s3": "^3.600.0",
    "@aws-sdk/s3-request-presigner": "^3.600.0",
    "@aws-sdk/client-ssm": "^3.600.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
cd backend
npm install
```
Expected: creates `backend/node_modules` and `backend/package-lock.json`, no errors.

- [ ] **Step 3: Commit**

```bash
cd ..
git add backend/package.json backend/package-lock.json
git commit -m "feat(backend): add Lambda package manifest and AWS SDK v3 deps"
```

### Task 3: Cookie auth (TDD)

**Files:**
- Create: `backend/src/auth.mjs`
- Test: `backend/test/auth.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `backend/test/auth.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, parseCookies } from '../src/auth.mjs';

const KEY = 'test-hmac-key-0123456789';

test('signSession then verifySession round-trips and is valid', () => {
  const token = signSession(KEY, 3600);
  assert.equal(typeof token, 'string');
  assert.equal(verifySession(KEY, token), true);
});

test('verifySession rejects a tampered token', () => {
  const token = signSession(KEY, 3600);
  const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  assert.equal(verifySession(KEY, tampered), false);
});

test('verifySession rejects a token signed with a different key', () => {
  const token = signSession(KEY, 3600);
  assert.equal(verifySession('a-different-key', token), false);
});

test('verifySession rejects an expired token', () => {
  const token = signSession(KEY, -10); // expired 10s ago
  assert.equal(verifySession(KEY, token), false);
});

test('verifySession rejects garbage', () => {
  assert.equal(verifySession(KEY, ''), false);
  assert.equal(verifySession(KEY, 'not.a.token'), false);
  assert.equal(verifySession(KEY, undefined), false);
});

test('parseCookies reads a named cookie from a Cookie header string', () => {
  const jar = parseCookies(['a=1; folio_session=abc.def; b=2']);
  assert.equal(jar.folio_session, 'abc.def');
  assert.equal(jar.a, '1');
});

test('parseCookies handles the Function URL cookies array', () => {
  const jar = parseCookies(['folio_session=xyz', 'other=1']);
  assert.equal(jar.folio_session, 'xyz');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test test/auth.test.mjs`
Expected: FAIL — cannot find module `../src/auth.mjs`.

- [ ] **Step 3: Implement `auth.mjs`**

Create `backend/src/auth.mjs`:

```js
import crypto from 'node:crypto';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function hmac(key, msg) {
  return b64url(crypto.createHmac('sha256', key).update(msg).digest());
}

// Token format: base64url(JSON{exp}) + "." + hmac
export function signSession(key, ttlSeconds) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = b64url(JSON.stringify({ exp }));
  return `${payload}.${hmac(key, payload)}`;
}

export function verifySession(key, token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = hmac(key, payload);
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    return typeof exp === 'number' && exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
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

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test test/auth.test.mjs`
Expected: PASS — all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ..
git add backend/src/auth.mjs backend/test/auth.test.mjs
git commit -m "feat(backend): HMAC session cookie sign/verify with tests"
```

### Task 4: SSM config loader

**Files:**
- Create: `backend/src/config.mjs`

- [ ] **Step 1: Implement the cached config loader**

Create `backend/src/config.mjs`:

```js
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
```

- [ ] **Step 2: Sanity-check it parses (syntax only)**

Run: `cd backend && node --check src/config.mjs && echo OK`
Expected: prints `OK` (no syntax errors).

- [ ] **Step 3: Commit**

```bash
cd ..
git add backend/src/config.mjs
git commit -m "feat(backend): cached SSM config loader for password and hmac key"
```

### Task 5: Data access (DynamoDB + S3 presign)

**Files:**
- Create: `backend/src/repo.mjs`

- [ ] **Step 1: Implement the repository**

Create `backend/src/repo.mjs`:

```js
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, QueryCommand, PutCommand, GetCommand,
  UpdateCommand, DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TABLE = process.env.TABLE_NAME;
const BUCKET = process.env.PDF_BUCKET;
const PK = 'lib'; // single-user partition

const pdfKey = (id) => `pdfs/${id}.pdf`;

export async function listBooks() {
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': PK },
  }));
  // Strip the partition key from the response.
  return (out.Items ?? []).map(({ pk, ...rest }) => rest);
}

export async function putBook(book) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: PK, ...book } }));
}

export async function getBook(id) {
  const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: PK, id } }));
  if (!out.Item) return null;
  const { pk, ...rest } = out.Item;
  return rest;
}

export async function updateProgress(id, currentPage, lastReadAt) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: PK, id },
    UpdateExpression: 'SET currentPage = :p, lastReadAt = :t',
    ConditionExpression: 'attribute_exists(id)',
    ExpressionAttributeValues: { ':p': currentPage, ':t': lastReadAt },
  }));
}

export async function deleteBook(id) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK, id } }));
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: pdfKey(id) })).catch(() => {});
}

export function presignPut(id) {
  return getSignedUrl(s3, new PutObjectCommand({
    Bucket: BUCKET, Key: pdfKey(id), ContentType: 'application/pdf',
  }), { expiresIn: 900 });
}

export function presignGet(id) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: pdfKey(id) }), { expiresIn: 900 });
}
```

- [ ] **Step 2: Syntax check**

Run: `cd backend && node --check src/repo.mjs && echo OK`
Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
cd ..
git add backend/src/repo.mjs
git commit -m "feat(backend): DynamoDB + S3 presign data access layer"
```

### Task 6: The Function URL router

**Files:**
- Create: `backend/src/handler.mjs`

- [ ] **Step 1: Implement the handler**

Create `backend/src/handler.mjs`. The Function URL uses payload format 2.0 (`event.requestContext.http.method`, `event.rawPath`, `event.cookies`).

```js
import { getConfig } from './config.mjs';
import { signSession, verifySession, parseCookies, timingSafeEqualStr } from './auth.mjs';
import * as repo from './repo.mjs';

const COOKIE = 'folio_session';
const TTL = 60 * 60 * 24 * 30; // 30 days

const json = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
  ...extra,
});

function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function authed(event) {
  const { hmacKey } = await getConfig();
  const jar = parseCookies(event.cookies);
  return verifySession(hmacKey, jar[COOKIE]);
}

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = (event.rawPath ?? '/').replace(/\/+$/, '') || '/';
  const body = event.body
    ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body)
    : {};

  try {
    // --- login (unauthenticated) ---
    if (method === 'POST' && path === '/api/login') {
      const { password, hmacKey } = await getConfig();
      if (!password || !timingSafeEqualStr(body.password ?? '', password)) {
        return json(401, { error: 'bad password' });
      }
      const token = signSession(hmacKey, TTL);
      return json(200, { ok: true }, { cookies: [sessionCookie(token, TTL)] });
    }

    // --- everything below requires a valid session ---
    if (!(await authed(event))) return json(401, { error: 'unauthorized' });

    if (method === 'POST' && path === '/api/logout') {
      return json(200, { ok: true }, { cookies: [sessionCookie('', 0)] });
    }

    if (method === 'GET' && path === '/api/books') {
      return json(200, { books: await repo.listBooks() });
    }

    if (method === 'POST' && path === '/api/books') {
      // body: full Book metadata (without the file bytes)
      if (!body.id) return json(400, { error: 'missing id' });
      await repo.putBook(body);
      const uploadUrl = await repo.presignPut(body.id);
      return json(200, { ok: true, uploadUrl });
    }

    const m = path.match(/^\/api\/books\/([^/]+)(\/url|\/progress)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2];

      if (method === 'GET' && sub === '/url') {
        const book = await repo.getBook(id);
        if (!book) return json(404, { error: 'not found' });
        return json(200, { url: await repo.presignGet(id) });
      }
      if (method === 'PUT' && sub === '/progress') {
        if (typeof body.currentPage !== 'number') return json(400, { error: 'currentPage required' });
        await repo.updateProgress(id, body.currentPage, body.lastReadAt ?? Date.now());
        return json(200, { ok: true });
      }
      if (method === 'DELETE' && !sub) {
        await repo.deleteBook(id);
        return json(200, { ok: true });
      }
    }

    return json(404, { error: 'no route' });
  } catch (err) {
    console.error('handler error', err);
    return json(500, { error: 'server error' });
  }
}
```

- [ ] **Step 2: Syntax check and run the full backend test suite**

Run:
```bash
cd backend && node --check src/handler.mjs && node --test
```
Expected: `node --check` is silent (ok); `node --test` reports all auth tests passing.

- [ ] **Step 3: Commit**

```bash
cd ..
git add backend/src/handler.mjs
git commit -m "feat(backend): Function URL router with login + books routes"
```

---

## Phase 3 — Main Terraform stack

All files live in `infra/`. We write them, then `init` against the remote backend, then `validate`. The first real `apply` happens in Phase 4 after secrets are set.

### Task 7: Providers, versions, variables, data sources, backend

**Files:**
- Create: `infra/versions.tf`, `infra/providers.tf`, `infra/variables.tf`, `infra/data.tf`, `infra/backend.tf`

- [ ] **Step 1: Write `infra/versions.tf`**

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
```

- [ ] **Step 2: Write `infra/providers.tf`**

```hcl
# CloudFront requires its ACM cert in us-east-1, and the whole stack lives there,
# so a single default provider in us-east-1 suffices.
provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = {
      Project = "folio"
      App     = "read.magj.dev"
    }
  }
}
```

- [ ] **Step 3: Write `infra/variables.tf`**

```hcl
variable "domain_name" {
  type    = string
  default = "read.magj.dev"
}

variable "hosted_zone_name" {
  type    = string
  default = "magj.dev"
}

variable "github_repo" {
  type    = string
  default = "kayaman/reader"
}

variable "name_prefix" {
  type    = string
  default = "folio"
}
```

- [ ] **Step 4: Write `infra/data.tf`**

```hcl
data "aws_caller_identity" "current" {}

data "aws_route53_zone" "primary" {
  name         = var.hosted_zone_name
  private_zone = false
}
```

- [ ] **Step 5: Write `infra/backend.tf`**

```hcl
terraform {
  backend "s3" {
    bucket         = "folio-tfstate-257394450889"
    key            = "read-magj-dev/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "folio-tflock"
    encrypt        = true
  }
}
```

- [ ] **Step 6: Initialize the remote backend**

Run:
```bash
cd infra
terraform init
```
Expected: `Successfully configured the backend "s3"`, providers installed, `Terraform has been successfully initialized!`.

- [ ] **Step 7: Commit**

```bash
cd ..
git add infra/versions.tf infra/providers.tf infra/variables.tf infra/data.tf infra/backend.tf
git commit -m "feat(infra): providers, variables, data sources, remote backend"
```

### Task 8: Data stores — DynamoDB + private PDF bucket

**Files:**
- Create: `infra/data_stores.tf`

- [ ] **Step 1: Write `infra/data_stores.tf`**

```hcl
resource "aws_dynamodb_table" "books" {
  name         = "${var.name_prefix}-books"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "id"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_s3_bucket" "pdfs" {
  bucket = "${var.name_prefix}-pdfs-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "pdfs" {
  bucket                  = aws_s3_bucket.pdfs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# The browser uploads/downloads directly to S3 via presigned URLs, which is a
# cross-origin request from read.magj.dev, so the bucket needs CORS.
resource "aws_s3_bucket_cors_configuration" "pdfs" {
  bucket = aws_s3_bucket.pdfs.id
  cors_rule {
    allowed_methods = ["GET", "PUT"]
    allowed_origins = ["https://${var.domain_name}"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}
```

- [ ] **Step 2: Validate**

Run: `cd infra && terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
cd ..
git add infra/data_stores.tf
git commit -m "feat(infra): DynamoDB books table and private PDF bucket with CORS"
```

### Task 9: SSM SecureString parameters (placeholder values)

**Files:**
- Create: `infra/ssm.tf`

- [ ] **Step 1: Write `infra/ssm.tf`**

```hcl
# Created with throwaway placeholder values; the real secrets are written once
# out-of-band (see Phase 4) and ignored thereafter so they never enter state diffs.
resource "aws_ssm_parameter" "password" {
  name  = "/${var.name_prefix}/app_password"
  type  = "SecureString"
  value = "change-me-set-out-of-band"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "hmac_key" {
  name  = "/${var.name_prefix}/hmac_key"
  type  = "SecureString"
  value = "change-me-set-out-of-band"

  lifecycle {
    ignore_changes = [value]
  }
}
```

- [ ] **Step 2: Validate**

Run: `cd infra && terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
cd ..
git add infra/ssm.tf
git commit -m "feat(infra): SSM SecureString params for password and hmac key"
```

### Task 10: Lambda + Function URL + IAM role

**Files:**
- Create: `infra/lambda.tf`

- [ ] **Step 1: Write `infra/lambda.tf`**

This packages `backend/` (whatever is on disk, including `node_modules`) into the zip, so CI must `npm ci` in `backend/` before `terraform apply`. Day-to-day code updates push via `update-function-code` in the deploy workflow; Terraform owns the function's existence and config.

```hcl
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../backend"
  output_path = "${path.module}/build/function.zip"
  excludes    = ["test", "function.zip"]
}

resource "aws_iam_role" "lambda" {
  name = "${var.name_prefix}-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = "${var.name_prefix}-lambda-policy"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Query", "dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.books.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.pdfs.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameters"]
        Resource = [aws_ssm_parameter.password.arn, aws_ssm_parameter.hmac_key.arn]
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.name_prefix}-api"
  retention_in_days = 14
}

resource "aws_lambda_function" "api" {
  function_name    = "${var.name_prefix}-api"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "src/handler.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 15
  memory_size      = 256

  environment {
    variables = {
      TABLE_NAME     = aws_dynamodb_table.books.name
      PDF_BUCKET     = aws_s3_bucket.pdfs.bucket
      PASSWORD_PARAM = aws_ssm_parameter.password.name
      HMAC_PARAM     = aws_ssm_parameter.hmac_key.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "AWS_IAM"
}

# Allow CloudFront (via OAC) to invoke the Function URL.
resource "aws_lambda_permission" "cloudfront" {
  statement_id          = "AllowCloudFrontInvoke"
  action                = "lambda:InvokeFunctionUrl"
  function_name         = aws_lambda_function.api.function_name
  principal             = "cloudfront.amazonaws.com"
  source_arn            = aws_cloudfront_distribution.site.arn
  function_url_auth_type = "AWS_IAM"
}
```

> The `archive_file` and `cloudfront` references require the `archive` provider and the CloudFront resource (Task 13). Add the archive provider in the next step.

- [ ] **Step 2: Add the `archive` provider to `infra/versions.tf`**

Edit `infra/versions.tf` so `required_providers` includes archive:

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}
```

Then run `cd infra && terraform init -upgrade` to pull the archive provider.
Expected: archive provider installed.

- [ ] **Step 3: Validate (will pass once CloudFront exists; defer full validate to Task 13)**

Run: `cd infra && terraform validate`
Expected: at this point validate **fails** with a reference to undeclared `aws_cloudfront_distribution.site` — that's expected; it's created in Task 13. Proceed; do not commit a broken validate as "passing".

- [ ] **Step 4: Commit**

```bash
cd ..
git add infra/lambda.tf infra/versions.tf
git commit -m "feat(infra): Lambda function, Function URL, IAM role, log group"
```

### Task 11: Frontend bucket

**Files:**
- Create: `infra/frontend.tf`

- [ ] **Step 1: Write `infra/frontend.tf`**

```hcl
resource "aws_s3_bucket" "site" {
  bucket = "${var.name_prefix}-site-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Only CloudFront (via OAC) may read objects.
resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn }
      }
    }]
  })
}
```

- [ ] **Step 2: Commit (validate deferred to Task 13)**

```bash
cd ..
git add infra/frontend.tf
git commit -m "feat(infra): private site bucket with CloudFront OAC read policy"
```

### Task 12: ACM certificate + Route 53 records

**Files:**
- Create: `infra/dns_cert.tf`

- [ ] **Step 1: Write `infra/dns_cert.tf`**

```hcl
resource "aws_acm_certificate" "site" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.site.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id = data.aws_route53_zone.primary.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "site" {
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_route53_record" "alias_a" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "alias_aaaa" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = var.domain_name
  type    = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
```

- [ ] **Step 2: Commit (validate deferred to Task 13)**

```bash
cd ..
git add infra/dns_cert.tf
git commit -m "feat(infra): ACM DNS-validated cert and Route53 alias records"
```

### Task 13: CloudFront distribution (ties it together)

**Files:**
- Create: `infra/cloudfront.tf`

- [ ] **Step 1: Write `infra/cloudfront.tf`**

```hcl
resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "${var.name_prefix}-s3-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "lambda" {
  name                              = "${var.name_prefix}-lambda-oac"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# AWS-managed policies.
data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

locals {
  lambda_url_host = replace(replace(aws_lambda_function_url.api.function_url, "https://", ""), "/", "")
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = [var.domain_name]
  price_class         = "PriceClass_100" # cheapest: US/Canada/Europe edges

  origin {
    origin_id                = "s3-site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  origin {
    origin_id                = "lambda-api"
    domain_name              = local.lambda_url_host
    origin_access_control_id = aws_cloudfront_origin_access_control.lambda.id
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "s3-site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    compress               = true
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "lambda-api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    compress                 = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
```

- [ ] **Step 2: Full validate (all references now resolve)**

Run: `cd infra && terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Format**

Run: `cd infra && terraform fmt`
Expected: lists any reformatted files (or nothing). Working tree stays buildable.

- [ ] **Step 4: Commit**

```bash
cd ..
git add infra/cloudfront.tf
git commit -m "feat(infra): CloudFront distribution fronting S3 site and Lambda API"
```

### Task 14: Outputs

**Files:**
- Create: `infra/outputs.tf`

- [ ] **Step 1: Write `infra/outputs.tf`**

```hcl
output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "lambda_function_name" {
  value = aws_lambda_function.api.function_name
}

output "url" {
  value = "https://${var.domain_name}"
}

output "ci_role_arn" {
  value = aws_iam_role.ci.arn
}
```

> `aws_iam_role.ci` is created in Task 15; if you validate before then, temporarily comment the `ci_role_arn` output. It is included here because outputs belong together.

- [ ] **Step 2: Commit**

```bash
git add infra/outputs.tf
git commit -m "feat(infra): stack outputs for deploy workflow"
```

### Task 15: GitHub OIDC provider + CI role

**Files:**
- Create: `infra/cicd.tf`

- [ ] **Step 1: Write `infra/cicd.tf`**

```hcl
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

resource "aws_iam_role" "ci" {
  name = "${var.name_prefix}-ci"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:*"
        }
      }
    }]
  })
}

# Scoped to this app's resources plus the Terraform state backend. Broad-ish on
# purpose so `terraform apply` from CI can manage the whole stack; tighten later.
resource "aws_iam_role_policy" "ci" {
  name = "${var.name_prefix}-ci-policy"
  role = aws_iam_role.ci.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "TerraformState"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
        Resource = [
          "arn:aws:s3:::folio-tfstate-${data.aws_caller_identity.current.account_id}",
          "arn:aws:s3:::folio-tfstate-${data.aws_caller_identity.current.account_id}/*"
        ]
      },
      {
        Sid      = "TerraformLock"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = "arn:aws:dynamodb:us-east-1:${data.aws_caller_identity.current.account_id}:table/folio-tflock"
      },
      {
        Sid    = "DeployArtifacts"
        Effect = "Allow"
        Action = [
          "s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket",
          "lambda:UpdateFunctionCode", "lambda:GetFunction",
          "cloudfront:CreateInvalidation"
        ]
        Resource = "*"
      },
      {
        Sid    = "ManageStack"
        Effect = "Allow"
        Action = [
          "cloudfront:*", "s3:*", "lambda:*", "dynamodb:*", "iam:*",
          "acm:*", "route53:*", "ssm:*", "logs:*"
        ]
        Resource = "*"
      }
    ]
  })
}
```

> The `ManageStack` statement is intentionally broad so CI can run `terraform apply` over the full stack. This is acceptable for a solo project; a hardening pass can scope it to specific ARNs later.

- [ ] **Step 2: Validate and format**

Run: `cd infra && terraform validate && terraform fmt`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
cd ..
git add infra/cicd.tf
git commit -m "feat(infra): GitHub OIDC provider and scoped CI deploy role"
```

---

## Phase 4 — First deploy + secrets

### Task 16: Package backend deps and apply the stack

**Files:** none (operational)

- [ ] **Step 1: Ensure backend production deps are present for packaging**

Run:
```bash
cd backend && npm ci --omit=dev
cd ..
```
Expected: `node_modules` populated with only runtime deps (the archive_file zips this).

- [ ] **Step 2: Apply the main stack**

Run:
```bash
cd infra
terraform apply
```
Expected: creates ~30 resources. **ACM validation + CloudFront can take 5–20 minutes** — wait for completion. On success, outputs print (`url`, `site_bucket`, `distribution_id`, `lambda_function_name`, `ci_role_arn`).

- [ ] **Step 3: Record the outputs**

Run: `cd infra && terraform output`
Expected: capture `site_bucket`, `distribution_id`, `lambda_function_name`, `ci_role_arn` — you'll need them for the workflows and GitHub config.

### Task 17: Set the real secrets in SSM

**Files:** none (operational)

- [ ] **Step 1: Generate and store the HMAC key and your password**

Run (replace `YOUR-CHOSEN-PASSWORD`):
```bash
aws ssm put-parameter --name /folio/hmac_key --type SecureString \
  --value "$(openssl rand -base64 48)" --overwrite

aws ssm put-parameter --name /folio/app_password --type SecureString \
  --value "YOUR-CHOSEN-PASSWORD" --overwrite
```
Expected: each prints a new `Version` number > 1.

- [ ] **Step 2: Verify the Lambda picks them up (force a cold start)**

Run:
```bash
aws lambda update-function-configuration --function-name folio-api \
  --description "secrets set $(date +%s)" >/dev/null
sleep 5
curl -s -X POST https://read.magj.dev/api/login \
  -H 'content-type: application/json' \
  -d '{"password":"YOUR-CHOSEN-PASSWORD"}' -i | head -20
```
Expected: `HTTP/2 200`, a `set-cookie: folio_session=...` header, body `{"ok":true}`. A wrong password returns `401`.

> If you get `403` from CloudFront here, the distribution may still be deploying — wait a few minutes and retry.

---

## Phase 5 — Frontend: swap IndexedDB for the API

All changes are in `project/app.ts`. After each change, rebuild with `npm run build` (from repo root) and confirm no esbuild errors. The app is browser-run; verification is the build plus the end-to-end check in Phase 7.

### Task 18: Add an API client and Book type tweaks

**Files:**
- Modify: `project/app.ts` (the `// ---------- IndexedDB ----------` block, lines ~64–108)

- [ ] **Step 1: Replace the IndexedDB block with an API client**

In `project/app.ts`, replace the entire IndexedDB section (from `// ---------- IndexedDB ----------` down to and including the `dbDel` function, ending just before `// ---------- state ----------`) with this API client. It keeps the same function names (`dbPut`, `dbAll`, `dbGet`, `dbDel`) so the rest of the file needs minimal changes, but they now talk to `/api`.

```ts
// ---------- API client ----------
// The book metadata that lives server-side (everything except the PDF bytes).
type BookMeta = Omit<Book, 'data'>;

async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  const res = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) { onUnauthorized(); throw new Error('unauthorized'); }
  return res;
}

let _onUnauthorized: () => void = () => {};
function onUnauthorized(): void { _onUnauthorized(); }

// List metadata for all books (no bytes).
async function dbAll(): Promise<BookMeta[]> {
  const res = await api('/books');
  if (!res.ok) return [];
  const { books } = await res.json();
  return books as BookMeta[];
}

// Persist metadata. If the book carries fresh `data`, upload the bytes to S3.
async function dbPut(b: Book): Promise<void> {
  const meta: BookMeta = stripData(b);
  const res = await api('/books', { method: 'POST', body: JSON.stringify(meta) });
  if (!res.ok) throw new Error('save failed');
  const { uploadUrl } = await res.json();
  if (b.data && uploadUrl) {
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: b.data,
    });
    if (!put.ok) throw new Error('upload failed');
  }
}

// Update just the reading position (used by persistPage).
async function dbPutProgress(b: Book): Promise<void> {
  await api('/books/' + encodeURIComponent(b.id) + '/progress', {
    method: 'PUT',
    body: JSON.stringify({ currentPage: b.currentPage, lastReadAt: b.lastReadAt || Date.now() }),
  });
}

// Fetch the PDF bytes for one book via a presigned URL.
async function dbGet(id: string): Promise<ArrayBuffer | null> {
  const res = await api('/books/' + encodeURIComponent(id) + '/url');
  if (!res.ok) return null;
  const { url } = await res.json();
  const file = await fetch(url);
  if (!file.ok) return null;
  return file.arrayBuffer();
}

async function dbDel(id: string): Promise<void> {
  await api('/books/' + encodeURIComponent(id), { method: 'DELETE' });
}

function stripData(b: Book): BookMeta {
  const { data, ...rest } = b;
  return rest;
}
```

- [ ] **Step 2: Rebuild**

Run: `npm run build`
Expected: esbuild prints the output size, no errors. (Type errors won't fail the build — esbuild transpiles — but watch the log.)

- [ ] **Step 3: Commit**

```bash
git add project/app.ts
git commit -m "feat(app): replace IndexedDB layer with /api client"
```

### Task 19: Wire upload, open, delete, and progress to the new client

**Files:**
- Modify: `project/app.ts` — `ingest` (~174), `openBook` (~393), `confirmDelete` (~357), `persistPage` (~477), `seedIfEmpty` removal, `boot` (~665)

- [ ] **Step 1: Update `ingest` to keep `data` so `dbPut` uploads it**

The existing `ingest` already builds a `Book` with `data: buf` and calls `await dbPut(book)`. With the new `dbPut`, that single call now both saves metadata and uploads the bytes — **no change needed inside `ingest`**. Confirm the line `await dbPut(book);` is still present (~193) and leave it.

- [ ] **Step 2: Update `openBook` to fetch bytes via `dbGet`**

In `openBook`, the current code does `const b = await dbGet(id);` expecting a full `Book`. Now `dbGet` returns only the bytes. Change `openBook` (starting ~393) so it looks up metadata from the in-memory `books` array and fetches bytes separately. Replace the opening of the function:

Find:
```ts
async function openBook(id: string): Promise<void> {
  const b = await dbGet(id);
  if (!b) { toast('Could not open that book'); return; }
  reader.book = b;
```
Replace with:
```ts
async function openBook(id: string): Promise<void> {
  const meta = books.find(x => x.id === id);
  if (!meta) { toast('Could not open that book'); return; }
  const b = meta as Book;
  reader.book = b;
```

Then, further down in `openBook`, find where it loads the doc:
```ts
    reader.doc = await loadDoc(b.data);
```
Replace with:
```ts
    const bytes = await dbGet(id);
    if (!bytes) { toast('Could not load this PDF'); el('r-loading').classList.add('hidden'); return; }
    reader.doc = await loadDoc(bytes);
```

- [ ] **Step 3: Update `persistPage` to call the progress endpoint**

Find (~484):
```ts
  reader.saveTimer = window.setTimeout(() => { dbPut(b).catch(() => {}); }, 350);
```
Replace with:
```ts
  reader.saveTimer = window.setTimeout(() => { dbPutProgress(b).catch(() => {}); }, 350);
```

- [ ] **Step 4: Update `boot` to drop seeding and load metadata**

Find `boot` (~665):
```ts
async function boot(): Promise<void> {
  if (booted) { renderLibrary(); return; }
  booted = true;
  try {
    books = await dbAll();
    if (!books.length) await seedIfEmpty();
    books = await dbAll();
  } catch (e) { console.error('db error', e); books = []; }
  renderLibrary();
}
```
Replace with:
```ts
async function boot(): Promise<void> {
  if (booted) { renderLibrary(); return; }
  booted = true;
  try {
    books = (await dbAll()) as unknown as Book[];
  } catch (e) { console.error('api error', e); books = []; }
  renderLibrary();
}
```

- [ ] **Step 5: Delete the now-unused `seedIfEmpty` function**

Remove the entire `seedIfEmpty` function (the `// ---------- seeding ----------` block, ~214–232). The sample PDFs are no longer auto-loaded; you'll upload your own. Also remove `seeded: 'folio.seeded2',` from the `LS` object (~115).

- [ ] **Step 6: Rebuild**

Run: `npm run build`
Expected: no esbuild errors. (If esbuild complains about the removed `seedIfEmpty` being referenced elsewhere, grep `seedIfEmpty` and remove the stray call.)

- [ ] **Step 7: Commit**

```bash
git add project/app.ts
git commit -m "feat(app): wire upload/open/delete/progress to API, drop local seeding"
```

### Task 20: Real login against `/api/login`

**Files:**
- Modify: `project/app.ts` — `wireAuth` (~608), `init` (~676)

- [ ] **Step 1: Make the login form POST the password and gate on the response**

Replace the `login-form` submit handler inside `wireAuth` (the `el<HTMLFormElement>('login-form').addEventListener('submit', ...)` block, ~609–617) with:

```ts
  el<HTMLFormElement>('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (el('login-name') as HTMLInputElement).value.trim() || 'Reader';
    const pass = (el('login-pass') as HTMLInputElement).value;
    if (!pass) return;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password: pass }),
      });
      if (!res.ok) { toast('Wrong password'); return; }
      localStorage.setItem(LS.user, JSON.stringify({ name }));
      showApp(name);
      await boot();
    } catch {
      toast('Could not reach the server');
    }
  });
```

- [ ] **Step 2: Make the logout button hit `/api/logout` and register the 401 handler**

In `wireAuth`, replace the `btn-logout` handler (~625) with one that also clears the server cookie:

```ts
  el('btn-logout').addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    localStorage.removeItem(LS.user);
    el('app').classList.add('hidden');
    el('login').classList.remove('hidden');
    el('dropdown').classList.add('hidden');
    (el('login-pass') as HTMLInputElement).value = '';
    booted = false;
    books = [];
  });
```

- [ ] **Step 3: Register the unauthorized handler in `init`**

In `init` (~676), immediately after `wireAuth();`, add a line that wires the API client's 401 fallback to the login screen:

```ts
  _onUnauthorized = () => {
    localStorage.removeItem(LS.user);
    el('app').classList.add('hidden');
    el('login').classList.remove('hidden');
    booted = false;
  };
```

- [ ] **Step 4: Rebuild**

Run: `npm run build`
Expected: no esbuild errors.

- [ ] **Step 5: Commit**

```bash
git add project/app.ts
git commit -m "feat(app): authenticate against /api/login and /api/logout"
```

---

## Phase 6 — CI/CD with GitHub Actions

### Task 21: Configure GitHub repo with the CI role ARN

**Files:** none (operational)

- [ ] **Step 1: Add the CI role ARN as a GitHub Actions variable**

Using the `ci_role_arn` output from Task 16 (`arn:aws:iam::257394450889:role/folio-ci`):
```bash
gh variable set AWS_ROLE_ARN --repo kayaman/reader --body "arn:aws:iam::257394450889:role/folio-ci"
gh variable set AWS_REGION --repo kayaman/reader --body "us-east-1"
```
Expected: `gh` confirms each variable was set.

### Task 22: PR workflow — build + terraform plan

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  build-and-plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Build frontend
        run: |
          npm ci
          npm run build

      - name: Install backend deps
        working-directory: backend
        run: npm ci

      - name: Backend tests
        working-directory: backend
        run: npm test

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.10.5

      - name: Terraform fmt
        working-directory: infra
        run: terraform fmt -check -recursive

      - name: Terraform init
        working-directory: infra
        run: terraform init -input=false

      - name: Terraform validate
        working-directory: infra
        run: terraform validate

      - name: Terraform plan
        working-directory: infra
        run: terraform plan -input=false -no-color
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: PR workflow builds frontend, tests backend, terraform plan"
```

### Task 23: Deploy workflow — apply + publish

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Write `.github/workflows/deploy.yml`**

```yaml
name: Deploy

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

concurrency:
  group: deploy-main
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Build frontend
        run: |
          npm ci
          npm run build

      - name: Install backend runtime deps (for the Lambda zip)
        working-directory: backend
        run: npm ci --omit=dev

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.10.5

      - name: Terraform apply
        working-directory: infra
        run: |
          terraform init -input=false
          terraform apply -auto-approve -input=false

      - name: Read outputs
        id: tf
        working-directory: infra
        run: |
          echo "site_bucket=$(terraform output -raw site_bucket)" >> "$GITHUB_OUTPUT"
          echo "distribution_id=$(terraform output -raw distribution_id)" >> "$GITHUB_OUTPUT"
          echo "lambda_name=$(terraform output -raw lambda_function_name)" >> "$GITHUB_OUTPUT"

      - name: Publish frontend to S3
        run: |
          aws s3 cp project/index.html "s3://${{ steps.tf.outputs.site_bucket }}/index.html" --cache-control "no-cache"
          aws s3 cp project/app.js     "s3://${{ steps.tf.outputs.site_bucket }}/app.js"     --cache-control "max-age=300"
          aws s3 cp project/styles.css "s3://${{ steps.tf.outputs.site_bucket }}/styles.css" --cache-control "max-age=300"

      - name: Update Lambda code
        working-directory: backend
        run: |
          rm -f function.zip
          zip -rq function.zip src node_modules package.json
          aws lambda update-function-code \
            --function-name "${{ steps.tf.outputs.lambda_name }}" \
            --zip-file fileb://function.zip >/dev/null

      - name: Invalidate CloudFront
        run: |
          aws cloudfront create-invalidation \
            --distribution-id "${{ steps.tf.outputs.distribution_id }}" \
            --paths "/index.html" "/app.js" "/styles.css"
```

> Note: the deploy uploads `index.html`, `app.js`, `styles.css`. The app loads `Folio.html` only as a design artifact — `index.html` is the entry point CloudFront serves as `default_root_object`. Confirm `project/index.html` references `app.js` and `styles.css` (it does per the existing build).

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: deploy workflow applies terraform and publishes site + lambda"
```

### Task 24: Push and watch the first CI deploy

**Files:** none (operational)

- [ ] **Step 1: Push `main`**

Run:
```bash
git push origin main
```
Expected: push succeeds.

- [ ] **Step 2: Watch the deploy run**

Run: `gh run watch --repo kayaman/reader` (or `gh run list`)
Expected: the `Deploy` workflow completes green. If `terraform apply` reports "no changes" that's fine — the publish/lambda/invalidate steps still run.

---

## Phase 7 — End-to-end verification

### Task 25: Manual cross-device statefulness check

**Files:** none (operational)

- [ ] **Step 1: Confirm the site loads over HTTPS on the custom domain**

Run: `curl -sI https://read.magj.dev | head -5`
Expected: `HTTP/2 200`, served via CloudFront, valid TLS (no cert warning).

- [ ] **Step 2: Log in and upload in browser A**

In a browser, open `https://read.magj.dev`, enter your password, and upload a PDF (e.g. one of the files in `project/uploads/`). Confirm it appears on the shelf, open it, and turn a few pages.

- [ ] **Step 3: Verify server-side state**

Run:
```bash
aws dynamodb scan --table-name folio-books --max-items 5 \
  --query 'Items[].{id:id.S,title:title.S,page:currentPage.N}' --output table
aws s3 ls s3://folio-pdfs-257394450889/pdfs/
```
Expected: the book metadata row(s) with a non-1 `currentPage` after page turns, and a matching `<id>.pdf` object in S3.

- [ ] **Step 4: Cross-device check**

Open `https://read.magj.dev` in a **different browser or device**, log in with the same password, and confirm the same book appears **on the page you left off**. This is the core acceptance criterion.

- [ ] **Step 5: Auth gate check**

Run: `curl -s https://read.magj.dev/api/books -i | head -3`
Expected: `HTTP/2 401` (no cookie → unauthorized). Confirms strangers can't read your library.

- [ ] **Step 6: Final commit / done**

If you made any incidental fixes during verification, commit them. Otherwise the work is complete and deployed.

---

## Self-review notes (addressed)

- **Spec coverage:** static hosting (Tasks 11, 13), single CloudFront + `/api/*` (Task 13), Lambda Function URL OAC-only (Tasks 10, 13), DynamoDB + S3 presign (Tasks 5, 8), password→cookie auth (Tasks 3, 6, 17, 20), SSM out-of-band secrets (Tasks 9, 17), app.ts swap (Tasks 18–20), remote TF state (Task 1), OIDC CI (Tasks 15, 21–23), presigned-URL delivery + S3 CORS (Tasks 5, 8) — all mapped.
- **Naming consistency:** `dbPut`/`dbAll`/`dbGet`/`dbDel`/`dbPutProgress` defined in Task 18 and used consistently in Task 19; env var names (`TABLE_NAME`, `PDF_BUCKET`, `PASSWORD_PARAM`, `HMAC_PARAM`) match between `lambda.tf` (Task 10) and backend `config.mjs`/`repo.mjs` (Tasks 4, 5); SSM names `/folio/app_password` + `/folio/hmac_key` consistent across Tasks 9, 17.
- **Ordering caveat called out:** `infra` does not fully `validate` until CloudFront (Task 13) and CI role (Task 15) exist; flagged explicitly in Tasks 10, 11, 12, 14 so a worker doesn't treat the intermediate failure as a regression.
