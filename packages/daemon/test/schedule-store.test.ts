import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, open } from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/core/logger';
import { botPaths } from '../src/config/paths';
import { createScheduleStore } from '../src/bot/schedule/store';
import type { StoredTask } from '../src/bot/schedule/types';
import { writeFileAtomic } from '../src/server/atomic-file';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const task = (id = 'task'): StoredTask => ({
  id, chatId: 'chat', revision: 'before', name: 'task', instruction: 'hello', spec: { kind: 'every', minutes: 1, anchor: 0 },
  timeZone: 'UTC', placement: { kind: 'follow' }, state: 'active', createdBy: { via: 'cli' }, createdAt: 0, updatedAt: 0,
  cursor: 0, counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [],
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'schedule-store-')); dirs.push(dir);
  const file = join(dir, 'schedules.json'); const diagnostics = vi.fn();
  const store = createScheduleStore(file, { now: () => 123, log, diagnostics, newRevision: () => 'after' });
  return { dir, file, diagnostics, store };
}

describe('schedule persistence', () => {
  it('starts empty without creating a file; saves version without file revision', async () => {
    const { file, store } = await setup();
    expect(botPaths('bot-test').schedulesFile).toBe(join(botPaths('bot-test').dir, 'schedules.json'));
    expect(await store.load()).toEqual({ interrupted: [] }); expect(store.all()).toEqual([]);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await store.mutateConfig(tasks => tasks.push(task()));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, tasks: [task()] });
  });
  it('touch changes only configuration revisions and runtime leaves them alone', async () => {
    const { store } = await setup(); await store.mutateConfig(tasks => tasks.push(task(), task('other')));
    await store.mutateConfig((tasks, touch) => { touch(tasks[0]!); });
    expect(store.all().map(t => [t.revision, t.updatedAt])).toEqual([['after', 123], ['before', 0]]);
    await store.mutateRuntime(tasks => { tasks[0]!.cursor = 60_000; });
    expect(store.get('task')).toMatchObject({ revision: 'after', cursor: 60_000 });
    const snapshot = store.all(); snapshot[0]!.name = 'mutated'; expect(store.get('task')!.name).toBe('task');
  });
  it('serializes competing writes and returns their callback values', async () => {
    const { store, file } = await setup();
    expect(await Promise.all(['a', 'b'].map(id => store.mutateConfig(tasks => { tasks.push(task(id)); return id; })))).toEqual(['a', 'b']);
    expect(JSON.parse(await readFile(file, 'utf8')).tasks.map((t: StoredTask) => t.id)).toEqual(['a', 'b']);
  });
  it('keeps memory intact on a failed write and recovers the write chain', async () => {
    const { store, file } = await setup(); await store.mutateConfig(tasks => tasks.push(task()));
    const before = store.all(); await rm(file); await mkdir(file);
    await expect(store.mutateRuntime(tasks => { tasks[0]!.cursor = 5; })).rejects.toThrow(); expect(store.all()).toEqual(before);
    await rm(file, { recursive: true }); await store.mutateRuntime(tasks => { tasks[0]!.cursor = 6; });
    expect(store.get('task')!.cursor).toBe(6);
  });
  it.each(['{broken', '{"version":2,"tasks":[]}'])('quarantines corrupt input %s', async contents => {
    const { store, file, dir, diagnostics } = await setup(); await writeFile(file, contents);
    expect(await store.load()).toEqual({ interrupted: [] }); expect(store.all()).toEqual([]);
    expect(await readdir(dir)).toEqual(['schedules.json.corrupt-123']);
    expect(diagnostics).toHaveBeenCalledExactlyOnceWith({ kind: 'schedule-store-corrupt' });
  });
  it('bounds records and excerpts, reloads inflight and keeps reads detached', async () => {
    const { store, file } = await setup(); const value = task();
    value.recent = Array.from({ length: 21 }, (_, slot) => ({ runId: String(slot), slot, trigger: 'schedule', status: 'done' }));
    value.lastResult = { at: 0, status: 'done', excerpt: '字'.repeat(501) };
    value.inflight = { runId: 'run', revision: 'before', slot: 1, trigger: 'schedule', startedAt: 1 };
    await store.mutateConfig(tasks => tasks.push(value));
    expect(store.get('task')!.recent.map(r => r.slot)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(store.get('task')!.lastResult!.excerpt).toHaveLength(500);
    await store.mutateRuntime(tasks => { tasks[0]!.lastResult!.excerpt = '字' + '😀'.repeat(251); });
    expect(store.get('task')!.lastResult!.excerpt).toHaveLength(499);
    expect(store.get('task')!.lastResult!.excerpt).toBe('字' + '😀'.repeat(249));
    const loaded = createScheduleStore(file, { now: Date.now, log, diagnostics: vi.fn() });
    expect((await loaded.load()).interrupted).toEqual(store.all());
    expect(loaded.byChat('chat')).toHaveLength(1); expect(loaded.byChat('elsewhere')).toEqual([]);
  });
  it('notifies only committed changes and supports unsubscribe', async () => {
    const { store } = await setup(); const listener = vi.fn(); const off = store.onChange(listener);
    await store.mutateRuntime(() => 'ok'); expect(listener).toHaveBeenCalledOnce(); off();
    await store.mutateRuntime(() => undefined); expect(listener).toHaveBeenCalledOnce();
  });
  it('syncs both temporary file and parent directory only for durable writes', async () => {
    const { file, dir } = await setup(); const handle = await open(join(dir, 'probe'), 'w');
    const sync = vi.spyOn(Object.getPrototypeOf(handle), 'sync'); await handle.close();
    await writeFileAtomic(file, 'normal'); expect(sync).not.toHaveBeenCalled();
    await writeFileAtomic(file, 'durable', { durable: true }); expect(sync).toHaveBeenCalledTimes(2);
    expect(await readFile(file, 'utf8')).toBe('durable');
  });
  it('tolerates unsupported directory fsync but propagates file fsync failures', async () => {
    const { file, dir } = await setup(); const handle = await open(join(dir, 'probe'), 'w');
    const sync = vi.spyOn(Object.getPrototypeOf(handle), 'sync'); await handle.close();
    sync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error('unsupported'), { code: 'EINVAL' }));
    await writeFileAtomic(file, 'committed', { durable: true });
    expect(await readFile(file, 'utf8')).toBe('committed');
    sync.mockRejectedValueOnce(new Error('file sync failed'));
    await expect(writeFileAtomic(file, 'lost', { durable: true })).rejects.toThrow('file sync failed');
    expect(await readFile(file, 'utf8')).toBe('committed');
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  // [4]/[15]: once rename has replaced the file, a directory fsync error must not reject the write.
  it('[4][15] directory fsync EPERM after rename resolves, keeps the new file and logs directory-sync-failed', async () => {
    const { file, dir } = await setup(); const handle = await open(join(dir, 'probe'), 'w');
    const sync = vi.spyOn(Object.getPrototypeOf(handle), 'sync'); await handle.close();
    const warn = vi.spyOn(log, 'warn');
    sync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error('not permitted'), { code: 'EPERM' }));
    await writeFileAtomic(file, 'new', { durable: true });
    expect(await readFile(file, 'utf8')).toBe('new');
    expect(warn).toHaveBeenCalledWith('atomic-file', 'directory-sync-failed', { path: dir, code: 'EPERM' });
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
  it('[4][15] any other directory fsync errno (EIO) after rename resolves too', async () => {
    const { file, dir } = await setup(); const warn = vi.spyOn(log, 'warn');
    const handle = await open(join(dir, 'probe'), 'w');
    const sync = vi.spyOn(Object.getPrototypeOf(handle), 'sync'); await handle.close();
    sync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error('io'), { code: 'EIO' }));
    await expect(writeFileAtomic(file, 'again', { durable: true })).resolves.toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('again');
    expect(warn).toHaveBeenCalledWith('atomic-file', 'directory-sync-failed', { path: dir, code: 'EIO' });
  });
  it('[4][15] skips the directory fsync on win32 and still syncs the temporary file', async () => {
    const { file, dir } = await setup(); const handle = await open(join(dir, 'probe'), 'w');
    const sync = vi.spyOn(Object.getPrototypeOf(handle), 'sync'); await handle.close();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      // Directory handles on Windows reject sync with EPERM; fail every sync after the first to prove none is made.
      sync.mockResolvedValueOnce(undefined).mockRejectedValue(Object.assign(new Error('not permitted'), { code: 'EPERM' }));
      await writeFileAtomic(file, 'windows', { durable: true });
    } finally { Object.defineProperty(process, 'platform', platform); }
    expect(sync).toHaveBeenCalledTimes(1);
    expect(await readFile(file, 'utf8')).toBe('windows');
  });
  it('[4][15] store mutate resolves on directory fsync EPERM and memory equals disk', async () => {
    const { store, file, dir } = await setup(); const handle = await open(join(dir, 'probe'), 'w');
    const sync = vi.spyOn(Object.getPrototypeOf(handle), 'sync'); await handle.close();
    sync.mockImplementation(async function (this: { fd: number }) {
      // Fail only directory handles, like FlushFileBuffers on a Windows directory.
      if (fstatSync(this.fd).isDirectory()) throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });
    await expect(store.mutateConfig(tasks => { tasks.push(task('a')); })).resolves.toBeUndefined();
    await expect(store.mutateRuntime(tasks => { tasks[0]!.cursor = 99; })).resolves.toBeUndefined();
    expect(store.get('a')!.cursor).toBe(99);
    expect(JSON.parse(await readFile(file, 'utf8')).tasks).toEqual(store.all());
  });

  // [16]/[2]/[17]: the store must never write what its own load() would quarantine.
  it('[16][2][17] clamps an over-long recent error to 200 units, rounds durationMs, and the file reloads with every task', async () => {
    const { store, file, dir } = await setup();
    await store.mutateConfig(tasks => { tasks.push(task('a'), task('b')); });
    await store.mutateRuntime(tasks => {
      tasks[0]!.recent.push(
        { runId: 'r1', slot: 1, trigger: 'schedule', status: 'failed', error: 'x'.repeat(201), durationMs: 12.6 },
        { runId: 'r2', slot: 2, trigger: 'schedule', status: 'failed', error: '字' + '😀'.repeat(100), durationMs: -5 },
      );
    });
    const [first, second] = store.get('a')!.recent;
    expect(first!.error).toBe('x'.repeat(200));
    expect(first!.durationMs).toBe(13);
    expect(second!.error).toBe('字' + '😀'.repeat(99)); // 199 units: the next pair would cross 200, so it is not split
    expect(second!.durationMs).toBe(0);
    const reloaded = createScheduleStore(file, { now: () => 456, log, diagnostics: vi.fn() });
    await reloaded.load();
    expect(reloaded.all()).toEqual(store.all());
    expect(reloaded.all().map(t => t.id)).toEqual(['a', 'b']);
    expect((await readdir(dir)).filter(name => name.includes('.corrupt-'))).toEqual([]);
  });
  it('[16][2][17] refuses a draft its load() would reject (bad link); memory, file and listeners unchanged', async () => {
    const { store, file } = await setup(); await store.mutateConfig(tasks => { tasks.push(task('a'), task('b')); });
    const before = store.all(); const text = await readFile(file, 'utf8'); const listener = vi.fn(); store.onChange(listener);
    await expect(store.mutateRuntime(tasks => {
      tasks[1]!.recent.push({ runId: 'r', slot: 1, trigger: 'schedule', status: 'done', link: 'not a url' });
    })).rejects.toThrow(/schedule store refused an invalid write/);
    expect(store.all()).toEqual(before);
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(listener).not.toHaveBeenCalled();
    await store.mutateRuntime(tasks => { tasks[0]!.cursor = 7; }); // the chain recovers
    expect(store.get('a')!.cursor).toBe(7);
  });
  it('[16][2][17] refuses a draft with an unknown key or a non-integer runtime field', async () => {
    const { store, file } = await setup(); await store.mutateConfig(tasks => { tasks.push(task('a')); });
    const text = await readFile(file, 'utf8');
    await expect(store.mutateRuntime(tasks => { Object.assign(tasks[0]!, { extra: 1 }); })).rejects.toThrow(/invalid write/);
    await expect(store.mutateRuntime(tasks => { tasks[0]!.cursor = 1.5; })).rejects.toThrow(/invalid write/);
    expect(await readFile(file, 'utf8')).toBe(text);
  });
  it('[16][2][17] refuses more than 200 tasks for one bot', async () => {
    const { store, file } = await setup();
    await store.mutateConfig(tasks => { for (let i = 0; i < 200; i += 1) tasks.push(task(`t${i}`)); });
    const text = await readFile(file, 'utf8');
    await expect(store.mutateConfig(tasks => { tasks.push(task('one-too-many')); })).rejects.toThrow(/invalid write/);
    expect(store.all()).toHaveLength(200);
    expect(await readFile(file, 'utf8')).toBe(text);
  });
  it('loads and keeps the optional noticeSince runtime field', async () => {
    const { store, file } = await setup();
    await writeFile(file, JSON.stringify({ version: 1, tasks: [{ ...task('a'), noticePending: true, noticeSince: 1_000 }] }));
    await store.load();
    expect(store.get('a')).toMatchObject({ noticePending: true, noticeSince: 1_000 });
    await store.mutateRuntime(tasks => { tasks[0]!.cursor = 1; });
    expect(JSON.parse(await readFile(file, 'utf8')).tasks[0]).toMatchObject({ noticeSince: 1_000, cursor: 1 });
  });

});
