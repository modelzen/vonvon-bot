import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobIdSchema, type Event } from '@vonvon/protocol';
import type { AdminService } from '../src/admin/service';
import { Jobs, type JobPeer } from '../src/server/jobs';
import { fakeService, socketClient, startFixture } from './server-fixture';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function peer(id: string) { const events: Event[] = []; const value: JobPeer = { id, open: true, event: event => events.push(event) }; return { value, events }; }
const managers: Jobs[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(jobs => jobs.close())); });
function manager(service: AdminService) { const jobs = new Jobs({ service, changed: () => {}, toolsSettled: () => {} }); managers.push(jobs); return jobs; }

describe('job lifetimes', () => {
  it('cancels QR on preemption and owner detach while ignoring a late committed success', async () => {
    const work: ReturnType<typeof deferred<Awaited<ReturnType<AdminService['registerBotByQr']>> >>[] = [];
    const service = fakeService({ registerBotByQr: () => { const operation = deferred<Awaited<ReturnType<AdminService['registerBotByQr']>>>(); work.push(operation); return operation.promise; } });
    const jobs = manager(service);
    const first = peer('first');
    const second = peer('second');
    jobs.startRegistration(first.value);
    await vi.waitFor(() => expect(work).toHaveLength(1));
    jobs.startRegistration(second.value);
    await vi.waitFor(() => expect(work).toHaveLength(2));
    expect(jobs.snapshot()[0]?.phase).toBe('cancelled');
    jobs.detach(second.value);
    const saved = { ok: true as const, appId: 'cli_saved', name: 'saved', tenant: 'feishu' as const, adminOpenId: 'ou_owner' };
    work.forEach(operation => operation.resolve(saved));
    await Promise.resolve();
    await Promise.resolve();
    expect(jobs.snapshot().map(job => job.phase)).toEqual(['cancelled', 'cancelled']);
  });

  it('counts all unsettled registration services after cancellation for the 32 admission limit', async () => {
    const work: ReturnType<typeof deferred<Awaited<ReturnType<AdminService['registerBotByQr']>> >>[] = [];
    const jobs = manager(fakeService({ registerBotByQr: () => { const operation = deferred<Awaited<ReturnType<AdminService['registerBotByQr']>>>(); work.push(operation); return operation.promise; } }));
    for (let i = 0; i < 32; i++) { jobs.startRegistration(peer(String(i)).value); await Promise.resolve(); }
    expect(work).toHaveLength(32);
    expect(jobs.startRegistration(peer('overflow').value)).toMatchObject({ kind: 'refused', code: 'registration_busy' });
    work.forEach(operation => operation.resolve({ ok: false, code: 'abort', reason: '' }));
    await jobs.close();
  });

  it('keeps Codex jobs after disconnect and supports cancellation', async () => {
    let state: 'running' | 'cancelled' = 'running';
    const jobs = manager(fakeService({ startCodexJob: () => ({ id: 'codex-job' }), codexJob: () => ({ id: 'codex-job', type: 'login', state }), cancelCodexJob: async () => { state = 'cancelled'; return { id: 'codex-job', type: 'login', state }; } }));
    expect(jobs.startCodex('login')).toMatchObject({ kind: 'started' });
    jobs.detach(peer('gone').value);
    expect(jobs.snapshot()[0]?.phase).toBe('running');
    await jobs.cancel(jobIdSchema.parse('codex-job'));
    expect(jobs.snapshot()[0]?.phase).toBe('cancelled');
  });
});

describe('backend admission commit boundary', () => {
  it('replays synchronous output and a terminal result settled while rebuild waits, then starts fresh work', async () => {
    const gate = deferred<void>();
    let rebuilding = false;
    let hold = false;
    let installs = 0;
    const fixture = await startFixture(fakeService({
      listBots: async () => { if (hold) { rebuilding = true; await gate.promise; } return []; },
      installBackend: async (_id, progress) => { installs++; progress?.('sync'); return { ok: true, code: 0, aborted: false, tail: '' }; },
    }));
    try {
      const client = await socketClient(fixture.api.port, fixture.credential);
      await client.ready();
      hold = true;
      const reply = client.call({ type: 'request', id: 'install', method: 'environment', payload: { type: 'backendInstall', id: 'claude', update: false } });
      await vi.waitFor(() => expect(rebuilding).toBe(true));
      gate.resolve();
      expect(await reply).toMatchObject({ type: 'response', payload: { attached: false, replay: [{ type: 'log', chunk: 'sync' }, { type: 'done' }] } });
      expect(client.frames.filter(frame => frame.type === 'event' && frame.event === 'backendInstall')).toEqual([]);
      hold = false;
      await client.call({ type: 'request', id: 'again', method: 'environment', payload: { type: 'backendInstall', id: 'claude', update: false } });
      expect(installs).toBe(2);
      await client.close();
    } finally { await fixture.close(); }
  });

  it('attaches concurrent clients with complete replay and continues after detach without cancelling npm', async () => {
    const complete = deferred<Awaited<ReturnType<AdminService['installBackend']>>>();
    let progress: (chunk: string) => void = () => {};
    let installs = 0;
    const jobs = manager(fakeService({ installBackend: (_id, callback) => { installs++; progress = callback ?? (() => {}); progress('first'); return complete.promise; } }));
    const first = jobs.selectBackend('claude', false);
    await Promise.resolve();
    const second = jobs.selectBackend('claude', false);
    const a = peer('a'); const b = peer('b');
    expect(jobs.attachBackend(first, a.value)).toMatchObject({ attached: false, replay: [{ type: 'log', chunk: 'first' }] });
    expect(jobs.attachBackend(second, b.value)).toMatchObject({ attached: true, replay: [{ type: 'log', chunk: 'first' }] });
    progress('second');
    jobs.detach(a.value);
    progress('third');
    complete.resolve({ ok: true, code: 0, aborted: false, tail: '' });
    await vi.waitFor(() => expect(b.events).toHaveLength(3));
    expect(a.events).toHaveLength(1);
    expect(installs).toBe(1);
  });

  it('does not attach a peer that disconnects during the rebuild await', async () => {
    const complete = deferred<Awaited<ReturnType<AdminService['installBackend']>>>();
    const jobs = manager(fakeService({ installBackend: () => complete.promise }));
    const admission = jobs.selectBackend('claude', false);
    const events: Event[] = [];
    const disconnected: JobPeer = { id: 'gone', open: false, event: event => events.push(event) };
    jobs.attachBackend(admission, disconnected);
    complete.resolve({ ok: true, code: 0, aborted: false, tail: '' });
    await Promise.resolve(); await Promise.resolve();
    expect(events).toEqual([]);
  });
});
