import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Event } from '@vonvon/protocol';
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
});

// main 必败 (devices-ui-2 4.9): the old Codex install and login commands are no longer in the protocol.
it('answers the old Codex install and login commands with invalid_request', async () => {
  const fixture = await startFixture(fakeService({}));
  try {
    const client = await socketClient(fixture.api.port, fixture.credential);
    await client.ready();
    for (const type of ['installCodex', 'startCodexLogin']) {
      // Not in the schema any more, so the request is built as raw JSON.
      expect(await client.call({ type: 'request', id: type, method: 'command', payload: { type } } as never)).toMatchObject({ type: 'error', id: type, code: 'invalid_request' });
    }
    await client.close();
  } finally { await fixture.close(); }
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
      const reply = client.call({ type: 'request', id: 'install', method: 'environment', payload: { type: 'backendInstall', id: 'claude-agent', update: false } });
      await vi.waitFor(() => expect(rebuilding).toBe(true));
      gate.resolve();
      expect(await reply).toMatchObject({ type: 'response', payload: { attached: false, replay: [{ type: 'log', chunk: 'sync' }, { type: 'done' }] } });
      expect(client.frames.filter(frame => frame.type === 'event' && frame.event === 'backendInstall')).toEqual([]);
      hold = false;
      await client.call({ type: 'request', id: 'again', method: 'environment', payload: { type: 'backendInstall', id: 'claude-agent', update: false } });
      expect(installs).toBe(2);
      await client.close();
    } finally { await fixture.close(); }
  });

  it('attaches concurrent clients with complete replay and continues after detach without cancelling npm', async () => {
    const complete = deferred<Awaited<ReturnType<AdminService['installBackend']>>>();
    let progress: (chunk: string) => void = () => {};
    let installs = 0;
    const jobs = manager(fakeService({ installBackend: (_id, callback) => { installs++; progress = callback ?? (() => {}); progress('first'); return complete.promise; } }));
    const first = jobs.selectBackend('claude-agent', false);
    await Promise.resolve();
    const second = jobs.selectBackend('claude-agent', false);
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

  // cli-7-environment 审查 202: the starting request's id is the install's, shown in its state; attaching does not change it
  it('keeps the starting request id on a component install, through an attach and over the socket', async () => {
    const complete = deferred<Awaited<ReturnType<AdminService['installBackend']>>>();
    const jobs = manager(fakeService({ installBackend: () => complete.promise }));
    const mine = '33333333-3333-4333-8333-333333333333';
    try {
      const first = jobs.selectBackend('claude-agent', false, mine);
      const second = jobs.selectBackend('claude-agent', false, '44444444-4444-4444-8444-444444444444');
      expect(second).toMatchObject({ attached: true, operation: { operationId: first.operation.operationId } });
      expect(jobs.backendInstallStatus('claude-agent')).toMatchObject({ operationId: first.operation.operationId, requestId: mine, state: 'running' });
      jobs.selectBackend('codex-appserver', false);
      expect(jobs.backendInstallStatus('codex-appserver')).not.toHaveProperty('requestId');
    } finally { complete.resolve({ ok: true, code: 0, aborted: false, tail: '' }); }
    const gate = deferred<Awaited<ReturnType<AdminService['installBackend']>>>();
    const fixture = await startFixture(fakeService({ installBackend: () => gate.promise }));
    try {
      const client = await socketClient(fixture.api.port, fixture.credential);
      await client.ready();
      await client.call({ type: 'request', id: 'install', method: 'environment', payload: { type: 'backendInstall', id: 'claude-agent', update: false, requestId: mine } });
      expect(await client.call({ type: 'request', id: 'status', method: 'environment', payload: { type: 'backendInstallStatus', id: 'claude-agent' } }))
        .toMatchObject({ type: 'response', payload: { kind: 'backendInstallStatus', operation: { requestId: mine, state: 'running' } } });
      await client.close();
    } finally { gate.resolve({ ok: true, code: 0, aborted: false, tail: '' }); await fixture.close(); }
  });

  it('does not attach a peer that disconnects during the rebuild await', async () => {
    const complete = deferred<Awaited<ReturnType<AdminService['installBackend']>>>();
    const jobs = manager(fakeService({ installBackend: () => complete.promise }));
    const admission = jobs.selectBackend('claude-agent', false);
    const events: Event[] = [];
    const disconnected: JobPeer = { id: 'gone', open: false, event: event => events.push(event) };
    jobs.attachBackend(admission, disconnected);
    complete.resolve({ ok: true, code: 0, aborted: false, tail: '' });
    await Promise.resolve(); await Promise.resolve();
    expect(events).toEqual([]);
  });
});

// devices 6.3 and devices-ui-3 4.2: whose a scan is, and how long it waits for its client. main 必败 where marked.
describe('scan ownership', () => {
  type Outcome = Awaited<ReturnType<AdminService['registerBotByQr']>>;
  /** A scan that shows its QR and runs until it is aborted. */
  const scanning = (): Partial<AdminService> => {
    const run = (callbacks: Parameters<AdminService['registerBotByQr']>[0]): Promise<Outcome> => new Promise(resolve => {
      callbacks.onQr({ url: 'https://example.com/qr', expireIn: 600 });
      callbacks.signal.addEventListener('abort', () => resolve({ ok: false, code: 'abort', reason: '' }), { once: true });
    });
    return { registerBotByQr: run, refreshBotByQr: (_agentId, callbacks) => run(callbacks) };
  };
  const A = { key: 'paired:cl_aaaaaaaaaaaaaaaa', label: '另一台设备「Clay 的 MacBook」', far: '另一台设备「Clay 的 MacBook」' };
  const B = { key: 'paired:cl_bbbbbbbbbbbbbbbb', label: '另一台设备「工作笔记本」', far: '另一台设备「工作笔记本」' };
  const CLI = { key: 'local:cli', label: '本机的命令行', far: '「办公室 Mac」上的命令行' };
  const phases = (jobs: Jobs) => jobs.snapshot().map(job => job.phase);
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  afterEach(() => { vi.useRealTimers(); });

  it('refuses another client while one scans, leaving the first alone (main 必败)', async () => {
    const jobs = manager(fakeService(scanning()));
    expect(jobs.startRegistration(peer('a').value, undefined, A)).toMatchObject({ kind: 'started' });
    await vi.waitFor(() => expect(phases(jobs)).toEqual(['qr']));
    expect(jobs.startRegistration(peer('b').value, undefined, B)).toEqual({ kind: 'refused', code: 'job_running', message: '另一台设备「Clay 的 MacBook」正在扫码添加 Bot，等它完成后再试。' });
    expect(phases(jobs)).toEqual(['qr']);
  });
  it('names a scan on this computer by where the refused client is', async () => {
    const jobs = manager(fakeService(scanning()));
    jobs.startRegistration(peer('c').value, undefined, CLI);
    expect(jobs.startRegistration(peer('a').value, undefined, A)).toMatchObject({ code: 'job_running', message: '「办公室 Mac」上的命令行正在扫码添加 Bot，等它完成后再试。' });
    expect(jobs.startRegistration(peer('w').value, undefined, { key: 'local:web', label: '本机的网页端', far: '' })).toMatchObject({ message: '本机的命令行正在扫码添加 Bot，等它完成后再试。' });
  });
  it('says 重新扫码 for a bot\'s new credentials', async () => {
    const jobs = manager(fakeService(scanning()));
    jobs.startRegistration(peer('a').value, 'cli_example', A);
    expect(jobs.startRegistration(peer('b').value, undefined, B)).toMatchObject({ code: 'job_running', message: '另一台设备「Clay 的 MacBook」正在为一个 Bot 重新扫码，等它完成后再试。' });
  });
  it('starts over for the same client on a new connection', async () => {
    const jobs = manager(fakeService(scanning()));
    jobs.startRegistration(peer('a').value, undefined, A);
    expect(jobs.startRegistration(peer('a2').value, undefined, A)).toMatchObject({ kind: 'started' });
    await vi.waitFor(() => expect(phases(jobs)).toEqual(['cancelled', 'qr']));
  });
  it('waits 60 seconds after the last connection drops (main 必败)', async () => {
    vi.useFakeTimers();
    const jobs = manager(fakeService(scanning()));
    const a = peer('a').value;
    jobs.startRegistration(a, undefined, A);
    await settle();
    jobs.detach(a);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(phases(jobs)).toHaveLength(1);
    expect(phases(jobs)).not.toContain('cancelled');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(phases(jobs)).toEqual(['cancelled']);
  });
  it('goes on when the same client comes back, and waits again once that connection drops', async () => {
    vi.useFakeTimers();
    const jobs = manager(fakeService(scanning()));
    const [a, a2] = [peer('a').value, peer('a2').value];
    jobs.startRegistration(a, undefined, A);
    jobs.detach(a);
    await vi.advanceTimersByTimeAsync(30_000);
    jobs.attach(a2, A);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(phases(jobs)).not.toContain('cancelled');
    jobs.detach(a2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(phases(jobs)).toEqual(['cancelled']);
  });
  it('starts no grace when the new connection came before the old one dropped (main 必败)', async () => {
    vi.useFakeTimers();
    const jobs = manager(fakeService(scanning()));
    const [a, a2] = [peer('a').value, peer('a2').value];
    jobs.startRegistration(a, undefined, A);
    jobs.attach(a2, A);
    jobs.detach(a);
    expect(vi.getTimerCount()).toBe(1); // the finished-job poll only
    await vi.advanceTimersByTimeAsync(60_000);
    expect(phases(jobs)).not.toContain('cancelled');
    jobs.detach(a2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(phases(jobs)).toEqual(['cancelled']);
  });
  it('counts a short command of the same client as a holder, and none of another', async () => {
    vi.useFakeTimers();
    const jobs = manager(fakeService(scanning()));
    const [a, b, c] = [peer('a').value, peer('b').value, peer('c').value];
    jobs.startRegistration(a, undefined, A);
    jobs.attach(b, A);
    jobs.detach(b);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(phases(jobs)).not.toContain('cancelled');
    jobs.attach(c, B);
    jobs.detach(a);
    jobs.detach(c);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(phases(jobs)).toEqual(['cancelled']);
  });
  it('cancels a revoked client\'s scan at once, connected or in its grace', async () => {
    vi.useFakeTimers();
    const jobs = manager(fakeService(scanning()));
    const a = peer('a').value;
    jobs.startRegistration(a, undefined, A);
    jobs.cancelOwner(B.key);
    expect(phases(jobs)).not.toContain('cancelled');
    jobs.cancelOwner(A.key);
    expect(phases(jobs)).toEqual(['cancelled']);
    jobs.detach(a);
    expect(vi.getTimerCount()).toBe(1);
    const a2 = peer('a2').value;
    jobs.startRegistration(a2, undefined, A);
    jobs.detach(a2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(2);
    jobs.cancelOwner(A.key);
    expect(phases(jobs)).toEqual(['cancelled', 'cancelled']);
    expect(vi.getTimerCount()).toBe(1);
  });
  it('keeps today\'s behaviour with no owner: the later one cancels the earlier, a drop cancels at once', async () => {
    const jobs = manager(fakeService(scanning()));
    const [first, second] = [peer('first').value, peer('second').value];
    jobs.startRegistration(first);
    jobs.startRegistration(second);
    await vi.waitFor(() => expect(phases(jobs)).toEqual(['cancelled', 'qr']));
    jobs.detach(second);
    expect(phases(jobs)).toEqual(['cancelled', 'cancelled']);
  });
  it('clears a grace on close, so the process can exit', async () => {
    vi.useFakeTimers();
    const jobs = manager(fakeService(scanning()));
    const a = peer('a').value;
    jobs.startRegistration(a, undefined, A);
    jobs.detach(a);
    expect(vi.getTimerCount()).toBe(2);
    await jobs.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(phases(jobs)).toEqual(['cancelled']);
  });
});
