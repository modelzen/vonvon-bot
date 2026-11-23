import type { AccountStatus } from '@vonvon/protocol';
import { accountAuth, AccountFault, accountOrigin, checkAuth, requestSignal, sessionTokens, verifyAccount,
  type AccountCredential, type AccountDeployment } from './account-auth.js';
import { nativeLogin } from './account-login.js';
import { fetchAccountAvatar } from './account-avatar.js';
import type { AccountStore } from './account-store.js';

type PublicIdentity = Awaited<ReturnType<typeof verifyAccount>>;
type Access = { token: string; expiresAt: number };
type Persistence = 'secure' | 'memory';
type Avatar = { accountId: string; url: string; dataUrl?: string; retryAt?: number };

const uuidSegment = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const publicDetail = new RegExp('^/v[12]/recipes/' + uuidSegment + '/versions/' + uuidSegment + '$');
const publicVersionObject = new RegExp('^/v2/versions/' + uuidSegment + '/(?:display-logo|objects/' + uuidSegment + ')$');
function apiUrl(path: string, origin: string, publicRead = false) {
  const pathname = path.split('?', 1)[0]!;
  if (!/^\/v[12]\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(pathname) || path.includes('#') || /[\r\n\t]/.test(path))
    throw new AccountFault('invalid');
  const url = new URL(path, origin);
  if (url.origin !== origin || url.pathname !== pathname || url.hash) throw new AccountFault('invalid');
  if (publicRead && !(/^\/v[12]\/community\/recipes$/.test(pathname) || !path.includes('?') && (publicDetail.test(pathname) || publicVersionObject.test(pathname))))
    throw new AccountFault('invalid');
  return url;
}

export interface NativeAccount {
  lease?(accountId: string): AbortSignal | undefined;
  status(): AccountStatus;
  onStatus(listener: (value: AccountStatus) => void): () => void;
  login(): Promise<AccountStatus>;
  cancelLogin(): Promise<AccountStatus>;
  logout(): Promise<AccountStatus>;
  recipeLink?(recipeId: string, versionId: string): string;
  publicRequest?(path: string): Promise<Response>;
  request(accountId: string, path: string, init?: RequestInit, beforeSend?: () => void): Promise<Response>;
  dispose(): Promise<void>;
}

export function createAccountSession(options: {
  deployment?: AccountDeployment; store: AccountStore; openBrowser(url: string): Promise<void>;
  transport?: typeof fetch; pollMs?: number;
}): NativeAccount {
  const { deployment, store } = options;
  const transport = options.transport ?? fetch;
  const listeners = new Set<(value: AccountStatus) => void>();
  let view: AccountStatus = deployment ? { kind: 'signingIn' } : { kind: 'unavailable', reason: 'configuration' };
  let owner = new AbortController();
  let leaseOwner = new AbortController();
  let disposed = false;
  let credential: AccountCredential | undefined;
  let access: Access | undefined;
  let refreshing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writes = Promise.resolve();
  let loginActive = false;
  let avatar: Avatar | undefined;

  function publish(next: AccountStatus) {
    if (view.kind==='signedIn' && (next.kind!=='signedIn' || next.accountId!==view.accountId)) {
      leaseOwner.abort(); leaseOwner=new AbortController();
    }
    view = next;
    for (const listener of listeners) {
      try { listener(next); } catch { /* A closed window cannot interrupt a credential change. */ }
    }
    return next;
  }
  function serialize<T>(action: () => Promise<T>) {
    const run = writes.then(action);
    writes = run.then(() => {}, () => {});
    return run;
  }
  function invalidate() {
    leaseOwner.abort(); leaseOwner=new AbortController();
    owner.abort();
    owner = new AbortController();
    clearTimeout(timer);
    credential = undefined;
    access = undefined;
    refreshing = undefined;
    loginActive = false;
    avatar = undefined;
    return owner.signal;
  }
  function schedule(signal: AbortSignal, ms: number) {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!signal.aborted) void refresh(signal); }, Math.min(2_147_483_647, Math.max(1000, ms)));
    timer.unref();
  }
  function ready(record: AccountCredential, verified: PublicIdentity, token: Access, persistence: Persistence, signal: AbortSignal) {
    credential = record;
    access = token;
    schedule(signal, token.expiresAt - Date.now() - 60_000);
    if (avatar?.accountId !== verified.accountId || avatar?.url !== verified.avatarUrl) avatar = undefined;
    publish({ kind: 'signedIn', ...verified, provider: record.provider, persistence,
      ...(avatar?.dataUrl ? { avatarDataUrl: avatar.dataUrl } : {}) });
    if (!verified.avatarUrl || (avatar && (avatar.retryAt === undefined || avatar.retryAt > Date.now()))) return;
    const current: Avatar = { accountId: verified.accountId, url: verified.avatarUrl };
    avatar = current;
    void fetchAccountAvatar(current.url, signal, transport).then(dataUrl => {
      if (signal.aborted || avatar !== current) return;
      if (!dataUrl) { current.retryAt = Date.now() + 60_000; return; }
      current.dataUrl = dataUrl;
      if (view.kind === 'signedIn' && view.accountId === current.accountId) publish({ ...view, avatarDataUrl: dataUrl });
    });
  }

  function refresh(signal: AbortSignal): Promise<void> {
    if (refreshing) return refreshing;
    const saved = credential;
    if (!deployment || !saved || signal.aborted) return Promise.resolve();
    const auth = accountAuth(saved, signal, transport);
    const run = (async () => {
      try {
        const response = await auth.refreshSession({ refresh_token: saved.refreshToken });
        signal.throwIfAborted();
        checkAuth(response.error);
        const tokens = sessionTokens(response.data.session);
        if (tokens.subject !== saved.subject) throw new AccountFault('invalid');
        const updated = { ...saved, refreshToken: tokens.refresh };
        // Rotation invalidates the old refresh token even if the account API is temporarily offline.
        const persistence = await serialize(async () => {
          signal.throwIfAborted();
          return store.save(updated);
        });
        signal.throwIfAborted();
        credential = updated;
        const identity = await verifyAccount(deployment, auth, tokens.access, saved.subject, saved.provider, signal, transport);
        signal.throwIfAborted();
        if (identity.accountId !== saved.accountId) throw new AccountFault('invalid');
        ready(updated, identity, { token: tokens.access, expiresAt: tokens.expiresAt }, persistence, signal);
      } catch (error) {
        if (signal.aborted) return;
        access = undefined;
        if (error instanceof AccountFault && error.reason === 'offline') {
          publish({ kind: 'unavailable', reason: 'offline' });
          schedule(signal, 30_000);
        } else {
          credential = undefined;
          try {
            await serialize(() => store.clear());
            if (!signal.aborted) publish({ kind: 'signedOut', reason: 'sessionExpired' });
          } catch { if (!signal.aborted) publish({ kind: 'unavailable', reason: 'storage' }); }
        }
      } finally { await auth.dispose(); }
    })();
    refreshing = run;
    void run.finally(() => { if (refreshing === run) refreshing = undefined; });
    return run;
  }

  const initial = owner.signal;
  const initialized = (async () => {
    if (!deployment) return;
    try {
      const record = await store.read();
      initial.throwIfAborted();
      if (!record) { publish({ kind: 'signedOut' }); return; }
      if (record.webOrigin !== deployment.webOrigin || record.apiOrigin !== deployment.apiOrigin ||
          accountOrigin(record.supabaseUrl, deployment.allowLoopback) !== record.supabaseUrl) {
        publish({ kind: 'unavailable', reason: 'configuration' });
        return;
      }
      credential = record;
      void refresh(initial);
    } catch { if (!initial.aborted) publish({ kind: 'unavailable', reason: 'storage' }); }
  })();

  async function clearLocal(reason?: 'cancelled') {
    const signal = invalidate();
    publish(deployment ? { kind: 'signedOut', ...(reason && { reason }) } : { kind: 'unavailable', reason: 'configuration' });
    try {
      await serialize(() => store.clear());
    } catch { if (!signal.aborted) publish({ kind: 'unavailable', reason: 'storage' }); }
    return view;
  }

  return {
    lease: accountId => !disposed && credential?.accountId === accountId && view.kind === 'signedIn' && view.accountId === accountId ? leaseOwner.signal : undefined,
    status: () => view,
    onStatus(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async login() {
      await initialized;
      if (!deployment || disposed || loginActive || view.kind === 'signedIn') return view;
      if (credential) {
        await refresh(owner.signal);
        return view;
      }
      const signal = invalidate();
      loginActive = true;
      publish({ kind: 'signingIn' });
      const start = async () => {
        await serialize(() => store.clear()).catch(() => { throw new AccountFault('storage'); });
        signal.throwIfAborted();
        await nativeLogin({
          deployment, signal, transport, pollMs: options.pollMs ?? 1000, openBrowser: options.openBrowser,
          async accept({ project, provider, tokens, auth, signal: attempt }) {
            const identity = await verifyAccount(deployment, auth, tokens.access, tokens.subject, provider, attempt, transport);
            const record: AccountCredential = { ...project, webOrigin: deployment.webOrigin, apiOrigin: deployment.apiOrigin,
              subject: tokens.subject, refreshToken: tokens.refresh, accountId: identity.accountId, provider };
            await serialize(async () => {
              attempt.throwIfAborted();
              const persistence = await store.save(record).catch(() => { throw new AccountFault('storage'); });
              if (attempt.aborted) { await store.clear(); attempt.throwIfAborted(); }
              ready(record, identity, { token: tokens.access, expiresAt: tokens.expiresAt }, persistence, signal);
              loginActive = false;
            });
          },
        });
      };
      void start().catch(error => {
        if (signal.aborted || credential) return;
        if (error instanceof AccountFault && (error.reason === 'offline' || error.reason === 'configuration' || error.reason === 'storage')) {
          publish({ kind: 'unavailable', reason: error.reason });
        } else {
          const reason = error instanceof AccountFault && (error.reason === 'expired' || error.reason === 'cancelled') ? error.reason : 'failed';
          publish({ kind: 'signedOut', reason });
        }
      }).finally(() => { if (!signal.aborted) loginActive = false; });
      return view;
    },
    async cancelLogin() { return view.kind === 'signingIn' && !disposed ? clearLocal('cancelled') : view; },
    async logout() { return disposed ? view : clearLocal(); },
    recipeLink(recipeId, versionId) {
      if (!deployment || !/^[0-9a-f-]{36}$/.test(recipeId) || !/^[0-9a-f-]{36}$/.test(versionId)) throw new AccountFault('invalid');
      return `${deployment.webOrigin}/recipes/${recipeId}/versions/${versionId}`;
    },
    async publicRequest(path) {
      if (!deployment || disposed) throw new AccountFault('invalid');
      const url = apiUrl(path, deployment.apiOrigin, true);
      return transport(url, {credentials: 'omit', redirect: 'error', cache: 'no-store', signal: requestSignal(owner.signal)});
    },
    async request(accountId, path, init = {}, beforeSend) {
      const signal = owner.signal;
      if (!deployment || disposed || !credential || credential.accountId !== accountId) throw new AccountFault('invalid');
      const url = apiUrl(path, deployment.apiOrigin);
      if (!access || access.expiresAt - Date.now() <= 30_000) await refresh(signal);
      signal.throwIfAborted();
      if (!access || view.kind !== 'signedIn' || view.accountId !== accountId) throw new AccountFault('invalid');
      const headers = new Headers(init.headers);
      headers.set('Authorization', 'Bearer ' + access.token);
      const signals = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
      beforeSend?.();
      const response = await transport(url, { ...init, headers, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: requestSignal(signals) });
      signal.throwIfAborted();
      return response;
    },
    async dispose() {
      if (!disposed) { disposed = true; invalidate(); listeners.clear(); }
      await writes;
    },
  };
}
