import { mkdir, mkdtemp, readFile, realpath, rm, link, symlink, unlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { admitCodexWorkspaceLayout, CodexWorkspaceLayoutError } from '../src/agent/codex-appserver/workspace-admission';
import { CODEX_PROTECTED_PATHS } from '../src/agent/codex-appserver/workspace-policy';
import * as fullOnly from '../src/agent/codex-appserver/full-only';
import type { StartThreadOptions } from '../src/agent/types';

const rpc = vi.hoisted(() => ({ request: vi.fn(), close: vi.fn(async () => {}), take: vi.fn(), refill: vi.fn(async () => {}) }));
vi.mock('../src/agent/codex-appserver/client-pool', async original => ({ ...await original<typeof import('../src/agent/codex-appserver/client-pool')>(),
  takeWarmClient: rpc.take, refillWarmPool: rpc.refill, connectGated: vi.fn(),
}));
vi.mock('../src/agent/codex-appserver/locate', () => ({ resolveCodexBin: () => '/fake/codex', codexVersionAsync: vi.fn(async () => 'codex-cli 0.163.0'), cachedCodexVersion: () => undefined }));
let root: string;
let a: string;
let b: string;
let opts: StartThreadOptions;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(fullOnly, 'codexConfinesReads').mockReturnValue(true);
  root = await realpath(await mkdtemp(join(tmpdir(), 's39-admission-')));
  a = join(root, 'a'); b = join(root, 'b');
  await mkdir(a); await mkdir(b);
  opts = { cwd: a, mode: 'write', profile: { instructions: '', env: {}, nativeSettings: { automaticMemory: false },
    additionalRoots: [{ path: b, access: 'write' }], capabilityPackages: [], mcpServers: [] } };
  rpc.take.mockReturnValue({ request: rpc.request, close: rpc.close });
  rpc.request.mockImplementation(async (_method, params) => ({ cwd: params.cwd, runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
    thread: { id: params.threadId ?? 'native' }, approvalPolicy: 'never', activePermissionProfile: { id: 'feishu', extends: null },
    sandbox: { type: 'workspaceWrite', writableRoots: [b], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } }));
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const directoryGuard = (path: string) => path === '.codex' || path.endsWith('/skills') || path.endsWith('/commands') || path.endsWith('/agents');

for (const guard of CODEX_PROTECTED_PATHS) for (const action of ['start', 'resume'] as const) {
  it(`${action} rejects preexisting linked files in ${guard} before acquiring a native client`, async () => {
    const target = directoryGuard(guard) ? join(b, guard, 'nested/file') : join(b, guard);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, 'SAFE\n');
    await link(target, join(a, 'preexisting-alias'));
    const backend = new CodexAppServerBackend();
    await expect(action === 'start' ? backend.startThread(opts) : backend.resumeThread({ ...opts, sessionId: 'native' })).rejects.toBeInstanceOf(CodexWorkspaceLayoutError);
    expect(rpc.take).not.toHaveBeenCalled(); expect(await readFile(target, 'utf8')).toBe('SAFE\n');
    await unlink(join(a, 'preexisting-alias'));
    const thread = action === 'start' ? await backend.startThread(opts) : await backend.resumeThread({ ...opts, sessionId: 'native' });
    expect(rpc.take).toHaveBeenCalledOnce(); await thread.close();
  });
}

it('rescans the layout on a fresh backend resume after a successful start', async () => {
  const target = join(a, '.mcp.json'); await writeFile(target, '{}\n');
  const thread = await new CodexAppServerBackend().startThread(opts); await thread.close();
  await link(target, join(b, 'later-alias')); rpc.take.mockClear();
  await expect(new CodexAppServerBackend().resumeThread({ ...opts, sessionId: 'native' })).rejects.toBeInstanceOf(CodexWorkspaceLayoutError);
  expect(rpc.take).not.toHaveBeenCalled(); expect(await readFile(target, 'utf8')).toBe('{}\n');
});

it.each(['target', 'ancestor', 'descendant'])('rejects a symlink at a protected %s without following it', async kind => {
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'file'), 'SAFE');
  if (kind === 'target') await symlink(join(outside, 'file'), join(a, '.mcp.json'));
  else if (kind === 'ancestor') await symlink(outside, join(a, '.claude'));
  else { await mkdir(join(a, '.codex')); await symlink(outside, join(a, '.codex/link')); }
  await expect(admitCodexWorkspaceLayout(opts)).rejects.toBeInstanceOf(CodexWorkspaceLayoutError);
  expect(await readFile(join(outside, 'file'), 'utf8')).toBe('SAFE');
});

it.skipIf(process.platform === 'win32')('rejects nonregular descendants without opening or waiting on a FIFO', async () => {
  await mkdir(join(a, '.codex')); execFileSync('mkfifo', [join(a, '.codex/pipe')]);
  await expect(admitCodexWorkspaceLayout(opts)).rejects.toBeInstanceOf(CodexWorkspaceLayoutError);
});

it('full access retains its historical behavior and does not inspect missing or linked layouts', async () => {
  await writeFile(join(a, '.mcp.json'), '{}\n'); await link(join(a, '.mcp.json'), join(b, 'alias'));
  await expect(admitCodexWorkspaceLayout({ ...opts, mode: 'full' })).resolves.toBeUndefined();
  await expect(admitCodexWorkspaceLayout({ cwd: '/nonexistent', mode: 'full' })).resolves.toBeUndefined();
});
