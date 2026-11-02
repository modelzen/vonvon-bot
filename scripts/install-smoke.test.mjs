// The pieces of the CI install smoke (docs/plans/server-5-release.md 4.6) that can be checked without building a package.
// The whole smoke is `node scripts/install-smoke.mjs`, run by the CI Linux job (ci-run.mjs).
// main 必败: install-smoke.mjs does not exist on main.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { curlShim, noSystemdShim, parseArguments, smokeTarget } from './install-smoke.mjs';

const run = promisify(execFile);
const outcome = (file, args, env) => run(file, args, { env }).then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vonvon-install-smoke-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the smoke runs only where install.sh installs, on one of the published packages', () => {
  assert.equal(smokeTarget('linux', 'x64'), 'linux-x64');
  assert.equal(smokeTarget('linux', 'arm64'), 'linux-arm64');
  assert.throws(() => smokeTarget('darwin', 'arm64'), /只在 Linux 上跑/);
  assert.throws(() => smokeTarget('linux', 'ia32'), /没有 linux-ia32/);
});

test('the Node cache comes from --node-cache or VONVON_SMOKE_NODE_CACHE, as an absolute path', () => {
  assert.deepEqual(parseArguments([], {}), { cache: undefined });
  assert.deepEqual(parseArguments([], { VONVON_SMOKE_NODE_CACHE: 'relative/cache' }), { cache: resolve('relative/cache') });
  assert.deepEqual(parseArguments(['--node-cache', '/cache'], { VONVON_SMOKE_NODE_CACHE: '/other' }), { cache: '/cache' });
  assert.throws(() => parseArguments(['--node-cache'], {}), /usage/);
  assert.throws(() => parseArguments(['--out', '/x'], {}), /usage/);
});

test('the curl stand-in only serves the release address over a request limited to https, from the loopback CDN', async t => {
  const dir = await temporary(t), log = join(dir, 'curl.log'), seen = join(dir, 'real.log');
  await writeFile(join(dir, 'real-curl'), `#!/bin/sh\nprintf '%s\\n' "$*" > '${seen}'\n`);
  await writeFile(join(dir, 'curl'), curlShim({ realCurl: join(dir, 'real-curl'), port: 4321, log }));
  await chmod(join(dir, 'real-curl'), 0o755); await chmod(join(dir, 'curl'), 0o755);
  const env = { PATH: '/usr/bin:/bin' };
  // The call install.sh makes.
  const ok = await outcome(join(dir, 'curl'), ['--proto', '=https', '--tlsv1.2', '-fsSL', '--retry', '3', '--retry-delay', '2', '-o', join(dir, 'm.json'), 'https://dl.vonvon.cc/bot/server/stable/manifest.json'], env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal((await readFile(seen, 'utf8')).trim(), `-fsS --max-time 120 -o ${join(dir, 'm.json')} http://127.0.0.1:4321/script/stable/manifest.json`);
  const unlimited = await outcome(join(dir, 'curl'), ['-fsSL', '-o', join(dir, 'x'), 'https://dl.vonvon.cc/bot/server/install.sh'], env);
  assert.equal(unlimited.code, 2); assert.match(unlimited.stderr, /not limited to https/);
  const elsewhere = await outcome(join(dir, 'curl'), ['--proto', '=https', '-o', join(dir, 'x'), 'https://example.com/bot/server/install.sh'], env);
  assert.equal(elsewhere.code, 6); assert.match(elsewhere.stderr, /not the release address/);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 3, 'every call is logged');
});

test('the systemctl and loginctl stand-ins fail the way a machine without systemd does', async t => {
  const dir = await temporary(t), log = join(dir, 'systemd.log');
  await writeFile(join(dir, 'systemctl'), noSystemdShim('systemctl', log)); await chmod(join(dir, 'systemctl'), 0o755);
  const result = await outcome(join(dir, 'systemctl'), ['--user', 'daemon-reload'], { PATH: '/usr/bin:/bin' });
  assert.equal(result.code, 1);
  // The phrase the daemon's linux-session.ts reads as "no systemd"; install.sh then takes its detached fallback.
  assert.match(result.stderr, /has not been booted with systemd/);
  assert.equal((await readFile(log, 'utf8')).trim(), 'systemctl --user daemon-reload');
  const session = await readFile(new URL('../packages/daemon/src/service/linux-session.ts', import.meta.url), 'utf8');
  assert.match(session, /const NO_SYSTEMD = \/has not been booted with systemd\|/);
});
