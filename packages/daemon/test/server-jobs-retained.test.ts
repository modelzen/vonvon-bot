import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { agentIdSchema, jobIdSchema, type DesktopSnapshot, type JobId } from '@vonvon/protocol';
import type { AdminService } from '../src/admin/service';
import { Jobs } from '../src/server/jobs';
import { createSnapshotStore } from '../src/server/snapshot';
import { fakeService, socketClient, startFixture } from './server-fixture';

function gate() {
  let release = (): void => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
type Client = Awaited<ReturnType<typeof socketClient>>;
async function start(client: Client, id: string) {
  const reply = await client.call({ type: 'request', id, method: 'command', payload: { type: 'registerAgent' } });
  if (reply.type !== 'response' || reply.method !== 'command' || reply.payload.kind !== 'started') throw new Error('Registration did not start');
  return reply.payload.jobId;
}
function cancel(client: Client, id: string, jobId: JobId) {
  return client.call({ type: 'request', id, method: 'command', payload: { type: 'cancelJob', jobId } });
}
async function snapshot(client: Client, id: string) {
  const reply = await client.call({ type: 'request', id, method: 'snapshot', payload: { type: 'get' } });
  if (reply.type !== 'response' || reply.method !== 'snapshot') throw new Error('Snapshot missing');
  return reply.payload;
}

describe('retained QR behavior over WebSocket', () => {
  it('publishes cancellation before QR but acknowledges only after persistence and never cancels a successor', async () => {
    const persist = gate();
    const signals: AbortSignal[] = [];
    let saved = false;
    const fixture = await startFixture(fakeService({ registerBotByQr: async options => {
      signals.push(options.signal);
      await persist.promise;
      saved = true;
      return { ok: true, appId: 'cli_saved', name: 'saved', tenant: 'feishu', adminOpenId: 'ou_owner' };
    } }));
    try {
      const client = await socketClient(fixture.api.port, fixture.credential);
      await client.ready();
      const first = await start(client, 'first');
      expect((await snapshot(client, 'running')).jobs).toContainEqual(expect.objectContaining({ id: first, phase: 'running' }));
      let acknowledged = false;
      const cancellation = cancel(client, 'cancel-first', first).then(reply => { acknowledged = true; return reply; });
      await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
      await client.wait(frame => frame.type === 'event' && frame.event === 'snapshot' && frame.payload.jobs.some(job => job.id === first && job.phase === 'cancelled'));
      await delay(30);
      expect(acknowledged).toBe(false);
      expect(saved).toBe(false);
      const second = await start(client, 'second');
      expect(signals[1]?.aborted).toBe(false);
      persist.release();
      expect(await cancellation).toMatchObject({ type: 'response', payload: { kind: 'cancelled' } });
      expect(saved).toBe(true);
      expect(await cancel(client, 'repeat', first)).toMatchObject({ type: 'response', payload: { kind: 'cancelled' } });
      expect(signals[1]?.aborted).toBe(false);
      const state = await snapshot(client, 'settled');
      expect(state.jobs).toContainEqual(expect.objectContaining({ id: first, phase: 'cancelled' }));
      expect(state.jobs).toContainEqual(expect.objectContaining({ id: second, phase: 'succeeded', agentId: 'cli_saved' }));
      expect(await cancel(client, 'unknown', jobIdSchema.parse('unknown-job'))).toMatchObject({ type: 'response', payload: { kind: 'refused', code: 'unknown_job' } });
      await client.close();
    } finally { persist.release(); await fixture.close(); }
  });

  it('keeps the owner socket\'s scan through its disconnect (60-second grace), and API close cancels it and stays pending until persistence settles', async () => {
    const persist = gate();
    const aborted = gate();
    let saved = false;
    let abortedNow = false;
    const fixture = await startFixture(fakeService({ registerBotByQr: async options => {
      options.signal.addEventListener('abort', () => { abortedNow = true; aborted.release(); }, { once: true });
      await persist.promise;
      saved = true;
      return { ok: true, appId: 'cli_saved', name: 'saved', tenant: 'feishu', adminOpenId: 'ou_owner' };
    } }));
    try {
      const owner = await socketClient(fixture.api.port, fixture.credential);
      const observer = await socketClient(fixture.api.port, fixture.credential);
      await owner.ready(); await observer.ready();
      const id = await start(owner, 'start');
      await owner.close();
      // devices-ui-3 6.3: the owner's disconnect leaves the scan for 60 seconds; the grace itself is tested with a fake clock in server-jobs.test.ts
      await delay(200);
      expect(abortedNow).toBe(false);
      const kept = (await snapshot(observer, 'after-owner')).jobs.find(job => job.id === id);
      expect(kept).toBeDefined();
      expect(kept?.phase).not.toBe('cancelled');
      let closed = false;
      const closing = fixture.api.close().then(() => { closed = true; });
      await aborted.promise;
      await delay(30);
      expect(closed).toBe(false);
      expect(saved).toBe(false);
      persist.release();
      await closing;
      expect(saved).toBe(true);
      await observer.close();
    } finally { persist.release(); await fixture.close(); }
  });

  it('projects refresh QR PNG, URL, expiry, status and successful agent identity without credentials', async () => {
    const persist = gate();
    let callbacks: Parameters<AdminService['registerBotByQr']>[0] | undefined;
    const targets: string[] = [];
    const fixture = await startFixture(fakeService({ refreshBotByQr: async (agentId, options) => {
      targets.push(agentId); callbacks = options;
      await persist.promise;
      return { ok: true, appId: agentId, name: 'saved', tenant: 'feishu', adminOpenId: 'ou_owner', client_secret: 'fixture-secret' };
    } }));
    try {
      const client = await socketClient(fixture.api.port, fixture.credential); await client.ready();
      const reply = await client.call({ type: 'request', id: 'refresh', method: 'command', payload: { type: 'refreshAgentCredentials', agentId: agentIdSchema.parse('cli_original') } });
      expect(reply).toMatchObject({ type: 'response', payload: { kind: 'started' } });
      expect(targets).toEqual(['cli_original']);
      if (!callbacks?.onStatus) throw new Error('Missing registration callbacks');
      const before = Date.now();
      callbacks.onQr({ url: 'https://example.test/scan', expireIn: 600 });
      callbacks.onStatus({ status: 'polling' });
      const frame = await client.wait(frame => frame.type === 'event' && frame.event === 'snapshot' && frame.payload.jobs.some(job => job.phase === 'qr'));
      if (frame.type !== 'event' || frame.event !== 'snapshot') throw new Error('Missing QR snapshot');
      const qr = frame.payload.jobs.find(job => job.phase === 'qr');
      if (!qr || qr.phase !== 'qr') throw new Error('Missing QR job');
      expect(qr.url).toBe('https://example.test/scan');
      expect(qr.status).toBe('polling');
      expect(qr.expiresAt).toBeGreaterThanOrEqual(before + 600_000);
      expect(qr.expiresAt).toBeLessThanOrEqual(Date.now() + 600_000);
      expect(qr.image).toMatch(/^data:image\/png;base64,/);
      expect(Buffer.from(qr.image.split(',')[1] ?? '', 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      callbacks.onStatus({ status: 'slow_down' });
      await client.wait(frame => frame.type === 'event' && frame.event === 'snapshot' && frame.payload.jobs.some(job => job.phase === 'qr' && job.status === 'slow_down'));
      persist.release();
      const done = await client.wait(frame => frame.type === 'event' && frame.event === 'snapshot' && frame.payload.jobs.some(job => job.phase === 'succeeded'));
      expect(done).toMatchObject({ payload: { jobs: [expect.objectContaining({ phase: 'succeeded', agentId: 'cli_original' })] } });
      expect(JSON.stringify(client.frames)).not.toContain('fixture-secret');
      expect(JSON.stringify(client.frames)).not.toContain('client_secret');
      await client.close();
      const reconnected = await socketClient(fixture.api.port, fixture.credential); await reconnected.ready();
      expect((await snapshot(reconnected, 'retained')).jobs).toContainEqual(expect.objectContaining({ phase: 'succeeded', agentId: 'cli_original' }));
      await reconnected.close();
    } finally { persist.release(); await fixture.close(); }
  });
});


describe('retained registration terminal snapshots', () => {
  it.each(['expired_token', 'access_denied'] as const)('preserves %s and bounds failure text', async code => {
    const fixture = await startFixture(fakeService({ registerBotByQr: async () => ({ ok: false, code, reason: 'x'.repeat(2000) }) }));
    try {
      const client = await socketClient(fixture.api.port, fixture.credential); await client.ready();
      const id = await start(client, 'start');
      await client.wait(frame => frame.type === 'event' && frame.event === 'snapshot' && frame.payload.jobs.some(job => job.id === id && job.phase === 'failed'));
      expect((await snapshot(client, 'failed')).jobs).toEqual([{ id, type: 'registerAgent', phase: 'failed', code, message: 'x'.repeat(1024) }]);
      await client.close();
    } finally { await fixture.close(); }
  });

  it('retains a terminal job for ten minutes and publishes a higher revision when it expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T00:00:00Z'));
    const service = fakeService({ registerBotByQr: async () => ({ ok: false, code: 'expired_token', reason: 'expired' }) });
    const jobs = new Jobs({ service, changed: () => {}, toolsSettled: () => {} });
    const published: DesktopSnapshot[] = [];
    // No service manager: its first answer lands at a real-time moment and would add a revision of its own.
    const store = await createSnapshotStore({ service, jobs: () => jobs.snapshot(), publish: value => published.push(value), readTools: async () => [], readService: async () => ({ supported: false, installed: false, running: false }) });
    try {
      const started = jobs.startRegistration({ id: 'owner', open: true, event: () => {} });
      if (started.kind !== 'started') throw new Error('Registration did not start');
      await vi.advanceTimersByTimeAsync(0);
      await store.rebuild();
      const terminal = store.current();
      expect(terminal.jobs).toEqual([{ id: started.jobId, type: 'registerAgent', phase: 'failed', code: 'expired_token', message: 'expired' }]);
      await vi.advanceTimersByTimeAsync(599_999);
      await store.rebuild();
      expect(store.current().jobs).toEqual(terminal.jobs);
      expect(store.current().revision).toBe(terminal.revision);
      await vi.advanceTimersByTimeAsync(1);
      await store.rebuild();
      expect(store.current().jobs).toEqual([]);
      expect(store.current().revision).toBe(terminal.revision + 1);
      expect(published.at(-1)).toEqual(store.current());
      expect(await jobs.cancel(started.jobId)).toMatchObject({ kind: 'refused', code: 'unknown_job' });
    } finally { await jobs.close(); await store.close(); vi.useRealTimers(); }
  });
});
