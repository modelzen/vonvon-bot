import {createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type Dispatch, type SetStateAction} from 'react';
import type {Destination} from '../search';
import {useAccount} from '../account-context';
import type {CommunityShell, RecipeDetail, CommunityResponses, DraftPreviewNavigation} from '@vonvon/protocol';
import {useActiveDevice, useClient, useShellCapabilities} from '../client-context';
import type {RecipeGroupTarget} from '../recipes/recipe-use-context';
import {useOptionalDraftGuard} from '../settings/DraftGuard';

export type CommunityRoute = {kind: 'catalog'} | {kind: 'library'} | {kind: 'workspace'} | {kind: 'detail'; recipe: {recipeId: string; versionId: string}; from?: 'library'; privateView?: boolean; useTarget?: RecipeGroupTarget} | {kind: 'draft'; draftId: string; expectedRevision?: number; navigationId?: string};
export type CommunityDeparture = {deviceId: string; destination: Destination};
type CommunityContextValue = {
  shell?: CommunityShell; isOpen: boolean; route: CommunityRoute;
  departure?: CommunityDeparture; leave: (departure: CommunityDeparture) => void; consumeDeparture: (departure: CommunityDeparture) => void;
  open: (route?: CommunityRoute) => void; close: () => void;
  catalog: {generation: number; query: string; search: string; result?: CommunityResponses['catalog']; scrollTop: number};
  setCatalog: Dispatch<SetStateAction<CommunityContextValue['catalog']>>;
  invalidateCatalog: () => void;
  onUse?: (recipe: RecipeDetail) => void;
};
const Context = createContext<CommunityContextValue | undefined>(undefined);

export function CommunityProvider({shell, onUse, children}: {shell?: CommunityShell; onUse?: (recipe: RecipeDetail, target?: RecipeGroupTarget) => void; children: ReactNode}) {
  const [isOpen, setOpen] = useState(false);
  const [departure, setDeparture] = useState<CommunityDeparture>();
  const account = useAccount();
  const accountId = account.status?.kind === 'signedIn' ? account.status.accountId : undefined;
  const preview = useShellCapabilities()?.recipePreview;
  const guard = useOptionalDraftGuard();
  const client = useClient();
  const device = useActiveDevice();
  const [stored, setRoute] = useState<{route: CommunityRoute; owner?: string; deviceId?: string; client?: typeof client}>({route: {kind: 'catalog'}});
  const privateRoute = stored.route.kind === 'draft' || stored.route.kind === 'workspace' || stored.route.kind === 'library' || stored.route.kind === 'detail' && stored.route.privateView;
  const foreignRoute = privateRoute && stored.owner !== undefined && stored.owner !== accountId;
  const route = foreignRoute ? {kind: 'catalog'} as const : stored.route;
  useEffect(() => {if (foreignRoute) setRoute({route: {kind: 'catalog'}});}, [foreignRoute]);
  const currentAccount = useRef(accountId);
  currentAccount.current = accountId;
  const pendingPreview = useRef<DraftPreviewNavigation | undefined>(undefined);
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
      setDeparture(undefined);
      setRoute({route: {kind: 'draft', draftId: navigation.draftId, expectedRevision: navigation.revision, navigationId: navigation.navigationId}, owner: currentAccount.current});
      setOpen(true);
      if (currentAccount.current) {
        acknowledge(navigation.navigationId);
        pendingPreview.current = undefined;
      }
    };
    const receive = (navigation: DraftPreviewNavigation) => {
      if (!active || seen.has(navigation.navigationId)) return;
      seen.add(navigation.navigationId);
      const previous = pendingPreview.current;
      if (previous && previous.navigationId !== navigation.navigationId) acknowledge(previous.navigationId);
      pendingPreview.current = navigation;
      if (!guard) openPending();
      else if (!navigating) {
        navigating = true;
        if (!guard.navigate(openPending, cancelPending)) cancelPending();
      }
    };
    const unsubscribe = preview.onOpen(navigation => {receivedLive = true; receive(navigation);});
    void preview.pending().then(queue => {
      if (!active) return;
      if (!receivedLive) queue.forEach(receive);
      else for (const navigation of queue) if (!seen.has(navigation.navigationId)) acknowledge(navigation.navigationId);
    }).catch(() => {});
    return () => {active = false; unsubscribe();};
  }, [preview, guard]);
  useEffect(() => {
    if (!accountId || !privateRoute || stored.owner !== undefined) return;
    setRoute(current => ({...current, owner: accountId}));
    const navigation = pendingPreview.current;
    if (navigation && stored.route.kind === 'draft' && stored.route.draftId === navigation.draftId) {
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
  const currentUse = useRef({onUse, useTarget, route, isOpen});
  currentUse.current = {onUse, useTarget, route, isOpen};
  const value = useMemo(() => ({shell, isOpen, route, onUse: onUse ? (recipe: RecipeDetail) => {
    const current = currentUse.current;
    if (current.isOpen && current.route.kind === 'detail' && current.route.recipe.recipeId === recipe.recipeId && current.route.recipe.versionId === recipe.versionId) current.onUse?.(recipe, current.useTarget);
  } : undefined, catalog, setCatalog, invalidateCatalog, departure,
    leave: (next: CommunityDeparture) => {clearPendingPreview(); setDeparture(next); setOpen(false); clearUseTarget();},
    consumeDeparture: (expected: CommunityDeparture) => setDeparture(current => current === expected ? undefined : current),
    open: (next?: CommunityRoute) => {if (next) clearPendingPreview(); setDeparture(undefined); if (next) setRoute({route: next.kind === 'detail' ? {...next, recipe: {recipeId: next.recipe.recipeId, versionId: next.recipe.versionId}} : next, owner: accountId, deviceId: device.id, client}); setOpen(true);}, close: () => {clearPendingPreview(); setDeparture(undefined); setOpen(false); clearUseTarget();},
  }), [shell, isOpen, route, onUse, useTarget, accountId, device.id, client, catalog, departure, preview]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useCommunity() {return useContext(Context);}
