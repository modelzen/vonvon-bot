import {createContext, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import type {VonvonClient} from '@vonvon/client/browser';
import {groupIdSchema, type AgentId, type GroupId, type DesktopSnapshot, type RecipeDetail, type RecipeUseReply, type RecipeUseRequest} from '@vonvon/protocol';
import {useAccount} from '../account-context';
import {ClientProvider, useActiveDevice, useClient, useDevicesState, useShellCapabilities, type ActiveDevice} from '../client-context';
import {DraftGuardProvider} from '../settings/DraftGuard';
import {RecipeUseDialog} from './RecipeUseDialog';
import './recipe-use.css';

export type RecipeReference = {recipeId: string; versionId: string; name: string; version: string};
export type RecipeGroupTarget = {botId: AgentId; groupId: GroupId};
export type RecipeUseSession = {
  recipe: RecipeReference; accountId: string; device: ActiveDevice; client: VonvonClient;
  target?: RecipeGroupTarget; botId?: AgentId;
};
type ContextValue = {start: (recipe: RecipeReference | RecipeDetail, target?: RecipeGroupTarget) => void;
  acquireForGroup: (recipe: RecipeReference, target: RecipeGroupTarget) => void; available: boolean; refreshVersion: number};
const Context = createContext<ContextValue | undefined>(undefined);
export function useRecipeUse() {return useContext(Context);}
export function recipeReference(recipe: RecipeReference | RecipeDetail): RecipeReference {
  return 'public' in recipe ? {recipeId: recipe.recipeId, versionId: recipe.versionId, name: recipe.public.name, version: recipe.public.version} : recipe;
}

/** This outlives the device's App. A hidden operation remains bound to its original account and target. */
export function RecipeUseProvider({children}: {children: ReactNode}) {
  const account = useAccount();
  const client = useClient();
  const device = useActiveDevice();
  const devices = useDevicesState();
  const shell = useShellCapabilities();
  const [session, setSession] = useState<RecipeUseSession>();
  const [visible, setVisible] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const awaitingAcquisition = useRef<RecipeUseSession | undefined>(undefined);
  const accountId = account.status?.kind === 'signedIn' ? account.status.accountId : undefined;
  const available = Boolean(shell?.recipeUse);
  function start(recipe: RecipeReference | RecipeDetail, target?: RecipeGroupTarget) {
    if (!available || !accountId) return;
    // An unfinished operation must be acknowledged or cancelled before choosing another target.
    if (!session) {
      const original = awaitingAcquisition.current;
      const reference = recipeReference(recipe);
      setSession(original?.recipe.versionId === reference.versionId ? {...original, recipe: reference}
        : {recipe: reference, accountId, device, client, target, botId: target?.botId});
      awaitingAcquisition.current = undefined;
    }
    setVisible(true);
  }
  return <Context.Provider value={{start, available, refreshVersion,
    acquireForGroup: (recipe, target) => {if (accountId) awaitingAcquisition.current = {recipe, target, botId: target.botId, accountId, device, client};}}}>
    {children}
    {session && shell?.recipeUse && <RecipeUseSessionView session={session} visible={visible}
      currentAccountId={accountId} currentDeviceId={device.id} currentClient={client}
      currentReady={!devices || devices.active.phase === 'ready' && device.mode === 'full'}
      request={request => shell.recipeUse!.request(request)} onSelectBot={botId => setSession({...session, botId})}
      onSelectGroup={groupId => {if (session.botId) setSession({...session, target: {botId: session.botId, groupId: groupIdSchema.parse(groupId)}});}}
      onClose={() => {setVisible(false); if (!session.botId) setSession(undefined);}} onFinished={() => {setSession(undefined); setVisible(false); setRefreshVersion(value => value + 1);}}/>}
  </Context.Provider>;
}

function RecipeUseSessionView({session, visible, currentAccountId, currentDeviceId, currentClient, currentReady, request, onSelectBot, onSelectGroup, onClose, onFinished}: {
  session: RecipeUseSession; visible: boolean; currentAccountId?: string; currentDeviceId: string; currentClient: VonvonClient; currentReady: boolean;
  request: (request: RecipeUseRequest) => Promise<RecipeUseReply>; onSelectBot: (id: AgentId) => void; onClose: () => void; onFinished: () => void;
  onSelectGroup: (groupId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  const [reply, setReply] = useState<RecipeUseReply>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [recover, setRecover] = useState(false);
  const [reviewEpoch, setReviewEpoch] = useState(0);
  const [acceptedResolution, setAcceptedResolution] = useState<Extract<RecipeUseRequest, {type: 'resolve'}>['resolution']>();
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const begunTarget = useRef<string | undefined>(undefined);
  const accountChanged = currentAccountId !== session.accountId;
  const deviceChanged = currentDeviceId !== session.device.id || currentClient !== session.client;
  const unavailable = !currentReady || Boolean(snapshot && (snapshot.host.kind !== 'connected' || snapshot.stale));
  // Returning to the same account ID or device still requires a fresh main-process lease.
  const invalidated = useRef(false);
  if (accountChanged || deviceChanged || unavailable) invalidated.current = true;
  const paused = accountChanged || deviceChanged || unavailable;
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  useEffect(() => session.client.watchSnapshots(setSnapshot), [session.client]);

  async function send(input: RecipeUseRequest) {
    if (inFlight.current || paused) return;
    inFlight.current = true; setBusy(true); setError(undefined);
    try {
      const result = await request(input);
      if (!mounted.current) return;
      if (result.kind === 'closed') {onFinished(); return;}
      setReply(result); setRecover(false);
      setAcceptedResolution(input.type === 'resolve' && result.kind === 'prepared' ? input.resolution : undefined);
      invalidated.current = false;
      if (result.kind === 'review' || result.kind === 'prepared') setReviewEpoch(value => value + 1);
    } catch (failure) {
      if (mounted.current) {setError(failure instanceof Error ? failure.message : '暂时无法确认结果，请恢复原操作。'); setRecover(true);}
    } finally {inFlight.current = false; if (mounted.current) setBusy(false);}
  }
  function begin() {
    if (!session.botId) return;
    return send({type: 'begin', accountId: session.accountId, viewId: session.device.id, recipeId: session.recipe.recipeId,
      versionId: session.recipe.versionId, botId: session.botId, ...(session.target ? {groupId: session.target.groupId} : {})});
  }
  useEffect(() => {
    const target = JSON.stringify([session.botId, session.target?.groupId]);
    if (!session.botId || begunTarget.current === target || paused) return;
    begunTarget.current = target;
    void begin();
  }, [session.botId, session.target?.groupId, paused]);
  const needsRecovery = recover || invalidated.current;
  const groupId = reply && 'groupId' in reply ? reply.groupId : session.target?.groupId;
  return <ClientProvider client={session.client} device={session.device}>
    <DraftGuardProvider><RecipeUseDialog session={session} snapshot={snapshot} visible={visible} reply={reply} error={error} busy={busy}
      paused={paused} accountChanged={accountChanged} unavailable={unavailable && !deviceChanged} needsRecovery={needsRecovery} reviewEpoch={reviewEpoch} acceptedResolution={acceptedResolution}
      onSelectBot={onSelectBot} onSelectGroup={onSelectGroup} onClose={onClose} onRecover={() => void begin()}
      onRequest={input => send(input)} groupId={groupId}/></DraftGuardProvider>
  </ClientProvider>;
}
