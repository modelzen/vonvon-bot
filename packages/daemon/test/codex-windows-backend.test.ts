import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { codexTierUnavailable, type WindowsSandboxCapability } from '../src/agent/codex-appserver/full-only';
import { codexTable } from '../src/agent/permission/codex';
import type { PermissionMode, StartThreadOptions } from '../src/agent/types';

const state = vi.hoisted(() => ({
  version: 'codex-cli 0.163.0' as string | null,
  capability: { status: 'ready', implementation: 'mxc' } as WindowsSandboxCapability | undefined,
  versionProbe: vi.fn(), refresh: vi.fn(), request: vi.fn(),
  close: vi.fn(async () => {}), take: vi.fn(), refill: vi.fn(async () => {}),
}));
vi.mock('../src/agent/codex-appserver/locate', () => ({
  resolveCodexBin: () => 'C:\\fixture\\codex.exe',
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
function invoke(action: 'start' | 'resume', backend: CodexAppServerBackend, opts: StartThreadOptions) {
  return action === 'start' ? backend.startThread(opts)
    : backend.resumeThread({ ...opts, sessionId: 'windows-thread' });
}

describe.skipIf(process.platform !== 'win32')('Windows native permission guards in start/resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.version = 'codex-cli 0.163.0';
    state.capability = { status: 'ready', implementation: 'mxc' };
    state.versionProbe.mockImplementation(async () => state.version);
    state.refresh.mockImplementation(async () => state.capability);
    state.take.mockReturnValue({ request: state.request, close: state.close });
  });
  afterEach(() => vi.restoreAllMocks());

  for (const action of ['start', 'resume'] as const) {
    it.each(['qa', 'write'] as const)(`${action} %s pins MXC, keeps the feishu profile and checks the echo`, async mode => {
      state.request.mockResolvedValue(echo(mode));
      const backend = new CodexAppServerBackend();
      const thread = await invoke(action, backend, options(mode));
      expect(state.refresh).toHaveBeenCalledOnce();
      expect(state.request).toHaveBeenCalledExactlyOnceWith(`thread/${action}`, expect.objectContaining({
        cwd, runtimeWorkspaceRoots: [cwd, readRoot, writeRoot], approvalPolicy: 'never',
        ...(action === 'resume' ? { threadId: 'windows-thread' } : {}),
        config: expect.objectContaining({
          windows: { sandbox: 'mxc' }, features: expect.objectContaining({ prefer_mxc: false, memories: false }),
          default_permissions: 'feishu',
          permissions: { feishu: { filesystem: expect.objectContaining({
            ':minimal': 'read', [cwd]: expect.objectContaining({ '.': mode === 'qa' ? 'read' : 'write', '.codex': 'read' }),
            [readRoot]: expect.objectContaining({ '.': 'read' }),
            [writeRoot]: expect.objectContaining({ '.': mode === 'qa' ? 'read' : 'write' }),
          }), network: { enabled: mode === 'write' } } },
        }),
      }));
      const params = state.request.mock.calls[0]![1];
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
      state.request.mockResolvedValue(echo('full'));
      const thread = await invoke(action, new CodexAppServerBackend(), options('full'));
      expect(state.refresh).not.toHaveBeenCalled();
      const params = state.request.mock.calls[0]![1];
      expect(params.sandbox).toBe('danger-full-access');
      expect(params.config).not.toHaveProperty('windows');
      expect(params.config).not.toHaveProperty('permissions');
      await thread.close();
    });

    it.each(['network', 'profile'] as const)(`${action} closes a client whose %s echo widens permission`, async defect => {
      state.request.mockResolvedValue({ ...echo('qa'), ...(defect === 'network'
        ? { sandbox: { type: 'readOnly', networkAccess: true } }
        : { activePermissionProfile: { id: 'workspace', extends: null } }) });
      await expect(invoke(action, new CodexAppServerBackend(), options('qa'))).rejects.toThrow('s39a');
      expect(state.close).toHaveBeenCalledOnce();
      expect(state.request).toHaveBeenCalledOnce();
      expect(state.request.mock.calls[0]![1]).not.toHaveProperty('sandbox', 'danger-full-access');
    });

    it(`${action} provider refusal is not retried as full access or a fresh conversation`, async () => {
      state.request.mockRejectedValue(new Error('native MXC policy refused'));
      await expect(invoke(action, new CodexAppServerBackend(), options('qa'))).rejects.toThrow('native MXC policy refused');
      expect(state.request).toHaveBeenCalledOnce();
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
