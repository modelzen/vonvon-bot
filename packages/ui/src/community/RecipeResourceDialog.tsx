import {useEffect, useRef, useState} from 'react';
import type {AgentId, DesktopAuthoringReply, DesktopSnapshot, RecipeDetail} from '@vonvon/protocol';
import {useActiveDevice, useClient, useShellCapabilities} from '../client-context';
import {useAccount} from '../account-context';
import {GlowButton} from '../GlowButton';
import {Button, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {botChatUrl, openExternalUrl} from '../url-actions';
import {CopyButton} from './RecipeContent';
import './authoring/authoring.css';

type Session = Extract<DesktopAuthoringReply, {kind: 'session'}>;
type Challenge = Extract<DesktopAuthoringReply, {kind: 'challenge'}>;
type Link = Extract<DesktopAuthoringReply, {kind: 'link'}>;
type Delivery = Extract<DesktopAuthoringReply, {kind: 'resourceHandoff'}>;
type Flow = {kind: 'choice'} | {kind: 'reconcile'} | {kind: 'delivery'; reply: Delivery}
  | {kind: 'link'; session: Session; challenge?: Challenge; link?: Link};
type Intent = {bot: DesktopSnapshot['agents'][number]; requestId: string; key: string; owner?: object; session?: Session};
export type ResourceHandoffIntents = Map<string, Intent>;

export function RecipeResourceDialog({recipe, intents, onClose}: {recipe: Pick<RecipeDetail, 'recipeId' | 'versionId' | 'public'>; intents: ResourceHandoffIntents; onClose: () => void}) {
  const account = useAccount(), client = useClient(), device = useActiveDevice(), capabilities = useShellCapabilities();
  const shell = capabilities?.recipeAuthoring;
  const accountId = account.status?.kind === 'signedIn' ? account.status.accountId : undefined;
  const [origin] = useState(() => ({accountId, client, viewId: device.id, shell}));
  const current = useRef({accountId, client, viewId: device.id, shell});
  current.current = {accountId, client, viewId: device.id, shell};
  const active = useRef(false), locked = useRef(false);
  const invalidated = useRef(false), owner = useRef({});
  const intent = useRef<Intent | undefined>(undefined);
  const opened = useRef(false), polls = useRef(0), unknownRetries = useRef(0);
  const [flow, setFlow] = useState<Flow>({kind: 'choice'});
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  const [botId, setBotId] = useState<AgentId>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<{kind: 'handoff' | 'chat'; message: string}>();
  const [now, setNow] = useState(Date.now());
  invalidated.current ||= accountId !== origin.accountId || client !== origin.client || device.id !== origin.viewId || shell !== origin.shell;
  const changed = invalidated.current;
  const bots = snapshot?.agents.filter(bot => bot.running && bot.connection === 'connected' && bot.tenant) ?? [];
  const bot = bots.find(row => row.id === (botId ?? (bots.length === 1 ? bots[0]?.id : undefined)));
  const ready = snapshot?.host.kind === 'connected' && !snapshot.stale && !changed;
  function check() {
    const value = current.current;
    if (!active.current || invalidated.current || value.accountId !== origin.accountId || value.client !== origin.client || value.viewId !== origin.viewId || value.shell !== origin.shell) throw new Error('账号或设备已切换，请关闭后重新选择。');
    if (!shell || !accountId) throw new Error('请登录后使用最新版桌面应用。');
  }
  useEffect(() => {
    active.current = true;
    const stop = origin.client.watchSnapshots(value => {if (active.current) setSnapshot(value);});
    return () => {
      active.current = false; stop();
      const selected = intent.current;
      if (selected?.owner === owner.current) {
        delete selected.owner;
        const session = selected.session;
        if (session) void origin.shell?.request({type: 'detach', handle: session.handle}).catch(() => {});
        delete selected.session;
      }
    };
  }, [origin]);
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(undefined);
    try {check(); await action();} catch (reason) {if (active.current) setError({kind: 'handoff', message: reason instanceof Error ? reason.message : '交付尚未确认，请核对原请求。'});}
    finally {locked.current = false; if (active.current) setBusy(false);}
  }
  async function openChat(reply: Delivery) {
    check();
    try {await openExternalUrl(botChatUrl(reply.botId, reply.tenant), 'bot-chat', capabilities);}
    catch {if (active.current && !invalidated.current) setError({kind: 'chat', message: '私聊引导已经发送。请重试打开 Bot 私聊。'});}
  }
  function retireLink(selected: Intent, session: Session) {
    if (selected.owner && selected.owner !== owner.current) {
      if (!selected.session) {selected.session = session; return;}
      if (selected.session.handle === session.handle) return;
    }
    void origin.shell?.request({type: 'detach', handle: session.handle}).catch(() => {});
  }
  async function handoff() {
    check();
    const selected = intent.current;
    if (!selected || !accountId || !shell) return;
    const fresh = await origin.client.snapshot(); check();
    const present = fresh.agents.find(row => row.id === selected.bot.id);
    if (fresh.stale || fresh.host.kind !== 'connected' || !present?.running || present.connection !== 'connected'
      || present.registrationId !== selected.bot.registrationId || present.registeredAt !== selected.bot.registeredAt) throw new Error('原 Bot 暂不可用或已重新配置，请恢复连接后核对。');
    const reply = await shell.request({type: 'resourceHandoff', accountId, viewId: origin.viewId, botId: selected.bot.id,
      target: {recipeId: recipe.recipeId, versionId: recipe.versionId}, requestId: selected.requestId});
    try {check();} catch (reason) {
      if (reply.kind === 'handoffLinkRequired') retireLink(selected, reply.session);
      throw reason;
    }
    if (reply.kind === 'handoffLinkRequired') {
      if (reply.session.target.accountId !== accountId || reply.session.target.viewId !== origin.viewId || reply.session.target.botId !== selected.bot.id) {
        retireLink(selected, reply.session); throw new Error('私聊关联来源已变化。');
      }
      if (selected.session && selected.session.handle !== reply.session.handle) retireLink(selected, selected.session);
      selected.session = reply.session;
      setFlow({kind: 'link', session: reply.session});
      await beginLink(reply.session);
      return;
    }
    if (reply.kind !== 'resourceHandoff' || reply.accountId !== accountId || reply.viewId !== origin.viewId || reply.botId !== selected.bot.id
      || reply.requestId !== selected.requestId || reply.target.recipeId !== recipe.recipeId || reply.target.versionId !== recipe.versionId) throw new Error('交付回执与所选配方不一致，请核对原请求。');
    setFlow({kind: 'delivery', reply});
    if ((reply.delivery === 'sent' || reply.delivery === 'unavailable') && intents.get(selected.key) === selected) intents.delete(selected.key);
    if (reply.delivery === 'sent' && !opened.current) {opened.current = true; await openChat(reply);}
  }
  async function beginLink(session: Session) {
    check(); if (!shell) return;
    const challenge = await shell.request({type: 'beginLink', handle: session.handle}); check();
    if (challenge.kind !== 'challenge') throw new Error('尚未准备好本人私聊关联，请重试。');
    setFlow({kind: 'link', session, challenge});
  }
  async function inspectLink() {
    if (flow.kind !== 'link' || !flow.challenge || !shell) return;
    const reply = await shell.request({type: 'inspectLink', handle: flow.session.handle, challengeId: flow.challenge.challengeId}); check();
    if (reply.kind !== 'link') throw new Error('尚未确认本人私聊。');
    setFlow({...flow, link: reply});
    if (!reply.recipient) throw new Error('尚未收到关联命令，请确认已发送给所选 Bot。');
  }
  async function confirmLink() {
    if (flow.kind !== 'link' || !flow.challenge || !flow.link?.evidence || !shell) return;
    setFlow({kind: 'reconcile'});
    const reply = await shell.request({type: 'confirmLink', handle: flow.session.handle, challengeId: flow.challenge.challengeId, evidence: flow.link.evidence}); check();
    if (reply.kind !== 'link' || !reply.linked) throw new Error('尚未确认本人私聊关联。');
    await handoff();
  }
  useEffect(() => {
    if (changed || busy || flow.kind !== 'delivery') return;
    const pending = flow.reply.delivery === 'pending' && polls.current < 20;
    const uncertain = flow.reply.delivery === 'unknown' && unknownRetries.current < 1;
    if (!pending && !uncertain) return;
    const timer = setTimeout(() => {
      if (uncertain) unknownRetries.current++; else polls.current++;
      void run(handoff);
    }, 1500);
    return () => clearTimeout(timer);
  }, [flow, busy, changed]);
  useEffect(() => {
    if (flow.kind !== 'link' || !flow.challenge) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [flow]);
  const delivery = flow.kind === 'delivery' ? flow.reply : undefined;
  const expired = flow.kind === 'link' && flow.challenge !== undefined && now >= flow.challenge.expiresAt;
  const command = flow.kind === 'link' && flow.challenge ? `/recipe link ${flow.challenge.code}` : '';
  async function start() {
    if (!bot) return;
    if (!intent.current) {
      const key = JSON.stringify([origin.viewId, bot.id, bot.registrationId, bot.registeredAt, recipe.recipeId, recipe.versionId]);
      const prior = intents.get(key);
      if (!prior && intents.size >= 32) throw new Error('还有未确认的配方交付，请先核对原请求。');
      const selected: Intent = prior ?? {bot, key, requestId: crypto.randomUUID()};
      selected.owner = owner.current;
      intents.set(key, selected); intent.current = selected;
    }
    await handoff();
  }
  async function retryUnavailable() {
    const selected = intent.current;
    if (!selected) return;
    if (selected.session) retireLink(selected, selected.session);
    delete selected.owner; delete selected.session;
    const next: Intent = {bot: selected.bot, key: selected.key, requestId: crypto.randomUUID(), owner: owner.current};
    intents.set(next.key, next); intent.current = next; polls.current = 0; unknownRetries.current = 0;
    setFlow({kind: 'reconcile'});
    await handoff();
  }
  return <Dialog open size="sm" title="交给 Bot" description={`${recipe.public.name} · ${recipe.public.version}`} onClose={onClose} footer={<>
    <Button onClick={onClose}>{delivery?.delivery === 'sent' ? '完成' : '关闭'}</Button>
    {!changed && (flow.kind === 'choice' ? <GlowButton variant="dark" disabled={busy || !ready || !bot} onClick={() => void run(start)}>{busy ? '正在准备…' : intent.current ? '核对原请求' : '前往私聊'}</GlowButton>
      : flow.kind === 'link' ? <>{intent.current?.bot.tenant && <Button disabled={busy} onClick={() => void run(async () => {
        const selected = intent.current;
        if (selected?.bot.tenant) await openExternalUrl(botChatUrl(selected.bot.id, selected.bot.tenant), 'bot-chat', capabilities);
      })}>打开 Bot 私聊</Button>}<GlowButton variant="dark" disabled={busy} onClick={() => void run(expired ? () => beginLink(flow.session) : flow.link?.evidence ? confirmLink : flow.challenge ? inspectLink : () => beginLink(flow.session))}>{expired ? '重新关联' : flow.link?.evidence ? '确认是我的私聊' : flow.challenge ? '我已发送，核对收件人' : '准备关联命令'}</GlowButton></>
        : delivery?.delivery === 'sent' ? <GlowButton variant="dark" disabled={busy} onClick={() => void run(() => openChat(delivery))}>打开 Bot 私聊</GlowButton>
          : <GlowButton variant="dark" disabled={busy || !ready} onClick={() => void run(delivery?.delivery === 'unavailable' ? retryUnavailable : handoff)}>{delivery?.delivery === 'unavailable' ? '重新交付' : '核对交付'}</GlowButton>)}
  </>}><div className="recipe-source-dialog">
    {flow.kind !== 'choice' && intent.current && <p className="recipe-source-help">接收 Bot：{intent.current.bot.name}</p>}
    {changed ? <p role="status">账号或设备已切换，请关闭后重新选择。</p> : flow.kind === 'choice' ? <>
      <p>和 Bot 讨论如何使用这份配方：新建群聊，或应用到已有群聊。</p>
      <label className="authoring-command">Bot<select aria-label="接收配方的 Bot" disabled={busy || Boolean(intent.current)} value={bot?.id ?? ''} onChange={event => setBotId(bots.find(row => row.id === event.target.value)?.id)}><option value="">选择 Bot</option>{bots.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <p className="recipe-source-help">{!ready ? '正在等待当前设备连接…' : !bots.length ? '当前设备没有已连接的 Bot。' : 'Bot 会主动发一条私聊引导，先与你讨论群名、配置和冲突处理方案，等你确认后再创建或配置。'}</p>
    </> : flow.kind === 'link' ? <>
      <p>首次使用，需关联你与「{flow.session.target.botName}」的本人私聊。</p>
      {command && <><label className="authoring-command">向 Bot 私聊发送<input readOnly value={command} aria-label="私聊关联命令" onFocus={event => event.target.select()}/></label><CopyButton value={command} label="复制关联命令"/></>}
      {flow.link?.recipient && <dl className="recipe-source-fixed"><dt>飞书身份</dt><dd>{flow.link.recipient.openId}</dd><dt>私聊</dt><dd>{flow.link.recipient.chatId}</dd><dt>租户</dt><dd>{flow.link.recipient.tenantKey}</dd></dl>}
      {expired && <p role="status">关联命令已过期，请重新关联。</p>}
    </> : flow.kind === 'reconcile' ? <p role="status">正在核对本人关联和原配方交付…</p> : <p role="status">{{sent: '配方已交给 Bot，私聊引导已发送。', pending: '正在准备配方资料和私聊引导…', unknown: '尚未确认私聊引导送达。核对会继续原请求。', unavailable: '此次交付未完成。恢复 Bot 连接后，可以重新交付。'}[flow.reply.delivery]}</p>}
    {error && <InlineNotice title={error.kind === 'chat' ? '未能打开私聊' : '交付尚未完成'} tone="warning">{error.message}</InlineNotice>}
  </div></Dialog>;
}
