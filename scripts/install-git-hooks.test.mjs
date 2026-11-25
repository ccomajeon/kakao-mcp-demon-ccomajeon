import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('./install-git-hooks.mjs', import.meta.url));
const env = { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function repo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kakao-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  return { dir, git };
}
const install = (cwd) => spawnSync(process.execPath, [installer], { cwd, env, encoding: 'utf8' });
// A stand-in scanner that reports which copy ran, with its arguments and standard input.
const fakeScanner = (name, code) => `import fs from 'node:fs';\nprocess.stdout.write(${JSON.stringify(name)} + ' ' + JSON.stringify(process.argv.slice(2)) + ' ' + fs.readFileSync(0, 'utf8'));\nprocess.exitCode = ${code};\n`;

test('installs marked stubs into the clone hooks directory and drops the tracked hooks path', t => {
  const { dir, git } = repo(t);
  git('config', 'core.hooksPath', '.githooks');
  const result = install(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => git('config', '--local', '--get', 'core.hooksPath'), 'the tracked hooks path is no longer used');
  for (const name of ['pre-commit', 'commit-msg', 'pre-push']) {
    const file = path.join(dir, '.git', 'hooks', name);
    assert.match(readFileSync(file, 'utf8'), /installed by scripts\/install-git-hooks\.mjs/);
    assert.ok(statSync(file).mode & 0o100, `${name} is executable`);
  }
  assert.equal(install(dir).status, 0, 'running again is harmless');
});

test('keeps a hook the person wrote and a custom hooks path', t => {
  const { dir, git } = repo(t);
  const own = path.join(dir, '.git', 'hooks', 'pre-commit');
  mkdirSync(path.dirname(own), { recursive: true });
  writeFileSync(own, '#!/bin/sh\necho mine\n');
  const result = install(dir);
  assert.match(result.stderr, /kept your existing pre-commit hook/);
  assert.equal(readFileSync(own, 'utf8'), '#!/bin/sh\necho mine\n');
  assert.ok(existsSync(path.join(dir, '.git', 'hooks', 'commit-msg')));

  const other = repo(t);
  other.git('config', 'core.hooksPath', 'custom-hooks');
  assert.match(install(other.dir).stderr, /core\.hooksPath is set/);
  assert.equal(other.git('config', '--get', 'core.hooksPath'), 'custom-hooks');
  assert.ok(!existsSync(path.join(other.dir, 'custom-hooks')));
});

test('the stubs run the scanner from origin/main, not from the checked-out branch', t => {
  const { dir, git } = repo(t);
  mkdirSync(path.join(dir, 'scripts'));
  writeFileSync(path.join(dir, 'scripts', 'check-private-terms.mjs'), fakeScanner('trusted', 0));
  git('add', 'scripts'); git('commit', '-q', '-m', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(path.join(dir, 'scripts', 'check-private-terms.mjs'), fakeScanner('branch copy', 1));
  assert.equal(install(dir).status, 0);
  const hook = (name, args, input = '') => spawnSync('sh', [path.join(dir, '.git', 'hooks', name), ...args], { cwd: dir, env, input, encoding: 'utf8' });
  const push = hook('pre-push', ['origin', 'https://example.invalid/repo.git'], 'refs/heads/x 1 refs/heads/x 2\n');
  assert.equal(push.status, 0, push.stderr);
  assert.equal(push.stdout, 'trusted ["--pre-push","origin"] refs/heads/x 1 refs/heads/x 2\n');
  assert.equal(hook('commit-msg', ['MSG']).stdout, 'trusted ["--message-file","MSG"] ');
  assert.equal(hook('pre-commit', []).stdout, 'trusted ["--staged"] ');

  // Without origin/main the working copy runs, with a warning, and its failure still blocks.
  git('update-ref', '-d', 'refs/remotes/origin/main');
  const fallback = hook('pre-commit', []);
  assert.equal(fallback.status, 1);
  assert.match(fallback.stdout, /^branch copy/);
  assert.match(fallback.stderr, /origin\/main is unavailable/);
});

test('a linked worktree installs into the shared hooks directory', t => {
  const { dir, git } = repo(t);
  git('commit', '-q', '--allow-empty', '-m', 'fixture');
  const linked = path.join(dir, 'linked');
  git('worktree', 'add', '-q', linked);
  assert.equal(install(linked).status, 0);
  assert.ok(existsSync(path.join(dir, '.git', 'hooks', 'pre-push')));
});
