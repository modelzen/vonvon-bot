import {accountProfileSchema, type AccountProfile, type AccountStatus} from '@vonvon/protocol';
import { accountAuth, AccountFault, accountOrigin, checkAuth, requestSignal, sessionTokens, verifyAccount,
  type AccountCredential, type AccountDeployment, checkResponse } from './account-auth.js';
import {boundedJson} from './community-response.js';
import { nativeLogin } from './account-login.js';
import { fetchAccountAvatar } from './account-avatar.js';
import type { AccountStore } from './account-store.js';

type PublicIdentity = Pick<Extract<AccountStatus, {kind: 'signedIn'}>, 'accountId' | 'displayName' | 'avatarUrl' | 'avatarDataUrl' | 'profileRevision'>;
type Access = { token: string; expiresAt: number };
type Persistence = 'secure' | 'memory';
type Avatar = {
  accountId: string; url: string; dataUrl?: string; retryAt?: number;
  attempts: number; loading: boolean; controller: AbortController;
};
const avatarRetryDelays = [5000, 30_000] as const;
const avatarAttemptLimit = avatarRetryDelays.length + 1;

const uuidSegment = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const publicDetail = new RegExp('^/v[12]/recipes/' + uuidSegment + '/versions/' + uuidSegment + '(?:/preview)?$');
const publicBrowse = new RegExp('^/v2/recipes/' + uuidSegment + '/versions/' + uuidSegment + '/preview$');
const publicVersionObject = new RegExp('^/v2/versions/' + uuidSegment + '/display-logo$');
const publicAuthor = new RegExp('^/v2/authors/' + uuidSegment + '/recipes$', 'i');
const authorCursor = new RegExp('^' + uuidSegment + '$', 'i');
const privateObjectMember = new RegExp('^/v2/objects/' + uuidSegment + '/members/(?:[0-9]|[1-5][0-9]|6[0-5])$');
function apiUrl(path: string, origin: string, publicRead = false) {
  const pathname = path.split('?', 1)[0]!;
  if (!/^\/v[12]\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(pathname) || path.includes('#') || /[\r\n\t]/.test(path))
    throw new AccountFault('invalid');
  const url = new URL(path, origin);
  if (url.origin !== origin || url.pathname !== pathname || url.hash) throw new AccountFault('invalid');
  const authorRead = publicAuthor.test(pathname) && [...url.searchParams.keys()].every(key => key === 'cursor') &&
    url.searchParams.getAll('cursor').length <= 1 && (!url.searchParams.has('cursor') || authorCursor.test(url.searchParams.get('cursor')!));
  if (publicRead && !(/^\/v[12]\/community\/recipes$/.test(pathname) || authorRead || !path.includes('?') && (publicDetail.test(pathname) || publicVersionObject.test(pathname))))
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
  manage?(): Promise<void>;
  refresh?(): Promise<AccountStatus>;
  applyProfile?(accountId: string, profile: AccountProfile): void;
  recipeLink?(recipeId: string, versionId: string): string;
  publicRequest?(path: string): Promise<Response>;
  request(accountId: string, path: string, init?: RequestInit, beforeSend?: () => void | Promise<void>): Promise<Response>;
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
  let avatarTimer: ReturnType<typeof setTimeout> | undefined;
  let profileIdentity: PublicIdentity | undefined;
  let profileRefreshing: Promise<AccountStatus> | undefined;

  function publish(next: AccountStatus) {
    if (next.kind !== 'signedIn') clearAvatarTimer();
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
  function clearAvatarTimer() {
    clearTimeout(avatarTimer);
    avatarTimer = undefined;
  }
  function discardAvatar() {
    clearAvatarTimer();
    avatar?.controller.abort();
    avatar = undefined;
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
    discardAvatar();
    profileIdentity = undefined;
    profileRefreshing = undefined;
    return owner.signal;
  }
  function schedule(signal: AbortSignal, ms: number) {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!signal.aborted) void refresh(signal); }, Math.min(2_147_483_647, Math.max(1000, ms)));
    timer.unref();
  }
  function currentAvatar(current: Avatar, signal: AbortSignal) {
    return !signal.aborted && !profileIdentity?.avatarDataUrl && avatar === current && credential?.accountId === current.accountId &&
      view.kind === 'signedIn' && view.accountId === current.accountId;
  }
  function scheduleAvatar(current: Avatar, signal: AbortSignal, ms: number) {
    clearAvatarTimer();
    if (!currentAvatar(current, signal) || current.attempts >= avatarAttemptLimit) return;
    const scheduled = setTimeout(() => {
      if (avatarTimer !== scheduled) return;
      avatarTimer = undefined;
      if (currentAvatar(current, signal)) loadAvatar(current, signal);
    }, Math.min(2_147_483_647, Math.max(0, ms)));
    avatarTimer = scheduled;
    avatarTimer.unref();
  }
  function loadAvatar(current: Avatar, signal: AbortSignal) {
    if (!currentAvatar(current, signal) || current.loading || current.dataUrl) return;
    clearAvatarTimer();
    current.loading = true;
    current.attempts++;
    void fetchAccountAvatar(current.url, AbortSignal.any([signal, current.controller.signal]), transport).then(dataUrl => {
      current.loading = false;
      if (signal.aborted || avatar !== current) return;
      if (!dataUrl) {
        const delay = avatarRetryDelays[current.attempts - 1] ?? 60_000;
        current.retryAt = Date.now() + delay;
        scheduleAvatar(current, signal, delay);
        return;
      }
      current.retryAt = undefined;
      current.dataUrl = dataUrl;
      if (view.kind === 'signedIn' && currentAvatar(current, signal)) publish({ ...view, avatarDataUrl: dataUrl });
    });
  }
  function ready(record: AccountCredential, verified: PublicIdentity, token: Access, persistence: Persistence, signal: AbortSignal) {
    const previous = profileIdentity;
    if (previous?.accountId === verified.accountId && previous.profileRevision !== undefined &&
        (verified.profileRevision === undefined || verified.profileRevision < previous.profileRevision)) {
      const {avatarDataUrl: _staleAvatar, ...identity} = verified;
      verified = {...identity, displayName: previous.displayName, profileRevision: previous.profileRevision,
        ...(previous.avatarDataUrl && {avatarDataUrl: previous.avatarDataUrl})};
    }
    profileIdentity = verified;
    credential = record;
    access = token;
    schedule(signal, token.expiresAt - Date.now() - 60_000);
    if (avatar?.accountId !== verified.accountId || avatar?.url !== verified.avatarUrl) discardAvatar();
    publish({ kind: 'signedIn', ...verified, provider: record.provider, persistence,
      ...(!verified.avatarDataUrl && avatar?.dataUrl ? { avatarDataUrl: avatar.dataUrl } : {}) });
    if (signal.aborted || verified.avatarDataUrl || !verified.avatarUrl) return;
    const current = avatar ??= { accountId: verified.accountId, url: verified.avatarUrl,
      attempts: 0, loading: false, controller: new AbortController() };
    if (current.dataUrl || current.loading) return;
    if (current.retryAt !== undefined && current.retryAt > Date.now()) {
      scheduleAvatar(current, signal, current.retryAt - Date.now());
      return;
    }
    // A later verified refresh can begin another bounded attempt series after its cooldown.
    if (current.attempts >= avatarAttemptLimit) current.attempts = 0;
    loadAvatar(current, signal);
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

  function applyProfile(accountId: string, profile: AccountProfile) {
    if (disposed || !credential || !access || !profileIdentity || view.kind !== 'signedIn' ||
        view.accountId !== accountId || credential.accountId !== accountId || profile.authorId !== accountId) return;
    if (profileIdentity.profileRevision !== undefined &&
        (profile.revision === undefined || profile.revision < profileIdentity.profileRevision)) return;
    const {avatarDataUrl: _previousAvatar, ...identity} = profileIdentity;
    ready(credential, {...identity, displayName: profile.displayName, ...(profile.revision !== undefined && {profileRevision: profile.revision}),
      ...(profile.avatarDataUrl && {avatarDataUrl: profile.avatarDataUrl})}, access, view.persistence, owner.signal);
  }

  function refreshProfile(): Promise<AccountStatus> {
    if (disposed || !deployment || view.kind !== 'signedIn' || !credential) return Promise.resolve(view);
    if (profileRefreshing) return profileRefreshing;
    const signal = owner.signal, accountId = credential.accountId;
    const run = (async () => {
      if (!access || access.expiresAt - Date.now() <= 30_000) await refresh(signal);
      signal.throwIfAborted();
      if (!access || credential?.accountId !== accountId || view.kind !== 'signedIn' || view.accountId !== accountId)
        throw new AccountFault('offline');
      const response = await transport(deployment.apiOrigin + '/v2/me/account-profile', {
        headers: {Authorization: 'Bearer ' + access.token}, credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: requestSignal(signal),
      });
      signal.throwIfAborted();
      if (response.status === 404 || response.status === 405) return view;
      checkResponse(response);
      const profile = accountProfileSchema.parse(await boundedJson(response, 400_000));
      signal.throwIfAborted();
      if (profile.authorId !== accountId) throw new AccountFault('invalid');
      applyProfile(accountId, profile);
      return view;
    })();
    profileRefreshing = run;
    void run.then(() => {if (profileRefreshing === run) profileRefreshing = undefined;},
      () => {if (profileRefreshing === run) profileRefreshing = undefined;});
    return run;
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
          async accept({ project, provider, tokens, auth, signal: attempt, confirmedAccountId, checkActive }) {
            const identity = await verifyAccount(deployment, auth, tokens.access, tokens.subject, provider, attempt, transport, {expectedAccountId: confirmedAccountId, checkActive});
            const record: AccountCredential = { ...project, webOrigin: deployment.webOrigin, apiOrigin: deployment.apiOrigin,
              subject: tokens.subject, refreshToken: tokens.refresh, accountId: identity.accountId, provider };
            await serialize(async () => {
              checkActive();
              const persistence = await store.save(record).catch(() => { throw new AccountFault('storage'); });
              try {checkActive();} catch (error) {await store.clear(); throw error;}
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
    async logout() {
      if (disposed) return view;
      const saved = credential, token = access;
      const cleared = clearLocal();
      if (saved) {
        const auth = accountAuth(saved, AbortSignal.timeout(3000), transport);
        try {
          const result = token && token.expiresAt > Date.now() ? await auth.admin.signOut(token.token, 'local') : undefined;
          if (!result || result.error?.status === 401 || result.error?.status === 403) {
            const refreshed = await auth.refreshSession({refresh_token: saved.refreshToken});
            checkAuth(refreshed.error);
            const outgoing = sessionTokens(refreshed.data.session);
            if (outgoing.subject === saved.subject) await auth.admin.signOut(outgoing.access, 'local');
          }
        }
        catch { /* Local logout completes even when the identity service is offline. */ }
        finally { await auth.dispose(); }
      }
      return cleared;
    },
    async manage() {
      if (!deployment || disposed || view.kind !== 'signedIn') throw new AccountFault('invalid');
      const accountId = view.accountId;
      const signal = owner.signal;
      if (!access || access.expiresAt - Date.now() <= 90_000) await refresh(signal);
      signal.throwIfAborted();
      if (!access || credential?.accountId !== accountId) throw new AccountFault('invalid');
      const response = await transport(deployment.webOrigin + '/auth/account-link', {
        method: 'POST', headers: {Authorization: 'Bearer ' + access.token}, credentials: 'omit',
        redirect: 'error', cache: 'no-store', signal: requestSignal(signal),
      });
      checkResponse(response);
      const link = await boundedJson(response, 4096) as {ticket?: unknown; accountId?: unknown};
      signal.throwIfAborted();
      if (link.accountId !== accountId || typeof link.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(link.ticket)) throw new AccountFault('invalid');
      await options.openBrowser(deployment.webOrigin + '/account#link=' + link.ticket);
    },
    refresh: refreshProfile,
    applyProfile,
    recipeLink(recipeId, versionId) {
      if (!deployment || !/^[0-9a-f-]{36}$/.test(recipeId) || !/^[0-9a-f-]{36}$/.test(versionId)) throw new AccountFault('invalid');
      return `${deployment.webOrigin}/recipes/${recipeId}/versions/${versionId}`;
    },
    async publicRequest(path) {
      if (!deployment || disposed) throw new AccountFault('invalid');
      const url = apiUrl(path, deployment.apiOrigin, true);
      return transport(url, {credentials: 'omit', redirect: 'error', cache: 'no-store', signal: requestSignal(owner.signal),
        ...(publicBrowse.test(url.pathname) && {headers: {'X-Vonvon-Browse': 'public-v2'}})});
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
      await beforeSend?.();
      signal.throwIfAborted();signals.throwIfAborted();
      if(disposed||!credential||credential.accountId!==accountId||view.kind!=='signedIn'||view.accountId!==accountId)throw new AccountFault('invalid');
      // Member uploads also wait for normalization and private storage.
      const timeout = init.method === 'PUT' && privateObjectMember.test(path) ? 20_000 : undefined;
      const response = await transport(url, { ...init, headers, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: requestSignal(signals, timeout) });
      signal.throwIfAborted();
      return response;
    },
    async dispose() {
      if (!disposed) { disposed = true; invalidate(); listeners.clear(); }
      await writes;
    },
  };
}
