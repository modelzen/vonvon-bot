import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import * as admission from '../src/agent/codex-appserver/workspace-admission';
import * as fullOnly from '../src/agent/codex-appserver/full-only';
import { log } from '../src/core/logger';
import type { SessionProfile } from '../src/agent/session-profile';
import type { PermissionMode } from '../src/agent/types';

// T4b 4.3 against a fake app-server: the builtin package as the thread's capability root, readable in the read-only
// and read-write tiers and never made a workspace root.
const rpc = vi.hoisted(() => ({ request: vi.fn(), close: vi.fn(async () => {}), take: vi.fn(), refill: vi.fn(async () => {}) }));
vi.mock('../src/agent/codex-appserver/client-pool', async importOriginal => ({
  ...await importOriginal<typeof import('../src/agent/codex-appserver/client-pool')>(),
  takeWarmClient: rpc.take, refillWarmPool: rpc.refill, connectGated: vi.fn(),
}));
vi.mock('../src/agent/codex-appserver/locate', async () => {
  const { resolve } = await import('node:path');
  return { refreshCodexResolution: () => resolve('/fake/codex'), resolveCodexBin: () => resolve('/fake/codex'), codexVersionAsync: vi.fn(async () => 'codex-cli 0.163.0'), cachedCodexVersion: () => undefined };
});
vi.mock('../src/agent/codex-appserver/windows-sandbox', () => ({
  cachedWindowsSandbox: () => ({ status: 'ready', implementation: 'mxc' }),
  refreshWindowsSandbox: async () => ({ status: 'ready', implementation: 'mxc' }),
  windowsShellPath: () => undefined,
}));
const cwd = resolve('/workspace');
let packagePath: string;
beforeEach(() => {
  vi.clearAllMocks();
  packagePath = mkdtempSync(join(tmpdir(), 't4b-codex-'));
  vi.spyOn(fullOnly, 'codexTierUnavailable').mockReturnValue(undefined);
  vi.spyOn(admission, 'admitCodexWorkspaceLayout').mockResolvedValue();
  rpc.request.mockImplementation(async (method: string, params: Record<string, any>) => method === 'config/read' ? { config: {} } : {
    thread: { id: params.threadId ?? 'thread', turns: [] }, cwd: params.cwd, runtimeWorkspaceRoots: params.runtimeWorkspaceRoots, approvalPolicy: 'never',
    activePermissionProfile: params.config?.default_permissions ? { id: 'feishu', extends: null } : null,
    sandbox: params.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' } : params.config.permissions.feishu.filesystem[cwd]['.'] === 'read'
      ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
  });
  rpc.take.mockReturnValue({ request: rpc.request, close: rpc.close });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(packagePath, { recursive: true, force: true });
});
const profile = (packages: SessionProfile['capabilityPackages']): SessionProfile => ({ instructions: '', env: {}, nativeSettings: { automaticMemory: false },
  additionalRoots: [], capabilityPackages: packages, mcpServers: [], tools: { schedule: packages.length > 0 } });
async function params(action: 'start' | 'resume', mode: PermissionMode, p: SessionProfile): Promise<Record<string, any>> {
  const backend = new CodexAppServerBackend();
  const options = { cwd, mode, network: false, profile: p };
  const thread = action === 'start' ? await backend.startThread(options) : await backend.resumeThread({ ...options, sessionId: 'thread' });
  await thread.close();
  return rpc.request.mock.calls.find(([method]) => method === `thread/${action}`)![1];
}

for (const mode of ['qa', 'write', 'full'] as const) {
  for (const action of ['start', 'resume'] as const) {
    it(`${action} ${mode}: selects the package as a capability root, read-only for the session`, async () => {
      const sent = await params(action, mode, profile([{ path: packagePath, kind: 'builtin' }]));
      expect(sent.selectedCapabilityRoots).toEqual([{ id: 'vonvon-builtin', location: { type: 'environment', environmentId: 'local', path: packagePath } }]);
      expect(sent.runtimeWorkspaceRoots).toEqual([cwd]);
      if (mode === 'full') expect(sent).toMatchObject({ sandbox: 'danger-full-access' });
      else expect(sent.config.permissions.feishu.filesystem[packagePath]).toEqual({ '.': 'read' });
    });
    it(`${action} ${mode}: sends neither without a package`, async () => {
      const sent = await params(action, mode, profile([]));
      expect(sent).not.toHaveProperty('selectedCapabilityRoots');
      expect(JSON.stringify(sent)).not.toContain(packagePath);
    });
  }
}

it('leaves out a package directory that is not there, and logs it', async () => {
  const fail = vi.spyOn(log, 'fail');
  const missing = join(packagePath, 'missing');
  const sent = await params('start', 'write', profile([{ path: missing, kind: 'builtin' }]));
  expect(sent).not.toHaveProperty('selectedCapabilityRoots');
  expect(sent.config.permissions.feishu.filesystem).not.toHaveProperty([missing]);
  expect(fail).toHaveBeenCalledWith('agent', expect.anything(), expect.objectContaining({ phase: 'capability-root' }));
});
