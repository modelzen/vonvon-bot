import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config/paths', () => ({
  botPaths: (id: string) => ({ dir: join(fixture.root, id), setupFile: join(fixture.root, id, 'setup.json') }),
}));
import { cardCallbackFile, createCardCallbackRecorder, readCardCallbackVerifiedAt, recordCardCallback } from '../src/config/card-callback';
import { readCardCallbackStatus, readSetupProgress, writeSetupProgress } from '../src/config/setup-progress';

const firstAt = 1_790_000_000_000;
beforeEach(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'vonvon-card-callback-'));
  await Promise.all(['cli_a', 'cli_b'].map(id => mkdir(join(fixture.root, id))));
});
afterEach(async () => { await rm(fixture.root, { recursive: true, force: true }); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('persists the first received time per Bot and keeps it after restarting the receiver', async () => {
  expect(await readCardCallbackStatus('cli_a')).toEqual({ confirmed: false });
  const first = createCardCallbackRecorder('cli_a', { now: () => firstAt });
  first.received(); first.received(); await first.close();
  expect(await readCardCallbackStatus('cli_a')).toEqual({ confirmed: true, verifiedAt: firstAt });
  expect(await readCardCallbackStatus('cli_b')).toEqual({ confirmed: false });
  const restarted = createCardCallbackRecorder('cli_a', { now: () => firstAt + 1000 });
  restarted.received(); await restarted.close();
  expect(await readCardCallbackVerifiedAt('cli_a')).toBe(firstAt);
  expect((await stat(cardCallbackFile('cli_a'))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(cardCallbackFile('cli_a'), 'utf8'))).toEqual({ verifiedAt: firstAt });
  expect(await readdir(join(fixture.root, 'cli_a'))).toEqual(['card-callback.json']);
});

it('keeps manual confirmation separate from real evidence, including concurrent writes and cancellation', async () => {
  await writeSetupProgress('cli_a', { cardCallbackConfirmed: true });
  expect(await readCardCallbackStatus('cli_a')).toEqual({ confirmed: true });
  expect(await readCardCallbackVerifiedAt('cli_a')).toBeUndefined();
  await Promise.all([recordCardCallback('cli_a', firstAt), writeSetupProgress('cli_a', { cardCallbackConfirmed: false })]);
  expect(await readSetupProgress('cli_a')).toEqual({ cardCallbackConfirmed: false });
  expect(await readCardCallbackStatus('cli_a')).toEqual({ confirmed: true, verifiedAt: firstAt });
  await writeSetupProgress('cli_a', { cardCallbackConfirmed: true });
  await writeSetupProgress('cli_a', { cardCallbackConfirmed: false });
  expect(await readCardCallbackStatus('cli_a')).toEqual({ confirmed: true, verifiedAt: firstAt });
});

it('never replaces the evidence if receivers publish concurrently', async () => {
  await Promise.all([recordCardCallback('cli_a', firstAt), recordCardCallback('cli_a', firstAt)]);
  await recordCardCallback('cli_a', firstAt + 1000);
  expect(await readCardCallbackVerifiedAt('cli_a')).toBe(firstAt);
  expect(await readdir(join(fixture.root, 'cli_a'))).toEqual(['card-callback.json']);
});

it('deduplicates in-flight and successful writes, drains on close, then ignores later receives', async () => {
  const writing = deferred();
  const write = vi.fn(() => writing.promise);
  const recorder = createCardCallbackRecorder('cli_a', { now: () => firstAt, write });
  recorder.received(); recorder.received();
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  let closed = false;
  const closing = recorder.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  writing.resolve(); await closing;
  recorder.received();
  expect(write).toHaveBeenCalledExactlyOnceWith('cli_a', firstAt);
});

it('does not throw write failures into the receive path and retries with the first receipt time', async () => {
  const error = Object.assign(new Error('disk unavailable'), { code: 'EIO' });
  const write = vi.fn(recordCardCallback).mockRejectedValueOnce(error);
  const onError = vi.fn(() => { throw new Error('logger unavailable'); });
  const now = vi.fn().mockReturnValueOnce(firstAt).mockReturnValue(firstAt + 1000);
  const recorder = createCardCallbackRecorder('cli_a', { write, now, onError });
  expect(() => recorder.received()).not.toThrow();
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
  expect(await readCardCallbackVerifiedAt('cli_a')).toBeUndefined();
  recorder.received(); await recorder.close();
  expect(write).toHaveBeenCalledTimes(2);
  expect(await readCardCallbackVerifiedAt('cli_a')).toBe(firstAt);
});

it('does not create a missing or deleted Bot directory', async () => {
  await expect(recordCardCallback('cli_missing', firstAt)).rejects.toMatchObject({ code: 'ENOENT' });
  const writeGate = deferred();
  const onError = vi.fn();
  const recorder = createCardCallbackRecorder('cli_a', {
    now: () => firstAt, onError, write: async (id, at) => { await writeGate.promise; await recordCardCallback(id, at); },
  });
  recorder.received();
  await rm(join(fixture.root, 'cli_a'), { recursive: true });
  writeGate.resolve(); await recorder.close();
  expect(onError).toHaveBeenCalledOnce();
  expect(await readdir(fixture.root)).toEqual(['cli_b']);
});

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001])('never treats invalid time %s as proof', async at => {
  await writeFile(cardCallbackFile('cli_a'), JSON.stringify({ verifiedAt: at }));
  expect(await readCardCallbackStatus('cli_a')).toEqual({ confirmed: false });
  await expect(recordCardCallback('cli_b', at)).rejects.toThrow('时间无效');
  const write = vi.fn();
  const recorder = createCardCallbackRecorder('cli_b', { now: () => at, write });
  recorder.received(); await recorder.close();
  expect(write).not.toHaveBeenCalled();
});

it('does not silently overwrite unreadable evidence with a newer receipt time', async () => {
  await writeFile(cardCallbackFile('cli_a'), '{broken');
  expect(await readCardCallbackVerifiedAt('cli_a')).toBeUndefined();
  await expect(recordCardCallback('cli_a', firstAt)).rejects.toThrow();
  expect(await readFile(cardCallbackFile('cli_a'), 'utf8')).toBe('{broken');
});
