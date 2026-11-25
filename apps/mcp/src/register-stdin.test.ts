import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readPasswordLine } from './register.ts';

test('the stdin password is the first line exactly, spaces kept and the line ending dropped', async () => {
  assert.equal(await readPasswordLine(Readable.from(['  pass word  \n', 'next line\n'])), '  pass word  ');
  assert.equal(await readPasswordLine(Readable.from(['fix', 'ture\r\n'])), 'fixture');
  assert.equal(await readPasswordLine(Readable.from(['no newline'])), 'no newline');
  assert.equal(await readPasswordLine(Readable.from([])), '');
  await assert.rejects(readPasswordLine(Readable.from(['x'.repeat(5000)])), /too long/);
});

test('--password-stdin never echoes the password and still requires an account', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkt-register-stdin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env.local'), 'KAKAO_DEVICE_NAME=fixture\n');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
  for (const key of Object.keys(env)) if (key.startsWith('KAKAO_')) delete env[key];
  const entry = fileURLToPath(new URL('./register.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', entry, '--password-stdin'],
    { cwd: dir, env, input: 'fixture-secret-value\n', encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing KAKAO_EMAIL/);
  assert.ok(!(result.stdout + result.stderr).includes('fixture-secret-value'));
});
