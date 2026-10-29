import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedWindowsSandbox, createWindowsSandboxCache, refreshWindowsSandbox, windowsShellPath } from '../src/agent/codex-appserver/windows-sandbox';
import { codexTierUnavailable } from '../src/agent/codex-appserver/full-only';

const fixture = vi.hoisted(() => ({
  execRaw: undefined as unknown, readiness: undefined as unknown,
  execError: undefined as Error | undefined, connectError: undefined as Error | undefined,
  cleanupError: undefined as Error | undefined, ownedCleanupError: undefined as Error | undefined, timeout: false,
  ownedClose: vi.fn(), clientClose: vi.fn(), connect: vi.fn(), peerClose: vi.fn(),
  peerRequest: vi.fn(), clientRequest: vi.fn(), launch: vi.fn(), clientOptions: vi.fn(),
}));
vi.mock('../src/agent/codex-appserver/client-pool', () => ({ binFingerprint: () => 'fixture-binary' }));
vi.mock('../src/agent/owned-process', async () => {
  const { ChildProcess } = await import('node:child_process');
  const { PassThrough } = await import('node:stream');
  return { OwnedProviderProcess: class {
    child = Object.assign(new ChildProcess(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    constructor(...args: unknown[]) { fixture.launch(...args); }
    async close() { fixture.ownedClose(); if (fixture.ownedCleanupError) throw fixture.ownedCleanupError; }
  } };
});
vi.mock('../src/provider/transport/jsonrpc', () => ({
  JsonRpcPeer: class {
    async request(...args: unknown[]) {
      fixture.peerRequest(...args);
      if (fixture.timeout) return await new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timed out')), args[2] as number));
      if (fixture.execError) throw fixture.execError;
      return fixture.execRaw;
    }
    notify() {}
    close() { fixture.peerClose(); }
  },
  AppServerClient: class {
    constructor(opts: unknown) { fixture.clientOptions(opts); }
    async connect() { fixture.connect(); if (fixture.connectError) throw fixture.connectError; }
    async request(...args: unknown[]) { fixture.clientRequest(...args); return fixture.readiness; }
    async close() { fixture.clientClose(); if (fixture.cleanupError) throw fixture.cleanupError; }
  },
}));

const ready = { status: 'ready' as const, implementation: 'mxc' as const };
const unsupported = { status: 'unsupported' as const };
const shellPath = join(tmpdir(), 'Portable PowerShell', 'pwsh.exe');
let serial = 0;
const bin = () => `C:\\fixture\\codex-probe-${serial++}.exe`;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(fixture, { execRaw: { environmentInfo: { capabilities: { windowsMxc: true }, shell: { path: shellPath } } },
    readiness: { status: 'ready' }, execError: undefined, connectError: undefined, cleanupError: undefined, ownedCleanupError: undefined, timeout: false });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('selected Windows Codex native capability probe', () => {
  it('checks actual executor MXC support, selected configuration, and retains an absolute shell', async () => {
    const selected = bin();
    expect(await refreshWindowsSandbox(selected)).toEqual(ready);
    expect(fixture.launch).toHaveBeenCalledWith(selected, ['exec-server', '--listen', 'stdio'], expect.anything());
    expect(fixture.peerRequest).toHaveBeenCalledWith('initialize', { clientName: 'vonvon-sandbox-probe', resumeSessionId: null }, expect.any(Number));
    expect(fixture.clientOptions).toHaveBeenCalledWith(expect.objectContaining({ bin: selected,
      configOverrides: ['windows.sandbox="mxc"', 'features.prefer_mxc=false'] }));
    expect(fixture.clientRequest).toHaveBeenCalledWith('windowsSandbox/readiness', undefined, expect.any(Number));
    expect(windowsShellPath(selected)).toBe(shellPath);
    expect(cachedWindowsSandbox(selected)).toEqual(ready);
    expect(fixture.ownedClose).toHaveBeenCalledOnce(); expect(fixture.clientClose).toHaveBeenCalledOnce();
  });
  it('treats a false runtime capability as unsupported without legacy setup or app-server startup', async () => {
    fixture.execRaw = { environmentInfo: { capabilities: { windowsMxc: false } } };
    expect(await refreshWindowsSandbox(bin())).toEqual(unsupported);
    expect(fixture.ownedClose).toHaveBeenCalledOnce(); expect(fixture.connect).not.toHaveBeenCalled();
  });
  it.each([{}, { environmentInfo: {} }, { environmentInfo: { capabilities: {} } },
    { environmentInfo: { capabilities: { windowsMxc: 'true' } } }])('fails closed on incomplete or nonboolean capability %j', async raw => {
    fixture.execRaw = raw;
    expect(await refreshWindowsSandbox(bin())).toEqual({ status: 'probeFailed' });
    expect(fixture.ownedClose).toHaveBeenCalledOnce(); expect(fixture.connect).not.toHaveBeenCalled();
  });
  it.each(['notConfigured', 'updateRequired'] as const)('preserves readiness reason %s', async status => {
    fixture.readiness = { status };
    expect(await refreshWindowsSandbox(bin())).toEqual({ status });
    expect(fixture.clientClose).toHaveBeenCalledOnce();
  });
  it('rejects malformed readiness without widening permissions', async () => {
    fixture.readiness = { status: 'unknown' };
    expect(await refreshWindowsSandbox(bin())).toEqual({ status: 'probeFailed' });
    expect(fixture.clientClose).toHaveBeenCalledOnce();
  });
  it('reports explicit MXC policy refusal separately from transient connection failures', async () => {
    fixture.connectError = new Error('windows.sandbox = "mxc" is not allowed when windows.allow_mxc = false');
    expect(await refreshWindowsSandbox(bin())).toEqual(unsupported);
    fixture.connectError = new Error('connection interrupted');
    expect(await refreshWindowsSandbox(bin())).toEqual({ status: 'probeFailed' });
    expect(fixture.clientClose).toHaveBeenCalledTimes(2);
  });
  it('closes the owned probe after a finite RPC timeout', async () => {
    vi.useFakeTimers(); fixture.timeout = true;
    const pending = refreshWindowsSandbox(bin());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toEqual({ status: 'probeFailed' });
    expect(fixture.ownedClose).toHaveBeenCalledOnce(); expect(fixture.connect).not.toHaveBeenCalled();
  });
  it('invalidates readiness when cleanup cannot be confirmed', async () => {
    fixture.cleanupError = new Error('cleanup failed');
    expect(await refreshWindowsSandbox(bin())).toEqual({ status: 'probeFailed' });
  });
  it('overrides even an early unsupported result when owned process cleanup fails', async () => {
    fixture.execRaw = { environmentInfo: { capabilities: { windowsMxc: false } } };
    fixture.ownedCleanupError = new Error('cleanup failed');
    expect(await refreshWindowsSandbox(bin())).toEqual({ status: 'probeFailed' });
  });
  it('cannot admit a ready executor without its actual shell path', async () => {
    fixture.execRaw = { environmentInfo: { capabilities: { windowsMxc: true } } };
    expect(await refreshWindowsSandbox(bin())).toEqual({ status: 'probeFailed' });
    expect(fixture.ownedClose).toHaveBeenCalledOnce(); expect(fixture.connect).not.toHaveBeenCalled();
  });
  it('never returns a relative executable as a filesystem read grant', async () => {
    fixture.execRaw = { environmentInfo: { capabilities: { windowsMxc: true }, shell: { path: 'pwsh.exe' } } };
    const selected = bin();
    expect(await refreshWindowsSandbox(selected)).toEqual({ status: 'probeFailed' });
    expect(windowsShellPath(selected)).toBeUndefined();
  });
});

describe('Windows capability refresh cache', () => {
  it('retains the last verdict on synchronous reads while TTL and force require refresh', async () => {
    let now = 0;
    const probe = vi.fn(async () => ({ capability: ready, shellPath: 'C:\\Shell\\pwsh.exe' }));
    const cache = createWindowsSandboxCache(probe, () => 'v1', () => now);
    expect(cache.cached('selected')).toBeUndefined(); expect(probe).not.toHaveBeenCalled();
    expect(await cache.refresh('selected')).toEqual(ready);
    now = 29_999;
    expect(await cache.refresh('selected')).toEqual(ready); expect(probe).toHaveBeenCalledTimes(1);
    now = 30_000;
    expect(cache.cached('selected')).toEqual(ready); expect(cache.shellPath('selected')).toBe('C:\\Shell\\pwsh.exe');
    expect(probe).toHaveBeenCalledTimes(1);
    await cache.refresh('selected'); expect(probe).toHaveBeenCalledTimes(2);
    await cache.refresh('selected', { force: true }); expect(probe).toHaveBeenCalledTimes(3);
  });
  it('does not use an expired positive verdict after awaited execution-time refresh fails', async () => {
    let now = 0;
    let available = true;
    const cache = createWindowsSandboxCache(async () => available
      ? { capability: ready, shellPath: 'C:\\Shell\\pwsh.exe' } : { capability: unsupported }, () => 'same-binary', () => now);
    await cache.refresh('selected');
    now = 30_000; available = false;
    expect(cache.cached('selected')).toEqual(ready);
    expect(await cache.refresh('selected')).toEqual(unsupported);
    expect(cache.cached('selected')).toEqual(unsupported); expect(cache.shellPath('selected')).toBeUndefined();
    expect(codexTierUnavailable('qa', 'win32', 'codex-cli 0.163.0', cache.cached('selected'))).toBeDefined();
  });
  it('a changed binary, config, or Codex home identity invalidates the conclusion and shell', async () => {
    let key = 'binary-v1/home-a/config-1';
    const probe = vi.fn(async () => ({ capability: ready, shellPath: 'C:\\Shell\\pwsh.exe' }));
    const cache = createWindowsSandboxCache(probe, () => key);
    await cache.refresh('selected');
    // A previous good runtime verdict cannot relax the independent version guard.
    expect(codexTierUnavailable('qa', 'win32', 'codex-cli 0.162.9', cache.cached('selected'))).toBeDefined();
    key = 'binary-v2/home-b/config-2';
    expect(cache.cached('selected')).toBeUndefined(); expect(cache.shellPath('selected')).toBeUndefined();
    expect(codexTierUnavailable('qa', 'win32', 'codex-cli 0.163.0', cache.cached('selected'))).toBeDefined();
    await cache.refresh('selected'); await cache.refresh('other-path');
    expect(probe).toHaveBeenCalledTimes(3);
  });
  it('coalesces concurrent refreshes, including force, and shares failures without spawning on read', async () => {
    let finish!: (value: { capability: typeof ready }) => void;
    const probe = vi.fn(() => new Promise<{ capability: typeof ready }>(resolve => { finish = resolve; }));
    const cache = createWindowsSandboxCache(probe, () => 'v1');
    const first = cache.refresh('selected'); const second = cache.refresh('selected', { force: true });
    expect(probe).toHaveBeenCalledOnce(); expect(cache.cached('selected')).toBeUndefined();
    finish({ capability: ready });
    expect(await first).toEqual(ready); expect(await second).toEqual(ready);
    const failure = createWindowsSandboxCache(async () => { throw new Error('probe timed out'); }, () => 'v1');
    expect(await failure.refresh('selected')).toEqual({ status: 'probeFailed' });
    expect(failure.cached('selected')).toEqual({ status: 'probeFailed' });
  });
  it('does not let a stale in-flight probe overwrite a new fingerprint or expose the old shell', async () => {
    let key = 'v1'; let finishOld!: (value: { capability: typeof ready; shellPath: string }) => void;
    const cache = createWindowsSandboxCache(() => key === 'v1'
      ? new Promise<{ capability: typeof ready; shellPath: string }>(resolve => { finishOld = resolve; })
      : Promise.resolve({ capability: unsupported }), () => key);
    const old = cache.refresh('selected'); key = 'v2';
    expect(await cache.refresh('selected')).toEqual(unsupported);
    finishOld({ capability: ready, shellPath: 'C:\\Old Shell\\pwsh.exe' });
    expect(await old).toEqual({ status: 'probeFailed' });
    expect(cache.cached('selected')).toEqual(unsupported); expect(cache.shellPath('selected')).toBeUndefined();
  });
});
