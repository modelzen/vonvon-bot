// The shell text the repo ships, read as bytes: no `$name` directly followed by a non-ASCII byte (fixes-0-9-0). bash on
// macOS, and bash in a single-byte locale on Linux, takes the first byte of a Chinese character for part of the name,
// so under `set -u` the script dies with "VERSION\xef: unbound variable"; `${name}` ends the name. sh is dash on Linux
// CI, which does not do this, so install.test.mjs alone does not catch it.
// main 必败: install.sh printed `$VERSION（$TARGET）` on every install.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The TypeScript that writes shell launchers, or the PATH block every interactive shell runs; scanned whole. */
const LAUNCHER_SOURCES = [
  // startupBlock(): written into ~/.bashrc, ~/.profile and ~/.zshrc (fixes-0-9-0 审查)
  'packages/protocol/src/cli-path-block.ts',
  'packages/daemon/src/cli/commands/standalone-setup.ts',
  'packages/daemon/src/config/data-compatibility.ts',
  'packages/desktop/src/cli-registration.ts',
];

/** Each `$name` followed by a byte ≥ 0x80, as `line: text`. latin1 keeps one character per byte. */
const misread = bytes => bytes.toString('latin1').split('\n').flatMap((line, index) =>
  [...line.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*[\x80-\xff]/g)].map(() => `${index + 1}: ${Buffer.from(line, 'latin1').toString('utf8')}`));

test('the check finds a name run into a Chinese character, and nothing else', () => {
  assert.equal(misread(Buffer.from('say "正在安装 $VERSION（$TARGET）…"\n')).length, 2);
  assert.equal(misread(Buffer.from('fail 1 "缺 $required，没有安装。"')).length, 1);
  for (const fine of ['say "正在安装 ${VERSION}（${TARGET}）…"', 'say "$ROOT/bin/vonvon 没有"', 'echo "$1中$?。$$，"', 'x=$(id -u)。'])
    assert.deepEqual(misread(Buffer.from(fine)), [], fine);
});

test('no shipped shell script or launcher runs a variable name into a non-ASCII byte', async () => {
  const scripts = execFileSync('git', ['ls-files', '-z', '--', '*.sh'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const name of ['scripts/install.sh', 'scripts/uninstall.sh']) assert.ok(scripts.includes(name), `${name} not in ${scripts.join(' ')}`);
  const found = [];
  for (const file of [...scripts, ...LAUNCHER_SOURCES]) {
    for (const hit of misread(await readFile(join(root, file)))) found.push(`${file}:${hit}`);
  }
  assert.deepEqual(found, [], `write \${name} before a Chinese character:\n${found.join('\n')}`);
});
