import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve, sep } from 'node:path';
import { CodexAppServerBackend, codexSessionParams } from '../src/agent/codex-appserver/backend';
import { CODEX_PROTECTED_PATHS } from '../src/agent/codex-appserver/workspace-policy';
import * as admission from '../src/agent/codex-appserver/workspace-admission';
import * as fullOnly from '../src/agent/codex-appserver/full-only';
import type { SessionProfile } from '../src/agent/session-profile';
import type { StartThreadOptions } from '../src/agent/types';

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
const wire = (path: string) => process.platform === 'win32' ? resolve(path) : path;
const profile: SessionProfile = {
  instructions: 'Preserve these instructions', env: { SESSION_TEST: 'yes' }, nativeSettings: { automaticMemory: false },
  additionalRoots: [{ path: wire('/repo2'), access: 'write' }, { path: wire('/reference'), access: 'read' }], capabilityPackages: [], mcpServers: [],
};
function options(mode: 'qa' | 'write' | 'full' = 'write'): StartThreadOptions {
  return { cwd: wire('/workspace'), mode, network: false, profile };
}
function echo(mode: 'qa' | 'write' | 'full' = 'write') {
  return {
    thread: { id: 'test-thread', turns: [] }, cwd: wire('/workspace'), runtimeWorkspaceRoots: ['/workspace', '/repo2', '/reference'].map(wire),
    approvalPolicy: 'never', activePermissionProfile: mode === 'full' ? null : { id: 'feishu', extends: null },
    sandbox: mode === 'full' ? { type: 'dangerFullAccess' } : mode === 'qa' ? { type: 'readOnly', networkAccess: false } : {
      type: 'workspaceWrite', writableRoots: [wire('/repo2')], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  // Capability admission has separate native/backend coverage. These cases exercise
  // workspace transport and echo checks even on hosts whose write tier is refused.
  vi.spyOn(fullOnly, 'codexTierUnavailable').mockReturnValue(undefined);
  // Parameter/echo unit cases use symbolic wire roots; real layout admission is
  // exercised with actual files and the same backend in s39-workspace-admission.
  vi.spyOn(admission, 'admitCodexWorkspaceLayout').mockResolvedValue();
  rpc.request.mockResolvedValue(echo());
  rpc.take.mockReturnValue({ request: rpc.request, close: rpc.close });
});
afterEach(() => vi.restoreAllMocks());

for (const mode of ['qa', 'write', 'full'] as const) {
  for (const action of ['start', 'resume'] as const) {
    it(`${action} ${mode}: transports all roots, access and existing profile fields`, async () => {
      rpc.request.mockResolvedValue(echo(mode));
      const backend = new CodexAppServerBackend();
      const thread = action === 'start' ? await backend.startThread(options(mode))
        : await backend.resumeThread({ ...options(mode), sessionId: 'test-thread' });
      const params = codexSessionParams(options(mode), 'codex-cli 0.163.0');
      expect(rpc.request).toHaveBeenCalledWith(`thread/${action}`, { ...params, ...(action === 'resume' ? { threadId: 'test-thread', serviceTier: null } : {}) });
      expect(params).toMatchObject({ runtimeWorkspaceRoots: ['/workspace', '/repo2', '/reference'].map(wire), developerInstructions: expect.stringContaining(profile.instructions) });
      expect(params).toMatchObject({ config: { shell_environment_policy: { set: { SESSION_TEST: 'yes' } } } });
      if (mode === 'full') {
        expect(params).toMatchObject({ sandbox: 'danger-full-access' });
        expect(params.config).not.toHaveProperty('permissions');
      } else {
        for (const path of ['/workspace', '/repo2', '/reference'].map(wire)) {
          expect(params).toMatchObject({ config: { permissions: { feishu: { filesystem: {
            [path]: { '.': mode === 'qa' || path === wire('/reference') ? 'read' : 'write', ...(process.platform === 'linux' ? {} : Object.fromEntries(CODEX_PROTECTED_PATHS.map(target => [target, 'read']))) },
          } } } } });
        }
        expect(params).toMatchObject({ config: { permissions: { feishu: { filesystem: { ':workspace_roots': { '.': 'read' },
          ...(process.platform === 'win32' ? {} : { '/private/tmp': { '.': 'read' }, '/private/var/tmp': { '.': 'read' } }),
        } } } } });
        if (process.platform === 'win32') for (const path of ['/private/tmp', '/private/var/tmp']) {
          expect(params).not.toHaveProperty(`config.permissions.feishu.filesystem.${path}`);
        }
      }
      await thread.close();
    });
  }
}

describe('native echo admission releases refused clients', () => {
  const failures: readonly [string, object][] = [
    ['missing thread', { thread: undefined }], ['empty thread id', { thread: { id: '' } }],
    ['missing roots', { runtimeWorkspaceRoots: undefined }], ['extra root', { runtimeWorkspaceRoots: ['/workspace', '/repo2', '/reference', '/foreign'].map(wire) }],
    ['wrong cwd', { cwd: wire('/other') }], ['missing cwd', { cwd: undefined }], ['missing sandbox', { sandbox: undefined }],
    ['wrong profile', { activePermissionProfile: { id: 'other', extends: null } }], ['missing profile', { activePermissionProfile: undefined }],
    ['missing policy', { approvalPolicy: undefined }], ['network widened', { sandbox: { ...echo().sandbox, networkAccess: true } }],
    ['write to read root', { sandbox: { ...echo().sandbox, writableRoots: ['/repo2', '/reference'].map(wire) } }],
    ['missing writableRoots', { sandbox: { ...echo().sandbox, writableRoots: undefined } }],
    ['tmp write widened', { sandbox: { ...echo().sandbox, excludeSlashTmp: false } }],
  ];
  for (const [label, patch] of failures) for (const action of ['start', 'resume'] as const) {
    it(`${action}: ${label}`, async () => {
      rpc.request.mockResolvedValue({ ...echo(), ...patch });
      const backend = new CodexAppServerBackend();
      await expect(action === 'start' ? backend.startThread(options()) : backend.resumeThread({ ...options(), sessionId: 'test-thread' })).rejects.toThrow('s39a');
      expect(rpc.close).toHaveBeenCalledOnce();
    });
  }
  for (const action of ['start', 'resume'] as const) it(`${action}: provider rejection closes`, async () => {
    rpc.request.mockResolvedValueOnce({ config: {} }).mockRejectedValue(new Error('unsupported permission profile'));
    const backend = new CodexAppServerBackend();
    await expect(action === 'start' ? backend.startThread(options()) : backend.resumeThread({ ...options(), sessionId: 'test-thread' })).rejects.toThrow('unsupported');
    expect(rpc.close).toHaveBeenCalledOnce();
  });
});

it('rejects restricted platforms and conflicting/nested roots before acquiring a process', async () => {
  const backend = new CodexAppServerBackend();
  const refusal = vi.spyOn(fullOnly, 'codexTierUnavailable').mockReturnValue('测不出 Codex 的版本');
  await expect(backend.startThread(options())).rejects.toThrow('版本');
  expect(rpc.take).not.toHaveBeenCalled();
  refusal.mockRestore();
  for (const roots of [
    [{ path: wire('/workspace'), access: 'read' }],
    [{ path: wire('/workspace/.claude/skills/injected'), access: 'write' }],
    [{ path: wire('/reference'), access: 'read' }, { path: wire('/reference/sub'), access: 'write' }],
    [{ path: `${wire('/alias')}${sep}..${sep}repo`, access: 'write' }],
    ...(process.platform === 'win32' ? [] : [
      [{ path: '/private/tmp', access: 'write' as const }], [{ path: '/tmp', access: 'read' as const }],
    ]),
  ] satisfies SessionProfile['additionalRoots'][]) {
    await expect(backend.startThread({ ...options(), profile: { ...profile, additionalRoots: roots } })).rejects.toThrow();
    expect(rpc.take).not.toHaveBeenCalled();
  }
});

it('resume refuses a provider silently returning another thread', async () => {
  const backend = new CodexAppServerBackend();
  await expect(backend.resumeThread({ ...options(), sessionId: 'different-thread' })).rejects.toThrow('s39a');
  expect(rpc.close).toHaveBeenCalledOnce();
});
