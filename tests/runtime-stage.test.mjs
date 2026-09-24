import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';
import timers from 'node:timers/promises';
import { promises as fs } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { promoteRuntimeStage } from '../scripts/runtime-stage.mjs';

function substitute(t, { platform, rename, wait, now, log }) {
  if (platform) {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform });
    t.after(() => Object.defineProperty(process, 'platform', original));
  }
  if (rename) t.mock.method(fs, 'rename', rename);
  if (wait) t.mock.method(timers, 'setTimeout', wait);
  if (now) t.mock.method(performance, 'now', now);
  if (log) t.mock.method(console, 'warn', log);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, 'runtime.staging');
  const destination = join(root, 'runtime');
  await mkdir(stage);
  await writeFile(join(stage, 'verified.txt'), 'verified runtime');
  return { stage, destination };
}

for (const code of ['EPERM', 'EBUSY']) {
  test(`Windows promotion survives temporary ${code} without exposing partial runtime`, async t => {
    const { stage, destination } = await fixture(t);
    let attempts = 0;
    const logs = [];
    substitute(t, {
      platform: 'win32',
      rename: async (from, to) => {
        if (++attempts <= 2) throw Object.assign(new Error('directory is locked'), { code });
        await rename(from, to);
      },
      wait: async () => {
        assert.equal(await readFile(join(stage, 'verified.txt'), 'utf8'), 'verified runtime');
        await assert.rejects(stat(destination), { code: 'ENOENT' });
      },
      log: message => logs.push(message),
    });
    await promoteRuntimeStage(stage, destination);
    assert.equal(await readFile(join(destination, 'verified.txt'), 'utf8'), 'verified runtime');
    await assert.rejects(stat(stage), { code: 'ENOENT' });
    assert.ok(logs.some(message => message.includes(code)));
    assert.ok(logs.some(message => message.includes('recovered')));
  });
}

test('persistent Windows permission failure preserves staging and stops at the deadline', async t => {
  const { stage, destination } = await fixture(t);
  const failure = Object.assign(new Error('persistent permission failure'), { code: 'EPERM' });
  let elapsed = 0;
  let attempts = 0;
  substitute(t, {
    platform: 'win32',
    rename: async () => { attempts++; throw failure; },
    now: () => elapsed,
    wait: async ms => {
      elapsed += ms;
      assert.ok(elapsed <= 10000, 'retry deadline exceeded');
    },
    log: () => {},
  });
  await assert.rejects(promoteRuntimeStage(stage, destination), error => error === failure);
  assert.ok(attempts > 1, 'transient failures should get another attempt');
  assert.equal(elapsed, 10000);
  assert.equal(await readFile(join(stage, 'verified.txt'), 'utf8'), 'verified runtime');
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

for (const [platform, code] of [['darwin', 'EPERM'], ['linux', 'EBUSY'], ['win32', 'ENOENT'], ['win32', 'EACCES'], ['win32', 'EEXIST']]) {
  test(`${platform} ${code} fails immediately and preserves staging`, async t => {
    const { stage, destination } = await fixture(t);
    const failure = Object.assign(new Error('non-retryable rename'), { code });
    let attempts = 0;
    substitute(t, {
      platform,
      rename: async () => { attempts++; throw failure; },
      wait: async () => assert.fail('must not wait for a non-retryable error'),
      log: () => assert.fail('must not report a retry'),
    });
    await assert.rejects(promoteRuntimeStage(stage, destination), error => error === failure);
    assert.equal(attempts, 1);
    assert.equal(await readFile(join(stage, 'verified.txt'), 'utf8'), 'verified runtime');
    await assert.rejects(stat(destination), { code: 'ENOENT' });
  });
}

test('normal promotion moves the verified directory without waiting', async t => {
  const { stage, destination } = await fixture(t);
  substitute(t, {
    wait: async () => assert.fail('successful rename must not wait'),
    log: () => assert.fail('successful rename must not report a retry'),
  });
  await promoteRuntimeStage(stage, destination);
  assert.equal(await readFile(join(destination, 'verified.txt'), 'utf8'), 'verified runtime');
  await assert.rejects(stat(stage), { code: 'ENOENT' });
});

test('Windows promotion recovers after a real file handle releases staging', {
  skip: process.platform !== 'win32',
  timeout: 15000,
}, async t => {
  const { stage, destination } = await fixture(t);
  const command = "$ErrorActionPreference='Stop'; $stream=[System.IO.File]::Open($env:VONVON_LOCK_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); try { [Console]::WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $stream.Dispose() }";
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, VONVON_LOCK_FILE: join(stage, 'verified.txt') },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => holder.kill());
  const exited = once(holder, 'exit');
  const lines = createInterface({ input: holder.stdout });
  t.after(() => lines.close());
  const [ready] = await Promise.race([
    once(lines, 'line'),
    exited.then(([code]) => { throw new Error(`Lock holder exited before readiness with ${code}.`); }),
  ]);
  assert.equal(ready, 'locked');
  await assert.rejects(rename(stage, destination), error => ['EPERM', 'EBUSY'].includes(error.code));
  const logs = [];
  let released = false;
  substitute(t, {
    wait: async ms => {
      if (!released) {
        released = true;
        holder.stdin.end('\n');
        const [code] = await exited;
        assert.equal(code, 0);
      }
      await setTimeout(ms);
    },
    log: message => logs.push(message),
  });
  await promoteRuntimeStage(stage, destination);
  assert.ok(logs.some(message => message.includes('recovered')));
  assert.equal(await readFile(join(destination, 'verified.txt'), 'utf8'), 'verified runtime');
  await assert.rejects(stat(stage), { code: 'ENOENT' });
});
