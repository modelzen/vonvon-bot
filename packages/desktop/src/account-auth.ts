import { AuthClient, type AuthError, type Session } from '@supabase/auth-js';
import { accountAvatarUrlSchema, accountProviderSchema, type AccountProvider } from '@vonvon/protocol';
import { z } from 'zod';

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
  const { accountId } = z.object({ accountId: z.string().uuid() }).parse(await proof.json());
  const metadata = user.user_metadata ?? {};
  const displayName = [metadata.full_name, metadata.name, metadata.user_name]
    .filter((name): name is string => typeof name === 'string')
    .map(name => name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 80))
    .find(name => name && !name.includes('@')) || 'Vonvon 用户';
  const picture = metadata.avatar_url ?? metadata.picture;
  let avatarUrl: string | undefined;
  if (typeof picture === 'string' && picture.length <= 2048 && URL.canParse(picture)) {
    const url = new URL(picture);
    url.search = ''; url.hash = '';
    const avatar = accountAvatarUrlSchema.safeParse(url.href);
    if (avatar.success) avatarUrl = avatar.data;
  }
  return { accountId, displayName, ...(avatarUrl ? { avatarUrl } : {}) };
}

export function sessionTokens(session: Session | null) {
  const fields = z.object({
    access_token: z.string().min(1).max(16_384), refresh_token: z.string().min(1).max(8192),
    expires_at: z.number().int().positive(), user: z.object({ id: z.string().uuid() }),
  }).parse(session);
  return { access: fields.access_token, refresh: fields.refresh_token, expiresAt: fields.expires_at * 1000, subject: fields.user.id };
}
