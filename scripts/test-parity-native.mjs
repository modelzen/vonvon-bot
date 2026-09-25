import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, pbkdf2Sync, createCipheriv } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeFixture } from './native-fixtures.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.env.CI) throw new Error('Local macOS arm64 test only');
const args = process.argv.slice(2);
const injectedFailure = args.includes('--inject-failure=after-host');
if (args.length !== (injectedFailure ? 2 : 1) || !args.includes('--os-service-fixture=absent') || args.some(arg => !['--os-service-fixture=absent', '--inject-failure=after-host'].includes(arg))) throw new Error('Requires explicit absent OS service fixture; only after-host failure injection is supported');
const require = createRequire(import.meta.url);
const runtime = resolve('build/runtime/mac-arm64');
const node = join(runtime, 'node/bin/node');
const modes = injectedFailure ? ['migration'] : ['migration', 'conflict', 'delete', 'active', 'restart'];
const summary = [];
const audit = resolve('.audit/macos-round2');
await mkdir(audit, { recursive: true });
const pause = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
const commandFor = pid => new Promise((accept, reject) => execFile('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }, (error, stdout) => error ? reject(error) : accept(stdout.trim())));
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function discoveryRecords(home) {
  const records = new Map();
  for (const name of ['.vonvon-bridge', '.feishu-codex-bridge']) {
    let text;
    try { text = await readFile(join(home, name, 'web-console.json'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const record = JSON.parse(text);
    if (!Number.isSafeInteger(record.pid) || record.pid < 1 || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || typeof record.token !== 'string' || !record.token) throw new Error(`Invalid fixture discovery at ${home}`);
    records.set(record.pid, record);
  }
  return [...records.values()];
}
async function cleanupFixtureHost(home, expectedPid) {
  const temp = await realpath(tmpdir());
  assert.ok(home.startsWith(join(temp, 'vonvon-parity-')), 'Cleanup is restricted to this run’s fixture home');
  let records = await discoveryRecords(home);
  const seen = [...new Set([...records.map(record => record.pid), ...(expectedPid ? [expectedPid] : [])])];
  const signaled = [];
  for (const record of records) {
    if (!isAlive(record.pid)) continue;
    const response = await fetch(`http://127.0.0.1:${record.port}/api/state`, { headers: { Authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`Fixture Host authentication failed for PID ${record.pid}; refusing to signal`);
    const state = await response.json();
    if (typeof state.version !== 'string' || !Array.isArray(state.bots)) throw new Error(`Fixture Host identity failed for PID ${record.pid}`);
    const command = await commandFor(record.pid);
    if (!command.includes(node) || !command.includes(join(runtime, 'core/bin/feishu-codex-bridge.mjs')) || !command.includes('host --parent-control')) throw new Error(`PID ${record.pid} is not this fixture's bundled Host; refusing to signal`);
    process.kill(record.pid, 'SIGTERM');
    signaled.push(record.pid);
  }
  for (let attempt = 0; attempt < 120; attempt++) {
    if (seen.every(pid => !isAlive(pid))) return { home, observedPids: seen, signaledPids: signaled, verifiedAbsent: true };
    await pause(100);
  }
  records = await discoveryRecords(home);
  throw new Error(`Fixture Host did not stop after cleanup; home=${home}; remaining=${records.map(record => record.pid).join(',')}`);
}
for (const mode of modes) {
  const home = await realpath(await mkdtemp(join(tmpdir(), `vonvon-parity-${mode}-`)));
  await mkdir(join(home, '.codex'));
  await mkdir(join(home, 'fixture-workspace'));
  const originals = await createNativeFixture(home, 'existing');
  const oldPath = join(home, '.feishu-codex-bridge');
  if (mode === 'delete' || mode === 'migration' || mode === 'active') {
    const salt = randomBytes(32);
    const key = pbkdf2Sync(`${hostname()}|${userInfo().username}`, salt, 100_000, 32, 'sha256');
    const encrypt = value => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return { iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') }; };
    await writeFile(join(oldPath, '.keystore.salt'), salt);
    if (mode === 'migration') originals.set(join(oldPath, '.keystore.salt'), salt);
    const envelope = JSON.stringify({ version: 1, entries: { 'app-cli_fixture_engineering': encrypt('fixture-secret-A'), 'app-cli_fixture_content': encrypt('fixture-secret-B') } });
    await writeFile(join(oldPath, 'secrets.enc'), envelope);
    if (mode === 'migration') originals.set(join(oldPath, 'secrets.enc'), envelope);
  }
  const newPath = join(home, '.vonvon-bridge');
  if (mode === 'conflict') {
    await writeFile(join(oldPath, 'fixture-conflict.txt'), 'old store');
    await mkdir(newPath);
    await writeFile(join(newPath, 'fixture-conflict.txt'), 'new distinct store');
  }
  await mkdir(join(home, 'probe-bin'));
  await writeFile(join(home, 'probe-bin', 'launchctl'), '#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = list ]; then exit 0; fi\nprintf "Fixture refused launchctl mutation\\n" >&2\nexit 99\n', { mode: 0o755 });
  await writeFile(join(home, 'probe-bin', 'ps'), '#!/bin/sh\nif [ "$1" = -axo ]; then exit 0; fi\nexec /bin/ps "$@"\n', { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'),
    VONVON_DESKTOP_TEST_HOME: home, VONVON_PARITY_MODE: mode,
    ...(injectedFailure ? { VONVON_PARITY_INJECT_FAILURE: 'after-host' } : {}),
    VONVON_OS_QUERIES: 'explicit-development-fixture',
    VONVON_NPM_CLI: join(runtime, 'node/lib/node_modules/npm/bin/npm-cli.js'),
    PATH: `${join(runtime, 'node/bin')}:${join(home, 'probe-bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  for (const key of ['CODEX_BIN','CLAUDE_BIN','ELECTRON_RUN_AS_NODE','OPENAI_API_KEY','CODEX_API_KEY','CHATGPT_AUTH_TOKEN']) delete env[key];
  const run = (file, args) => new Promise((accept, reject) => {
    const child = spawn(file, args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`${mode} exited ${code}; evidence=${home}`)));
  });
  let injectedPid;
  try {
    if (injectedFailure) {
      await assert.rejects(run(require('electron'), ['scripts/native-parity.cjs']), /migration exited 1/);
      const marker = JSON.parse(await readFile(join(home, 'injected-failure.json'), 'utf8'));
      assert.equal(marker.phase, 'after-host');
      assert.ok(Number.isSafeInteger(marker.pid) && marker.pid > 0);
      injectedPid = marker.pid;
      continue;
    }
    await run(require('electron'), ['scripts/native-parity.cjs']);
    const result = JSON.parse(await readFile(join(home, 'parity-result.json'), 'utf8'));
    if (mode === 'migration') {
      assert.equal(result.alias.oldIsSymlink && result.alias.sameRealpath && result.alias.settingsBytesEqual, true);
      for (const [file, original] of originals) {
        const actual = await readFile(file, typeof original === 'string' ? 'utf8' : undefined);
        assert.deepEqual(actual, original, `Migration changed ${file}`);
      }
      assert.equal(result.stoppedSettings.readonly, 'readonly');
      assert.equal(result.stoppedSettings.denied, 'unavailable');
    }
    if (mode === 'conflict') {
      assert.equal(result.blocked.bothPathsNamed && result.blocked.uiShowsConflict, true);
      assert.equal(result.recovered.oldAlias, true);
      assert.equal(result.recovered.heldStore, 'new distinct store');
      assert.equal(result.recovered.newStore, 'old store');
    }
    if (mode === 'delete') {
      assert.equal(result.preserved.firstConfigBytesEqual && result.preserved.deletedDirectoryAbsent && result.preserved.removedTargetSecret && result.preserved.otherSecretBytesEqual, true);
      assert.deepEqual(result.preserved.remainingIds, ['cli_fixture_engineering']);
      let checked = 0;
      for (const [file, original] of originals) {
        if (!file.includes('/bots/cli_fixture_engineering/')) continue;
        assert.equal(await readFile(file, 'utf8'), original, `Other Agent changed at ${file}`);
        checked++;
      }
      assert.equal(checked, 4, 'Other Agent config, projects, session and comment files checked');
    }
    if (mode === 'active') assert.equal(result.preserved.targetFilesUnchanged && result.preserved.registryBytesEqual && result.preserved.secretBytesEqual && result.preserved.targetListed, true);
    if (mode === 'restart') {
      assert.equal(result.restartReply.kind, 'applied');
      assert.equal(result.restart.afterOwnership, 'owned');
      assert.equal(result.restart.savedSetting, null);
      assert.deepEqual(result.restart.preservedAgentIds, ['cli_fixture_content', 'cli_fixture_engineering']);
    }
    const inspector = join(home, 'inspect.mjs');
    await writeFile(inspector, `import {inspectHost} from ${JSON.stringify(pathToFileURL(join(runtime, 'core/dist/host.js')).href)}; const result=await inspectHost(${JSON.stringify(home)}); if(result.kind!=='absent')throw new Error(JSON.stringify(result)); process.stdout.write('Owned Host absent after quit.\\n');`);
    await run(node, [inspector]);
    summary.push({ mode, home, result });
  } finally {
    const cleanup = await cleanupFixtureHost(home, injectedPid);
    await writeFile(join(audit, `${mode}-cleanup.json`), JSON.stringify(cleanup, null, 2));
  }
}
await writeFile(join(audit, injectedFailure ? 'injected-failure-cleanup.json' : 'native-summary.json'), JSON.stringify(injectedFailure ? { cleaned: true, mode: 'migration', cleanup: JSON.parse(await readFile(join(audit, 'migration-cleanup.json'), 'utf8')) } : summary, null, 2));
process.stdout.write(`macOS native parity scenarios complete: ${modes.join(', ')}\n`);
