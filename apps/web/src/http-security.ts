// Any website open in the person's browser can reach a loopback server. The API answers only
// the GUI's own page: a foreign Host (DNS rebinding), a cross-site fetch or image, and a write
// without this origin or a JSON body (a CSRF form or text/plain post) are refused.
import type { IncomingHttpHeaders } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export type LocalRequestProblem = 'host' | 'cross-site' | 'origin' | 'content-type';

export function localRequestProblem(req: { method?: string; headers: IncomingHttpHeaders }, port: number): LocalRequestProblem | undefined {
  const own = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!own.includes(String(req.headers.host ?? '').toLowerCase())) return 'host';
  // Browsers label every request; 'none' is the person typing the address. Non-browser local clients send neither header.
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'cross-site';
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const origin = req.headers.origin;
  if ((origin !== undefined || site !== undefined) && !own.some(h => origin === `http://${h}`)) return 'origin';
  // A cross-origin JSON post needs a CORS preflight, which this server never grants.
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return 'content-type';
  return undefined;
}

// Loopback keeps the network out, but not other OS users on the same machine: a local client sends
// no browser headers, so the checks above let it through and this server would act as the person.
// Each launch makes a secret that only the person's terminal shows. Opening the printed launch link
// stores a separate page secret in an HttpOnly, SameSite=Strict cookie and hands the page's script an
// API token in the URL fragment; every other request without them is refused.
//
// The cookie alone is not enough for the API: cookies ignore ports, so the browser also sends it to
// any other server on 127.0.0.1 (an image, a link). Every /api request must carry the token in a
// custom header, which only this page's script holds and which an image, a link or another origin
// cannot attach (a cross-origin request with it needs a CORS preflight, which this server never grants).

/** Header that carries the page's API token on every /api request (lowercase, as Node reports it). */
export const API_TOKEN_HEADER = 'x-kakao-web-token';

/** A fresh per-launch secret (256 bits, base64url). */
export function createLaunchSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Cookie name; includes the port so two GUIs on different ports keep separate sessions. */
export function sessionCookieName(port: number): string {
  return `kakao_mcp_web_${port}`;
}

/** Set-Cookie value for the page secret. Browser-only, never sent cross-site (but sent to other local ports). */
export function sessionCookie(port: number, secret: string): string {
  return `${sessionCookieName(port)}=${secret}; Path=/; HttpOnly; SameSite=Strict`;
}

/** Constant-time comparison of a presented value with the launch secret. */
export function matchesSecret(presented: unknown, secret: string): boolean {
  if (typeof presented !== 'string' || !presented) return false;
  const a = Buffer.from(presented), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the request carries this launch's session cookie. */
export function hasSession(headers: IncomingHttpHeaders, port: number, secret: string): boolean {
  const name = sessionCookieName(port);
  for (const part of String(headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name && matchesSecret(part.slice(eq + 1).trim(), secret)) return true;
  }
  return false;
}

/** True when the request carries this launch's API token header. */
export function hasApiToken(headers: IncomingHttpHeaders, token: string): boolean {
  return matchesSecret(headers[API_TOKEN_HEADER], token);
}

/** Where a valid launch link sends the browser: the page, with the API token in the fragment (never sent to a server). */
export function launchLocation(token: string): string {
  return `/#t=${token}`;
}

// The page loads only its own scripts, styles and data; remote images are https only (profile
// pictures), and this page may not be framed, change its base URL or embed plugins.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' blob: data: https:",
  "connect-src 'self'", "font-src 'self'", "media-src 'self' blob:", "object-src 'none'", "base-uri 'none'",
  "frame-ancestors 'none'", "form-action 'none'"
].join('; ');

/** Headers sent with every response of the GUI server. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin'
};
