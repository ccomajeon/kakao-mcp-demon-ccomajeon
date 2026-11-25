#!/usr/bin/env node
// Install the private-terms hooks into this clone's own Git hooks directory (`npm ci` runs this as `prepare`).
// Hooks never come from a tracked directory: a branch under review could otherwise add a hook that runs on
// checkout. Each installed stub runs the scanner from origin/main instead of the checked-out branch.
// An existing hook that this script did not install is left alone.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MARK = '# kakao-mcp private-terms hook (installed by scripts/install-git-hooks.mjs)';
const SCANNER = 'scripts/check-private-terms.mjs';
const LEGACY_HOOKS_PATH = '.githooks';
const HOOKS = {
  'pre-commit': '--staged',
  'commit-msg': '--message-file "$1"',
  'pre-push': '--pre-push "$1"'
};

function hookScript(args) {
  return `#!/bin/sh
${MARK}
# Runs ${SCANNER} from origin/main, not from the checked-out branch, so a branch under review cannot
# change what runs here. Never bypass with --no-verify; rewrite the text instead.
dir=$(mktemp -d "\${TMPDIR:-/tmp}/kakao-private-terms.XXXXXX") || exit 1
trap 'rm -rf "$dir"' EXIT
if git show origin/main:${SCANNER} >"$dir/check-private-terms.mjs" 2>/dev/null; then
  scanner="$dir/check-private-terms.mjs"
else
  echo "private-terms hook: origin/main is unavailable; running this checkout's scanner, review it before trusting it" >&2
  scanner=${SCANNER}
fi
node "$scanner" ${args}
`;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function install() {
  try {
    if (git('rev-parse', '--is-inside-work-tree') !== 'true') return;
  } catch {
    return; // not a Git checkout (for example an unpacked package) or Git is missing
  }
  // Earlier versions pointed core.hooksPath at the tracked .githooks directory; undo only that value.
  let hooksPath = '';
  try { hooksPath = git('config', '--local', '--get', 'core.hooksPath'); } catch { /* unset */ }
  if (hooksPath === LEGACY_HOOKS_PATH || hooksPath === `${LEGACY_HOOKS_PATH}/`) {
    git('config', '--local', '--unset', 'core.hooksPath');
    hooksPath = '';
  }
  try { hooksPath ||= git('config', '--get', 'core.hooksPath'); } catch { /* unset */ }
  if (hooksPath) {
    process.stderr.write(`private-terms hooks: core.hooksPath is set to ${hooksPath}; not installing. Add hooks that run ${SCANNER} there yourself.\n`);
    return;
  }
  const dir = path.resolve(git('rev-parse', '--git-path', 'hooks'));
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, args] of Object.entries(HOOKS)) {
    const file = path.join(dir, name);
    let current;
    try { current = fs.readFileSync(file, 'utf8'); } catch { /* absent */ }
    if (current !== undefined && !current.includes(MARK)) {
      process.stderr.write(`private-terms hooks: kept your existing ${name} hook; add a call to ${SCANNER} ${args} yourself.\n`);
      continue;
    }
    const script = hookScript(args);
    if (current !== script) fs.writeFileSync(file, script);
    fs.chmodSync(file, 0o755);
  }
}

try {
  install();
} catch (error) {
  // Installing dependencies must not fail because of hooks; say so instead of hiding it.
  process.stderr.write(`private-terms hooks: not installed (${error?.message ?? error})\n`);
}
