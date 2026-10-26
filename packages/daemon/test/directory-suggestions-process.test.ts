import {execFileSync, type ChildProcess} from 'node:child_process';
import {mkdtemp, mkdir, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createDirectorySuggestions, directorySuggestionWorkerSource} from '../src/server/directory-suggestions';

// Keep process readiness and exit observation on real time while controlling only
// the parent's product deadline. Worker filesystem calls and FIFO blocking stay real.
const waitForIo = delay;
const children = vi.hoisted(() => [] as Array<{child: ChildProcess; closed: Promise<void>}>);
vi.mock('node:child_process', async original => {
  const real = await original<typeof import('node:child_process')>();
  return {...real, spawn: (...args: Parameters<typeof real.spawn>) => {
    const child = real.spawn(...args);
    children.push({child, closed: new Promise<void>(resolve => { child.once('close', () => resolve()); })});
    return child;
  }};
});
const resources: Array<{root: string; search: ReturnType<typeof createDirectorySuggestions>}> = [];
beforeEach(() => { vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']}); });
afterEach(async () => {
  const owned = resources.splice(0);
  try {
    for (const {search} of owned) search.close();
    // Also reap a child that had not written its readiness marker when setup failed.
    const spawned = children.splice(0);
    for (const {child} of spawned) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(spawned.map(({closed}) => closed));
    for (const {root} of owned) await rm(root, {recursive: true, force: true});
  } finally { vi.useRealTimers(); }
});
async function waitUntil(check: () => boolean | Promise<boolean>, signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const ready = await check();
    signal.throwIfAborted();
    if (ready) return;
    await waitForIo(10, undefined, {signal});
  }
}
function observed<T>(promise: Promise<T>) {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  // Install both handlers immediately: failed readiness must not leave an
  // unhandled assertion promise when cleanup resolves or rejects the search.
  const result = promise.then(value => { state = 'fulfilled'; return {kind: 'fulfilled' as const, value}; },
    error => { state = 'rejected'; return {kind: 'rejected' as const, error: error as unknown}; });
  return {state: () => state, result};
}
async function fixture(signal: AbortSignal) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vonvon-directory-process-')));
  await mkdir(join(root, 'work', 'paseo'), {recursive: true});
  execFileSync('mkfifo', [join(root, 'blocked.pipe')]);
  // This is a genuine blocking filesystem syscall in a real child process, not
  // a mocked timeout Promise. Normal queries still execute the compiled worker.
  const prologue = `if(process.argv[2].includes('blocked')){require('node:fs').writeFileSync(process.argv[1]+'/ready-'+process.argv[2].replaceAll('/','_'),String(process.pid));require('node:fs').readFileSync(process.argv[1]+'/blocked.pipe');}\n`;
  const search = createDirectorySuggestions(prologue + directorySuggestionWorkerSource);
  resources.push({root, search});
  const ready = async (query: string) => {
    let pid = 0;
    await waitUntil(async () => {
      try { pid = Number(await readFile(join(root, `ready-${query.replaceAll('/', '_')}`), {encoding: 'utf8', signal})); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      return Number.isInteger(pid) && pid > 0;
    }, signal);
    return pid;
  };
  return {root, search, ready};
}
const exited = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

it('keeps explicit paths usable after two searches are blocked in filesystem syscalls', async ({signal}) => {
  const {root, search, ready} = await fixture(signal);
  const first = observed(search.search(root, 'blocked-one'));
  const second = observed(search.search(root, 'blocked-two'));
  const pids = await Promise.all([ready('blocked-one'), ready('blocked-two')]);
  expect(first.state()).toBe('pending');
  expect(second.state()).toBe('pending');
  const current = observed(search.search(root, '~/work/'));
  // Eviction settles without advancing the product clock or waiting for old I/O.
  await Promise.resolve();
  expect(first.state()).toBe('fulfilled');
  expect(await first.result).toMatchObject({kind: 'fulfilled', value: {truncated: true}});
  expect(await current.result).toMatchObject({kind: 'fulfilled', value: {
    entries: [{name: 'work'}, {name: 'paseo'}], truncated: false,
  }});
  search.close();
  expect(await second.result).toMatchObject({kind: 'fulfilled', value: {truncated: true}});
  await waitUntil(() => pids.every(exited), signal);
});

it('hard-times out a hung name search and kills the actual worker process', async ({signal}) => {
  const {root, search, ready} = await fixture(signal);
  const result = observed(search.search(root, 'blocked-name'));
  const pid = await ready('blocked-name');
  await vi.advanceTimersByTimeAsync(1499);
  expect(result.state()).toBe('pending');
  expect(exited(pid)).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(result.state()).toBe('fulfilled');
  expect(await result.result).toMatchObject({kind: 'fulfilled', value: {truncated: true}});
  await waitUntil(() => exited(pid), signal);
  expect((await search.search(root, '~/work/')).entries.map(entry => entry.name)).toEqual(['work', 'paseo']);
});

it('reports a timeout when an explicit path never produced a verified directory', async ({signal}) => {
  const {root, search, ready} = await fixture(signal);
  const result = observed(search.search(root, '~/blocked-path'));
  const pid = await ready('~/blocked-path');
  await vi.advanceTimersByTimeAsync(1499);
  expect(result.state()).toBe('pending');
  expect(exited(pid)).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(result.state()).toBe('rejected');
  expect(await result.result).toMatchObject({kind: 'rejected', error: {code: 'directory_timeout'}});
  await waitUntil(() => exited(pid), signal);
});

it('closes pending directory workers immediately without waiting for blocked I/O', async ({signal}) => {
  const {root, search, ready} = await fixture(signal);
  const result = observed(search.search(root, 'blocked-shutdown'));
  const pid = await ready('blocked-shutdown');
  search.close();
  await Promise.resolve();
  expect(result.state()).toBe('fulfilled');
  expect(await result.result).toMatchObject({kind: 'fulfilled', value: {truncated: true}});
  await waitUntil(() => exited(pid), signal);
  await expect(search.search(root, '')).rejects.toMatchObject({code: 'directory_closed'});
});
