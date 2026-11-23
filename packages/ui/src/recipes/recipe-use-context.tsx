import {createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import type {VonvonClient} from '@vonvon/client/browser';
import {groupIdSchema, type AgentId, type GroupId, type DesktopSnapshot, type DevicesState, type RecipeDetail, type RecipeUseReply, type RecipeUseRequest} from '@vonvon/protocol';
import {useAccount} from '../account-context';
import {ClientProvider, useActiveDevice, useClient, useDevicesState, useShellCapabilities, type ActiveDevice} from '../client-context';
import {DraftGuardProvider} from '../settings/DraftGuard';
import {RecipeUseDialog} from './RecipeUseDialog';
import {useRecipeGroupIdentity, useRecipeTargetSnapshot} from './recipe-group-identity';
import {Button} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import './recipe-use.css';

export type RecipeReference = {format?: 'rich-v2'; recipeId: string; versionId: string; name: string; version: string};
export type RecipeGroupTarget = {botId: AgentId; groupId: GroupId};
export type RecipeUseSession = {
  id: number; intentTarget?: RecipeGroupTarget;
  recipe: RecipeReference; accountId: string; device: ActiveDevice; client: VonvonClient;
  target?: RecipeGroupTarget; botId?: AgentId;
  summary?: {botName?: string; groupId?: string};
};
type ContextValue = {start: (recipe: RecipeReference | RecipeDetail, target?: RecipeGroupTarget) => void; available: boolean; refreshVersion: number};
type Display = {kind: 'closed'; selected?: number} | {kind: 'session'; selected: number} | {kind: 'choice'; selected: number; previous: RecipeUseSession; next: RecipeUseSession};
const SESSION_SUMMARY_LIMIT = 8;
const Context = createContext<ContextValue | undefined>(undefined);
export function useRecipeUse() {return useContext(Context);}
export function recipeReference(recipe: RecipeReference | RecipeDetail): RecipeReference {
  return 'public' in recipe ? {...(recipe.format === 'rich-v2' ? {format: 'rich-v2' as const} : {}), recipeId: recipe.recipeId, versionId: recipe.versionId, name: recipe.public.name, version: recipe.public.version} : recipe;
}
function connectionState(state?: DevicesState) {
  return JSON.stringify([state?.active.id, state?.active.phase, state?.active.mode, state?.devices.find(row => row.id === state.active.id)?.status]);
}

export function RecipeUseProvider({children}: {children: ReactNode}) {
  const account = useAccount();
  const client = useClient();
  const device = useActiveDevice();
  const devices = useDevicesState();
  const shell = useShellCapabilities();
  const [sessions, setSessions] = useState<RecipeUseSession[]>([]);
  const [display, setDisplay] = useState<Display>({kind: 'closed'});
  const sequence = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const accountId = account.status?.kind === 'signedIn' ? account.status.accountId : undefined;
  const available = Boolean(shell?.recipeUse);
  const currentReady = !devices || devices.active.phase === 'ready' && device.mode === 'full'
    && (device.isRemote || devices.devices.find(row => row.id === devices.active.id)?.status === 'online');
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  useEffect(() => {
    let previous = connectionState(devices);
    return shell?.devices?.onState(state => {
      const next = connectionState(state);
      if (next !== previous) setConnectionEpoch(value => value + 1);
      previous = next;
    });
  }, [shell?.devices]);
  const currentScope = useMemo(() => ({account: account.status, deviceId: device.id, client, currentReady, connectionEpoch}), [account.status, device.id, client, currentReady, connectionEpoch]);
  function start(recipe: RecipeReference | RecipeDetail, target?: RecipeGroupTarget) {
    if (!available || !accountId) return;
    const reference = recipeReference(recipe);
    const matching = sessions.find(item => item.accountId === accountId && item.device.id === device.id && item.client === client
      && item.recipe.recipeId === reference.recipeId && item.recipe.versionId === reference.versionId
      && item.intentTarget?.botId === target?.botId && item.intentTarget?.groupId === target?.groupId);
    const next = matching ?? {id: ++sequence.current, recipe: reference, accountId, device, client, intentTarget: target, target, botId: target?.botId};
    const previous = sessions.find(item => item.id === display.selected && item.accountId === accountId);
    if (previous && previous.id !== next.id) {
      setDisplay({kind: 'choice', selected: previous.id, previous, next});
      return;
    }
    activate(next);
  }
  function activate(next: RecipeUseSession) {
    setSessions(items => items.some(item => item.id === next.id) ? items : [...items.slice(1 - SESSION_SUMMARY_LIMIT), next]);
    setDisplay({kind: 'session', selected: next.id});
  }
  function update(session: RecipeUseSession, change: Partial<RecipeUseSession>) {
    setSessions(items => items.map(item => item.id === session.id ? {...item, ...change} : item));
  }
  function finish(session: RecipeUseSession) {
    setSessions(items => items.filter(item => item.id !== session.id));
    setDisplay(current => current.kind === 'session' && current.selected === session.id ? {kind: 'closed'} : current);
    setRefreshVersion(value => value + 1);
  }
  const session = sessions.find(item => item.id === display.selected);
  const currentChoice = display.kind === 'choice' && display.previous.accountId === accountId && display.next.accountId === accountId && display.next.device.id === device.id && display.next.client === client ? {previous: session ?? display.previous, previousClosed: !session, next: display.next} : undefined;
  return <Context.Provider value={{start, available, refreshVersion}}>
    {children}
    {shell?.recipeUse && session && <RecipeUseSessionView key={session.id} session={session} visible={display.kind === 'session'}
      currentAccountId={accountId} currentDeviceId={device.id} currentClient={client} currentScope={currentScope} currentReady={currentReady}
      request={request => shell.recipeUse!.request(request)} onSelectBot={botId => update(session, {botId})}
      onSelectGroup={groupId => {if (session.botId) update(session, {target: {botId: session.botId, groupId: groupIdSchema.parse(groupId)}});}}
      onSummary={summary => setSessions(items => {
        const previous = items.find(item => item.id === session.id)?.summary;
        if (previous?.botName === summary?.botName && previous?.groupId === summary?.groupId) return items;
        return items.map(item => item.id === session.id ? {...item, summary} : item);
      })}
      onClose={() => {setDisplay({kind: 'closed', selected: session.botId ? session.id : undefined}); if (!session.botId) setSessions(items => items.filter(item => item.id !== session.id));}}
      onFinished={() => finish(session)}/>}
    {currentChoice && <RecipeIntentChoice currentScope={currentScope} currentReady={currentReady} choice={currentChoice} onClose={() => setDisplay({kind: 'closed', selected: currentChoice.previousClosed ? undefined : currentChoice.previous.id})} onSelect={activate}/>}
  </Context.Provider>;
}

function RecipeIntentChoice({choice, currentScope, currentReady, onClose, onSelect}: {currentScope: object; currentReady: boolean; choice: {previous: RecipeUseSession; previousClosed: boolean; next: RecipeUseSession}; onClose: () => void; onSelect: (session: RecipeUseSession) => void}) {
  const {snapshot, scope} = useRecipeTargetSnapshot(choice.next.client, currentScope, currentReady);
  const ready = currentReady && snapshot?.host.kind === 'connected' && !snapshot.stale;
  return <Dialog open title="选择本次应用目标" onClose={onClose} footer={<>
    <Button disabled={choice.previousClosed || !ready} onClick={() => onSelect(choice.previous)}>继续旧目标</Button>
    <Button variant="primary" disabled={!ready} onClick={() => onSelect(choice.next)}>开始当前目标</Button>
  </>}>
    <p>你选择了不同的应用目标。旧操作会保留，可从原配方和目标继续核对；开始当前目标不会取消旧操作。尚未提交的入群表单需要重新填写。</p>
    {choice.previousClosed && <p role="status">旧操作已结束。请明确选择是否开始当前目标。</p>}
    {!ready && <p role="status">目标设备暂不可用。连接恢复后，请重新核对目标。</p>}
    <h3>旧目标</h3><RecipeIntentSummary connectionScope={scope} session={choice.previous} snapshot={choice.previous.client === choice.next.client ? snapshot : undefined}/>
    <h3>当前目标</h3><RecipeIntentSummary connectionScope={scope} session={choice.next} snapshot={snapshot}/>
  </Dialog>;
}
function RecipeIntentSummary({session, snapshot, connectionScope}: {session: RecipeUseSession; snapshot?: DesktopSnapshot; connectionScope: object}) {
  const groupId = session.target?.groupId ?? session.summary?.groupId;
  const scope = useMemo(() => ({session, connectionScope}), [session, connectionScope]);
  const identity = useRecipeGroupIdentity({client: session.client, scope, snapshot, botId: session.botId, groupId, enabled: snapshot?.host.kind === 'connected' && !snapshot.stale});
  const localName = snapshot?.memberships.find(member => member.agentId === session.botId && member.groupId === groupId)?.name;
  return <p className="recipe-use-target">{session.recipe.name} · {session.recipe.version} · {session.device.name}<br/>
    Bot：{snapshot?.agents.find(agent => agent.id === session.botId)?.name ?? session.summary?.botName ?? session.botId ?? '待选择'}<br/>
    群聊：{identity.name ?? (groupId ? '待核对飞书群名' : '待选择')}{groupId && `（${groupId}）`}{localName && <><br/>本地名称：{localName}</>}</p>;
}

function RecipeUseSessionView({session, visible, currentAccountId, currentDeviceId, currentClient, currentScope, currentReady, request, onSelectBot, onSelectGroup, onSummary, onClose, onFinished}: {
  session: RecipeUseSession; visible: boolean; currentAccountId?: string; currentDeviceId: string; currentClient: VonvonClient; currentScope: object; currentReady: boolean;
  request: (request: RecipeUseRequest) => Promise<RecipeUseReply>; onSelectBot: (id: AgentId) => void; onClose: () => void; onFinished: () => void;
  onSelectGroup: (groupId: string) => void;
  onSummary: (summary: RecipeUseSession['summary']) => void;
}) {
  const accountChanged = currentAccountId !== session.accountId;
  const deviceChanged = currentDeviceId !== session.device.id || currentClient !== session.client;
  const {snapshot, scope: snapshotScope, isCurrent} = useRecipeTargetSnapshot(session.client, currentScope, !accountChanged && !deviceChanged && currentReady);
  const [reply, setReply] = useState<RecipeUseReply>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [acceptedResolution, setAcceptedResolution] = useState<Extract<RecipeUseRequest, {type: 'resolve'}>['resolution']>();
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const begunTarget = useRef<string | undefined>(undefined);
  const lease = useRef<{epoch: number; state: 'initial' | 'ready' | 'paused' | 'recover'}>({epoch: 0, state: 'initial'});
  const observedScope = useRef(snapshotScope);
  const unavailable = !currentReady || !snapshot || snapshot.host.kind !== 'connected' || snapshot.stale;
  const paused = accountChanged || deviceChanged || unavailable;
  if (paused && lease.current.state !== 'paused') {lease.current = {epoch: lease.current.epoch + 1, state: 'paused'};}
  else if (!paused && lease.current.state === 'paused') lease.current.state = begunTarget.current ? 'recover' : 'initial';
  else if (!paused && begunTarget.current && observedScope.current !== snapshotScope) lease.current = {epoch: lease.current.epoch + 1, state: 'recover'};
  observedScope.current = snapshotScope;
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);

  async function send(input: RecipeUseRequest) {
    if (inFlight.current || paused || !isCurrent() || input.type !== 'begin' && lease.current.state !== 'ready') return;
    const epoch = lease.current.epoch;
    inFlight.current = true; setBusy(true); setError(undefined);
    try {
      const result = await request(input);
      if (!mounted.current || !isCurrent() || lease.current.epoch !== epoch) return;
      if (result.kind === 'closed') {onFinished(); return;}
      setReply(result); lease.current.state = 'ready';
      setAcceptedResolution(input.type === 'resolve' && result.kind === 'prepared' ? input.resolution : undefined);
    } catch (failure) {
      if (mounted.current && isCurrent() && lease.current.epoch === epoch) {setError(failure instanceof Error ? failure.message : '暂时无法确认结果，请恢复原操作。'); lease.current.state = 'recover';}
    } finally {inFlight.current = false; if (mounted.current) setBusy(false);}
  }
  function begin() {
    if (!session.botId) return;
    return send({type: 'begin', ...(session.recipe.format ? {format:session.recipe.format} : {}), accountId: session.accountId, viewId: session.device.id, recipeId: session.recipe.recipeId,
      versionId: session.recipe.versionId, botId: session.botId, ...(session.target ? {groupId: session.target.groupId} : {})});
  }
  useEffect(() => {
    const target = JSON.stringify([session.botId, session.target?.groupId]);
    if (!session.botId || begunTarget.current === target || paused || lease.current.state === 'recover') return;
    begunTarget.current = target;
    void begin();
  }, [session.botId, session.target?.groupId, paused]);
  const needsRecovery = lease.current.state === 'recover';
  const groupId = reply && 'groupId' in reply && reply.groupId ? reply.groupId : reply?.kind === 'pending' && reply.phase === 'joining' ? reply.recovery?.groupId ?? session.target?.groupId : session.target?.groupId;
  const draftKey = JSON.stringify([session.botId, session.target?.groupId, groupId, reply?.kind === 'review' || reply?.kind === 'prepared' ? reply.review.reviewToken : reply?.kind]);
  const botName = snapshot?.agents.find(agent => agent.id === session.botId)?.name;
  const identity = useRecipeGroupIdentity({client: session.client, scope: snapshotScope, snapshot, botId: session.botId, groupId, enabled: !paused});
  const groupName = identity.name;
  useEffect(() => {if (snapshot) onSummary({botName, groupId});}, [snapshot, botName, groupId]);
  return <ClientProvider client={session.client} device={session.device}>
    <DraftGuardProvider><RecipeUseDialog key={draftKey} session={session} snapshot={snapshot} visible={visible} reply={reply} error={error} busy={busy}
      paused={paused} accountChanged={accountChanged} unavailable={unavailable && !deviceChanged} needsRecovery={needsRecovery} acceptedResolution={acceptedResolution}
      onSelectBot={onSelectBot} onSelectGroup={onSelectGroup} onClose={onClose} onRecover={() => void begin()}
      onRequest={input => send(input)} groupId={groupId} groupName={groupName} groupNameError={identity.error} onRefreshGroupName={identity.refresh}/></DraftGuardProvider>
  </ClientProvider>;
}
