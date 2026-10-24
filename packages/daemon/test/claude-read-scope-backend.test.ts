import { realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { linuxReadScope, realScope, ReadScopeError } from '../src/agent/claude-agent/read-scope';
import { log } from '../src/core/logger';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const dirs: string[] = [];
const nativePlatform = process.platform;
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(fs.readdir).mockReset(); Object.defineProperty(process, 'platform', { value: nativePlatform }); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function layout() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'vonvon-read-scope-'))); dirs.push(root);
  const cwd = join(root, 'projects/A/groups/g1');
  const g2 = join(root, 'projects/A/groups/g2');
  const bots = join(root, 'bots'); const library = join(root, 'library');
  await Promise.all([cwd, g2, bots, library, join(root, 'projects/B'), join(root, 'projects/A/private')].map(path => mkdir(path, { recursive: true })));
  return { root, cwd, g2, bots, library, scope: { deny: [join(root, 'projects'), bots, library], allow: [] } };
}
function fakeSdk() {
  const stop = new Error('query captured');
  const query = vi.fn<ClaudeSdkFacade['query']>(() => { throw stop; });
  const sdk: ClaudeSdkFacade = { query, listSessions: vi.fn(async () => []), getSessionInfo: vi.fn(async () => undefined), getSessionMessages: vi.fn(async () => []), renameSession: vi.fn(async () => undefined) };
  return { sdk, query, stop };
}

describe('Claude read scope preparation', () => {
  it('drops absent entries, preserves aliases and puts both workspace names first', async () => {
    const { root, cwd, bots } = await layout();
    const alias = join(root, 'alias'); await symlink(bots, alias);
    const cwdAlias = join(root, 'work'); await symlink(cwd, cwdAlias);
    expect(await realScope({ deny: [alias, join(root, 'missing')], allow: [join(root, 'absent')] }, cwdAlias, cwd)).toEqual({ deny: [alias, bots], allow: [cwdAlias, cwd] });
  });
  it('drops entries whose parent is a regular file', async () => {
    const { root, cwd } = await layout(); const file = join(root, 'file');
    await writeFile(file, 'x');
    expect(await realScope({ deny: [join(file, 'missing')], allow: [join(file, 'missing')] }, cwd, cwd)).toEqual({ deny: [], allow: [cwd] });
  });
  it('keeps dangling denies and removes dangling allows', async () => {
    const { root, cwd } = await layout(); const link = join(root, 'dangling');
    await symlink(join(root, 'missing'), link);
    expect(await realScope({ deny: [link], allow: [link] }, cwd, cwd)).toEqual({ deny: [link], allow: [cwd] });
  });
  it('rejects a workspace containing protected data', async () => {
    const { root, scope } = await layout();
    await expect(realScope(scope, root, root)).rejects.toThrow(ReadScopeError);
    await expect(realScope(scope, root, root)).rejects.toThrow('请主人在群详情页换一个工作区');
  });
  it('snapshots siblings at each level without descending into symlinks', async () => {
    const { root, cwd, g2, scope, bots, library } = await layout();
    const secret = join(root, 'secret'); await writeFile(secret, 'private');
    const link = join(root, 'projects/A/groups/alias'); await symlink(secret, link);
    const coarse = await realScope(scope, cwd, cwd);
    const linux = await linuxReadScope(coarse, cwd);
    expect(linux.deny).toEqual(expect.arrayContaining([g2, join(root, 'projects/B'), join(root, 'projects/A/private'), link, secret, bots, library]));
    for (const parent of [join(root, 'projects'), join(root, 'projects/A'), join(root, 'projects/A/groups'), cwd]) expect(linux.deny).not.toContain(parent);
    expect(coarse.deny).toContain(join(root, 'projects'));
    expect(linux.allow).toEqual([cwd]);
  });
  it('hides failed enumeration behind a Chinese error and logs the cause', async () => {
    const { cwd, scope } = await layout();
    const coarse = await realScope(scope, cwd, cwd);
    const error = Object.assign(new Error("EACCES: permission denied, scandir '/private/data'"), { code: 'EACCES' });
    vi.spyOn(fs, 'readdir').mockRejectedValueOnce(error);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    await expect(linuxReadScope(coarse, cwd)).rejects.toEqual(new ReadScopeError('没法读取数据目录里的群列表，只读、工作区可写档暂时不能启动。请主人检查数据目录的访问权限。'));
    expect(warn).toHaveBeenCalledWith('claude-read-scope', 'list-failed', { error });
  });
  it('omits sibling aliases to the workspace and ancestors but keeps other protected targets', async () => {
    const { root, cwd, scope, g2 } = await layout();
    const groups = join(root, 'projects/A/groups');
    const alias = join(groups, 'alias'), up = join(groups, 'up'), other = join(groups, 'other');
    await symlink(cwd, alias); await symlink(join(root, 'projects/A'), up); await symlink(g2, other);
    const linux = await linuxReadScope(await realScope(scope, cwd, cwd), cwd);
    expect(linux.deny).toEqual(expect.arrayContaining([other, g2]));
    expect(linux.deny).not.toContain(alias);
    expect(linux.deny).not.toContain(up);
    for (const path of [cwd, groups, join(root, 'projects/A'), join(root, 'projects')]) expect(linux.deny).not.toContain(path);
  });
  it.each(['subdirectory', 'root'] as const)('omits a sibling symlink to the workspace %s', async targetKind => {
    const { root, cwd, scope } = await layout();
    const sub = join(cwd, 'sub'); await mkdir(sub);
    const link = join(root, 'projects/A/groups/x');
    await symlink(targetKind === 'root' ? '/' : sub, link);
    const linux = await linuxReadScope(await realScope(scope, cwd, cwd), cwd);
    expect(linux.deny).not.toContain(link);
    expect(linux.deny).not.toContain(targetKind === 'root' ? '/' : sub);
  });
  it('rejects a level with 2001 entries and logs its count', async () => {
    const { root, cwd, scope } = await layout();
    await Promise.all(Array.from({ length: 1999 }, (_, i) => writeFile(join(root, 'projects', `entry-${i}`), '')));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    await expect(linuxReadScope(await realScope(scope, cwd, cwd), cwd)).rejects.toThrow('数据目录里的群太多');
    expect(warn).toHaveBeenCalledWith('claude-read-scope', 'too-many-entries', { count: 2001 });
  });
  it.each(['linux', 'darwin'])('passes %s scope to the SDK with the workspace first', async platform => {
    Object.defineProperty(process, 'platform', { value: platform });
    const { root, cwd, g2, scope, library } = await layout();
    const { sdk, query, stop } = fakeSdk();
    await expect(new ClaudeAgentBackend(async () => sdk).startThread({ cwd, mode: 'qa', readScope: { ...scope, deny: [...scope.deny, join(root, 'missing')] } })).rejects.toBe(stop);
    const filesystem = query.mock.calls[0]?.[0].options?.sandbox?.filesystem;
    expect(filesystem?.allowRead?.[0]).toBe(cwd);
    expect(filesystem?.denyRead).not.toContain(join(root, 'missing'));
    expect(filesystem?.denyRead).toContain(library);
    if (platform === 'linux') { expect(filesystem?.denyRead).not.toContain(join(root, 'projects')); expect(filesystem?.denyRead).toContain(g2); }
    else expect(filesystem?.denyRead).toContain(join(root, 'projects'));
  });
  it('does not add read restrictions in full access mode', async () => {
    const { cwd, scope } = await layout(); const { sdk, query, stop } = fakeSdk();
    await expect(new ClaudeAgentBackend(async () => sdk).startThread({ cwd, mode: 'full', readScope: scope })).rejects.toBe(stop);
    expect(query.mock.calls[0]?.[0].options?.sandbox?.filesystem?.denyRead).toBeUndefined();
    expect(query.mock.calls[0]?.[0].options?.sandbox?.filesystem?.allowRead).toBeUndefined();
  });
});
