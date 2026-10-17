import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[2];
assert(root && /^\/tmp\/tmp\.[^/]+$/.test(root), 'Use check-crash-recovery.sh to supply a fresh temporary directory');
assert.deepEqual(readdirSync(root), []);
const home = join(root, 'home'), data = join(root, 'vh'), fake = join(root, 'fake');
const cli = join(repo, 'packages/daemon/bin/vonvon.mjs');
const env = { ...process.env, HOME: home, VONVON_HOME: data, FAKE_FEISHU_DIR: fake,
  NODE_OPTIONS: `--import=${join(repo, 'scripts/fixtures/crash-feishu.mjs')}` };
for (const dir of [home, data, fake]) mkdirSync(dir, { recursive: true });
const bots = ['A', 'B'].map((suffix, index) => ({ name: `fake${suffix}`, appId: `cli_recoveryfake${suffix}`,
  botName: `假bot${suffix}`, tenant: 'feishu', createdAt: 1000 + index, active: true }));
for (const bot of bots) {
  const dir = join(data, 'bots', bot.appId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ accounts: { app: { id: bot.appId,
    secret: `secret-${bot.appId}`, tenant: 'feishu' } }, preferences: { access: { ownerOpenId: `ou_fake_${bot.name}` } } }), { mode: 0o600 });
}
writeFileSync(join(data, 'bots.json'), JSON.stringify({ version: 1, current: bots[0].appId, bots }), { mode: 0o600 });
const mode = value => writeFileSync(join(fake, 'mode'), value);
const jsonLines = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const sent = () => jsonLines(join(fake, 'sent.jsonl'));
const pending = () => existsSync(join(data, 'crash/unsent-notices.json'))
  ? JSON.parse(readFileSync(join(data, 'crash/unsent-notices.json'), 'utf8')).items : [];
const logs = () => readdirSync(join(data, 'logs')).filter(name => name.endsWith('.log'))
  .flatMap(name => jsonLines(join(data, 'logs', name)));
const vv = (...args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 40_000, stdio: ['ignore', 'pipe', 'pipe'] });
const status = () => JSON.parse(vv('daemon', 'status', '--json'));
const waitFor = async (check, label, timeout = 40_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = check();
    if (result) return result;
    await pause(200);
  }
  throw new Error(`Timed out: ${label}`);
};
const start = () => { vv('daemon', 'start'); assert.equal(status().running, true); };
const killHost = async () => {
  const current = status(); // This CLI authenticates the owner of this isolated data directory.
  assert.equal(current.running, true);
  assert(current.pid > 1 && current.pid !== process.pid);
  process.kill(current.pid, 'SIGKILL');
  await waitFor(() => !status().running, 'isolated host exits');
};
const hostPause = message => message.body.content.text.startsWith('daemon ') && message.body.content.text.includes('已停止自动重启');
let blocker;
try {
  mode('ok');
  start();
  await waitFor(() => sent().filter(message => message.mode === 'ok').length === 2, 'both fake bots pause and notify');
  assert.equal(status().pausedBots.length, 2);
  mode('503');
  for (let count = 0; count < 3; count++) { await killHost(); start(); }
  const failed = await waitFor(() => sent().find(message => message.mode === '503' && hostPause(message)), 'host pause fails with 503');
  const uuid = failed.body.uuid;
  assert(pending().some(item => item.kind === 'host-paused' && item.uuid === uuid));
  assert(status().paused);
  console.log('PASS D1: failed host pause is durable before a forced exit');

  // A failed startup must retain the pending pause even though hostStarted already queued it.
  const port = Number(status().listen.split(':').at(-1));
  await killHost();
  blocker = createServer();
  await new Promise((done, reject) => { blocker.once('error', reject); blocker.listen(port, '127.0.0.1', done); });
  assert.throws(() => vv('daemon', 'start', '--port', String(port)));
  assert(pending().some(item => item.kind === 'host-paused' && item.uuid === uuid));
  assert.equal(status().running, false);
  await new Promise(done => blocker.close(done));
  blocker = undefined;
  mode('ok');
  start();
  await waitFor(() => sent().some(message => message.mode === 'ok' && message.body.uuid === uuid), 'same UUID is replayed');
  await waitFor(() => pending().length === 0, 'successful replay settles the file');
  assert.equal(sent().filter(message => message.mode === 'ok' && message.body.uuid === uuid).length, 1);
  assert(logs().some(entry => entry.event === 'unsent-resent'));
  console.log('PASS D3: occupied-port startup preserves the UUID; same-chain restart replays it once');

  mode('503');
  vv('daemon', 'restart');
  await waitFor(() => pending().filter(item => item.kind === 'bot-paused').length === 2, 'new-chain bot pauses are durable');
  const stale = pending().map(item => item.uuid);
  await waitFor(() => stale.every(id => sent().some(message => message.mode === '503' && message.body.uuid === id)), 'both bot notices fail');
  vv('daemon', 'stop');
  assert.equal(pending().length, 2);
  mode('ok');
  start();
  await waitFor(() => sent().filter(message => message.mode === 'ok' && !hostPause(message)).length === 4, 'new chain sends new bot notices');
  assert(!sent().some(message => message.mode === 'ok' && stale.includes(message.body.uuid)));
  assert(logs().some(entry => entry.event === 'unsent-stale' && entry.n === 2));
  assert.equal(pending().length, 0);
  assert(jsonLines(join(fake, 'tokens.jsonl')).every(item => item.secret_ok));
  assert(jsonLines(join(fake, 'blocked.jsonl')).length > 0);
  console.log('PASS D2: unfinished shutdown notices survive; the next chain replaces both with new UUIDs');
} catch (error) {
  console.error('Crash recovery check failed:', error);
  console.error(JSON.stringify({ pending: pending(), sent: sent(), logs: existsSync(join(data, 'logs')) ? logs().slice(-15) : [] }, null, 2));
  process.exitCode = 1;
} finally {
  if (blocker) await new Promise(done => blocker.close(done));
  try { vv('daemon', 'stop'); } catch { /* Sweep only processes inheriting this exact isolated VONVON_HOME below. */ }
  // Linux only: clean an isolated orphan if the host was killed immediately before the check failed.
  if (process.platform === 'linux') {
    for (const name of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      if (Number(name) === process.pid) continue;
      try {
        const vars = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
        if (vars.includes(`VONVON_HOME=${data}`)) process.kill(Number(name), 'SIGKILL');
      } catch { /* Already exited or not owned by this user. */ }
    }
  }
}
