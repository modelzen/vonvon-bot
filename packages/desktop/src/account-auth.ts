import { AuthClient, type AuthError, type Session } from '@supabase/auth-js';
import { accountAvatarUrlSchema, accountProfileSchema, accountProviderSchema, publicDisplayNameSchema, type AccountProvider } from '@vonvon/protocol';
import { z } from 'zod';
import {boundedJson, ResponseBodyReadError} from './community-response.js';

export interface AccountDeployment {
  webOrigin: string;
  apiOrigin: string;
  allowLoopback: boolean;
}

export function accountOrigin(value: string | undefined, allowLoopback: boolean): string | undefined {
  if (!value || !URL.canParse(value)) return;
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (value !== url.origin && value !== url.origin + '/') return;
  if (url.protocol === 'https:' || (allowLoopback && loopback && url.protocol === 'http:')) return url.origin;
}

export function accountDeployment(web: string | undefined, api: string | undefined, allowLoopback: boolean): AccountDeployment | undefined {
  const webOrigin = accountOrigin(web, allowLoopback);
  const apiOrigin = accountOrigin(api, allowLoopback);
  if (webOrigin && apiOrigin) return { webOrigin, apiOrigin, allowLoopback };
}

export const projectSchema = z.object({
  supabaseUrl: z.string().max(2048),
  publishableKey: z.string().max(512).regex(/^sb_publishable_[A-Za-z0-9_-]+$/),
});
export type AccountProject = z.infer<typeof projectSchema>;
export const credentialSchema = projectSchema.extend({
  webOrigin: z.string(), apiOrigin: z.string(),
  subject: z.string().uuid(), accountId: z.string().uuid(), provider: accountProviderSchema,
  refreshToken: z.string().min(1).max(8192),
}).strict();
export type AccountCredential = z.infer<typeof credentialSchema>;

export class AccountFault extends Error {
  constructor(readonly reason: 'offline' | 'invalid' | 'expired' | 'cancelled' | 'configuration' | 'storage') { super(reason); }
}

export function requestSignal(signal: AbortSignal, timeout = 9000): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
}

export function checkResponse(response: Response): void {
  if (response.ok) return;
  if (response.status === 429 || response.status >= 500) throw new AccountFault('offline');
  throw new AccountFault('invalid');
}

async function accountJson(response: Response): Promise<unknown> {
  try {return await boundedJson(response, 400_000);}
  catch (error) {throw new AccountFault(error instanceof ResponseBodyReadError ? 'offline' : 'invalid');}
}

export function accountAuth(project: AccountProject, signal: AbortSignal, transport: typeof fetch) {
  return new AuthClient({
    url: project.supabaseUrl + '/auth/v1',
    headers: { apikey: project.publishableKey },
    flowType: 'pkce', persistSession: false, detectSessionInUrl: false, autoRefreshToken: false, skipAutoInitialize: true,
    fetch: (url, options) => {
      // The SDK retries refreshes on transport failures. A cancelled owner has no more work to retry.
      if (signal.aborted) return Promise.resolve(Response.json({ error: 'cancelled' }, { status: 400 }));
      return transport(url, { ...options, signal: requestSignal(signal), redirect: 'error', credentials: 'omit', cache: 'no-store' });
    },
  });
}

export function checkAuth(error: AuthError | null): void {
  if (error) {
    const status = error.status;
    throw new AccountFault(status === undefined || status === 0 || status >= 500 || status === 429 ? 'offline' : 'invalid');
  }
}

export async function verifyAccount(deployment: AccountDeployment, auth: ReturnType<typeof accountAuth>, token: string, subject: string,
  provider: AccountProvider, signal: AbortSignal, transport: typeof fetch) {
  const result = await auth.getUser(token);
  checkAuth(result.error);
  const user = result.data.user;
  if (!user || user.is_anonymous || !z.string().uuid().safeParse(user.id).success || user.id !== subject ||
      !user.identities?.some(identity => identity.provider === provider && identity.user_id === user.id)) throw new AccountFault('invalid');
  const proof = await transport(deployment.apiOrigin + '/v1/me', {
    headers: { Authorization: 'Bearer ' + token }, signal: requestSignal(signal), redirect: 'error', credentials: 'omit', cache: 'no-store',
  }).catch(() => { throw new AccountFault('offline'); });
  checkResponse(proof);
  const { accountId } = z.object({ accountId: z.string().uuid() }).parse(await accountJson(proof));
  const metadata = user.user_metadata ?? {};
  const displayName = [metadata.full_name, metadata.name, metadata.user_name]
    .filter((name): name is string => typeof name === 'string')
    .map(name => Array.from(name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()).slice(0, 80).join(''))
    .find(name => name && !name.includes('@')) || 'Vonvon 用户';
  const picture = metadata.avatar_url ?? metadata.picture;
  let avatarUrl: string | undefined;
  if (typeof picture === 'string' && picture.length <= 2048 && URL.canParse(picture)) {
    const avatar = accountAvatarUrlSchema.safeParse(picture);
    if (avatar.success) avatarUrl = avatar.data;
  }
  const fallback = {accountId, displayName, ...(avatarUrl ? {avatarUrl} : {})};
  async function requestProfile(body?: {displayName: string}) {
    signal.throwIfAborted();
    return transport(deployment.apiOrigin + '/v2/me/account-profile' + (body ? '/initialize' : ''), {
      method: body ? 'POST' : 'GET',
      headers: {Authorization: 'Bearer ' + token, ...(body && {'Content-Type': 'application/json'})},
      ...(body && {body: JSON.stringify(body)}),
      signal: requestSignal(signal), redirect: 'error', credentials: 'omit', cache: 'no-store',
    }).catch(() => {throw new AccountFault('offline');});
  }
  async function readProfile(response: Response) {
    checkResponse(response);
    const parsed = accountProfileSchema.safeParse(await accountJson(response));
    if (!parsed.success || parsed.data.authorId !== accountId) throw new AccountFault('invalid');
    return parsed.data;
  }
  const unavailable = (response: Response) => response.status === 404 || response.status === 405;
  const profileResponse = await requestProfile();
  if (unavailable(profileResponse)) return fallback;
  let profile = await readProfile(profileResponse);
  if (profile.revision === 0) {
    const name = publicDisplayNameSchema.safeParse(Array.from(displayName).slice(0, 60).join(''));
    const initialized = await requestProfile({displayName: name.success ? name.data : 'Vonvon 用户'});
    if (unavailable(initialized)) throw new AccountFault('offline');
    profile = await readProfile(initialized);
    if (profile.revision === 0) throw new AccountFault('offline');
  }
  signal.throwIfAborted();
  return {accountId, displayName: profile.displayName, ...(avatarUrl ? {avatarUrl} : {}),
    ...(profile.avatarDataUrl && {avatarDataUrl: profile.avatarDataUrl}),
    ...(profile.revision !== undefined && {profileRevision: profile.revision})};
}

export function sessionTokens(session: Session | null) {
  const fields = z.object({
    access_token: z.string().min(1).max(16_384), refresh_token: z.string().min(1).max(8192),
    expires_at: z.number().int().positive(), user: z.object({ id: z.string().uuid() }),
  }).parse(session);
  return { access: fields.access_token, refresh: fields.refresh_token, expiresAt: fields.expires_at * 1000, subject: fields.user.id };
}
