import {createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type Dispatch, type SetStateAction} from 'react';
import type {Destination} from '../search';
import {useAccount} from '../account-context';
import type {CommunityShell, RecipeDetail, CommunityResponses, RecipePreviewNavigationPayload} from '@vonvon/protocol';
import {useActiveDevice, useClient, useShellCapabilities} from '../client-context';
import type {RecipeGroupTarget} from '../recipes/recipe-use-context';
import {useOptionalDraftGuard} from '../settings/DraftGuard';
import type {ResourceHandoffIntents} from './RecipeResourceDialog';
import {useAccountPage} from '../accounts/account-page';

export type RecipeWorkspaceTab = 'acquired' | 'drafts' | 'published';
export type CommunityRoute = {kind: 'create'; navigationId: string} | {kind: 'author'; authorId: string} | {kind: 'catalog'} | {kind: 'workspace'; tab: RecipeWorkspaceTab; navigationId?: string} | {kind: 'detail'; recipe: {recipeId: string; versionId: string}; from?: RecipeWorkspaceTab; authorFrom?: string; privateView?: boolean; handoffNavigationId?: string; useTarget?: RecipeGroupTarget} | {kind: 'draft'; draftId: string; from?: 'drafts'; expectedRevision?: number; navigationId?: string};
// Native login attempts are bounded to five minutes in desktop/account-login.ts.
const acquisitionLoginTtlMs = 300_000;
const acquisitionLoginExpired = '本次获取登录已过期，请再次点击获取配方重试。';
type AcquisitionLogin = {id: string; expiresAt: number; recipe: {recipeId: string; versionId: string}} & (
  {phase: 'starting' | 'waiting'} | {phase: 'failed'; message: string} | {phase: 'ready'; accountId: string}
);
export type CommunityDeparture = {deviceId: string; destination: Destination};
type CommunityContextValue = {
  shell?: CommunityShell; isOpen: boolean; route: CommunityRoute;
  departure?: CommunityDeparture; leave: (departure: CommunityDeparture) => void; consumeDeparture: (departure: CommunityDeparture) => void;
  open: (route?: CommunityRoute) => void; close: () => void;
  catalog: {generation: number; query: string; search: string; result?: CommunityResponses['catalog']; scrollTop: number};
  setCatalog: Dispatch<SetStateAction<CommunityContextValue['catalog']>>;
  invalidateCatalog: () => void;
  resourceIntents: ResourceHandoffIntents;
  acquisitionLogin?: AcquisitionLogin;
  beginAcquisitionLogin: (recipe: {recipeId: string; versionId: string}) => Promise<void>;
  consumeAcquisitionLogin: (id: string) => void;
  claimHandoffNavigation: (id: string, accountId: string) => boolean;
  onUse?: (recipe: RecipeDetail) => void;
};
const Context = createContext<CommunityContextValue | undefined>(undefined);

export function CommunityProvider({shell, onUse, children}: {shell?: CommunityShell; onUse?: (recipe: RecipeDetail, target?: RecipeGroupTarget) => void; children: ReactNode}) {
  const [isOpen, setOpen] = useState(false);
  const [departure, setDeparture] = useState<CommunityDeparture>();
  const account = useAccount();
  const accountPage = useAccountPage();
  const currentAccountPage = useRef(accountPage);
  currentAccountPage.current = accountPage;
  const [acquisitionLogin, setAcquisitionLogin] = useState<AcquisitionLogin>();
  const acquisitionLoginLock = useRef(false);
  const currentStatus = useRef(account.status);
  currentStatus.current = account.status;
  useEffect(() => {
    const status = account.status;
    setAcquisitionLogin(current => {
      if (!current || current.phase === 'failed') return current;
      if (Date.now() >= current.expiresAt) {acquisitionLoginLock.current = false; return {...current, phase: 'failed', message: acquisitionLoginExpired};}
      if (current.phase === 'ready') return status?.kind === 'signedIn' && status.accountId === current.accountId ? current : undefined;
      if (status?.kind === 'signedIn') {acquisitionLoginLock.current = false; return {...current, phase: 'ready', accountId: status.accountId};}
      if (status?.kind === 'signingIn') return current.phase === 'waiting' ? current : {...current, phase: 'waiting'};
      if (current.phase === 'starting') return current;
      if (current.phase === 'waiting' || account.error) {
        acquisitionLoginLock.current = false;
        return {...current, phase: 'failed', message: account.error || (status?.kind === 'signedOut' && status.reason === 'cancelled' ? '已取消登录。请再次点击获取配方重试。' : '登录未完成，请重试获取配方。')};
      }
      return current;
    });
  }, [account.status, account.error]);
  useEffect(() => {
    if (!acquisitionLogin || acquisitionLogin.phase === 'failed') return;
    const id = acquisitionLogin.id;
    const timer = setTimeout(() => {
      setAcquisitionLogin(current => {
        if (!current || current.id !== id || current.phase === 'failed' || Date.now() < current.expiresAt) return current;
        acquisitionLoginLock.current = false;
        return {...current, phase: 'failed', message: acquisitionLoginExpired};
      });
    }, Math.max(0, acquisitionLogin.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [acquisitionLogin?.id, acquisitionLogin?.phase, acquisitionLogin?.expiresAt]);
  async function beginAcquisitionLogin(recipe: {recipeId: string; versionId: string}) {
    if (acquisitionLoginLock.current) return;
    acquisitionLoginLock.current = true;
    const id = crypto.randomUUID();
    setAcquisitionLogin({id, expiresAt: Date.now() + acquisitionLoginTtlMs, recipe, phase: account.status?.kind === 'signingIn' ? 'waiting' : 'starting'});
    if (account.status?.kind === 'signingIn') return;
    try {await account.login();}
    catch {}
    const status = currentStatus.current;
    setAcquisitionLogin(current => {
      if (!current || current.id !== id || current.phase !== 'starting') return current;
      if (Date.now() >= current.expiresAt) {acquisitionLoginLock.current = false; return {...current, phase: 'failed', message: acquisitionLoginExpired};}
      if (status?.kind === 'signedIn') {acquisitionLoginLock.current = false; return {...current, phase: 'ready', accountId: status.accountId};}
      if (status?.kind === 'signingIn') return {...current, phase: 'waiting'};
      acquisitionLoginLock.current = false;
      return {...current, phase: 'failed', message: '未能开始登录。请重试获取配方。'};
    });
  }
  function clearAcquisitionLogin() {acquisitionLoginLock.current = false; setAcquisitionLogin(undefined);}
  const accountId = account.status?.kind === 'signedIn' ? account.status.accountId : undefined;
  const resourceOwner = useRef<{accountId?: string; intents: ResourceHandoffIntents}>({accountId, intents: new Map()});
  if (resourceOwner.current.accountId !== accountId) resourceOwner.current = {accountId, intents: new Map()};
  const resourceIntents = resourceOwner.current.intents;
  const preview = useShellCapabilities()?.recipePreview;
  const guard = useOptionalDraftGuard();
  const client = useClient();
  const device = useActiveDevice();
  const [stored, setRoute] = useState<{route: CommunityRoute; owner?: string; deviceId?: string; client?: typeof client}>({route: {kind: 'catalog'}});
  const privateRoute = stored.route.kind === 'create' || stored.route.kind === 'draft' || stored.route.kind === 'workspace' || stored.route.kind === 'detail' && (stored.route.privateView || stored.route.from !== undefined || stored.route.handoffNavigationId !== undefined);
  const foreignRoute = privateRoute && stored.owner !== undefined && stored.owner !== accountId;
  const route = foreignRoute ? {kind: 'catalog'} as const : stored.route;
  useEffect(() => {if (foreignRoute) setRoute({route: {kind: 'catalog'}});}, [foreignRoute]);
  const currentAccount = useRef(accountId);
  currentAccount.current = accountId;
  const pendingPreview = useRef<RecipePreviewNavigationPayload | undefined>(undefined);
  const resumeBoundPreview = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (!preview) return;
    let active = true;
    let receivedLive = false;
    let navigating = false;
    const seen = new Set<string>();
    const acknowledge = (id: string) => {void preview.acknowledge(id).catch(() => {});};
    const cancelPending = () => {
      navigating = false;
      const navigation = pendingPreview.current;
      pendingPreview.current = undefined;
      if (navigation) acknowledge(navigation.navigationId);
    };
    const openPending = () => {
      navigating = false;
      const navigation = pendingPreview.current;
      if (!active || !navigation) return;
      if ('accountId' in navigation && navigation.accountId && navigation.accountId !== currentAccount.current) {
        if (currentAccount.current) pendingPreview.current = undefined;
        return;
      }
      currentAccountPage.current?.close();
      setDeparture(undefined);
      clearAcquisitionLogin();
      let route: CommunityRoute;
      if (!('kind' in navigation)) route = {kind: 'draft', draftId: navigation.draftId, expectedRevision: navigation.revision, navigationId: navigation.navigationId};
      else if (navigation.kind === 'handoff') route = {kind: 'detail', recipe: {recipeId: navigation.recipeId, versionId: navigation.versionId}, handoffNavigationId: navigation.navigationId};
      else if (navigation.kind === 'drafts') route = {kind: 'workspace', tab: 'drafts', navigationId: navigation.navigationId};
      else route = {kind: 'create', navigationId: navigation.navigationId};
      setRoute({route, owner: currentAccount.current});
      setOpen(true);
      if (currentAccount.current) {
        acknowledge(navigation.navigationId);
        pendingPreview.current = undefined;
      }
    };
    const navigate = () => {
      const navigation = pendingPreview.current;
      if (!navigation) return;
      if ('accountId' in navigation && navigation.accountId && navigation.accountId !== currentAccount.current) {
        if (currentAccount.current) pendingPreview.current = undefined;
        return;
      }
      if (!guard) openPending();
      else if (!navigating) {
        navigating = true;
        if (!guard.navigate(openPending, cancelPending)) cancelPending();
      }
    };
    resumeBoundPreview.current = () => {if (pendingPreview.current && 'accountId' in pendingPreview.current && pendingPreview.current.accountId) navigate();};
    const receive = (navigation: RecipePreviewNavigationPayload) => {
      if (!active || seen.has(navigation.navigationId)) return;
      seen.add(navigation.navigationId);
      const previous = pendingPreview.current;
      if (previous && previous.navigationId !== navigation.navigationId) acknowledge(previous.navigationId);
      pendingPreview.current = navigation;
      navigate();
    };
    const unsubscribe = preview.onOpen(navigation => {receivedLive = true; receive(navigation);});
    void preview.pending().then(queue => {
      if (!active) return;
      if (!receivedLive) queue.forEach(receive);
      else for (const navigation of queue) if (!seen.has(navigation.navigationId)) acknowledge(navigation.navigationId);
    }).catch(() => {});
    return () => {active = false; resumeBoundPreview.current = undefined; unsubscribe();};
  }, [preview, guard]);
  useEffect(() => {resumeBoundPreview.current?.();}, [accountId]);
  useEffect(() => {
    if (!accountId || !privateRoute || stored.owner !== undefined) return;
    setRoute(current => ({...current, owner: accountId}));
    const navigation = pendingPreview.current;
    const navigationId = stored.route.kind === 'detail' ? stored.route.handoffNavigationId : 'navigationId' in stored.route ? stored.route.navigationId : undefined;
    if (navigation && navigationId === navigation.navigationId) {
      pendingPreview.current = undefined;
      void preview?.acknowledge(navigation.navigationId).catch(() => {});
    }
  }, [accountId, privateRoute, stored, preview]);
  const useTarget = stored.route.kind === 'detail' && stored.owner === accountId && stored.deviceId === device.id && stored.client === client ? stored.route.useTarget : undefined;
  useEffect(() => {
    if (stored.route.kind === 'detail' && stored.route.useTarget && !useTarget) setRoute(current => current.route.kind === 'detail' ? {...current, route: {...current.route, useTarget: undefined}} : current);
  }, [stored, useTarget]);
  function clearUseTarget() {
    setRoute(current => current.route.kind === 'detail' && current.route.useTarget ? {...current, route: {...current.route, useTarget: undefined}} : current);
  }
  const [catalog, setCatalog] = useState<CommunityContextValue['catalog']>({generation: 0, query: '', search: '', scrollTop: 0});
  function clearPendingPreview() {
    const navigation = pendingPreview.current;
    pendingPreview.current = undefined;
    if (navigation) void preview?.acknowledge(navigation.navigationId).catch(() => {});
  }
  const invalidateCatalog = () => setCatalog(current => ({...current, generation: current.generation + 1, result: undefined, scrollTop: 0}));
  const claimedHandoff = useRef<string | undefined>(undefined);
  const currentUse = useRef({onUse, useTarget, route, isOpen});
  currentUse.current = {onUse, useTarget, route, isOpen};
  const value = useMemo(() => ({shell, isOpen, route, onUse: onUse ? (recipe: RecipeDetail) => {
    const current = currentUse.current;
    if (current.isOpen && current.route.kind === 'detail' && current.route.recipe.recipeId === recipe.recipeId && current.route.recipe.versionId === recipe.versionId) current.onUse?.(recipe, current.useTarget);
  } : undefined, catalog, setCatalog, invalidateCatalog, resourceIntents, departure, acquisitionLogin, beginAcquisitionLogin,
    claimHandoffNavigation: (id: string, accountId: string) => {
      const current = currentUse.current;
      if (currentAccount.current !== accountId || !current.isOpen || current.route.kind !== 'detail' || current.route.handoffNavigationId !== id || claimedHandoff.current === id) return false;
      claimedHandoff.current = id; return true;
    },
    consumeAcquisitionLogin: (id: string) => setAcquisitionLogin(current => current?.id === id ? undefined : current),
    leave: (next: CommunityDeparture) => {clearAcquisitionLogin(); clearPendingPreview(); setDeparture(next); setOpen(false); clearUseTarget();},
    consumeDeparture: (expected: CommunityDeparture) => setDeparture(current => current === expected ? undefined : current),
    open: (next?: CommunityRoute) => {if (next) {clearAcquisitionLogin(); clearPendingPreview();} setDeparture(undefined); if (next) setRoute({route: next.kind === 'detail' ? {...next, recipe: {recipeId: next.recipe.recipeId, versionId: next.recipe.versionId}} : next, owner: accountId, deviceId: device.id, client}); setOpen(true);}, close: () => {clearAcquisitionLogin(); clearPendingPreview(); setDeparture(undefined); setOpen(false); clearUseTarget();},
  }), [shell, isOpen, route, onUse, useTarget, accountId, device.id, client, catalog, departure, preview, resourceIntents, acquisitionLogin, account]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useCommunity() {return useContext(Context);}
