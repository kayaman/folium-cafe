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
