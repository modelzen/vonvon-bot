import { link, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { CodexWorkspaceLayoutError } from '../src/agent/codex-appserver/workspace-admission';
import * as fullOnly from '../src/agent/codex-appserver/full-only';
import type { StartThreadOptions } from '../src/agent/types';

const fault = vi.hoisted(() => ({
  operation: '' as '' | 'lstat' | 'readdir', path: '', code: '', afterReaddir: '',
  visitedDirectories: new Set<string>(), injected: 0,
}));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  function inspect(operation: 'lstat' | 'readdir', path: string): void {
    if (fault.operation !== operation || fault.path !== path
      || (fault.afterReaddir && !fault.visitedDirectories.has(fault.afterReaddir))) return;
    fault.injected++;
    throw Object.assign(new Error('synthetic metadata failure'), { code: fault.code });
  }
  return {
    ...actual,
    lstat: async (path: string) => { inspect('lstat', path); return actual.lstat(path); },
    readdir: async (path: string) => {
      inspect('readdir', path);
      const entries = await actual.readdir(path);
      fault.visitedDirectories.add(path);
      return entries;
    },
  };
});
const rpc = vi.hoisted(() => ({ request: vi.fn(), close: vi.fn(async () => {}), take: vi.fn(), refill: vi.fn(async () => {}) }));
vi.mock('../src/agent/codex-appserver/client-pool', async original => ({
  ...await original<typeof import('../src/agent/codex-appserver/client-pool')>(),
  takeWarmClient: rpc.take, refillWarmPool: rpc.refill, connectGated: vi.fn(),
}));
vi.mock('../src/agent/codex-appserver/locate', () => ({ refreshCodexResolution: () => '/fake/codex', resolveCodexBin: () => '/fake/codex', codexVersionAsync: vi.fn(async () => 'codex-cli 0.163.0'), cachedCodexVersion: () => undefined }));

let root: string;
let primary: string;
let additional: string;
beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(fault, { operation: '', path: '', code: '', afterReaddir: '', injected: 0 });
  fault.visitedDirectories.clear();
  vi.spyOn(fullOnly, 'codexConfinesReads').mockReturnValue(true);
  root = await realpath(await mkdtemp(join(tmpdir(), 's39-admission-failures-')));
  primary = join(root, 'primary'); additional = join(root, 'additional');
  await mkdir(primary); await mkdir(additional);
  rpc.take.mockReturnValue({ request: rpc.request, close: rpc.close });
  rpc.request.mockImplementation(async (method, params) => method === 'config/read' ? { config: {} } : ({
    cwd: params.cwd, runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
    thread: { id: params.threadId ?? 'synthetic-native' }, approvalPolicy: 'never',
    activePermissionProfile: { id: 'feishu', extends: null },
    sandbox: params.config.permissions.feishu.filesystem[primary]['.'] === 'read'
      ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: [], networkAccess: false,
        excludeTmpdirEnvVar: true, excludeSlashTmp: true },
  }));
});
afterEach(async () => {
  Object.assign(fault, { operation: '', path: '', afterReaddir: '' });
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
function options(mode: 'qa' | 'write'): StartThreadOptions {
  return { cwd: primary, mode, profile: {
    instructions: '', env: {}, nativeSettings: { automaticMemory: false },
    additionalRoots: [{ path: additional, access: 'read' }], capabilityPackages: [], mcpServers: [],
  } };
}
function open(action: 'start' | 'resume', opts: StartThreadOptions) {
  const backend = new CodexAppServerBackend();
  return action === 'start' ? backend.startThread(opts) : backend.resumeThread({ ...opts, sessionId: 'synthetic-native' });
}

describe('restricted workspace admission failure boundaries', () => {
  for (const action of ['start', 'resume'] as const) for (const scenario of [
    { mode: 'qa', target: 'primary', guard: '.claude/skills/nested/guard' },
    { mode: 'qa', target: 'additional', guard: '.agents/skills/nested/guard' },
    { mode: 'write', target: 'primary', guard: '.mcp.json' },
    { mode: 'write', target: 'additional', guard: '.codex/nested/guard' },
  ] as const) {
    it(`${action} checks ${scenario.target} in ${scenario.mode}, including a read-only additional root`, async () => {
      const opts = options(scenario.mode);
      const selected = scenario.target === 'primary' ? primary : additional;
      const aliasRoot = scenario.target === 'primary' ? additional : primary;
      const protectedFile = join(selected, scenario.guard), alias = join(aliasRoot, 'preexisting-alias');
      await mkdir(dirname(protectedFile), { recursive: true }); await writeFile(protectedFile, 'SAFE\n');
      await link(protectedFile, alias);
      await expect(open(action, opts)).rejects.toBeInstanceOf(CodexWorkspaceLayoutError);
      expect(rpc.take).not.toHaveBeenCalled(); expect(rpc.request).not.toHaveBeenCalled();
      expect(await readFile(protectedFile, 'utf8')).toBe('SAFE\n');
      // Positive control: the same qa/mixed roots can start after only our alias is removed.
      await unlink(alias);
      const thread = await open(action, opts);
      expect(rpc.take).toHaveBeenCalledOnce();
      await thread.close();
    });
  }

  for (const action of ['start', 'resume'] as const) for (const operation of ['lstat', 'readdir', 'disappearing-child'] as const) {
    it(`${action} fails closed on ${operation} metadata failure before acquiring a native client`, async () => {
      const protectedDirectory = join(primary, '.codex'), protectedFile = join(protectedDirectory, 'existing');
      await mkdir(protectedDirectory); await writeFile(protectedFile, 'SAFE\n');
      Object.assign(fault, operation === 'readdir'
        ? { operation: 'readdir', path: protectedDirectory, code: 'EACCES' }
        : operation === 'lstat'
          ? { operation: 'lstat', path: protectedDirectory, code: 'EACCES' }
          : { operation: 'lstat', path: protectedFile, code: 'ENOENT', afterReaddir: protectedDirectory });
      await expect(open(action, options('write'))).rejects.toBeInstanceOf(CodexWorkspaceLayoutError);
      expect(fault.injected).toBeGreaterThan(0);
      if (operation === 'disappearing-child') expect(fault.visitedDirectories.has(protectedDirectory)).toBe(true);
      expect(rpc.take).not.toHaveBeenCalled(); expect(rpc.request).not.toHaveBeenCalled();
      expect(await readFile(protectedFile, 'utf8')).toBe('SAFE\n');
      // No chmod, sleep race or deletion is needed to model a failed metadata read.
      Object.assign(fault, { operation: '', path: '', afterReaddir: '' });
      const thread = await open(action, options('write'));
      expect(rpc.take).toHaveBeenCalledOnce();
      await thread.close();
    });
  }
});
