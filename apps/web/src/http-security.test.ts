import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localRequestProblem, createLaunchSecret, sessionCookie, sessionCookieName, hasSession, matchesSecret, hasApiToken, launchLocation, API_TOKEN_HEADER, SECURITY_HEADERS, CONTENT_SECURITY_POLICY } from './http-security.ts';

const PORT = 8899;
const req = (method: string, headers: Record<string, string>) => ({ method, headers: { host: '127.0.0.1:8899', ...headers } });

test('the GUI page itself may read and write', () => {
  assert.equal(localRequestProblem(req('GET', { 'sec-fetch-site': 'same-origin' }), PORT), undefined);
  assert.equal(localRequestProblem(req('POST', { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:8899', 'content-type': 'application/json' }), PORT), undefined);
  assert.equal(localRequestProblem({ method: 'POST', headers: { host: 'localhost:8899', 'sec-fetch-site': 'same-origin', origin: 'http://localhost:8899', 'content-type': 'application/json' } }, PORT), undefined);
  assert.equal(localRequestProblem(req('GET', { 'sec-fetch-site': 'none' }), PORT), undefined, 'address typed by the person');
});

test('a local non-browser client passes the browser checks (the launch session below still applies)', () => {
  assert.equal(localRequestProblem(req('GET', {}), PORT), undefined);
  assert.equal(localRequestProblem(req('POST', { 'content-type': 'application/json' }), PORT), undefined);
});

test('DNS rebinding: a foreign Host is refused even when the browser calls it same-origin', () => {
  assert.equal(localRequestProblem({ method: 'GET', headers: { host: 'attacker.example:8899', 'sec-fetch-site': 'same-origin' } }, PORT), 'host');
  assert.equal(localRequestProblem({ method: 'GET', headers: { host: '127.0.0.1:9999' } }, PORT), 'host');
  assert.equal(localRequestProblem({ method: 'GET', headers: {} }, PORT), 'host');
});

test('another website cannot read, embed or post', () => {
  assert.equal(localRequestProblem(req('GET', { 'sec-fetch-site': 'cross-site' }), PORT), 'cross-site', 'image/fetch to /api/og or /api/history');
  assert.equal(localRequestProblem(req('POST', { 'sec-fetch-site': 'cross-site', origin: 'https://attacker.example', 'content-type': 'text/plain' }), PORT), 'cross-site');
  // A browser without Fetch Metadata still sends Origin on a cross-site post.
  assert.equal(localRequestProblem(req('POST', { origin: 'https://attacker.example', 'content-type': 'application/json' }), PORT), 'origin');
  assert.equal(localRequestProblem(req('POST', { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }), PORT), 'origin', 'browser write without Origin');
});

test('a same-origin write must be JSON, so a form or text/plain post cannot reach the API', () => {
  assert.equal(localRequestProblem(req('POST', { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:8899', 'content-type': 'text/plain' }), PORT), 'content-type');
  assert.equal(localRequestProblem(req('POST', { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:8899' }), PORT), 'content-type');
});

test('only a request carrying this launch secret has a session', () => {
  const secret = createLaunchSecret(), other = createLaunchSecret();
  assert.notEqual(secret, other, 'every launch gets a new secret');
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  const cookie = `${sessionCookieName(PORT)}=${secret}`;
  assert.equal(hasSession({ cookie }, PORT, secret), true);
  assert.equal(hasSession({ cookie: `theme=dark; ${cookie}; x=1` }, PORT, secret), true);
  assert.equal(hasSession({}, PORT, secret), false, 'another OS user\'s curl without the cookie');
  assert.equal(hasSession({ cookie: `${sessionCookieName(PORT)}=${other}` }, PORT, secret), false, 'a previous launch');
  assert.equal(hasSession({ cookie: `${sessionCookieName(9999)}=${secret}` }, PORT, secret), false, 'another port');
  assert.equal(hasSession({ cookie: `${sessionCookieName(PORT)}=${secret.slice(0, -1)}` }, PORT, secret), false);
});

test('the launch cookie is browser-only and never sent cross-site', () => {
  const set = sessionCookie(PORT, 'abc');
  assert.match(set, /^kakao_mcp_web_8899=abc;/);
  assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/); assert.match(set, /Path=\//);
});

test('launch secret comparison rejects missing, empty and wrong values', () => {
  const secret = createLaunchSecret();
  assert.equal(matchesSecret(secret, secret), true);
  for (const bad of [undefined, null, '', 'x', secret + 'x', 42]) assert.equal(matchesSecret(bad, secret), false);
});

test('the API token travels only in its custom header, compared in constant time', () => {
  const token = createLaunchSecret();
  assert.equal(API_TOKEN_HEADER, 'x-kakao-web-token');
  assert.equal(hasApiToken({ [API_TOKEN_HEADER]: token }, token), true);
  assert.equal(hasApiToken({}, token), false, 'an image, a link or a leaked cookie carries no header');
  assert.equal(hasApiToken({ cookie: `${sessionCookieName(PORT)}=${token}` }, token), false, 'a cookie is not the header');
  assert.equal(hasApiToken({ [API_TOKEN_HEADER]: createLaunchSecret() }, token), false);
  assert.equal(hasApiToken({ [API_TOKEN_HEADER]: '' }, token), false);
});

test('the launch link hands the token to the page in the fragment only', () => {
  assert.equal(launchLocation('abc'), '/#t=abc');
});

test('responses forbid framing, sniffing, referrers, plugins and foreign scripts', () => {
  assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
  const directives = new Map(CONTENT_SECURITY_POLICY.split('; ').map(d => [d.split(' ')[0], d.split(' ').slice(1)]));
  assert.deepEqual(directives.get('default-src'), ["'self'"]);
  assert.deepEqual(directives.get('script-src'), ["'self'"], 'no inline script or handler');
  assert.deepEqual(directives.get('connect-src'), ["'self'"]);
  for (const d of ['object-src', 'base-uri', 'frame-ancestors']) assert.deepEqual(directives.get(d), ["'none'"], d);
  assert.ok(!directives.get('img-src')!.includes('http:'), 'no plain-http images (they could reach other local ports)');
});
