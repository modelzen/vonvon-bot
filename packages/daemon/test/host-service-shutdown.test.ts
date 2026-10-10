import { fakeService, socketClient, startFixture } from './server-fixture';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { CodexSetupService } from '../src/agent/codex-appserver/setup';
import { createAdminService } from '../src/admin/service';
import { acquireMutex, closeMutex } from '../src/config/data-access';
import { Jobs } from '../src/server/jobs';

const execution = vi.hoisted(() => ({ run: async (_options: { onListening?: (listen: string) => Promise<void> }): Promise<void> => { throw new Error('runtime not arranged'); } }));
vi.mock('../src/cli/commands/run', () => ({ runRun: (_bot: unknown, options: { onListening?: (listen: string) => Promise<void> }) => execution.run(options) }));

vi.mock('../src/server/http', async importOriginal => {
  const { paths } = await import('../src/config/paths');
  const actual = await importOriginal<typeof import('../src/server/http')>();
  return { ...actual, startApi: (options: Parameters<typeof actual.startApi>[0]) => {
    expect(paths.appDir.startsWith(join(tmpdir(), 'vonvon-api-'))).toBe(true);
    return actual.startApi(options);
  } };
});

beforeEach(() => { vi.stubEnv('CODEX_BIN', ''); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function gate() {
  let release = (): void => { throw new Error('gate not initialized'); };
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function causes(error: unknown): unknown[] { return error instanceof AggregateError ? error.errors.flatMap(causes) : [error]; }

it('holds PID and mutex through usage then Codex cleanup despite a rejecting Jobs drain', async () => {
  const usageCleanup = gate();
  const installCleanup = gate();
  const closingStarted = gate();
  let signal: AbortSignal | undefined;
  const tools = new CodexSetupService({ install: cancellation => { signal = cancellation; return installCleanup.promise; } });
  const owner = createAdminService({ codexTools: tools, daemonStartedAt: 1, fetchAccountUsage: async () => {
    await usageCleanup.promise;
    return { profile: { topInvocations: [], dailyBuckets: [] }, usage: { main: {}, extras: [], fetchedAt: 1 } };
  } });
  const failure = new Error('independent Jobs cleanup failed');
  const original = Jobs.prototype.close;
  const jobsClose = vi.spyOn(Jobs.prototype, 'close').mockImplementation(async function (this: Jobs) { await original.call(this); throw failure; });
  const fixture = await startFixture(fakeService({ startCodexJob: owner.startCodexJob, codexJob: owner.codexJob, close: owner.close }));
  let client: Awaited<ReturnType<typeof socketClient>> | undefined;
  let usage: ReturnType<typeof owner.accountUsage> | undefined;
  let host: Promise<unknown> | undefined;
  let settled = false;
  try {
    execution.run = async options => {
      await options.onListening?.(fixture.api.listen);
      client = await socketClient(fixture.api.port, fixture.credential);
      await client.ready();
      expect(await client.call({ type: 'request', id: 'install', method: 'command', payload: { type: 'installCodex' } })).toMatchObject({ type: 'response', payload: { kind: 'started' } });
      expect(JSON.parse(await readFile(join(fixture.home, 'daemon.pid'), 'utf8'))).toMatchObject({ pid: process.pid });
      usage = owner.accountUsage(false);
      const closing = fixture.api.close();
      closingStarted.release();
      await closing;
    };
    vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'send', { value: undefined }));
    const { runHostRuntime } = await import('../src/host/bootstrap');
    host = runHostRuntime({ managed: false, control: { requested: false, waitForRequest: async () => {}, requestStop() {}, requestRestart() {}, dispose() {} } }).catch(error => error);
    void host.then(() => { settled = true; });
    await Promise.race([closingStarted.promise, host.then(error => { throw error; })]);
    await vi.waitFor(() => expect(client?.socket.readyState).toBe(WebSocket.CLOSED));
    await tick();
    expect(signal?.aborted).toBe(false);
    expect(settled).toBe(false);
    expect(await readFile(join(fixture.home, 'daemon.pid'), 'utf8').then(text => JSON.parse(text), () => undefined)).toMatchObject({ pid: process.pid, listen: fixture.api.listen });
    const held = await acquireMutex(fixture.home, 'host', 0).then(async mutex => { await closeMutex(mutex); return false; }, () => true);
    expect(held).toBe(true);
    usageCleanup.release();
    await usage;
    await tick();
    expect(signal?.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(JSON.parse(await readFile(join(fixture.home, 'daemon.pid'), 'utf8'))).toMatchObject({ pid: process.pid });
    const stillHeld = await acquireMutex(fixture.home, 'host', 0).then(async mutex => { await closeMutex(mutex); return false; }, () => true);
    expect(stillHeld).toBe(true);
    installCleanup.release();
    expect(causes(await host)).toContain(failure);
    await expect(readFile(join(fixture.home, 'daemon.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
    const mutex = await acquireMutex(fixture.home, 'host', 100);
    await closeMutex(mutex);
  } finally {
    usageCleanup.release(); installCleanup.release();
    await usage;
    await owner.close?.();
    await host;
    await client?.close();
    await fixture.api.close().catch(() => undefined);
    await rm(fixture.home, { recursive: true, force: true });
    jobsClose.mockRestore();
  }
});
