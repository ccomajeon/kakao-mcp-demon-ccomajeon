import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { terminalJson } from './terminal-text.ts';

// Room titles, names, messages and daemon error text are remote data. Each payload would act on the
// operator's terminal if printed raw: clipboard write (OSC 52), window title (OSC 0), hidden link (OSC 8),
// line erase and cursor report (CSI), 8-bit C1 CSI/OSC, device control (DCS) and bidi reordering.
const HOSTILE = '\x1b]52;c;Zml4dHVyZQ==\x07\x1b]0;fixture-title\x1b\\\x1b]8;;https://link.example.test\x1b\\link\x1b]8;;\x1b\\' +
  '\x1b[2K\r\x1b[5m\x1b[6n\x9b2J\x9d0;fixture\x9c\x1bP+q\x1b\\\u202eevil\u2066\u200b\x07\x08\x7f';
// The CLI's own colour codes; anything else that looks like a control must not reach stdout.
const OWN_SGR = /\x1b\[(?:0|1|2|3[1-6]|90)m/g;
const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;

test('CLI commands never print escape, control or bidi characters from daemon data raw', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-terminal-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chat = { id: '987654321', type: 'DirectChat', title: `room ${HOSTILE}`, unreadCount: 1, lastMessage: `last ${HOSTILE}`, lastSendAt: 1, maxLogId: '5' };
  const message = { chatId: chat.id, messageId: '5', authorId: '222', authorName: `author ${HOSTILE}`, type: 1, text: `text ${HOSTILE}`, sendAt: 1 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    readline.createInterface({ input: socket }).on('error', () => {}).on('line', line => {
      const req = JSON.parse(line);
      if (req.id === undefined) return;
      let result: unknown = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '0' } };
      if (req.method === 'tools/call') {
        const { name, arguments: args } = req.params;
        let data: unknown;
        if (name === 'get_status') data = { connected: true, userId: `111 ${HOSTILE}`, endpoint: { host: `host ${HOSTILE}`, port: 1 } };
        else if (name === 'list_chats') data = { chats: [chat] };
        else if (name === 'list_friends') data = { count: 1, friends: [{ userId: `333 ${HOSTILE}`, nickName: `nick ${HOSTILE}`, friendNickName: `friend ${HOSTILE}`, statusMessage: `status ${HOSTILE}` }] };
        else if (name === 'read_messages') data = args.mode === 'search' ? { count: 1, messages: [message] }
          : { untrusted: true, messages: [message], sync: { mode: `mode ${HOSTILE}`, status: 0, pages: 1, fetched: 1, inserted: 0, max: '5', reason: `reason ${HOSTILE}` } };
        result = data !== undefined ? { isError: false, content: [{ type: 'text', text: JSON.stringify(data) }] }
          : { isError: true, content: [{ type: 'text', text: `error ${HOSTILE}` }], structuredContent: { error: { code: 'POLICY_DENIED', message: `error ${HOSTILE}` } } };
      }
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
    });
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('KAKAO_')));
  env.MCP_HOST = '127.0.0.1'; env.MCP_PORT = String((server.address() as net.AddressInfo).port);
  const run = (args: string[]) => new Promise<string>(resolve => {
    execFile(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./index.ts', import.meta.url)), ...args],
      { cwd: root, env, timeout: 15000 }, (_error, stdout, stderr) => resolve(stdout + stderr));
  });
  const commands = [['ls'], ['status'], ['friends'], ['history', chat.id], ['search', 'fixture', chat.id], ['send', chat.id, 'fixture'],
    ['read', chat.id], ['download', chat.id, 'fixture-token', path.join(root, 'out.bin'), '--message-id', '5'], [`unknown${HOSTILE}`]];
  for (const args of commands) {
    const output = await run(args);
    const visible = output.replace(OWN_SGR, '');
    assert.ok(/room|author|friend|error|111|알 수 없는/.test(visible), `${args[0]} printed the fixture data: ${JSON.stringify(visible)}`);
    // The CLI's own line breaks and carriage returns; received ones become a visible marker.
    const raw = visible.replace(/[\r\n]/g, '').match(RAW_CONTROL);
    assert.equal(raw, null, `${args[0]} printed a raw control character: ${JSON.stringify(raw?.[0])} in ${JSON.stringify(visible)}`);
  }
});

test('terminalJson keeps JSON valid while escaping C1, bidi and invisible characters', () => {
  const value = { text: HOSTILE };
  const out = terminalJson(value);
  assert.equal(RAW_CONTROL.test(out.replace(/\n/g, '')), false);
  assert.deepEqual(JSON.parse(out), value);
});
