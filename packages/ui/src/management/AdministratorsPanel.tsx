import {RefreshCw} from 'lucide-react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {groupIdSchema, type AdminCandidate, type Agent, type AgentSettingsView} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {AgentAvatar} from '../AgentAvatar';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button, IconButton, InlineNotice} from '../reference/components/ui';
import {ConfirmDialog, Dialog} from '../reference/components/ui/Dialog';
import {errorText} from '../settings/SettingsPanel';
import './administrators.css';
import {Person} from './Person';
import {PeopleRows, PeopleSearch, matchesPerson} from './PeoplePicker';
import {settingAnchor} from '../search';

type Read = {kind: 'loading'} | {kind: 'ready'; view: AgentSettingsView} | {kind: 'failed'; message: string};
type Group = {id: string; name: string};
type Member = {openId: string; name: string};
type Listing<T> = {kind: 'idle'} | {kind: 'loading'} | {kind: 'ready'; items: T[]; next?: string} | {kind: 'failed'; message: string};

const tail = (openId: string) => `…${openId.slice(-6)}`;
const SOURCE_LABEL = {creator: '创建者', feishu: '飞书应用成员', refused: '私聊被拒'} as const;

/** Who may be picked, each with where they come from. */
export function CandidateRows({candidates, total, busy, onPick}: {candidates: readonly AdminCandidate[]; total: number; busy: boolean; onPick: (openId: string) => void}) {
  return <PeopleRows label="候选人" people={candidates.map(item => ({...item,source:item.sources.map(source => SOURCE_LABEL[source]).join(' · ')}))} disabled={busy} onPick={onPick}
    empty={total ? '没有匹配的人。' : '没有候选人。可以从下面的群里选。'}/>;
}

/**
 * The people on the list. Anyone can be removed while another stays: the creator and whoever Feishu names carry no
 * protection, and 「创建者」 is only a label.
 */
export function AdministratorRows({view, readonly, busy, onRemove}: {view: AgentSettingsView; readonly?: string; busy: boolean; onRemove: (openId: string, name: string) => void}) {
  const admins = view.administrators.openIds;
  const nameOf = (openId: string) => view.administrators.names?.[openId] ?? tail(openId);
  return <>
    {!admins.length && <SettingsRow title="这个 Bot 还没有管理员" description="添加一位，才能私聊它。"/>}
    {admins.map(openId => <SettingsRow key={openId} title={<Person name={nameOf(openId)} tag={openId === view.ownerOpenId ? '创建者' : undefined}/>}
      trailing={<Button size="sm" variant="ghost" disabled={Boolean(readonly) || busy || admins.length <= 1} title={admins.length <= 1 ? '至少要有一个管理员。' : readonly}
        aria-label={`移除 ${nameOf(openId)}`} onClick={() => onRemove(openId, nameOf(openId))}>移除</Button>}/>)}
  </>;
}

/** The candidates first (the creator, whom Feishu names, who was turned away), then a group and one of its members. */
function AddAdminDialog({agent, view, onPick, onClose, busy, failure}: {
  agent: Agent; view: AgentSettingsView; onPick: (openId: string) => void; onClose: () => void; busy: boolean; failure?: string;
}) {
  const client = useClient();
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<Listing<Group>>({kind: 'idle'});
  const [group, setGroup] = useState<string>();
  const [members, setMembers] = useState<Listing<Member>>({kind: 'idle'});
  const membersRead = useRef(0);
  const listed = view.administrators.openIds;
  const loadGroups = useCallback(async (cursor?: string) => {
    setGroups(previous => cursor && previous.kind === 'ready' ? previous : {kind: 'loading'});
    try {
      const reply = await client.run({type: 'listJoinedGroups', agentId: agent.id, ...(cursor ? {cursor} : {})});
      if (reply.kind !== 'groups') throw new Error('message' in reply ? reply.message : '无法读取飞书群。');
      setGroups(previous => ({kind: 'ready', items: [...cursor && previous.kind === 'ready' ? previous.items : [], ...reply.groups.map(item => ({id: item.id, name: item.name}))], next: reply.nextCursor}));
    } catch (failure) { setGroups({kind: 'failed', message: failure instanceof Error ? failure.message : '无法读取飞书群。'}); }
  }, [client, agent.id]);
  // Only the latest read may answer: a slower one for the group left behind would list its people under this one.
  const loadMembers = useCallback(async (groupId: string, cursor?: string) => {
    const request = ++membersRead.current;
    setMembers(previous => cursor && previous.kind === 'ready' ? previous : {kind: 'loading'});
    try {
      const reply = await client.run({type: 'listGroupMembers', agentId: agent.id, groupId: groupIdSchema.parse(groupId), ...(cursor ? {cursor} : {})});
      if (request !== membersRead.current) return;
      if (reply.kind !== 'members') throw new Error('message' in reply ? reply.message : '无法读取群成员。');
      setMembers(previous => ({kind: 'ready', items: [...cursor && previous.kind === 'ready' ? previous.items : [], ...reply.members], next: reply.nextCursor}));
    } catch (failure) { if (request === membersRead.current) setMembers({kind: 'failed', message: failure instanceof Error ? failure.message : '无法读取群成员。'}); }
  }, [client, agent.id]);
  useEffect(() => { void loadGroups(); }, [loadGroups]);
  const candidates = (view.administrators.candidates ?? []).filter(item => !listed.includes(item.openId) && matchesPerson(item, query));
  const pickable = (people: Member[]) => people.filter(person => !listed.includes(person.openId) && matchesPerson(person, query));
  return <Dialog open size="md" title={<span className="admin-dialog-title">添加管理员<span className="admin-bot-title"><AgentAvatar agent={agent}/><span>{agent.name}</span></span></span>}
    onClose={busy ? undefined : onClose} footer={<Button disabled={busy} onClick={onClose}>关闭</Button>}>
    <div className="admin-dialog">
      {failure && <InlineNotice tone="warning" title="没有添加成">{failure}</InlineNotice>}
      <PeopleSearch query={query} onChange={setQuery}/>
      <h3>候选人</h3>
      <CandidateRows candidates={candidates} total={view.administrators.candidates?.length ?? 0} busy={busy} onPick={onPick}/>
      <h3>从群里选</h3>
      {groups.kind === 'failed' && <InlineNotice tone="warning" title="读不到飞书群">{groups.message}</InlineNotice>}
      {groups.kind === 'loading' && <p className="admin-empty">正在读取…</p>}
      {groups.kind === 'ready' && <>
        <select aria-label="选择群" value={group ?? ''} onChange={event => {
          const next = event.target.value;
          setGroup(next || undefined);
          if (next) void loadMembers(next);
          else { membersRead.current++; setMembers({kind: 'idle'}); }
        }}>
          <option value="">选择一个群</option>
          {groups.items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        {groups.next && <Button size="sm" variant="ghost" onClick={() => void loadGroups(groups.next)}>加载更多群</Button>}
        {!groups.items.length && <p className="admin-empty">这个 Bot 还没有加入飞书群。</p>}
      </>}
      {members.kind === 'loading' && <p className="admin-empty">正在读取成员…</p>}
      {members.kind === 'failed' && <InlineNotice tone="warning" title="读不到群成员">{members.message}</InlineNotice>}
      {members.kind === 'ready' && group && <PeopleRows label="群成员" people={pickable(members.items)} disabled={busy} onPick={onPick}
        empty={members.items.length ? '没有可添加的人。' : '这个群没有读到成员。'}>
        {members.next && <Button size="sm" variant="ghost" onClick={() => void loadMembers(group, members.next)}>加载更多成员</Button>}
      </PeopleRows>}
    </div>
  </Dialog>;
}

export function BotAdministrators({agent, embedded = false}: {agent: Agent; embedded?: boolean}) {
  const client = useClient();
  const [read, setRead] = useState<Read>({kind: 'loading'});
  const [message, setMessage] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{openId: string; name: string; pending?: boolean}>();
  const [busy, setBusy] = useState(false);
  const serial = useRef(0);
  const load = useCallback(async () => {
    const request = ++serial.current;
    try {
      const reply = await client.settings({type: 'read', scope: {kind: 'agent', botId: agent.id}});
      if (request !== serial.current) return;
      if (reply.kind !== 'view' || reply.view.scope.kind !== 'agent' || !('administrators' in reply.view)) throw new Error(reply.kind === 'refused' ? reply.message : '管理员名单暂时读不到。');
      setRead({kind: 'ready', view: reply.view});
    } catch (failure) { if (request === serial.current) setRead({kind: 'failed', message: failure instanceof Error ? failure.message : '管理员名单暂时读不到。'}); }
  }, [client, agent.id]);
  useEffect(() => { void load(); return () => { serial.current++; }; }, [load]);
  const view = read.kind === 'ready' ? read.view : undefined;
  const readonly = view?.sections.access.access.kind === 'readonly' ? view.sections.access.access.message : undefined;
  async function change(openId: string, membership: 'present' | 'absent'): Promise<boolean> {
    if (!view || readonly || busy) return false;
    setBusy(true);
    try {
      const reply = await client.settings({type: 'act', action: {kind: 'adminMember', botId: agent.id, openId, membership, revision: view.administrators.revision}});
      const failure = errorText(reply);
      setMessage(failure);
      // A refused write may be an old revision: the fresh one lets the next try go through.
      await load();
      return !failure;
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : '没有改成。'); return false; }
    finally { setBusy(false); }
  }
  return <SettingsGroup className="admin-bot" id={embedded ? settingAnchor("回应谁") : undefined} label={embedded ? "回应谁" : <span className="admin-bot-title"><AgentAvatar agent={agent}/><span>{agent.name}</span></span>}
    action={<span className="admin-bot-actions">
      <IconButton size="sm" variant="ghost" label="重新读取" title="重新读取这个 Bot 的管理员" onClick={() => void load()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>
      <Button size="sm" disabled={!view || Boolean(readonly) || busy} title={readonly} onClick={() => { setMessage(undefined); void load(); setAdding(true); }}>添加管理员</Button>
    </span>}
    footer={<>{embedded && <span>只有管理员可以私聊这个 Bot。管理员能通过私聊操作这台设备及设备上的所有 Bot。名单按当前 Bot 保存。 </span>}{readonly ?? message}</>}>
    {read.kind === 'loading' && <SettingsRow title="正在读取…"/>}
    {read.kind === 'failed' && <SettingsRow title="读取失败" description={read.message}/>}
    {view && <AdministratorRows view={view} readonly={readonly} busy={busy} onRemove={(openId, name) => setRemoving({openId, name})}/>}
    {adding && view && <AddAdminDialog agent={agent} view={view} busy={busy} failure={message} onClose={() => setAdding(false)} onPick={openId => void change(openId, 'present').then(done => { if (done) setAdding(false); })}/>}
    <ConfirmDialog open={Boolean(removing)} title={removing ? `移除管理员「${removing.name}」？` : ''} tone="danger" confirmLabel="移除" pending={removing?.pending}
      description="这个人正在跑的私聊会停下，私聊定时任务会暂停。以后再加回来，暂停的任务也要手动恢复。"
      onCancel={() => setRemoving(undefined)}
      onConfirm={() => { const target = removing; if (!target) return; setRemoving({...target, pending: true}); void change(target.openId, 'absent').finally(() => setRemoving(undefined)); }}/>
  </SettingsGroup>;
}

/** Compatibility destination for an older navigation state; editing now lives in each Bot's private chat. */
export function AdministratorsPanel({agents, onOpenDm}: {agents: readonly Agent[]; onOpenDm: (agent: Agent) => void}) {
  return <div className="page-stack administrators-page">
    <div className="environment-lead today-page-heading"><h1>私聊设置</h1></div>
    <p className="administrators-note">管理员设置已移到各个 Bot 的私聊沟通方式中。</p>
    <SettingsGroup>{agents.map(agent => <SettingsRow key={agent.id} title={<span className="admin-bot-title"><AgentAvatar agent={agent}/><span>{agent.name}</span></span>} trailing={<Button size="sm" disabled={!agent.dm} onClick={() => onOpenDm(agent)}>打开私聊设置</Button>}/>)}</SettingsGroup>
    {!agents.length && <InlineNotice title="还没有 Bot">注册 Bot 后，可以在它的私聊设置中管理管理员。</InlineNotice>}
  </div>;
}
