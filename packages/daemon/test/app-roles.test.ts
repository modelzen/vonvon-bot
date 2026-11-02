import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_ROLE_CACHE_MS, APP_ROLE_RETRY_MS, APP_ROLE_TRUST_MS, createAppRoleRefresher, fetchAppRoles, getAppRoleSnapshot, trustedFeishuAdmins } from '../src/config/app-roles';
import { botPaths } from '../src/config/paths';
import { isAdmin, resolveOwner, type AppConfig } from '../src/config/schema';
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'app-roles-'));
  return { botPaths: (id: string) => ({ dir: join(root, id) }), paths: { appDir: root } };
});
const app = { id: 'cli_roles', secret: 'fixture', tenant: 'feishu' as const };
const cfg: AppConfig = { accounts: { app }, preferences: { access: { ownerOpenId: 'ou_scanner', admins: ['ou_local'] } } };
const result = { appId: app.id, tenant: app.tenant, ownerOpenId: 'ou_owner', admins: ['ou_developer', 'ou_admin'] };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function save(value: unknown): Promise<void> {
  await mkdir(botPaths(app.id).dir, { recursive: true });
  await writeFile(join(botPaths(app.id).dir, 'app-roles.json'), JSON.stringify(value));
}
describe('application roles', () => {
  it('keeps scanner and local admins, gains Feishu owner and developers, revokes removed members after a refresh', async () => {
    await save({ ...result, fetchedAt: 0 });
    const read = vi.fn(async () => result);
    const service = createAppRoleRefresher(app, 'fixture', read);
    await Promise.all([service.refresh(), service.refresh()]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(resolveOwner(cfg)).toBe('ou_owner');
    for (const id of ['ou_owner', 'ou_scanner', 'ou_local', 'ou_developer', 'ou_admin']) expect(isAdmin(cfg, id)).toBe(true);
    expect(isAdmin(cfg, 'ou_operator')).toBe(false);
    await service.stop();
    // A newly constructed service consumes persisted state without requesting again.
    const restarted = createAppRoleRefresher(app, 'fixture', read);
    await restarted.refresh(); expect(read).toHaveBeenCalledTimes(1);
    await restarted.stop();
    await save({ ...result, fetchedAt: Date.now() - APP_ROLE_CACHE_MS });
    const next = createAppRoleRefresher(app, 'fixture', async () => ({ ...result, admins: [] }));
    await next.refresh();
    expect(isAdmin(cfg, 'ou_developer')).toBe(false);
    expect(isAdmin(cfg, 'ou_scanner')).toBe(true);
    await next.stop();
  });
  it('retains last good result on denied permission and throttles retry; no prior result falls back to local identities', async () => {
    await save({ ...result, fetchedAt: Date.now() - APP_ROLE_CACHE_MS - 1 });
    const read = vi.fn(async () => { throw new Error('denied'); });
    const service = createAppRoleRefresher(app, 'fixture', read);
    await service.refresh(); await service.refresh();
    expect(read).toHaveBeenCalledTimes(1); expect(isAdmin(cfg, 'ou_developer')).toBe(true);
    await service.stop();
    await save({ broken: true });
    expect(getAppRoleSnapshot(app.id)).toBeUndefined();
    expect(resolveOwner(cfg)).toBe('ou_scanner'); expect(isAdmin(cfg, 'ou_local')).toBe(true);
    expect(isAdmin(cfg, 'ou_developer')).toBe(false);
  });
  // audit 252-4: the last good result vouches for Feishu's administrators for two refresh intervals, not forever. main 必败
  it('stops taking Feishu\'s administrators once no refresh has succeeded for two intervals, keeping the owner, the scanner and local admins', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
    const start = Date.now();
    let fail = false;
    const read = vi.fn(async () => { if (fail) throw new Error('unavailable'); return result; });
    await save({ broken: true });
    const service = createAppRoleRefresher(app, 'fixture', read);
    await service.refresh();
    expect(isAdmin(cfg, 'ou_developer')).toBe(true);
    // Feishu goes away for good: the developer was removed there, and no refresh gets through to say so
    fail = true;
    for (const minutes of [10, 15]) {
      vi.setSystemTime(start + minutes * 60_000);
      await service.refresh();
      expect(isAdmin(cfg, 'ou_developer'), `${minutes} minutes`).toBe(true);
    }
    expect(read).toHaveBeenCalledTimes(3);
    vi.setSystemTime(start + APP_ROLE_TRUST_MS - 1);
    expect(isAdmin(cfg, 'ou_developer')).toBe(true);
    vi.setSystemTime(start + APP_ROLE_TRUST_MS);
    await service.refresh();
    for (const id of ['ou_developer', 'ou_admin']) expect(isAdmin(cfg, id)).toBe(false);
    for (const id of ['ou_owner', 'ou_scanner', 'ou_local']) expect(isAdmin(cfg, id)).toBe(true);
    expect(resolveOwner(cfg)).toBe('ou_owner');
    vi.setSystemTime(start + 24 * 60 * 60_000);
    expect(isAdmin(cfg, 'ou_developer')).toBe(false);
    await service.stop();
    // a daemon started on the old snapshot reads it by its age too, before and without a refresh
    const restarted = createAppRoleRefresher(app, 'fixture', read);
    expect(isAdmin(cfg, 'ou_admin')).toBe(false);
    // the first refresh that gets through vouches again
    fail = false;
    await restarted.refresh();
    expect(isAdmin(cfg, 'ou_admin')).toBe(true);
    await restarted.stop();
  });
  it('trusts a snapshot by its age either way, so a clock set back does not stretch it', () => {
    const now = Date.parse('2026-11-02T00:00:00Z');
    const snapshot = { ...result, fetchedAt: now };
    expect(trustedFeishuAdmins(snapshot, now + APP_ROLE_TRUST_MS - 1)).toEqual(result.admins);
    expect(trustedFeishuAdmins(snapshot, now + APP_ROLE_TRUST_MS)).toEqual([]);
    expect(trustedFeishuAdmins(snapshot, now - 60_000)).toEqual(result.admins);
    expect(trustedFeishuAdmins(snapshot, now - APP_ROLE_TRUST_MS)).toEqual([]);
    expect(trustedFeishuAdmins(undefined, now)).toEqual([]);
    // one failed refresh is retried within the window, so a single failure never drops anyone
    expect(APP_ROLE_CACHE_MS + APP_ROLE_RETRY_MS).toBeLessThan(APP_ROLE_TRUST_MS);
  });
  it('aborts outstanding requests and never publishes their late result after stop', async () => {
    await save({ broken: true });
    let signal: AbortSignal | undefined;
    let finish: ((value: typeof result) => void) | undefined;
    const service = createAppRoleRefresher(app, 'fixture', async (_app, _secret, value) => {
      signal = value;
      return new Promise<typeof result>(resolve => { finish = resolve; });
    });
    const pending = service.refresh(); const stopping = service.stop();
    expect(signal?.aborted).toBe(true); finish?.(result);
    await Promise.all([pending, stopping]); expect(getAppRoleSnapshot(app.id)).toBeUndefined();
  });
  it('parses both complete Feishu responses, requests open ids and filters operators', async () => {
    const request = vi.fn(async (url: string) => Response.json(url.includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 'fixture-token' }
      : url.includes('collaborators') ? { code: 0, data: { collaborators: [
        { type: 'developer', user_id: 'ou_dev' }, { type: 'administrator', user_id: 'ou_admin' }, { type: 'operator', user_id: 'ou_operator' }, { type: 'owner', user_id: 'ou_owner' },
      ] } } : { code: 0, data: { app: { owner: { owner_id: 'ou_owner', type: 2 } } } }));
    vi.stubGlobal('fetch', request);
    expect(await fetchAppRoles(app, 'fixture', new AbortController().signal)).toEqual({ ...result, admins: ['ou_dev', 'ou_admin'] });
    expect(request.mock.calls.filter(([url]) => url.includes('user_id_type=open_id'))).toHaveLength(2);
    expect(request.mock.calls.map(([url]) => url)).toContain(`https://open.feishu.cn/open-apis/application/v6/applications/${app.id}?user_id_type=open_id&lang=zh_cn`);
    expect(request.mock.calls.map(([url]) => url)).toContain(`https://open.feishu.cn/open-apis/application/v6/applications/${app.id}/collaborators?user_id_type=open_id`);
  });
});
