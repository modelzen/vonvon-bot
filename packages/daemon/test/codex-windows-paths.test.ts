import { describe, expect, it } from 'vitest';
import { CODEX_PROTECTED_PATHS, codexFilesystem, codexWorkspaceRoots, verifyCodexWorkspaceEcho } from '../src/agent/codex-appserver/workspace-policy';
import type { SessionProfile } from '../src/agent/session-profile';

const cwd = 'C:\\Vonvon Tests\\权限工作区';
const read = 'C:\\Vonvon Tests\\只读资料';
const write = 'D:\\Extra Workspace';
function profile(additionalRoots: SessionProfile['additionalRoots']): SessionProfile {
  return { instructions: '', env: {}, nativeSettings: { automaticMemory: false }, additionalRoots,
    capabilityPackages: [], mcpServers: [] };
}
const opts = { cwd, mode: 'write' as const, network: true,
  profile: profile([{ path: read, access: 'read' }, { path: write, access: 'write' }]) };
function echo() {
  return { thread: { id: 'windows-thread' }, cwd: 'c:/vonvon tests/权限工作区',
    runtimeWorkspaceRoots: ['d:/extra workspace', 'c:/vonvon tests/只读资料', 'c:/vonvon tests/权限工作区'],
    approvalPolicy: 'never', activePermissionProfile: { id: 'feishu', extends: null },
    sandbox: { type: 'workspaceWrite', writableRoots: ['d:/extra workspace'], networkAccess: true,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true } };
}

describe.skipIf(process.platform !== 'win32')('Windows Codex workspace wire paths', () => {
  it('omits POSIX scratch entries without adding Windows temp or home grants', () => {
    const fs = codexFilesystem([{ path: cwd, access: 'write' }], 'write', undefined, 'win32');
    expect(Object.keys(fs).sort()).toEqual([':minimal', ':workspace_roots', cwd].sort());
    expect(fs[cwd]).toEqual({ '.': 'write', ...Object.fromEntries(CODEX_PROTECTED_PATHS.map(path => [path, 'read'])) });
  });
  it.each(['darwin', 'linux'] as const)('retains existing scratch entries on %s', platform => {
    expect(codexFilesystem([], 'qa', undefined, platform)).toMatchObject({
      '/private/tmp': { '.': 'read' }, '/private/var/tmp': { '.': 'read' },
    });
  });
  it('collapses case aliases with the same access and preserves the selected spelling', () => {
    expect(codexWorkspaceRoots({ cwd, mode: 'write', profile: profile([{ path: cwd.toLowerCase(), access: 'write' }]) }))
      .toEqual([{ path: cwd, access: 'write' }]);
  });
  it('rejects conflicting permissions through a case alias', () => {
    expect(() => codexWorkspaceRoots({ cwd, mode: 'write', profile: profile([{ path: cwd.toLowerCase(), access: 'read' }]) }))
      .toThrow('权限冲突');
  });
  it('still rejects a writable root nested under a differently cased read-only root', () => {
    expect(() => codexWorkspaceRoots({ cwd, mode: 'write', profile: profile([
      { path: read, access: 'read' }, { path: `${read.toLowerCase()}\\nested`, access: 'write' },
    ]) })).toThrow('重叠');
  });
  it('still rejects a writable root under a differently cased protected configuration path', () => {
    expect(() => codexWorkspaceRoots({ cwd, mode: 'write', profile: profile([
      { path: `${cwd.toLowerCase()}\\.CODEX\\injected`, access: 'write' },
    ]) })).toThrow('保护');
  });
  it('accepts equivalent absolute echo paths with case and slash changes, spaces and Chinese', () => {
    expect(() => verifyCodexWorkspaceEcho(echo(), opts)).not.toThrow();
  });
  it('accepts equivalent read-only echoes without changing the requested network policy', () => {
    const raw = { ...echo(), sandbox: { type: 'readOnly', networkAccess: false } };
    expect(() => verifyCodexWorkspaceEcho(raw, { ...opts, mode: 'qa', network: false })).not.toThrow();
  });
  it('accepts equivalent full-access paths while retaining the full-access sandbox check', () => {
    const raw = { ...echo(), activePermissionProfile: null, sandbox: { type: 'dangerFullAccess' } };
    expect(() => verifyCodexWorkspaceEcho(raw, { ...opts, mode: 'full' })).not.toThrow();
    expect(() => verifyCodexWorkspaceEcho(echo(), { ...opts, mode: 'full' })).toThrow('s39a');
  });
  it.each(['extra-root', 'duplicate-alias', 'wrong-drive', 'drive-relative', 'read-root-writable', 'network-widened', 'wrong-profile', 'tmp-widened'])(
    'rejects non-equivalent or widened echoes: %s', scenario => {
      const raw = echo();
      if (scenario === 'extra-root') raw.runtimeWorkspaceRoots.push('C:\\unauthorized');
      if (scenario === 'duplicate-alias') raw.runtimeWorkspaceRoots[0] = cwd;
      if (scenario === 'wrong-drive') raw.cwd = cwd.replace('C:', 'E:');
      if (scenario === 'drive-relative') raw.cwd = 'C:Vonvon Tests\\权限工作区';
      if (scenario === 'read-root-writable') raw.sandbox.writableRoots.push(read);
      if (scenario === 'network-widened') raw.sandbox.networkAccess = false;
      if (scenario === 'wrong-profile') raw.activePermissionProfile.id = 'default';
      if (scenario === 'tmp-widened') raw.sandbox.excludeTmpdirEnvVar = false;
      expect(() => verifyCodexWorkspaceEcho(raw, opts)).toThrow('s39a');
    });
});
