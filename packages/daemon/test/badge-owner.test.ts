import { mkdir, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { createBadgeOwnerNames } from '../src/admin/badge-owner';
import { botPaths } from '../src/config/paths';
import type { GroupMembers } from '../src/admin/groups';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'badge-owner-'));
  return { botPaths: (id: string) => ({ dir: join(root, id), projectsFile: join(root, id, 'projects.json') }) };
});

it('reads the confirmed owner across pages in the background, preserving only that identity across restarts', async () => {
  const appId = 'cli_test';
  const roles = { appId, tenant: 'feishu' as const, admins: ['ou_admin'], ownerOpenId: 'ou_owner', fetchedAt: 10 };
  const paths = botPaths(appId);
  await mkdir(paths.dir);
  await writeFile(paths.projectsFile, JSON.stringify({ projects: [{ chatId: 'oc_one', name: 'one', cwd: '/tmp' }] }));
  let finish!: (value: GroupMembers) => void;
  const delayed = new Promise<GroupMembers>(resolve => { finish = resolve; });
  const read = vi.fn(async (_bot: string, _chat: string, cursor?: string) => cursor ? delayed : { members: [{ openId: 'ou_admin', name: '管理员' }], nextCursor: 'two' });
  const cache = createBadgeOwnerNames(read);
  expect(cache.get(appId, roles, true)).toBeUndefined();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(cache.get(appId, roles, true)).toBeUndefined();
  finish({ members: [{ openId: 'ou_owner', name: '项目负责人' }] });
  await vi.waitFor(() => expect(cache.get(appId, roles, true)).toBe('项目负责人'));
  const restarted = createBadgeOwnerNames(read);
  expect(restarted.get(appId, roles, false)).toBe('项目负责人');
  expect(restarted.get(appId, { ...roles, ownerOpenId: 'ou_new' }, false)).toBeUndefined();
  expect(read).toHaveBeenCalledTimes(2);
});
