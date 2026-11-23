import {createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type Dispatch, type SetStateAction} from 'react';
import type {Destination} from '../search';
import {useAccount} from '../account-context';
import type {CommunityShell, RecipeDetail, CommunityResponses} from '@vonvon/protocol';
import {useActiveDevice, useClient} from '../client-context';
import type {RecipeGroupTarget} from '../recipes/recipe-use-context';

export type CommunityRoute = {kind: 'catalog'} | {kind: 'library'} | {kind: 'workspace'} | {kind: 'authoring';parent?:{recipeId:string;versionId:string}} | {kind: 'detail'; recipe: {recipeId: string; versionId: string}; privateView?: boolean; useTarget?: RecipeGroupTarget} | {kind: 'draft'; draftId?: string; source?: RecipeDetail};
export type CommunityDeparture = {deviceId: string; destination: Destination};
type CommunityContextValue = {
  shell?: CommunityShell; isOpen: boolean; route: CommunityRoute;
  departure?: CommunityDeparture; leave: (departure: CommunityDeparture) => void; consumeDeparture: (departure: CommunityDeparture) => void;
  open: (route?: CommunityRoute) => void; close: () => void;
  catalog: {query: string; search: string; result?: CommunityResponses['catalog']; scrollTop: number};
  setCatalog: Dispatch<SetStateAction<CommunityContextValue['catalog']>>;
  onUse?: (recipe: RecipeDetail) => void;
};
const Context = createContext<CommunityContextValue | undefined>(undefined);

export function CommunityProvider({shell, onUse, children}: {shell?: CommunityShell; onUse?: (recipe: RecipeDetail, target?: RecipeGroupTarget) => void; children: ReactNode}) {
  const [isOpen, setOpen] = useState(false);
  const [departure, setDeparture] = useState<CommunityDeparture>();
  const account = useAccount();
  const accountId = account.status?.kind === 'signedIn' ? account.status.accountId : undefined;
  const client = useClient();
  const device = useActiveDevice();
  const [stored, setRoute] = useState<{route: CommunityRoute; owner?: string; deviceId?: string; client?: typeof client}>({route: {kind: 'catalog'}});
  const privateRoute = stored.route.kind === 'authoring' || stored.route.kind === 'draft' || stored.route.kind === 'workspace' || stored.route.kind === 'library' || stored.route.kind === 'detail' && stored.route.privateView;
  const foreignRoute = privateRoute && stored.owner !== undefined && stored.owner !== accountId;
  const route = foreignRoute ? {kind: 'catalog'} as const : stored.route;
  useEffect(() => {if (foreignRoute) setRoute({route: {kind: 'catalog'}});}, [foreignRoute]);
  const useTarget = stored.route.kind === 'detail' && stored.owner === accountId && stored.deviceId === device.id && stored.client === client ? stored.route.useTarget : undefined;
  useEffect(() => {
    if (stored.route.kind === 'detail' && stored.route.useTarget && !useTarget) setRoute(current => current.route.kind === 'detail' ? {...current, route: {...current.route, useTarget: undefined}} : current);
  }, [stored, useTarget]);
  function clearUseTarget() {
    setRoute(current => current.route.kind === 'detail' && current.route.useTarget ? {...current, route: {...current.route, useTarget: undefined}} : current);
  }
  const [catalog, setCatalog] = useState<CommunityContextValue['catalog']>({query: '', search: '', scrollTop: 0});
  const currentUse = useRef({onUse, useTarget, route, isOpen});
  currentUse.current = {onUse, useTarget, route, isOpen};
  const value = useMemo(() => ({shell, isOpen, route, onUse: onUse ? (recipe: RecipeDetail) => {
    const current = currentUse.current;
    if (current.isOpen && current.route.kind === 'detail' && current.route.recipe.recipeId === recipe.recipeId && current.route.recipe.versionId === recipe.versionId) current.onUse?.(recipe, current.useTarget);
  } : undefined, catalog, setCatalog, departure,
    leave: (next: CommunityDeparture) => {setDeparture(next); setOpen(false); clearUseTarget();},
    consumeDeparture: (expected: CommunityDeparture) => setDeparture(current => current === expected ? undefined : current),
    open: (next?: CommunityRoute) => {setDeparture(undefined); if (next) setRoute({route: next.kind === 'detail' ? {...next, recipe: {recipeId: next.recipe.recipeId, versionId: next.recipe.versionId}} : next, owner: accountId, deviceId: device.id, client}); setOpen(true);}, close: () => {setDeparture(undefined); setOpen(false); clearUseTarget();},
  }), [shell, isOpen, route, onUse, useTarget, accountId, device.id, client, catalog, departure]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useCommunity() {return useContext(Context);}
