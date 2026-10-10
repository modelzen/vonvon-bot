import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentReply, Event } from '@vonvon/protocol';
import { Jobs, type BackendAdmission, type JobPeer } from '../src/server/jobs';
import { backendErrorSuffix } from '../src/server/backend-output';
import { fakeService, socketClient, startFixture } from './server-fixture';
import { installBackendDep, type InstallResult } from '../src/agent/installer';
import { paths } from '../src/config/paths';

const spawned = vi.hoisted((): { child?: EventEmitter } => ({}));
vi.mock('../src/platform/spawn', () => ({ spawnProcess: () => spawned.child }));
vi.mock('../src/agent/backend-loader', () => ({ isBackendDepInstalled: () => true, isBackendBinInstalled: () => true }));
vi.mock('../src/agent/native-helpers', () => ({ fixNativeHelperPerms: async () => {} }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {}, debug() {} } }));

const TAIL = 262_144;
const MIB = 1_048_576;
const TOTAL = 64 * MIB;
const success: InstallResult = { ok: true, code: 0, aborted: false, tail: '' };
const managers: Jobs[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(jobs => jobs.close())); });
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('uninitialized'); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function producer() {
  let progress: (text: string) => void = () => { throw new Error('not started'); };
  const gate = deferred<InstallResult>();
  const service = fakeService({ installBackend: (_id, callback) => { progress = callback ?? progress; return gate.promise; } });
  const jobs = new Jobs({ service, changed() {}, toolsSettled() {} });
  managers.push(jobs);
  return { jobs, service, emit: (text: string) => progress(text), finish: (result = success) => gate.resolve(result) };
}
function observer(id: string, consume: (event: Event) => void = () => {}): JobPeer {
  return { id, open: true, event: consume };
}
type Reply = Extract<EnvironmentReply, { kind: 'backendInstall' }>;
function checkReplay(reply: Reply, source: string, bytes = Buffer.byteLength(source)): void {
  const logs = reply.replay.filter(item => item.type === 'log');
  expect(logs.length).toBeLessThanOrEqual(1);
  const text = logs[0]?.chunk ?? '';
  const retained = Buffer.byteLength(text);
  expect(retained).toBeLessThanOrEqual(TAIL);
  if (bytes > TAIL) expect(retained).toBeGreaterThanOrEqual(TAIL - 3);
  expect(reply.omittedBytes! + retained).toBe(bytes);
  expect(Buffer.from(source).subarray(reply.omittedBytes).toString()).toBe(text);
  expect(text).not.toContain('\ufffd');
  expect(Buffer.from(text).toString()).toBe(text);
}
function checkStorage(admission: BackendAdmission, emitted: number): void {
  const output = admission.operation.output;
  expect(output.retainedEntryCount).toBeLessThanOrEqual(1);
  const fields = Object.entries(output);
  expect(fields.map(([key]) => key).sort()).toEqual(['head', 'ring', 'scratch', 'size', 'totalBytes']);
  const buffers = fields.flatMap(([, value]) => Buffer.isBuffer(value) ? [value] : []);
  expect(buffers.map(value => value.byteLength)).toEqual([TAIL, 65_536]);
  expect(buffers.map(value => value.buffer.byteLength)).toEqual([TAIL, 65_536]);
  expect(fields.find(([key]) => key === 'totalBytes')?.[1]).toBe(emitted);
  expect(fields.find(([key]) => key === 'size')?.[1]).toBeLessThanOrEqual(TAIL);
  expect(fields.find(([key]) => key === 'head')?.[1]).toBeLessThan(TAIL);
}

// A fixed period records S without retaining emitted event objects.
const pattern = Array.from({ length: 251 }, (_, index) => String.fromCharCode(33 + (index * 47 + Math.floor(index / 7)) % 90)).join('');
const sourceBlock = pattern.repeat(Math.ceil(MIB / pattern.length)).slice(0, MIB);
function sourceRange(start: number, length: number): string {
  const offset = start % MIB;
  return sourceBlock.repeat(Math.ceil((offset + length) / MIB)).slice(offset, offset + length);
}
function cursorPeer(id: string, start = 0) {
  let cursor = start;
  let done = false;
  const peer = observer(id, event => {
    if (event.event !== 'backendInstall') throw new Error('unexpected event');
    const item = event.payload.item;
    if (item.type === 'done') { done = true; return; }
    if (item.type !== 'log') throw new Error('unexpected error');
    const chunk = item.chunk;
    if (chunk.length > 65_536) throw new Error('oversized live chunk');
    if (chunk.length === 1) {
      if (chunk.charCodeAt(0) !== sourceBlock.charCodeAt(cursor % MIB)) throw new Error(`incorrect byte at ${cursor}`);
    } else if (chunk !== sourceRange(cursor, chunk.length)) throw new Error(`incorrect chunk at ${cursor}`);
    cursor += chunk.length;
  });
  return { peer, get cursor() { return cursor; }, get done() { return done; } };
}

describe('bounded backend output', () => {
  it.each([1, 65_536, MIB])('streams 64 MiB in %i-byte callbacks with bounded retained storage', async width => {
    const run = producer();
    const admission = run.jobs.selectBackend('claude-agent', false);
    const first = cursorPeer('initial');
    expect(run.jobs.attachBackend(admission, first.peer)).toMatchObject({ attached: false, replay: [], omittedBytes: 0 });
    await Promise.resolve();
    const late: ReturnType<typeof cursorPeer>[] = [];
    const chunks = width === 1 ? Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)) : Array.from({ length: MIB / width }, (_, index) => sourceRange(index * width, width));
    let emitted = 0;
    for (let index = 0; index < TOTAL / width; index++) {
      run.emit(chunks[width === 1 ? sourceBlock.charCodeAt(emitted % MIB) : (emitted % MIB) / width]!);
      emitted += width;
      if (emitted === MIB || emitted === MIB + width || emitted === 32 * MIB || emitted === TOTAL) {
        const next = cursorPeer(`at-${emitted}`, emitted);
        const reply = run.jobs.attachBackend(run.jobs.selectBackend('claude-agent', false), next.peer);
        expect(reply.attached).toBe(true);
        expect(reply.omittedBytes).toBe(emitted - TAIL);
        expect(reply.replay).toEqual([{ type: 'log', chunk: sourceRange(emitted - TAIL, TAIL) }]);
        checkStorage(admission, emitted);
        late.push(next);
      }
    }
    expect(first.cursor).toBe(TOTAL);
    for (const next of late) expect(next.cursor).toBe(TOTAL);
    run.finish();
    await admission.operation.done;
    expect(first.done).toBe(true);
    for (const next of late) expect(next.done).toBe(true);
    expect(admission.operation.peers.size).toBe(0);
  }, 120_000);

  it.each([10_240, MIB])('replays %i pre-attach bytes and continues once', async bytes => {
    const run = producer();
    const admission = run.jobs.selectBackend('claude-agent', false);
    await Promise.resolve();
    const live = cursorPeer('creator', bytes);
    run.emit(sourceRange(0, bytes));
    expect(live.cursor).toBe(bytes);
    const reply = run.jobs.attachBackend(admission, live.peer);
    expect(reply.attached).toBe(false);
    checkReplay(reply, sourceRange(0, bytes));
    run.emit(sourceRange(bytes, 100_000));
    expect(live.cursor).toBe(bytes + 100_000);
    run.finish();
    await admission.operation.done;
  });

  it('keeps two selected admissions through settlement and frees the slot for held fresh work', async () => {
    const run = producer();
    const first = run.jobs.selectBackend('claude-agent', false);
    const second = run.jobs.selectBackend('claude-agent', false);
    await Promise.resolve();
    run.emit(sourceRange(0, 10_240));
    run.finish();
    await first.operation.done;
    for (const [admission, attached] of [[first, false], [second, true]] as const) {
      const reply = run.jobs.attachBackend(admission, observer('late', () => { throw new Error('settled peer received event'); }));
      expect(reply.attached).toBe(attached);
      checkReplay(reply, sourceRange(0, 10_240));
      expect(reply.replay.at(-1)).toEqual({ type: 'done' });
      expect(admission.operation.peers.size).toBe(0);
    }
    const held = deferred<InstallResult>();
    let releaseOutput: (text: string) => void = () => {};
    run.service.installBackend = (_id, callback) => { releaseOutput = callback ?? releaseOutput; return held.promise; };
    const fresh = run.jobs.selectBackend('claude-agent', false);
    expect(fresh.operation.operationId).not.toBe(first.operation.operationId);
    const live = cursorPeer('fresh');
    expect(run.jobs.attachBackend(fresh, live.peer)).toMatchObject({ attached: false, replay: [], omittedBytes: 0 });
    await Promise.resolve();
    releaseOutput(sourceRange(0, MIB));
    held.resolve(success);
    await fresh.operation.done;
    expect(live.cursor).toBe(MIB);
    expect(live.done).toBe(true);
  });

  it.each(['中', '😀'])('aligns every cut offset for %s and preserves large live pieces', async character => {
    for (let offset = 0; offset < Buffer.byteLength(character); offset++) {
      const run = producer();
      const admission = run.jobs.selectBackend('claude-agent', false);
      await Promise.resolve();
      const source = character.repeat(TAIL) + 'x'.repeat(offset);
      let live = '';
      const peer = observer('unicode', event => {
        if (event.event !== 'backendInstall' || event.payload.item.type !== 'log') return;
        const piece = event.payload.item.chunk;
        expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(65_536);
        expect(Buffer.from(piece).toString()).toBe(piece);
        live += piece;
      });
      run.jobs.attachBackend(admission, peer);
      run.emit(source);
      expect(live).toBe(source);
      checkReplay(run.jobs.attachBackend(run.jobs.selectBackend('claude-agent', false), observer('replay')), source);
      run.finish();
      await admission.operation.done;
    }
  });

  it('keeps mixed multibyte output through wrapped writes and single-byte evictions', async () => {
    const run = producer();
    const admission = run.jobs.selectBackend('claude-agent', false);
    await Promise.resolve();
    const mixed = 'ab中😀文🚀'.repeat(20_000);
    let source = '';
    for (const chunk of [mixed, 'x', 'y', 'z', mixed.slice(3), 'q']) {
      source += chunk;
      run.emit(chunk);
      checkReplay(run.jobs.attachBackend(admission, observer('mixed')), source);
      checkStorage(admission, Buffer.byteLength(source));
    }
    run.finish({ ok: false, code: null, aborted: true, tail: '取消😀' });
    await admission.operation.done;
    expect(run.jobs.attachBackend(admission, observer('aborted')).replay.at(-1)).toEqual({ type: 'error', code: 'aborted', message: '取消😀' });
  });

  it('continues 64 MiB after the only peer detaches and replays to a later peer', async () => {
    const run = producer();
    const admission = run.jobs.selectBackend('claude-agent', false);
    const first = cursorPeer('gone');
    run.jobs.attachBackend(admission, first.peer);
    await Promise.resolve();
    run.emit(sourceRange(0, MIB));
    run.jobs.detach(first.peer);
    for (let offset = MIB; offset < TOTAL; offset += MIB) run.emit(sourceRange(offset, MIB));
    expect(first.cursor).toBe(MIB);
    expect(admission.operation.terminal).toBeUndefined();
    const later = cursorPeer('later', TOTAL);
    const reply = run.jobs.attachBackend(run.jobs.selectBackend('claude-agent', false), later.peer);
    expect(reply.omittedBytes).toBe(TOTAL - TAIL);
    expect(reply.replay).toEqual([{ type: 'log', chunk: sourceRange(TOTAL - TAIL, TAIL) }]);
    checkStorage(admission, TOTAL);
    run.finish();
    await admission.operation.done;
    expect(later.done).toBe(true);
  });

  it('keeps a real control-character replay frame below 2 MiB and continues live', async () => {
    const run = producer();
    const gate = deferred<void>();
    let rebuilding = false;
    let hold = false;
    run.service.listBots = async () => { if (hold) { rebuilding = true; await gate.promise; } return []; };
    const fixture = await startFixture(run.service);
    const client = await socketClient(fixture.api.port, fixture.credential);
    try {
      await client.ready();
      let maxFrameBytes = 0;
      client.socket.on('message', bytes => { maxFrameBytes = Math.max(maxFrameBytes, Buffer.byteLength(bytes.toString())); });
      hold = true;
      const response = client.call({ type: 'request', id: 'install', method: 'environment', payload: { type: 'backendInstall', id: 'claude-agent', update: false } });
      await vi.waitFor(() => expect(rebuilding).toBe(true));
      run.emit('\x01'.repeat(MIB));
      hold = false;
      gate.resolve();
      expect(await response).toMatchObject({ type: 'response', payload: { omittedBytes: MIB - TAIL, replay: [{ type: 'log', chunk: '\x01'.repeat(TAIL) }] } });
      expect(maxFrameBytes).toBeLessThan(2 * MIB);
      expect(maxFrameBytes).toBeGreaterThan(6 * TAIL);
      run.emit('later-1');
      run.emit('later-2');
      run.finish();
      await client.wait(frame => frame.type === 'event' && frame.event === 'backendInstall' && frame.payload.item.type === 'done');
      expect(client.frames.flatMap(frame => frame.type === 'event' && frame.event === 'backendInstall' ? [frame.payload.item] : [])).toEqual([{ type: 'log', chunk: 'later-1' }, { type: 'log', chunk: 'later-2' }, { type: 'done' }]);
      expect(client.socket.readyState).toBe(1);
    } finally { gate.resolve(); run.finish(); await client.close(); await fixture.close(); }
  });
});

const errors = [
  { name: 'thrown 1 MiB error', source: 'e'.repeat(MIB), thrown: true, expected: 'e'.repeat(8192) },
  { name: 'low surrogate at sliced tail start', source: '\ude00' + 'a'.repeat(1999), expected: 'a'.repeat(1999) },
  { name: 'verification failure with long package', source: `tail\n安装后校验失败：「${'包'.repeat(10_000)}」解析不到，已回滚。` },
  { name: '2000-unit emoji tail', source: '😀'.repeat(1000), expected: '😀'.repeat(1000) },
  { name: 'interior low surrogate', source: 'prefix\ude00后😀', expected: '后😀' },
  { name: 'interior high surrogate', source: 'prefix\ud800后😀', expected: '后😀' },
  { name: 'final low surrogate', source: 'prefix\ude00', expected: '' },
  { name: 'final high surrogate', source: 'prefix\ud800', expected: '' },
];
it.each(errors)('bounds $name to an unchanged well-formed suffix', async ({ source, thrown, expected }) => {
  const run = producer();
  if (thrown) run.service.installBackend = async () => { throw new Error(source); };
  const admission = run.jobs.selectBackend('claude-agent', false);
  run.finish({ ok: false, code: 1, aborted: false, tail: source });
  await admission.operation.done;
  const item = run.jobs.attachBackend(admission, observer('error')).replay.at(-1);
  expect(item?.type).toBe('error');
  if (item?.type !== 'error') throw new Error('missing error');
  expect(item.code).toBe(thrown ? 'unknown' : 'install_failed');
  expect(Buffer.byteLength(item.message)).toBeLessThanOrEqual(8192);
  expect(Buffer.from(item.message).toString()).toBe(item.message);
  expect(source.endsWith(item.message)).toBe(true);
  if (expected !== undefined) expect(item.message).toBe(expected);
  else expect(Buffer.byteLength(item.message)).toBeGreaterThanOrEqual(8189);
  expect(backendErrorSuffix(source)).toBe(item.message);
});

it.each(['end', 'close', 'error'] as const)('decodes interleaved split reads and flushes once at %s', async finish => {
  const home = await mkdtemp(join(tmpdir(), 'vonvon-backend-decode-'));
  Object.assign(paths, { backendsDir: home, npmCacheDir: join(home, 'cache') });
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn() });
  spawned.child = child;
  const progress: string[] = [];
  try {
    const result = installBackendDep('fake-package', chunk => progress.push(chunk));
    await vi.waitFor(() => expect(stdout.listenerCount('data')).toBe(1));
    const emoji = Buffer.from('😀');
    const cjk = Buffer.from('中');
    stdout.emit('data', emoji.subarray(0, 2));
    stderr.emit('data', cjk.subarray(0, 1));
    if (finish === 'error') child.emit('error', new Error('fake spawn error'));
    stderr.emit('data', cjk.subarray(1));
    stdout.emit('data', emoji.subarray(2));
    expect(progress.join('')).toBe('中😀');
    stdout.emit('data', Buffer.from([0xf0]));
    stderr.emit('data', Buffer.from([0xe4]));
    if (finish === 'end') { stdout.emit('end'); stderr.emit('end'); }
    child.emit('close', 0);
    child.emit('close', 0);
    expect(progress.join('')).toBe('中😀\ufffd\ufffd');
    await result;
    expect(child.kill).not.toHaveBeenCalled();
  } finally { await rm(home, { recursive: true, force: true }); }
});
