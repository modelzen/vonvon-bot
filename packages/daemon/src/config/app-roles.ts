import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { botPaths } from './paths';
import type { AppCredentials } from './schema';
import { log } from '../core/logger';

export const APP_ROLE_CACHE_MS = 10 * 60_000;
/** A refresh that failed is tried again this much later, so one failure still leaves a second try within the trust window. */
export const APP_ROLE_RETRY_MS = APP_ROLE_CACHE_MS / 2;
/**
 * How long a successful refresh vouches for the administrators Feishu named: two refresh intervals (audit 252-4). Past it,
 * with every refresh since failing, they are no longer taken as administrators; the owner, the scanner and this machine's
 * own list stay as they are.
 */
export const APP_ROLE_TRUST_MS = 2 * APP_ROLE_CACHE_MS;
const snapshotSchema = z.object({
  appId: z.string().min(1), tenant: z.enum(['feishu', 'lark']),
  fetchedAt: z.number().finite().nonnegative(), ownerOpenId: z.string().min(1).optional(), ownerName: z.string().optional(),
  admins: z.array(z.string().min(1)),
});
export type AppRoleSnapshot = z.infer<typeof snapshotSchema>;
const fileFor = (appId: string): string => join(botPaths(appId).dir, 'app-roles.json');

// Both the host settings service and the bot worker read the same atomic snapshot.
export function getAppRoleSnapshot(appId: string, tenant?: AppCredentials['tenant']): AppRoleSnapshot | undefined {
  try {
    const value = snapshotSchema.parse(JSON.parse(readFileSync(fileFor(appId), 'utf8')));
    return value.appId === appId && (!tenant || value.tenant === tenant) ? value : undefined;
  } catch { return undefined; }
}

/**
 * The administrators and developers Feishu named, while the refresh that read them is recent enough to vouch for them (a
 * snapshot read at start-up included). Its age counts both ways: a clock set back makes it look from the future.
 */
export function trustedFeishuAdmins(snapshot: AppRoleSnapshot | undefined, now = Date.now()): readonly string[] {
  if (!snapshot) return [];
  const age = now - snapshot.fetchedAt;
  return age < APP_ROLE_TRUST_MS && age > -APP_ROLE_TRUST_MS ? snapshot.admins : [];
}

const tokenSchema = z.object({ code: z.literal(0), tenant_access_token: z.string().min(1) });
const infoSchema = z.object({ code: z.literal(0), data: z.object({ app: z.object({
  owner: z.object({ owner_id: z.string().min(1), type: z.number(), name: z.string().nullish() }),
}) }) });
const collaboratorsSchema = z.object({ code: z.literal(0), data: z.object({
  collaborators: z.array(z.object({ type: z.enum(['administrator', 'developer', 'operator', 'owner']), user_id: z.string().min(1) })),
}) });

export async function fetchAppRoles(app: AppCredentials, secret: string, signal: AbortSignal): Promise<Omit<AppRoleSnapshot, 'fetchedAt'>> {
  const base = app.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const request = async (path: string, init: RequestInit): Promise<unknown> => {
    const response = await fetch(`${base}/open-apis/${path}`, { ...init, signal });
    if (!response.ok) throw new Error('Application roles request failed');
    return response.json();
  };
  const token = tokenSchema.parse(await request('auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: app.id, app_secret: secret }),
  }));
  const headers = { Authorization: `Bearer ${token.tenant_access_token}` };
  const [info, collaborators] = await Promise.all([
    request(`application/v6/applications/${app.id}?user_id_type=open_id&lang=zh_cn`, { headers }).then(value => infoSchema.parse(value)),
    request(`application/v6/applications/${app.id}/collaborators?user_id_type=open_id`, { headers }).then(value => collaboratorsSchema.parse(value)),
  ]);
  const owner = info.data.app.owner;
  return { appId: app.id, tenant: app.tenant,
    ...(owner.type === 2 ? { ownerOpenId: owner.owner_id, ...(owner.name?.trim() ? { ownerName: owner.name.trim() } : {}) } : {}),
    admins: [...new Set(collaborators.data.collaborators.filter(person => person.type === 'administrator' || person.type === 'developer').map(person => person.user_id))],
  };
}

/**
 * One refresh at a time; failures keep the previous result on disk, which {@link trustedFeishuAdmins} stops vouching for
 * once it is {@link APP_ROLE_TRUST_MS} old.
 */
export function createAppRoleRefresher(app: AppCredentials, secret: string,
  read = fetchAppRoles,
): { refresh: () => Promise<void>; stop: () => Promise<void> } {
  let pending: Promise<void> | undefined;
  let stopped = false;
  let lastAttempt = 0;
  const abort = new AbortController();
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    const now = Date.now();
    const cached = getAppRoleSnapshot(app.id, app.tenant);
    if ((cached && now >= cached.fetchedAt && now - cached.fetchedAt < APP_ROLE_CACHE_MS)
      || (lastAttempt && now - lastAttempt < APP_ROLE_RETRY_MS)) return Promise.resolve();
    lastAttempt = now;
    pending = (async () => {
      try {
        const result = await read(app, secret, AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]));
        if (stopped) return;
        const snapshot = snapshotSchema.parse({ ...result, fetchedAt: Date.now() });
        const dir = botPaths(app.id).dir;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const temporary = join(dir, `.app-roles-${randomUUID()}.tmp`);
        writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, fileFor(app.id));
      } catch {
        if (!stopped) log.warn('app-roles', 'refresh-failed', { appId: app.id });
      } finally { pending = undefined; }
    })();
    return pending;
  };
  return { refresh, stop: async () => { stopped = true; abort.abort(); await pending; } };
}
