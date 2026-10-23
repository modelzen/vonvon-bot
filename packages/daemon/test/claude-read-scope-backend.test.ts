import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { linuxReadScope, realScope, ReadScopeError } from '../src/agent/claude-agent/read-scope';
import { log } from '../src/core/logger';

const dirs: string[] = [];
const nativePlatform = process.platform;
afterEach(async () => { vi.restoreAllMocks(); Object.defineProperty(process, 'platform', { value: nativePlatform }); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-read-scope-')); dirs.push(root);
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
