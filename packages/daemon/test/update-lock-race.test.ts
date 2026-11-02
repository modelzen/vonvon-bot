import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processStart } from '../src/service/update-lock';

// Review 220: reclaiming a stale lock by renaming it aside and linking it back left the name free in between, so a
// reclaimer that paused between judging the lock stale and renaming moved a newer holder's lock away, and a third
// process took the free name while that holder went on believing it held the lock. Real processes on the real lock
// module: exactly one holder, every round.
const root = mkdtempSync(join(tmpdir(), 'vonvon-lock-race-'));
const entry = join(root, 'update-lock.cjs');
beforeAll(async () => {
  await build({ entryPoints: [fileURLToPath(new URL('../src/service/update-lock.ts', import.meta.url))], outfile: entry, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const DEAD = JSON.stringify({ pid: 2147483000, at: 0, token: 'dead' });
// A child: loads the lock module, says it is ready, waits for the go file, takes the lock once and stays alive holding
// it. `slow` pauses 150 ms right after the first read of the lock file, the moment between judging it stale and
// reclaiming it.
const CHILD = `
const fs = require('node:fs');
const [entry, lock, ready, go, mode] = process.argv.slice(1);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (mode === 'slow') {
  const real = fs.readFileSync;
  let once = true;
  fs.readFileSync = function (path, ...rest) { const out = real.call(fs, path, ...rest); if (once && path === lock) { once = false; pause(150); } return out; };
}
const m = require(entry);
const acquire = m.acquireFileLock ?? m.acquireUpdateLock;
fs.writeFileSync(ready, '');
while (!fs.existsSync(go)) pause(1);
const release = acquire(lock);
process.stdout.write(release ? 'held' : 'none');
setInterval(() => {}, 1000);
`;

type Child = { child: ChildProcess; ready: string; output: () => string };
function start(lock: string, go: string, mode: 'slow' | 'fast', index: number): Child {
  const ready = `${lock}.ready-${index}`;
  const child = spawn(process.execPath, ['-e', CHILD, entry, lock, ready, go, mode], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  return { child, ready, output: () => out };
}
async function waitFor(condition: () => boolean, what: string, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const exited = (child: ChildProcess): Promise<void> => new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()); });

async function round(name: string, modes: Array<'slow' | 'fast'>, thirdParty: boolean): Promise<void> {
  const dir = join(root, name);
  mkdirSync(dir);
  const lock = join(dir, 'releases.lock');
  writeFileSync(lock, DEAD);
  const go = join(dir, 'go');
  const children = modes.map((mode, index) => start(lock, go, mode, index));
  try {
    await waitFor(() => children.every(child => existsSync(child.ready)), `${name}: children ready`);
    // The third party: records of this process, linked onto the lock's name whenever it is free. Nobody releases in a
    // round, so once anyone holds the lock the name must never be free again: at most one link succeeds, and then no
    // child may hold.
    const start = processStart(process.pid);
    const thirds = [0, 1, 2].map(index => {
      const file = join(dir, `third-${index}`);
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), token: `third-${index}`, ...(start ? { start } : {}) }));
      return file;
    });
    writeFileSync(go, '');
    let taken = 0;
    if (thirdParty) {
      for (const until = Date.now() + 400; Date.now() < until && taken < thirds.length;) {
        try { linkSync(thirds[taken]!, lock); taken++; } catch { /* the name is taken: as it should be */ }
      }
    }
    await waitFor(() => children.every(child => child.output().length > 0), `${name}: children answered`);
    const outputs = children.map(child => child.output());
    const holders = outputs.filter(output => output === 'held').length + taken;
    expect(holders, `${name}: ${JSON.stringify(outputs)}, third party took the name ${taken} times`).toBe(1);
    const record = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number };
    expect(record.pid, `${name}: the lock names the holder`).toBe(taken ? process.pid : children[outputs.indexOf('held')]!.child.pid);
    expect(existsSync(`${lock}.reclaim`), `${name}: no guard left`).toBe(false);
  } finally {
    for (const { child } of children) child.kill();
    await Promise.all(children.map(({ child }) => exited(child)));
  }
}

describe.skipIf(process.platform === 'win32')('acquireUpdateLock across processes', () => {
  it('a reclaimer that paused after judging the lock stale, another that reclaimed it meanwhile, and a third party: one holder', async () => {
    for (let i = 0; i < 8; i++) await round(`paused-${i}`, ['slow', 'fast'], true);
  }, 90_000);
  it('three processes reclaiming the same dead lock at once: one holder', async () => {
    for (let i = 0; i < 6; i++) await round(`three-${i}`, ['fast', 'fast', 'fast'], false);
  }, 90_000);
});
