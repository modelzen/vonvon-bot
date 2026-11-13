import {createContext, useContext, useEffect, useMemo, useState, type ReactNode, type Dispatch, type SetStateAction} from 'react';
import {useAccount} from '../account-context';
import type {CommunityShell, RecipeDetail, CommunityResponses} from '@vonvon/protocol';

export type CommunityRoute = {kind: 'catalog'} | {kind: 'library'} | {kind: 'workspace'} | {kind: 'detail'; recipe: {recipeId: string; versionId: string}; privateView?: boolean} | {kind: 'draft'; draftId?: string; source?: RecipeDetail};
type CommunityContextValue = {
  shell?: CommunityShell; isOpen: boolean; route: CommunityRoute;
  open: (route?: CommunityRoute) => void; close: () => void;
  catalog: {query: string; search: string; result?: CommunityResponses['catalog']; scrollTop: number};
  setCatalog: Dispatch<SetStateAction<CommunityContextValue['catalog']>>;
  onUse?: (recipe: RecipeDetail) => void;
};
const Context = createContext<CommunityContextValue | undefined>(undefined);

export function CommunityProvider({shell, onUse, children}: {shell?: CommunityShell; onUse?: (recipe: RecipeDetail) => void; children: ReactNode}) {
  const [isOpen, setOpen] = useState(false);
  const account = useAccount();
  const accountId = account.status?.kind === 'signedIn' ? account.status.accountId : undefined;
  const [stored, setRoute] = useState<{route: CommunityRoute; owner?: string}>({route: {kind: 'catalog'}});
  const privateRoute = stored.route.kind === 'draft' || stored.route.kind === 'workspace' || stored.route.kind === 'library' || stored.route.kind === 'detail' && stored.route.privateView;
  const foreignRoute = privateRoute && stored.owner !== undefined && stored.owner !== accountId;
  const route = foreignRoute ? {kind: 'catalog'} as const : stored.route;
  useEffect(() => {if (foreignRoute) setRoute({route: {kind: 'catalog'}});}, [foreignRoute]);
  const [catalog, setCatalog] = useState<CommunityContextValue['catalog']>({query: '', search: '', scrollTop: 0});
  const value = useMemo(() => ({shell, isOpen, route, onUse, catalog, setCatalog,
    open: (next?: CommunityRoute) => {if (next) setRoute({route: next, owner: accountId}); setOpen(true);}, close: () => setOpen(false),
  }), [shell, isOpen, route, onUse, accountId, catalog]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useCommunity() {return useContext(Context);}
