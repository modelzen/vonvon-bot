import {useEffect, useMemo, useRef, useState} from 'react';
import type {DesktopAuthoringOperation, DesktopAuthoringReply, DesktopAuthoringRequest, DesktopSnapshot, RecipeDraft, RecipeAuthoringShell, AgentId, GroupId} from '@vonvon/protocol';
import {useAccount} from '../../account-context';
import {useActiveDevice, useClient, useShellCapabilities} from '../../client-context';
import {Button, InlineNotice} from '../../reference/components/ui';
import {GroupSourceHistory} from './GroupSourceHistory';
import {CopyButton, RecipeConfiguration, RecipeMarkdown, RecipeMetadata} from '../RecipeContent';
import {botChatUrl, groupUrl, openExternalUrl} from '../../url-actions';
import './authoring.css';

type Session = Extract<DesktopAuthoringReply, {kind: 'session'}>;
type Challenge = Extract<DesktopAuthoringReply, {kind: 'challenge'}>;
type Link = Extract<DesktopAuthoringReply, {kind: 'link'}>;
type Source = Extract<DesktopAuthoringReply, {kind: 'source'}>;
type Candidate = Extract<DesktopAuthoringReply, {kind: 'candidate'}>;
export type AuthoringSource = {botId: AgentId; groupId: GroupId};
type DraftTarget = Pick<RecipeDraft, 'draftId' | 'revision'>;
type Props = {source?: AuthoringSource; draft?: DraftTarget; onSaved: (draftId: string, revision: number) => void; onBack?: () => void};

export function authoringPending(operation: DesktopAuthoringOperation) {
  return !['completed', 'cancelled', 'expired'].includes(operation.state);
}
export const authoringStateText: Record<DesktopAuthoringOperation['state'], string> = {
  pendingMain: '正在核验账号与来源', sending: '正在发送飞书卡片', waiting: '等待本人在飞书操作',
  candidate: '等待本人在飞书确认候选', pendingCloud: '飞书已确认，等待保存到账号', completed: '私人草稿已保存',
  cancelPending: '正在取消，等待云端确认', cancelled: '已取消', expired: '请求已到期', needsReview: '来源或权限已变化，需要重新核对',
};

export function RecipeAuthoringPage(props: Props) {
  const account = useAccount();
  const device = useActiveDevice();
  const client = useClient();
  const lease = useMemo(() => ({client, deviceId: device.id}), [client, device.id]);
  const [read, setRead] = useState<{lease: typeof lease; snapshot: DesktopSnapshot}>();
  useEffect(() => {let active = true; const stop = client.watchSnapshots(snapshot => {if (active) setRead({lease, snapshot});}); return () => {active = false; stop();};}, [lease, client]);
  const accountId = account.status?.kind === 'signedIn' ? account.status.accountId : undefined;
  if (!accountId) return <section className="recipe-authoring"><h2>登录后分享</h2><p>私人草稿保存在你的账号中，只有你能看到。</p>{account.error && <p role="alert">{account.error}</p>}<Button variant="primary" disabled={!account.supported || account.status?.kind === 'signingIn'} onClick={() => void account.login()}>登录</Button></section>;
  return <AuthoringSelection key={`${accountId}:${device.id}`} {...props} accountId={accountId} snapshot={read?.lease === lease ? read.snapshot : undefined}/>;
}

function AuthoringSelection({source, draft, onSaved, onBack, accountId, snapshot}: Props & {accountId: string; snapshot?: DesktopSnapshot}) {
  const device = useActiveDevice();
  const shell = useShellCapabilities()?.recipeAuthoring;
  const [selected, setSelected] = useState<AuthoringSource | {botId: AgentId} | undefined>(source);
  const [confirmed, setConfirmed] = useState(Boolean(source));
  const bots = snapshot?.agents.filter(bot => bot.running) ?? [];
  const groups = snapshot?.memberships.filter(member => !member.stale && bots.some(bot => bot.id === member.agentId) && snapshot.groups.some(group => group.id === member.groupId)) ?? [];
  const valid = selected && bots.some(bot => bot.id === selected.botId) && (draft || 'groupId' in selected && groups.some(member => member.agentId === selected.botId && member.groupId === selected.groupId));
  const bot = bots.find(bot => bot.id === selected?.botId);
  const binding = groups.find(member => selected && 'groupId' in selected && member.agentId === selected.botId && member.groupId === selected.groupId);
  const group = selected && 'groupId' in selected ? snapshot?.groups.find(group => group.id === selected.groupId) : undefined;
  if (!shell) return <InlineNotice title="此设备暂不支持聊天草稿" tone="warning">请更新桌面应用和来源设备的 Vonvon Bot 后重试。</InlineNotice>;
  return <section className="recipe-authoring" aria-label={draft ? '在飞书继续编辑草稿' : '准备分享本群配方'}>
    <header className="community-heading"><div><h2>{draft ? '在飞书继续编辑' : source ? '分享这个群的配方' : '选择要分享的群聊'}</h2><p>{draft ? '选择当前设备上的 Bot，把这份草稿交给经过验证的本人私聊。' : '从已绑定群聊准备私人草稿，再核对内容与公开介绍。保存草稿不会发布，也不会改变群设置。'}</p></div>{onBack && <Button variant="ghost" onClick={onBack}>返回创作中心</Button>}</header>
    <p className="community-muted">来源设备：{device.name}</p>
    {!snapshot ? <p role="status">正在读取当前设备的 Bot 与群聊…</p> : snapshot.host.kind !== 'connected' || snapshot.stale ? <InlineNotice title="来源设备暂不可用" tone="warning">请恢复当前设备连接后再核对。已有草稿仍保留在账号中。</InlineNotice> : <>
      {!confirmed && <><div className="authoring-source-list" role="group" aria-label={draft ? '选择草稿编辑 Bot' : '选择分享来源'}>
        {draft ? bots.map(bot => <button type="button" key={bot.id} aria-pressed={selected?.botId === bot.id} onClick={() => setSelected({botId: bot.id})}><strong>{bot.name}</strong><small>{device.name}</small></button>) : groups.map(member => <button type="button" key={member.id} aria-pressed={selected?.botId === member.agentId && 'groupId' in selected && selected.groupId === member.groupId} onClick={() => setSelected({botId: member.agentId, groupId: member.groupId})}><strong>{snapshot.groups.find(group => group.id === member.groupId)!.name}</strong><small>{bots.find(bot => bot.id === member.agentId)!.name} · {device.name}</small></button>)}
      </div>{!(draft ? bots.length : groups.length) && <InlineNotice title={draft ? '没有可用的 Bot' : '没有可分享的已绑定群聊'}>请先在当前设备启动 Bot，并完成群聊绑定。这里不会新建群聊。</InlineNotice>}<div><Button variant="primary" disabled={!valid} onClick={() => setConfirmed(true)}>{draft ? '确认编辑 Bot' : '核对所选群聊'}</Button></div></>}
      {confirmed && valid && bot && <AuthoringFlow key={`${device.id}:${accountId}:${bot.id}:${group?.id ?? draft?.draftId ?? ''}:${bot.tenant ?? ''}:${bot.registeredAt ?? ''}:${bot.registrationId ?? ''}:${binding?.bindingIncarnation ?? ''}`} shell={shell} accountId={accountId} botId={bot.id} botName={bot.name} tenant={bot.tenant} groupId={group?.id} groupHistory={Boolean(source)} groupName={group?.name} draft={draft} onSaved={onSaved} onChangeSource={source ? undefined : () => setConfirmed(false)}/>}
      {confirmed && !valid && <InlineNotice title="当前来源已不可用" tone="warning">Bot 已停止或群绑定已变化。请恢复来源后重新进入分享。</InlineNotice>}
    </>}
  </section>;
}

function AuthoringFlow({shell, accountId, botId, botName, tenant, groupId, groupHistory, groupName, draft, onSaved, onChangeSource}: {
  shell: RecipeAuthoringShell; accountId: string; botId: AgentId; botName: string; tenant?: 'feishu' | 'lark'; groupId?: GroupId; groupHistory: boolean; groupName?: string; draft?: DraftTarget;
  onSaved: Props['onSaved']; onChangeSource?: () => void;
}) {
  const device = useActiveDevice();
  const capabilities = useShellCapabilities();
  const [session, setSession] = useState<Session>();
  const [challenge, setChallenge] = useState<Challenge>();
  const [link, setLink] = useState<Link>();
  const [source, setSource] = useState<Source>();
  const [attested, setAttested] = useState(false);
  const [candidate, setCandidate] = useState<Candidate>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(Date.now());
  const live = useRef(false);
  const lock = useRef(false);
  const sessionRef = useRef<Session | undefined>(undefined);
  const lifetime = useRef(0);
  const watched = useRef(new Set<string>());
  const onSavedRef = useRef(onSaved); onSavedRef.current = onSaved;
  const notified = useRef(new Set<string>());
  function remember(next: Session) {sessionRef.current = next; setSession(next);}
  function operation(next: DesktopAuthoringOperation) {
    const current = sessionRef.current;
    if (current) remember({...current, operations: current.operations.some(item => item.operationId === next.operationId) ? current.operations.map(item => item.operationId === next.operationId ? next : item) : [...current.operations, next]});
  }
  useEffect(() => {
    if (paused) return;
    live.current = true; ++lifetime.current; lock.current = false; setBusy(false);
    let active = true;
    let handle: string | undefined;
    setError(undefined);
    void shell.request({type: 'open', accountId, viewId: device.id, botId, ...(groupId && {groupId})}).then(reply => {
      if (reply.kind !== 'session') throw new Error('无法打开草稿操作。');
      handle = reply.handle;
      if (!active) {void shell.request({type: 'close', handle}).catch(() => {}); return;}
      for (const item of reply.operations) if (authoringPending(item)) watched.current.add(item.operationId);
      remember(reply);
    }).catch(error => {if (active) setError(message(error));});
    return () => {active = false; live.current = false; sessionRef.current = undefined; if (handle) void shell.request({type: 'detach', handle}).catch(() => {});};
  }, [shell, accountId, device.id, botId, groupId, retry, paused]);
  async function request(input: DesktopAuthoringRequest) {
    const owner = sessionRef.current;
    const epoch = lifetime.current;
    if (!owner || !('handle' in input) || input.handle !== owner.handle) return;
    const reply = await shell.request(input);
    if (!live.current || epoch !== lifetime.current || sessionRef.current?.handle !== owner.handle) return;
    if (reply.kind === 'session') remember(reply);
    else if (reply.kind === 'operation') {if (authoringPending(reply.operation)) watched.current.add(reply.operation.operationId); operation(reply.operation);}
    return reply;
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    const epoch = lifetime.current;
    lock.current = true; setBusy(true); setError(undefined); setNotice(undefined);
    try {await action();} catch (error) {if (live.current && epoch === lifetime.current) setError(message(error));}
    finally {if (live.current && epoch === lifetime.current) {lock.current = false; setBusy(false);}}
  }
  const operations = session?.operations.filter(item => draft ? item.draftId === draft.draftId || item.receipt?.status === 'accepted' && item.receipt.draftId === draft.draftId : item.groupId === groupId) ?? [];
  const pending = operations.some(authoringPending);
  const followChat = pending || Boolean(draft && session?.linked);
  useEffect(() => {
    if (!session || !followChat) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let delay = 2000;
    const poll = async () => {
      if (document.visibilityState === 'hidden') {timer = setTimeout(() => void poll(), 30000); return;}
      try {const reply = await shell.request({type: 'status', handle: session.handle}); if (active && reply.kind === 'session') {remember(reply); setError(undefined);}}
      catch (error) {if (active) setError(message(error));}
      if (active) {delay = Math.min(delay * 2, 30000); timer = setTimeout(() => void poll(), delay);}
    };
    timer = setTimeout(() => void poll(), delay);
    return () => {active = false; clearTimeout(timer);};
  }, [shell, session?.handle, followChat]);
  useEffect(() => {if (!challenge) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);}, [challenge]);
  useEffect(() => {
    for (const item of operations) {
      if (item.state !== 'completed' || item.receipt?.status !== 'accepted') continue;
      if (!watched.current.has(item.operationId) && (!draft || item.receipt.draftId !== draft.draftId || item.receipt.revision <= draft.revision)) continue;
      const receiptKey = `${item.receipt.draftId}:${item.receipt.revision}`;
      if (!notified.current.has(receiptKey)) {notified.current.add(receiptKey); onSavedRef.current(item.receipt.draftId, item.receipt.revision);}
    }
  }, [session]);
  const expired = challenge && now >= challenge.expiresAt;
  const handle = session?.handle;
  async function reconnect() {
    const epoch = lifetime.current;
    if (handle) await shell.request({type:'close',handle}).catch(() => {});
    if (!live.current || epoch !== lifetime.current) return;
    setSession(undefined); setSource(undefined); setAttested(false); setCandidate(undefined); setChallenge(undefined); setLink(undefined);
    setRetry(value => value + 1);
  }
  async function beginLink() {if (!handle) return; const reply = await request({type: 'beginLink', handle}); if (reply?.kind === 'challenge') {setChallenge(reply); setLink(undefined); setNow(Date.now());}}
  async function inspectLink() {if (!handle || !challenge) return; const reply = await request({type: 'inspectLink', handle, challengeId: challenge.challengeId}); if (reply?.kind === 'link') {setLink(reply); if (!reply.recipient) setNotice('尚未收到有效的本人私聊请求。请检查 Bot、短码和当前管理员身份。');}}
  async function reviewSource() {if (!handle || !groupId) return; setSource(undefined); setAttested(false); const reply = await request({type: 'reviewSource', handle, groupId}); if (reply?.kind === 'source') setSource(reply);}
  if (paused) return <InlineNotice title="聊天编辑已暂停" actions={<Button onClick={() => setPaused(false)}>重新核验并继续</Button>}>私人草稿仍保存在账号中。</InlineNotice>;
  return <div className="authoring-flow">
    {groupHistory && handle && groupId && <GroupSourceHistory key={handle} shell={shell} handle={handle} groupId={groupId}/>}
    <dl className="authoring-target"><div><dt>设备</dt><dd>{device.name}</dd></div><div><dt>Bot</dt><dd>{botName}</dd></div>{groupName && <div><dt>来源群聊</dt><dd>{groupName}</dd></div>}{session && <div><dt>账号</dt><dd>{session.target.accountName}</dd></div>}</dl>
    {tenant && <div><Button onClick={() => void openExternalUrl(botChatUrl(botId,tenant),'bot-chat',capabilities).catch(error => setError(message(error)))}>打开 Bot 私聊</Button></div>}
    {onChangeSource && <div><Button size="sm" variant="ghost" onClick={onChangeSource}>重新选择{draft ? ' Bot' : '群聊'}</Button></div>}
    {error && <InlineNotice title="草稿操作未完成" tone="warning" actions={<Button disabled={busy} onClick={() => void run(reconnect)}>重新核验</Button>}>{error}</InlineNotice>}
    {notice && <p role="status" className="community-muted">{notice}</p>}
    {!session && !error && <p role="status">正在核验账号、设备与 Bot 管理员身份…</p>}
    {session && !session.linked && <section className="authoring-step"><h3>关联本人飞书私聊</h3><p>使用当前 Bot 的管理员身份，在这个 Bot 的私聊发送关联命令，再回到 App 核对。不会按姓名或邮箱选择收件人。</p>
      {!challenge ? <Button variant="primary" disabled={busy} onClick={() => void run(beginLink)}>关联我的飞书私聊</Button> : <>
        <label className="authoring-command">发送给 {botName}<input aria-label="私聊关联命令" readOnly value={`/recipe link ${challenge.code}`}/></label><CopyButton key={challenge.challengeId} value={`/recipe link ${challenge.code}`} label="复制关联命令"/>
        <p className="community-muted" role="status">{expired ? '关联短码已到期，请重新获取。' : `短码将在 ${Math.max(1, Math.ceil((challenge.expiresAt - now) / 60000))} 分钟内到期。仅在所选 Bot 的本人私聊中使用。`}</p>
        <div className="community-actions"><Button disabled={busy || expired} onClick={() => void run(inspectLink)}>我已发送，核对收件人</Button><Button disabled={busy} onClick={() => void run(beginLink)}>重新获取短码</Button><Button disabled={busy} onClick={() => void run(async () => {if (!handle) return; await request({type:'close',handle}); if (!live.current) return; setSession(undefined); setChallenge(undefined); setLink(undefined); setRetry(value => value + 1); setNotice('已停止本次关联。旧短码不能再用于当前流程。');})}>取消关联</Button></div>
        {link?.recipient && <div className="authoring-identity"><h4>核对这是你的飞书身份</h4><p>以下信息来自所选 Bot 实际收到的私聊。只有你确认后才建立关联。</p><dl><dt>用户 Open ID</dt><dd>{link.recipient.openId}</dd><dt>租户</dt><dd>{link.recipient.tenantKey || '未提供'}</dd><dt>私聊 ID</dt><dd>{link.recipient.chatId}</dd></dl><div className="community-actions"><Button variant="primary" disabled={busy || expired || !link.evidence} onClick={() => void run(async () => {if (!handle || !challenge || !link.evidence) return; const reply = await request({type: 'confirmLink', handle, challengeId: challenge.challengeId, evidence: link.evidence}); if (reply?.kind === 'link' && reply.linked) {remember({...session, linked: true}); setChallenge(undefined); setLink(reply);}})}>确认是我的私聊</Button><Button disabled={busy} onClick={() => void run(beginLink)}>这不是我，重新关联</Button></div></div>}
      </>}
    </section>}
    {session?.linked && <section className="authoring-step"><h3>{draft ? '继续编辑这份草稿' : '核对要分享的内容'}</h3><p>Bot 只向已验证的本人私聊发送操作卡。首次支持文字角色与使用前准备；公开介绍由你填写。</p>
      {draft ? <><p className="community-muted">草稿 {draft.draftId} · 修订 {draft.revision}</p><Button variant="primary" disabled={busy || pending} onClick={() => void run(async () => {if (handle) await request({type: 'edit', handle, draftId: draft.draftId, baseRevision: draft.revision});})}>发送继续编辑卡片</Button></> : <>
        {!source ? <Button variant="primary" disabled={busy || pending} onClick={() => void run(reviewSource)}>读取并核对来源</Button> : <><p><strong>{source.groupName}</strong> · {source.target.botName}</p><h4>角色与规则</h4><pre className="authoring-preview">{source.role || '本群没有可导出的文字角色。'}</pre>{source.untracked && <InlineNotice title="请确认来源归属" tone="warning">这些文字没有可验证的配方来源。仅在你拥有分享权、且没有混入他人受限内容时继续。</InlineNotice>}<label className="community-checkbox"><input type="checkbox" checked={attested} onChange={event => setAttested(event.target.checked)}/>我已核对来源和内容，确认有权分享，且不包含私人信息或凭据</label><div className="community-actions"><Button variant="primary" disabled={busy || pending || !attested} onClick={() => void run(async () => {if (handle && groupId) await request({type: 'prepare', handle, groupId, reviewToken: source.reviewToken, sourceAttested: true});})}>发送私人草稿卡片</Button><Button disabled={busy} onClick={() => void run(reviewSource)}>重新读取来源</Button></div></>}
      </>}
    </section>}
    {operations.length > 0 && <section className="authoring-step"><h3>{draft ? '此草稿的聊天编辑' : '本群的分享草稿'}</h3><div className="authoring-operations">{[...operations].sort((a,b) => b.createdAt - a.createdAt).map(item => <article className="authoring-operation" key={item.operationId}><h4>{item.purpose === 'editDraft' ? '继续编辑私人草稿' : '从本群准备私人草稿'}</h4><p role="status">{item.contextPaused ? '聊天编辑已暂停，原请求仍保留' : authoringStateText[item.state]}</p>{item.syncMessage && <p className="community-muted">{item.syncMessage}</p>}{item.deliveryUnknown && <InlineNotice title="飞书投递结果待核实" tone="warning">原卡片可能已送达。先检查本人私聊；明确重新发卡会使旧卡片失效。</InlineNotice>}{item.receipt?.status === 'accepted' && <><p className="community-muted">草稿 {item.receipt.draftId} · 修订 {item.receipt.revision}</p><Button onClick={() => {if (item.receipt?.status === 'accepted') onSaved(item.receipt.draftId, item.receipt.revision);}}>打开同一份私人草稿</Button></>}
      {authoringPending(item) && <div className="community-actions">{link?.recipient && <Button onClick={() => void openExternalUrl(groupUrl(link.recipient!.chatId), 'group', capabilities).catch(error => setError(message(error)))}>打开本人私聊</Button>}<Button disabled={busy} onClick={() => void run(async () => {if (handle) await request({type: 'resume', handle, operationId: item.operationId});})}>重新核验并继续</Button>{['sending','waiting','candidate'].includes(item.state) && <Button disabled={busy} onClick={() => void run(async () => {if (handle) {await request({type: 'resend', handle, operationId: item.operationId}); setCandidate(undefined);}})}>明确重新发卡</Button>}{['candidate', 'pendingCloud'].includes(item.state) && <Button disabled={busy} onClick={() => void run(async () => {if (!handle) return; const reply = await request({type: 'inspectCandidate', handle, operationId: item.operationId}); if (reply?.kind === 'candidate') setCandidate(reply);})}>在 App 核对候选</Button>}<Button disabled={busy || item.state === 'cancelPending'} onClick={() => void run(async () => {if (handle) await request({type: 'cancel', handle, operationId: item.operationId});})}>取消此请求</Button></div>}
    </article>)}</div></section>}
    {candidate && operations.some(item => item.operationId === candidate.operation.operationId && item.payloadDigest === candidate.payloadDigest && ['candidate','pendingCloud'].includes(item.state)) && <section className="authoring-step"><h3>待确认的确切候选</h3><p>核对后请在本人飞书私聊确认。App 不会替你跳过该确认。</p>{'changes' in candidate.content ? <><p className="community-muted">草稿 {candidate.content.draftId} · 基于修订 {candidate.content.baseRevision}</p>{candidate.content.changes.map((change, index) => <div key={index}><h4>{change.op === 'setPublicText' ? {name:'名称',summary:'公开简介',overview:'公开概览',version:'版本'}[change.field] : change.op === 'setDraftRole' ? '角色与规则' : '使用前准备'}</h4>{change.op === 'setSetup' ? change.value ? <RecipeConfiguration config={{role:'',setup:change.value}} section="使用前准备"/> : <p>移除使用前准备</p> : <pre className="authoring-preview">{change.value || '清空此字段'}</pre>}</div>)}</> : <><h4>公开介绍</h4><p>{candidate.content.public.name || '未填写名称'}</p><p>{candidate.content.public.summary || '未填写简介'}</p><RecipeMetadata meta={candidate.content.public}/><RecipeMarkdown text={candidate.content.public.overview}/><h4>角色与规则</h4><pre className="authoring-preview">{candidate.content.config.role}</pre><RecipeConfiguration config={candidate.content.config} section="使用前准备"/></>}</section>}
    {handle && <Button disabled={busy} onClick={() => void run(async () => {
      await request({type:'close',handle});
      if (live.current) {setSession(undefined); setChallenge(undefined); setLink(undefined); setSource(undefined); setAttested(false); setCandidate(undefined); setPaused(true);}
    })}>暂停聊天编辑</Button>}
    <p className="community-muted">离开此页后仍可在本人私聊继续。切换设备、退出账号或 App、30 分钟未操作都会暂停聊天编辑。</p>
  </div>;
}
function message(error: unknown) {return error instanceof Error ? error.message : '操作未完成，请检查来源设备、账号与 Bot 管理员权限后重试。';}
