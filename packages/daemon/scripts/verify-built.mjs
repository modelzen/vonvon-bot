import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../bin/vonvon.mjs', import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'vonvon-built-daemon-'));
const env = { ...process.env, HOME: home, VONVON_HOME: join(home, 'data') };
const child = spawn(process.execPath, [entry, 'daemon', 'run', '--port', '0'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Daemon did not become ready:\n${output}`)), 30_000);
    const ready = chunk => {
      output += chunk.toString();
      if (output.includes('vonvon daemon ready')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', ready);
    child.stderr.on('data', ready);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Daemon exited ${code} before readiness:\n${output}`)); });
  });
  const status = spawnSync(process.execPath, [entry, 'daemon', 'status', '--json'], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(status.status, 0, status.stderr);
  const running = JSON.parse(status.stdout);
  assert.equal(running.running, true);
  assert.equal(running.pid, child.pid, 'Only stop the daemon started by this check');
  const stop = spawnSync(process.execPath, [entry, 'daemon', 'stop', '--json'], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(JSON.parse(stop.stdout).stopped, true);
  const result = await Promise.race([
    exited,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Daemon did not stop:\n${output}`)), 10_000);
      timer.unref();
    }),
  ]);
  assert.equal(result.code, 0, output);
  console.log('Built daemon reached readiness and stopped cleanly.');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
  await rm(home, { recursive: true, force: true });
}
