import {useEffect, useRef, useState, type ReactNode} from 'react';
import type {AgentId, DesktopAuthoringReply, DesktopAuthoringRequest, DesktopSnapshot, GroupId, RecipeAuthoringShell, ViewId} from '@vonvon/protocol';
import {useAccount} from '../../account-context';
import {useActiveDevice, useClient, useDevicesState, useShellCapabilities} from '../../client-context';
import {GlowButton} from '../../GlowButton';
import {Button} from '../../reference/components/ui';
import {Dialog} from '../../reference/components/ui/Dialog';
import {OPEN_SETTING_EVENT} from '../../search';
import {botChatUrl, openExternalUrl} from '../../url-actions';
import {CopyButton} from '../RecipeContent';
import './authoring.css';

type ContinueRequest = Extract<DesktopAuthoringRequest, {type: 'creatorContinue'}>;
type SourceChoice = NonNullable<ContinueRequest['source']>;
type Session = Extract<DesktopAuthoringReply, {kind: 'session'}>;
type Challenge = Extract<DesktopAuthoringReply, {kind: 'challenge'}>;
type Link = Extract<DesktopAuthoringReply, {kind: 'link'}>;
export type AuthoringSource = {botId: AgentId; groupId: GroupId};
type Props = {
  source?: AuthoringSource;
  draft?: {draftId: string; revision: number};
  parent?: {recipeId: string; versionId: string};
  onBack: () => void;
  onWorkspace: () => void;
};
type Flow =
  | {kind: 'pending'}
  | Extract<DesktopAuthoringReply, {kind: 'creatorSourceRequired' | 'creatorContinuing'}>
  | {kind: 'link'; session: Session; challenge: Challenge; link?: Link};
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : '暂时无法连接来源 Bot。';
const detach = (shell: RecipeAuthoringShell, handle: string) => void shell.request({type: 'detach', handle}).catch(() => {});

function SourceDialog({title, onBack, footer, children}: {title: string; onBack: () => void; footer?: ReactNode; children: ReactNode}) {
  return <Dialog open size="lg" title={title} onClose={onBack} footer={footer}><div className="recipe-source-dialog">{children}</div></Dialog>;
}

function useSnapshot() {
  const client = useClient(), device = useActiveDevice();
  const [read, setRead] = useState<{client: typeof client; viewId: ViewId; snapshot: DesktopSnapshot}>();
  useEffect(() => {
    let active = true;
    const stop = client.watchSnapshots(snapshot => {if (active) setRead({client, viewId: device.id, snapshot});});
    return () => {active = false; stop();};
  }, [client, device.id]);
  return read?.client === client && read.viewId === device.id ? read.snapshot : undefined;
}

export function RecipeAuthoringPage(props: Props) {
  const account = useAccount(), device = useActiveDevice(), shell = useShellCapabilities()?.recipeAuthoring;
  const snapshot = useSnapshot();
  const title = props.draft ? '在飞书继续创作' : props.parent ? '创作新版本' : '分享配方';
  if (account.status?.kind !== 'signedIn') return <SourceDialog title={title} onBack={props.onBack} footer={<GlowButton variant="dark" disabled={!account.supported} onClick={() => void account.login()}>登录</GlowButton>}><p>登录后可以在自己的 Bot 私聊中创作和发布配方。</p></SourceDialog>;
  if (!shell) return <SourceDialog title={title} onBack={props.onBack}><p>此设备暂不支持私聊创作，请更新桌面应用。</p></SourceDialog>;
  const accountId = account.status.accountId;
  const entry: ContinueRequest['entry'] | undefined = props.draft ? {kind: 'draft', draftId: props.draft.draftId, revision: props.draft.revision} : props.parent && !props.source ? {kind: 'version', ...props.parent} : undefined;
  const scope = JSON.stringify([accountId, device.id, entry, props.source]);
  return entry
    ? <ContinueFlow key={scope} {...props} title={title} shell={shell} accountId={accountId} entry={entry} viewId={device.id} snapshot={snapshot}/>
    : <SourcePicker key={scope} {...props} title={title} shell={shell} accountId={accountId} viewId={device.id} snapshot={snapshot}/>;
}

function SourcePicker(props: Props & {title: string; shell: RecipeAuthoringShell; accountId: string; viewId: ViewId; snapshot?: DesktopSnapshot}) {
  const {snapshot, source, viewId, title, onBack} = props;
  const [botId, setBotId] = useState<AgentId>();
  const [groupId, setGroupId] = useState<GroupId>();
  const sourceIncarnation = useRef<string | undefined>(undefined);
  const [selection, setSelection] = useState<{entry: Extract<ContinueRequest['entry'], {kind: 'source'}>; incarnation: string}>();
  const bots = snapshot?.agents.filter(bot => bot.running) ?? [];
  const bindings = snapshot?.memberships.filter(binding => !binding.stale && binding.enabled && bots.some(bot => bot.id === binding.agentId) && snapshot.groups.some(group => group.id === binding.groupId)) ?? [];
  const availableBots = bots.filter(bot => bindings.some(binding => binding.agentId === bot.id));
  const bot = availableBots.find(bot => bot.id === (source?.botId ?? botId ?? (availableBots.length === 1 ? availableBots[0]?.id : undefined)));
  const memberships = bindings.filter(binding => binding.agentId === bot?.id);
  const membership = memberships.find(binding => binding.groupId === (source?.groupId ?? groupId ?? (memberships.length === 1 ? memberships[0]?.groupId : undefined)));
  const group = snapshot?.groups.find(group => group.id === membership?.groupId);
  const ready = snapshot?.host.kind === 'connected' && !snapshot.stale;
  const incarnation = JSON.stringify([bot?.registrationId, bot?.registeredAt, membership?.bindingIncarnation]);
  const chosen = bot && group ? {kind: 'source', viewId, botId: bot.id, groupId: group.id, ...(props.parent && {parent: props.parent})} satisfies ContinueRequest['entry'] : undefined;
  if (source && ready && chosen && sourceIncarnation.current === undefined) sourceIncarnation.current = incarnation;
  const entry = source ? chosen : selection?.entry;
  if (ready && entry && chosen && entry.botId === chosen.botId && entry.groupId === chosen.groupId && (!selection || selection.incarnation === incarnation) && (!source || sourceIncarnation.current === incarnation)) return <ContinueFlow {...props} entry={entry}/>;
  const problem = !snapshot ? '正在读取 Bot 与群聊…' : !ready ? '来源设备暂不可用，请恢复连接后再试。' : source || selection ? '原 Bot 或群绑定已变化，请回到群组核对来源。' : !availableBots.length ? '当前设备没有可分享的群内 Bot。请先连接 Bot 与群聊。' : undefined;
  return <SourceDialog title={title} onBack={onBack} footer={<><Button onClick={onBack}>取消</Button>{problem && ready ? <GlowButton variant="dark" onClick={() => {onBack(); window.dispatchEvent(new CustomEvent(OPEN_SETTING_EVENT, {detail: {page: 'collaboration', view: bots.length ? 'groups' : 'agents'}}));}}>前往{bots.length ? '群组' : 'Bot'}</GlowButton> : <GlowButton variant="dark" disabled={!chosen || Boolean(problem)} onClick={() => {if (chosen) setSelection({entry: chosen, incarnation});}}>在飞书继续</GlowButton>}</>}>
    <p>选择要在私聊中整理和分享的群内 Bot 配置。</p>
    {problem ? <p role="status">{problem}</p> : <div className="recipe-source-fields"><label>Bot<select aria-label="配方来源 Bot" value={bot?.id ?? ''} onChange={event => {setBotId(availableBots.find(bot => bot.id === event.target.value)?.id); setGroupId(undefined);}}><option value="">选择 Bot</option>{availableBots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label><label>群聊<select aria-label="配方来源群聊" value={group?.id ?? ''} onChange={event => setGroupId(memberships.find(binding => binding.groupId === event.target.value)?.groupId)}><option value="">选择群聊</option>{memberships.map(binding => <option key={binding.groupId} value={binding.groupId}>{snapshot?.groups.find(group => group.id === binding.groupId)?.name}</option>)}</select></label></div>}
    <p className="recipe-source-help">创作内容仅自己可见。在私聊中修改，再从卡片打开 App 预览，或直接确认发布。</p>
  </SourceDialog>;
}

function ContinueFlow({shell, accountId, entry, title, onBack, onWorkspace, viewId, snapshot}: Props & {shell: RecipeAuthoringShell; accountId: string; entry: ContinueRequest['entry']; title: string; viewId: ViewId; snapshot?: DesktopSnapshot}) {
  const capabilities = useShellCapabilities();
  const devices = useDevicesState();
  const [flow, setFlow] = useState<Flow>({kind: 'pending'});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const active = useRef(false), locked = useRef(false);
  const association = useRef<Session | undefined>(undefined);
  const selectedSource = useRef<SourceChoice | undefined>(undefined);
  async function continueInChat(source?: SourceChoice) {
    selectedSource.current = source;
    const reply = await shell.request({type: 'creatorContinue', accountId, entry, ...(source && entry.kind !== 'source' && {source})});
    if (!active.current) return;
    if (reply.kind !== 'creatorContinuing' && reply.kind !== 'creatorSourceRequired') throw new Error('未能确认私聊创作来源，请重试。');
    if (reply.kind === 'creatorContinuing' && (reply.accountId !== accountId || source && (reply.viewId !== source.viewId || reply.botId !== source.botId) || entry.kind === 'source' && (reply.viewId !== entry.viewId || reply.botId !== entry.botId))) throw new Error('私聊创作来源已变化，请重新核对。');
    if (reply.kind === 'creatorContinuing' && association.current) {detach(shell, association.current.handle); association.current = undefined;}
    setFlow(reply);
  }
  async function associate(source: SourceChoice) {
    selectedSource.current = source;
    const reply = await shell.request({type: 'open', accountId, ...source, ...(entry.kind === 'source' && {groupId: entry.groupId})});
    if (reply.kind !== 'session') throw new Error('暂时无法关联来源 Bot。');
    if (!active.current) {detach(shell, reply.handle); return;}
    if (reply.target.accountId !== accountId || reply.target.viewId !== source.viewId || reply.target.botId !== source.botId) {detach(shell, reply.handle); throw new Error('关联来源已变化，请重新核对。');}
    if (association.current && association.current.handle !== reply.handle) detach(shell, association.current.handle);
    association.current = reply;
    if (reply.linked) {await continueInChat(source); return;}
    const challenge = await shell.request({type: 'beginLink', handle: reply.handle});
    if (!active.current) return;
    if (challenge.kind !== 'challenge') throw new Error('未能准备私聊关联，请重试。');
    setNow(Date.now());
    setFlow({kind: 'link', session: reply, challenge});
  }
  async function start() {
    if (entry.kind === 'source') await associate({viewId: entry.viewId, botId: entry.botId});
    else await continueInChat(selectedSource.current);
  }
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(undefined);
    try {await action();} catch (reason) {if (active.current) setError(errorMessage(reason));}
    finally {locked.current = false; if (active.current) setBusy(false);}
  }
  useEffect(() => {
    active.current = true;
    void run(start);
    return () => {active.current = false; if (association.current) detach(shell, association.current.handle);};
  }, []);
  useEffect(() => {
    if (flow.kind !== 'link') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [flow.kind]);
  const expired = flow.kind === 'link' && now >= flow.challenge.expiresAt;
  const command = flow.kind === 'link' ? `/recipe link ${flow.challenge.code}` : '';
  const tenant = flow.kind === 'link' && flow.session.target.viewId === viewId
    ? snapshot?.agents.find(bot => bot.id === flow.session.target.botId)?.tenant : undefined;
  async function inspectRecipient() {
    if (flow.kind !== 'link' || Date.now() >= flow.challenge.expiresAt) return;
    const reply = await shell.request({type: 'inspectLink', handle: flow.session.handle, challengeId: flow.challenge.challengeId});
    if (!active.current) return;
    if (reply.kind !== 'link') throw new Error('尚未确认私聊收件人。');
    setFlow({...flow, link: reply});
    if (!reply.recipient) setError('尚未收到关联命令，请检查是否发给了这个 Bot。');
  }
  async function confirmRecipient() {
    if (flow.kind !== 'link' || !flow.link?.evidence || Date.now() >= flow.challenge.expiresAt) return;
    const reply = await shell.request({type: 'confirmLink', handle: flow.session.handle, challengeId: flow.challenge.challengeId, evidence: flow.link.evidence});
    if (!active.current) return;
    if (reply.kind !== 'link' || !reply.linked) throw new Error('尚未确认私聊关联。');
    await continueInChat(selectedSource.current);
  }
  const footer = flow.kind === 'creatorContinuing' ? <>
    <Button onClick={onWorkspace}>查看我的配方</Button>
    <GlowButton variant="dark" onClick={onBack}>完成</GlowButton>
  </> : flow.kind === 'link' ? <>
    <Button disabled={busy} onClick={onBack}>稍后继续</Button>
    {tenant && <Button onClick={() => void run(() => openExternalUrl(botChatUrl(flow.session.target.botId, tenant), 'bot-chat', capabilities))}>打开 Bot 私聊</Button>}
    {expired ? <GlowButton variant="dark" disabled={busy} onClick={() => void run(start)}>重新关联</GlowButton>
      : flow.link?.recipient && flow.link.evidence
        ? <GlowButton variant="dark" disabled={busy} onClick={() => void run(confirmRecipient)}>确认是我的私聊</GlowButton>
        : <GlowButton variant="dark" disabled={busy} onClick={() => void run(inspectRecipient)}>我已发送，核对收件人</GlowButton>}
  </> : <>
    <Button onClick={onBack}>关闭</Button>
    {(error || flow.kind === 'creatorSourceRequired' && !flow.options.length) && <GlowButton variant="dark" disabled={busy} onClick={() => void run(start)}>重试连接</GlowButton>}
  </>;
  return <SourceDialog title={title} onBack={onBack} footer={footer}>
    {flow.kind === 'pending' && <p role="status">{busy ? '正在连接私聊创作…' : '私聊连接尚未完成。'}</p>}
    {flow.kind === 'creatorContinuing' && <>
      <p>可以回到 Bot 私聊继续创作。</p>
      <p className="recipe-source-help">在私聊中修改内容，再从卡片打开 App 查看完整预览，或直接确认发布。App 预览页也可以发布。未发布内容会保存在「我的配方」。</p>
    </>}
    {flow.kind === 'creatorSourceRequired' && <>
      <p>这份作品尚未找到确切的来源。请选择已关联的 Bot，继续由本人核对。</p>
      {flow.options.length ? <div className="authoring-source-list">{flow.options.map(option => <Button
        key={JSON.stringify([option.viewId, option.botId])}
        disabled={busy}
        onClick={() => void run(() => continueInChat({viewId: option.viewId, botId: option.botId}))}
      >{option.botName}<small>{devices?.devices.find(device => device.id === option.viewId)?.name ?? (option.viewId === 'local' ? '这台电脑' : '未登记的来源设备')}</small></Button>)}</div>
        : <p>没有可用来源。请恢复原设备和 Bot 的连接后重试。</p>}
    </>}
    {flow.kind === 'link' && <>
      <p>首次使用需要关联你的本人私聊。向「{flow.session.target.botName}」的私聊发送下方命令，再核对实际收件人。</p>
      <label className="authoring-command">关联命令<input readOnly value={command} aria-label="私聊关联命令" onFocus={event => event.target.select()}/></label>
      <CopyButton value={command} label="复制关联命令"/>
      {flow.link?.recipient && <dl className="recipe-source-fixed">
        <dt>飞书身份</dt><dd>{flow.link.recipient.openId}</dd>
        <dt>私聊</dt><dd>{flow.link.recipient.chatId}</dd>
        <dt>租户</dt><dd>{flow.link.recipient.tenantKey}</dd>
      </dl>}
      {expired && <p role="status">关联命令已过期，请重新关联。</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </SourceDialog>;
}
