import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { codexTierUnavailable, type WindowsSandboxCapability } from '../src/agent/codex-appserver/full-only';
import { codexTable } from '../src/agent/permission/codex';
import { probeBackends } from '../src/admin/ops';
import type { PermissionMode, StartThreadOptions } from '../src/agent/types';

const state = vi.hoisted(() => ({
  version: 'codex-cli 0.163.0' as string | null,
  selectedBin: 'C:\\fixture\\codex.exe', resolvedBin: 'C:\\fixture\\codex.exe',
  capability: { status: 'ready', implementation: 'mxc' } as WindowsSandboxCapability | undefined,
  versionProbe: vi.fn(), refresh: vi.fn(), request: vi.fn(),
  close: vi.fn(async () => {}), take: vi.fn(), refill: vi.fn(async () => {}),
}));
vi.mock('../src/agent/codex-appserver/locate', () => ({
  refreshCodexResolution: () => state.selectedBin, resolveCodexBin: () => state.resolvedBin,
  cachedCodexVersion: () => state.version,
  codexVersionAsync: state.versionProbe,
}));
vi.mock('../src/agent/codex-appserver/windows-sandbox', () => ({
  cachedWindowsSandbox: () => state.capability,
  refreshWindowsSandbox: state.refresh,
  windowsShellPath: () => undefined,
}));
vi.mock('../src/agent/codex-appserver/client-pool', async original => ({
  ...await original<typeof import('../src/agent/codex-appserver/client-pool')>(),
  takeWarmClient: state.take, refillWarmPool: state.refill, connectGated: vi.fn(),
}));
vi.mock('../src/agent/codex-appserver/workspace-admission', () => ({ admitCodexWorkspaceLayout: vi.fn(async () => {}) }));
vi.mock('../src/agent/codex-appserver/workspace-policy', async original => ({
  ...await original<typeof import('../src/agent/codex-appserver/workspace-policy')>(),
  codexInstallRoot: () => ({ path: 'C:\\fixture\\codex.exe', kind: 'file' }),
}));

const cwd = join(tmpdir(), 'vonvon Windows 权限', 'workspace');
const readRoot = join(tmpdir(), 'vonvon Windows 权限', 'reference');
const writeRoot = join(tmpdir(), 'vonvon Windows 权限', 'extra writable');
function options(mode: PermissionMode): StartThreadOptions {
  return { cwd, mode, network: mode !== 'qa', profile: {
    instructions: 'fixture instructions', env: { VONVON_TEST: 'fixture' },
    nativeSettings: { automaticMemory: false },
    additionalRoots: [{ path: readRoot, access: 'read' }, { path: writeRoot, access: 'write' }],
    capabilityPackages: [], mcpServers: [],
  } };
}
function echo(mode: PermissionMode) {
  return {
    thread: { id: 'windows-thread', turns: [] }, cwd,
    runtimeWorkspaceRoots: [cwd, readRoot, writeRoot], approvalPolicy: 'never',
    activePermissionProfile: mode === 'full' ? null : { id: 'feishu', extends: null },
    sandbox: mode === 'full' ? { type: 'dangerFullAccess' } : mode === 'qa'
      ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: [writeRoot], networkAccess: true,
        excludeTmpdirEnvVar: true, excludeSlashTmp: true },
  };
}
function replyWith(result: ReturnType<typeof echo> | Error) {
  state.request.mockImplementation(async (method: string) => {
    if (method === 'config/read') return { config: { service_tier: null } };
    if (method !== 'thread/start' && method !== 'thread/resume') throw new Error(`Unexpected request: ${method}`);
    if (result instanceof Error) throw result;
    return result;
  });
}
const threadCalls = () => state.request.mock.calls.filter(([method]) => method === 'thread/start' || method === 'thread/resume');
function invoke(action: 'start' | 'resume', backend: CodexAppServerBackend, opts: StartThreadOptions) {
  return action === 'start' ? backend.startThread(opts)
    : backend.resumeThread({ ...opts, sessionId: 'windows-thread' });
}

describe.skipIf(process.platform !== 'win32')('Windows native permission guards in start/resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.version = 'codex-cli 0.163.0';
    state.selectedBin = 'C:\\fixture\\codex.exe';
    state.resolvedBin = state.selectedBin;
    state.capability = { status: 'ready', implementation: 'mxc' };
    state.versionProbe.mockImplementation(async () => state.version);
    state.refresh.mockImplementation(async () => state.capability);
    state.take.mockReturnValue({ request: state.request, close: state.close });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('keeps a healthy Windows doctor available while version and sandbox checks take more than 3 seconds', async () => {
    vi.useFakeTimers();
    state.versionProbe.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 4_000));
      return state.version;
    });
    state.refresh.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 6_000));
      return state.capability;
    });
    const backend = new CodexAppServerBackend();
    let settled = false;
    const result = probeBackends([backend]).then(rows => { settled = true; return rows; });
    await vi.advanceTimersByTimeAsync(3_001);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result)[0]?.probe).toMatchObject({ ok: true, version: state.version, location: state.selectedBin });
    expect(state.refresh).toHaveBeenCalledWith(state.selectedBin, expect.objectContaining({ force: true }));
  });

  it('still rejects a Windows doctor that fails after the old deadline or never finishes', async () => {
    vi.useFakeTimers();
    state.versionProbe.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 4_000));
      return null;
    });
    const failed = probeBackends([new CodexAppServerBackend()]);
    await vi.advanceTimersByTimeAsync(4_001);
    expect((await failed)[0]?.probe?.ok).toBe(false);
    state.versionProbe.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const hung = probeBackends([new CodexAppServerBackend()]).then(rows => { settled = true; return rows; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await hung)[0]?.probe).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  for (const action of ['start', 'resume'] as const) {
    it(`${action} probes the same executable that was selected for the session`, async () => {
      state.resolvedBin = 'C:\\other\\codex.exe';
      replyWith(echo('qa'));
      const backend = new CodexAppServerBackend();
      const thread = await invoke(action, backend, options('qa'));
      expect(state.refresh).toHaveBeenCalledWith(state.selectedBin, expect.objectContaining({ selectedBin: state.selectedBin }));
      expect(state.versionProbe.mock.calls.every(call => call[0] === state.selectedBin)).toBe(true);
      expect(state.take).toHaveBeenCalledWith(state.selectedBin);
      await thread.close();
    });

    it.each(['qa', 'write'] as const)(`${action} %s pins MXC, keeps the feishu profile and checks the echo`, async mode => {
      replyWith(echo(mode));
      const backend = new CodexAppServerBackend();
      const thread = await invoke(action, backend, options(mode));
      expect(state.refresh).toHaveBeenCalledOnce();
      expect(threadCalls()).toEqual([[`thread/${action}`, expect.objectContaining({
        cwd, runtimeWorkspaceRoots: [cwd, readRoot, writeRoot], approvalPolicy: 'never',
        ...(action === 'resume' ? { threadId: 'windows-thread' } : {}),
        config: expect.objectContaining({
          windows: { sandbox: 'mxc' }, features: expect.objectContaining({ prefer_mxc: false, memories: false, in_app_local_automation: false }),
          default_permissions: 'feishu',
          permissions: { feishu: { filesystem: expect.objectContaining({
            ':minimal': 'read', [cwd]: expect.objectContaining({ '.': mode === 'qa' ? 'read' : 'write', '.codex': 'read' }),
            [readRoot]: expect.objectContaining({ '.': 'read' }),
            [writeRoot]: expect.objectContaining({ '.': mode === 'qa' ? 'read' : 'write' }),
          }), network: { enabled: mode === 'write' } } },
        }),
      })]]);
      const params = threadCalls()[0]![1];
      expect(params).not.toHaveProperty('sandbox');
      expect(params.config.permissions.feishu.filesystem).not.toHaveProperty('/private/tmp');
      await thread.close();
    });

    it.each(['notConfigured', 'updateRequired', 'probeFailed', 'unsupported'] as const)(
      `${action} refuses %s before acquiring a session process and preserves the selection`, async status => {
        state.capability = { status };
        const backend = new CodexAppServerBackend();
        const opts = options('qa');
        const before = structuredClone(opts);
        const reason = codexTierUnavailable('qa', 'win32', state.version, state.capability)!;
        expect(backend.fullAccessOnly()).toBe(reason);
        expect(codexTable.tiers({ platform: 'win32' })[0].unavailable).toBe(reason);
        await expect(invoke(action, backend, opts)).rejects.toThrow(reason);
        expect(opts).toEqual(before);
        expect(state.take).not.toHaveBeenCalled();
        expect(state.request).not.toHaveBeenCalled();
      });

    it(`${action} refuses an absent or invalidated capability cache until asynchronous refresh succeeds`, async () => {
      state.capability = undefined;
      const backend = new CodexAppServerBackend();
      const opts = options('write');
      await expect(invoke(action, backend, opts)).rejects.toThrow('尚未完成');
      expect(state.take).not.toHaveBeenCalled();
      expect(state.request).not.toHaveBeenCalled();
      expect(opts.mode).toBe('write');
    });

    it.each(['0.162.9', '0.163.0-rc.1', '0.164.0-alpha.1', null])(
      `${action} rejects unverified version %s without a native capability probe`, async version => {
        state.version = version;
        await expect(invoke(action, new CodexAppServerBackend(), options('write'))).rejects.toThrow();
        expect(state.refresh).not.toHaveBeenCalled();
        expect(state.take).not.toHaveBeenCalled();
      });

    it(`${action} full access remains available without a capability probe`, async () => {
      state.version = null;
      state.capability = { status: 'probeFailed' };
      replyWith(echo('full'));
      const thread = await invoke(action, new CodexAppServerBackend(), options('full'));
      expect(state.refresh).not.toHaveBeenCalled();
      const params = threadCalls()[0]![1];
      expect(params.sandbox).toBe('danger-full-access');
      expect(params.config).not.toHaveProperty('windows');
      expect(params.config).not.toHaveProperty('permissions');
      await thread.close();
    });

    it.each(['network', 'profile'] as const)(`${action} closes a client whose %s echo widens permission`, async defect => {
      replyWith({ ...echo('qa'), ...(defect === 'network'
        ? { sandbox: { type: 'readOnly', networkAccess: true } }
        : { activePermissionProfile: { id: 'workspace', extends: null } }) });
      await expect(invoke(action, new CodexAppServerBackend(), options('qa'))).rejects.toThrow('s39a');
      expect(state.close).toHaveBeenCalledOnce();
      expect(threadCalls()).toHaveLength(1);
      expect(threadCalls()[0]![0]).toBe(`thread/${action}`);
      expect(threadCalls()[0]![1]).not.toHaveProperty('sandbox', 'danger-full-access');
    });

    it(`${action} provider refusal is not retried as full access or a fresh conversation`, async () => {
      replyWith(new Error('native MXC policy refused'));
      await expect(invoke(action, new CodexAppServerBackend(), options('qa'))).rejects.toThrow('native MXC policy refused');
      expect(threadCalls()).toHaveLength(1);
      expect(threadCalls()[0]![0]).toBe(`thread/${action}`);
      expect(state.close).toHaveBeenCalledOnce();
    });
  }

  it('fullAccessOnly reads cached capability without probing or changing a saved tier', () => {
    const backend = new CodexAppServerBackend();
    expect(backend.fullAccessOnly()).toBeUndefined();
    state.capability = { status: 'updateRequired' };
    expect(backend.fullAccessOnly()).toContain('需要更新');
    expect(state.versionProbe).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
    expect(state.take).not.toHaveBeenCalled();
  });
});
