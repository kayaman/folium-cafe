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
