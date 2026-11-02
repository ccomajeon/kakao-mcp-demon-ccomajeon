// The real GUI server process (no daemon behind it): the panel and write routes sit behind the same
// launch-session (page cookie and API token header), Host, Sec-Fetch-Site/Origin and JSON-only checks
// as every other /api route.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./index.ts', import.meta.url));

async function startGui(): Promise<{ base: string; launch: string }> {
  // MCP_PORT 9 (discard) on loopback: nothing answers, so the GUI stays disconnected.
  const child = spawn(process.execPath, ['--experimental-strip-types', entry], { env: { ...process.env, PORT: '0', MCP_HOST: '127.0.0.1', MCP_PORT: '9' }, stdio: ['ignore', 'pipe', 'pipe'] });
  after(() => { child.kill(); });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`GUI did not start: ${out}`)), 10_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /(http:\/\/127\.0\.0\.1:(\d+))\/launch\?t=[A-Za-z0-9_-]+/.exec(out);
      if (m) { clearTimeout(timer); resolve({ base: m[1], launch: m[0] }); }
    });
    child.on('exit', (code) => reject(new Error(`GUI exited ${code}: ${out}`)));
  });
}

const gui = startGui();
let cookie = '', token = '';
async function session(): Promise<{ base: string; cookie: string; token: string }> {
  const { base, launch } = await gui;
  if (!cookie) {
    const r = await fetch(launch, { redirect: 'manual' });
    assert.equal(r.status, 303);
    cookie = String(r.headers.get('set-cookie')).split(';')[0];
    token = /^\/#t=([A-Za-z0-9_-]{43})$/.exec(String(r.headers.get('location')))?.[1] ?? '';
    assert.ok(token, 'the launch link hands the page its API token in the fragment');
  }
  return { base, cookie, token };
}
const json = { 'content-type': 'application/json' };
const TOKEN = 'x-kakao-web-token';

test('the launch link sets a page cookie that differs from the link and from the API token', async () => {
  const { launch } = await gui;
  const { cookie, token } = await session();
  const linkSecret = new URL(launch).searchParams.get('t');
  const cookieSecret = cookie.split('=')[1];
  assert.notEqual(cookieSecret, linkSecret); assert.notEqual(cookieSecret, token); assert.notEqual(token, linkSecret);
});

test('a leaked page cookie alone opens the page but never the API', async () => {
  const { base, cookie, token } = await session();
  const page = await fetch(`${base}/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  for (const [p, method] of [['/api/state', 'GET'], ['/api/events', 'GET'], ['/api/approvals', 'GET'], ['/api/approvals/answer', 'POST'], ['/api/control', 'GET'], ['/api/media?chatId=1&token=a&messageId=2', 'GET']]) {
    const r = await fetch(base + p, { method, headers: { ...json, cookie }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(r.status, 401, `${method} ${p} with the cookie only`);
    assert.equal((await r.json()).code, 'WEB_SESSION_REQUIRED');
  }
  // The cookie value cannot be replayed as a launch link to obtain the token.
  const replay = await fetch(`${base}/launch?t=${cookie.split('=')[1]}`, { redirect: 'manual' });
  assert.equal(replay.status, 403);
  // The token without the cookie is not enough either, and a wrong token is refused.
  assert.equal((await fetch(`${base}/api/state`, { headers: { [TOKEN]: token } })).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie, [TOKEN]: token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A') } })).status, 401);
  const ok = await fetch(`${base}/api/state`, { headers: { cookie, [TOKEN]: token } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).connected, false);
});

test('the event stream needs the token header and starts with the current status', async () => {
  const { base, cookie, token } = await session();
  const ac = new AbortController();
  const r = await fetch(`${base}/api/events`, { headers: { cookie, [TOKEN]: token }, signal: ac.signal });
  assert.equal(r.status, 200);
  assert.match(String(r.headers.get('content-type')), /text\/event-stream/);
  const reader = r.body!.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /^event: status\ndata: \{"connected":false/);
  ac.abort();
});

test('every response carries the security headers', async () => {
  const { base, cookie, token } = await session();
  for (const r of [await fetch(`${base}/`, { headers: { cookie } }), await fetch(`${base}/app.js`, { headers: { cookie } }),
    await fetch(`${base}/api/state`, { headers: { cookie, [TOKEN]: token } }), await fetch(`${base}/api/state`), await fetch(`${base}/launch?t=wrong`, { redirect: 'manual' })]) {
    const csp = String(r.headers.get('content-security-policy'));
    for (const d of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), `${r.url}: ${d}`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  }
});

test('panel and write routes refuse requests without the launch session', async () => {
  const { base } = await gui;
  for (const [p, method] of [['/api/control', 'GET'], ['/api/control/pause', 'POST'], ['/api/control/revoke', 'POST'], ['/api/send', 'POST']]) {
    const r = await fetch(base + p, { method, headers: json, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(r.status, 401, `${method} ${p}`);
  }
});

test('panel writes refuse another website and a form post even with the session', async () => {
  const { base, cookie, token } = await session();
  const pause = JSON.stringify({ paused: true });
  const cases: Array<[Record<string, string>, string]> = [
    [{ ...json, cookie, [TOKEN]: token, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }, 'cross-site'],
    [{ ...json, cookie, [TOKEN]: token, origin: 'https://attacker.example' }, 'origin'],
    [{ ...json, cookie, [TOKEN]: token, origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-site' }, 'another local port'],
    [{ 'content-type': 'text/plain', cookie, [TOKEN]: token }, 'content-type']
  ];
  for (const [headers, why] of cases) {
    const r = await fetch(`${base}/api/control/pause`, { method: 'POST', headers, body: pause });
    assert.equal(r.status, 403, why);
  }
});

test('with the session, the panel reports a disconnected daemon and writes need a page-chosen requestId', async () => {
  const { base, cookie, token } = await session();
  const control = await (await fetch(`${base}/api/control`, { headers: { cookie, [TOKEN]: token } })).json();
  assert.equal(control.status.connected, false); assert.deepEqual(control.permissions, []);
  const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { ...json, cookie, [TOKEN]: token, origin: base, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) });
  for (const [p, body] of [['/api/send', { chatId: '1', text: 'x' }], ['/api/delete', { chatId: '1', logId: '2' }], ['/api/forward', { chatId: '1', text: 'x' }],
    ['/api/leave', { chatId: '1' }], ['/api/control/resume', {}], ['/api/send', { chatId: '1', text: 'x', requestId: 'not-a-uuid' }]] as const) {
    const r = await post(p, body);
    assert.equal(r.status, 400, p); assert.equal((await r.json()).code, 'INVALID_REQUEST_ID', p);
  }
  const offline = await post('/api/send', { chatId: '1', text: 'x', requestId: '00000000-0000-4000-8000-000000000001' });
  assert.equal(offline.status, 503);
  assert.deepEqual(await offline.json(), { error: 'Not connected to the daemon; nothing was sent', code: 'DAEMON_NOT_CONNECTED', uncertain: false, retryable: true });
  assert.equal((await post('/api/control/pause', { paused: true })).status, 503);
});
