import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { accountProviderSchema, type AccountProvider } from '@vonvon/protocol';
import { AccountFault, accountAuth, accountOrigin, checkAuth, checkResponse, projectSchema, requestSignal,
  sessionTokens, type AccountDeployment, type AccountProject } from './account-auth.js';

const nonce = z.string().regex(/^[\w-]{43}$/).refine(value => Buffer.from(value, 'base64url').toString('base64url') === value);
const flowSchema = projectSchema.extend({
  flowId: nonce, pollToken: nonce, launchUrl: z.string().max(4096), expiresAt: z.number().int(),
}).strict();
const pollSchema = z.object({
  state: nonce, expiresAt: z.number().int(),
  status: z.enum(['waiting', 'provider', 'code', 'completed', 'cancelled', 'expired', 'failed']),
  provider: accountProviderSchema.optional(), code: z.string().min(1).max(2048).optional(),
}).strict();

export interface LoginResult {
  project: AccountProject;
  provider: AccountProvider;
  tokens: ReturnType<typeof sessionTokens>;
  auth: ReturnType<typeof accountAuth>;
  signal: AbortSignal;
}

export async function nativeLogin(options: {
  deployment: AccountDeployment; signal: AbortSignal; openBrowser(url: string): Promise<void>;
  transport: typeof fetch; pollMs: number;
  accept(result: LoginResult): Promise<void>;
}): Promise<void> {
  const { deployment, signal, transport, pollMs } = options;
  const base = deployment.webOrigin + '/auth/native/flows';
  const state = randomBytes(32).toString('base64url');
  const deadline = Date.now() + 300_000;
  async function request(url: string, method: string, token?: string, body?: object, active = signal): Promise<unknown> {
    active.throwIfAborted();
    const response = await transport(url, {
      method, signal: requestSignal(active), redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Accept: 'application/json', ...(token && { Authorization: 'Bearer ' + token }),
        ...(body && { 'Content-Type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }),
    }).catch(() => { throw new AccountFault('offline'); });
    if (response.status === 410 || response.status === 404) throw new AccountFault('expired');
    if (response.status === 503 && url === base) {
      const failure = await response.json().catch(() => null);
      if (failure?.error?.code === 'native_login_unavailable') throw new AccountFault('configuration');
    }
    checkResponse(response);
    return response.json();
  }
  const flow = flowSchema.parse(await request(base, 'POST', undefined, { state }));
  const url = base + '/' + flow.flowId;
  const supabaseUrl = accountOrigin(flow.supabaseUrl, deployment.allowLoopback);
  const launch = new URL(flow.launchUrl);
  const ticket = /^#ticket=([\w-]{43})$/.exec(launch.hash)?.[1];
  if (!supabaseUrl || !nonce.safeParse(ticket).success ||
      launch.href !== deployment.webOrigin + '/auth/native' + launch.hash) throw new AccountFault('invalid');
  const expiresAt = Math.min(flow.expiresAt, deadline);
  // The deadline also bounds exchange, verification and acknowledgement, even across a suspended machine.
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) throw new AccountFault('expired');
  const attempt = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
  function checkActive(): void {
    signal.throwIfAborted();
    if (attempt.aborted || Date.now() >= expiresAt) throw new AccountFault('expired');
  }
  async function retry(method: string, suffix = '', body?: object): Promise<unknown> {
    for (;;) {
      checkActive();
      try { return await request(url + suffix, method, flow.pollToken, body, attempt); }
      catch (error) {
        if (!(error instanceof AccountFault && error.reason === 'offline')) throw error;
        await delay(pollMs, undefined, { signal: attempt });
      }
    }
  }

  const project = { supabaseUrl, publishableKey: flow.publishableKey };
  const auth = accountAuth(project, attempt, transport);
  let selected: { provider: AccountProvider; url: string; flowId: string | null } | undefined;
  let accepted = false;
  try {
    checkActive();
    await options.openBrowser(launch.href);
    for (;;) {
      const poll = pollSchema.parse(await retry('GET'));
      checkActive();
      if (poll.state !== state || poll.expiresAt !== flow.expiresAt) throw new AccountFault('invalid');
      if (poll.status === 'expired' || poll.status === 'cancelled') throw new AccountFault(poll.status);
      if (poll.status === 'failed' || poll.status === 'completed') throw new AccountFault('invalid');
      if (poll.status === 'provider') {
        if (!poll.provider || (selected && selected.provider !== poll.provider)) throw new AccountFault('invalid');
        if (!selected) {
          const { data, error } = await auth.signInWithOAuth({
            provider: poll.provider, options: {
              redirectTo: deployment.webOrigin + '/auth/native/callback', skipBrowserRedirect: true,
              ...(['github', 'google'].includes(poll.provider) && { queryParams: { prompt: 'select_account' } }),
            },
          });
          checkAuth(error);
          if (!data.url) throw new AccountFault('invalid');
          selected = { provider: poll.provider, url: data.url, flowId: data.flowId ?? null };
          await retry('PUT', '/authorize', { url: selected.url });
        }
      }
      if (poll.status === 'code') {
        if (!selected || !poll.code || (poll.provider !== undefined && poll.provider !== selected.provider)) throw new AccountFault('invalid');
        const exchange = await auth.exchangeCodeForSession(poll.code, selected.flowId ? { flowId: selected.flowId } : undefined);
        checkActive();
        if (exchange.error) throw new AccountFault('invalid');
        await options.accept({ project, provider: selected.provider, tokens: sessionTokens(exchange.data.session), auth, signal: attempt });
        accepted = true;
        await retry('POST', '/ack', {});
        return;
      }
      await delay(pollMs, undefined, { signal: attempt });
    }
  } catch (error) {
    if (attempt.aborted && !signal.aborted) throw new AccountFault('expired');
    throw error;
  } finally {
    if (!accepted) {
      // Cancel also works after the owning generation's signal has aborted.
      void request(url, 'DELETE', flow.pollToken, undefined, AbortSignal.timeout(3000)).catch(() => {});
    }
    await auth.dispose();
  }
}
