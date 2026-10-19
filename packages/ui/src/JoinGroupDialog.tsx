import {RpcError} from '@vonvon/client/browser';
import {useClient} from './client-context';
import {useDirectoryPicker} from './directory-picker';
import {useEffect, useRef, useState} from 'react';
import type {Agent, CommandResult, Conversation, FolderChoice, PendingGroup} from '@vonvon/protocol';
import {conversationCopy, topicConversationCopy, toolSchema} from '@vonvon/protocol';
import {Button, ChoiceGroup, FormField, InlineNotice} from './reference/components/ui';
import {Dialog} from './reference/components/ui/Dialog';
import {SettingsGroup, SettingsRow} from './reference/components/system-settings';
import {useDraft, useDraftGuard} from './settings/DraftGuard';
import type {PendingAgentGroups} from './pending-groups';

type Mode = {kind: 'create'} | {kind: 'existing'} | {kind: 'bind'; group: PendingGroup};
/** product.md 3.4: in this order, title plus one line, nothing preselected or marked as recommended. */
export const CONVERSATIONS = (['threads', 'shared', 'smart'] as const).map(value => ({value, label: conversationCopy[value].title, description: conversationCopy[value].subtitle}));
export function conversationsFor(topic: boolean) {
  return topic ? (['threads', 'smart'] as const).map(value => ({value, label: topicConversationCopy[value].title, description: topicConversationCopy[value].subtitle})) : CONVERSATIONS;
}
/** 免@ when the user has not touched it: 多会话开，单会话关. */
const defaultResponse = (conversation: Conversation): 'all' | 'mention' => conversation === 'threads' ? 'all' : 'mention';
/** The 免@ the dialog shows: the hand pick, else the 会话方式's default. 智能 has none (s25c). */
export function shownResponse(conversation: Conversation | undefined, picked: 'all' | 'mention' | undefined): 'all' | 'mention' | undefined {
  return conversation === undefined || conversation === 'smart' ? undefined : picked ?? defaultResponse(conversation);
}
/** A hand pick of 免@ after a 会话方式 pick: 智能 has none and drops it, so coming back 免@ follows the 会话方式 again (审查低). */
export function keptResponse(conversation: Conversation, picked: 'all' | 'mention' | undefined): 'all' | 'mention' | undefined {
  return conversation === 'smart' ? undefined : picked;
}
/** What goes on the wire. Left out only when the default gives it on this daemon and on one from before s21 alike:
 * those bind with 3.4's defaults but create every group with 免@ on. Otherwise sent; an old daemon then refuses. */
export function sentResponse(kind: 'create' | 'bind', conversation: Conversation, freeAt: 'all' | 'mention' | undefined): {response?: 'all' | 'mention'} {
  if (freeAt === undefined) return {};
  return freeAt === defaultResponse(conversation) && (kind === 'bind' || conversation === 'threads') ? {} : {response: freeAt};
}
/** The protocol's project-name rule, checked here so the user sees why instead of a generic request failure. */
export function projectNameProblem(value: string): string | undefined {
  const name = value.trim();
  if (/[/\\]/.test(name)) return '名称里不能有 / 或 \\，请换成别的字符。';
  if (/[\x00-\x1f]/.test(name)) return '名称里不能有换行、制表符等控制字符。';
  return undefined;
}
/** The owner's words (2026-10-18) for a creation whose result is not known. */
export const CREATION_UNKNOWN = '可能已经建好了，先去飞书看一眼再重试。';
/** How a failed 创建新飞书群 ended: refused (nothing was made), unknown (a group may exist) or unsaved (it exists, unbound). */
export type CreationFailure = {kind: 'refused' | 'unknown' | 'unsaved'; message: string};
/**
 * What a failed 创建新飞书群 tells the user (s36d1). Only the daemon's own refusal says no group was made; a lost
 * connection, or the daemon saying it does not know, may have made one, and `created_unsaved` says one was made.
 * Only a refusal leaves the form open: after the others another click could make a second group.
 */
export function creationFailure(failure: unknown): CreationFailure {
  if (failure instanceof RpcError && failure.code === 'created_unsaved') return {kind: 'unsaved', message: failure.message};
  if (failure instanceof RpcError && failure.code !== 'outcome_unknown') return {kind: 'refused', message: failure.message};
  return {kind: 'unknown', message: CREATION_UNKNOWN};
}
/** Shown while a creation that may have made a group keeps the form locked: the daemon's binding guide, else retry advice. */
export function CreationLockNotice({failure}: {failure: CreationFailure}) {
  return failure.kind === 'unsaved'
    ? <InlineNotice title="群已建好，但没存上" tone="warning">{failure.message}</InlineNotice>
    : <InlineNotice title="不确定建好没有" tone="warning">{CREATION_UNKNOWN}要重试，关掉这个窗口再建。</InlineNotice>;
}
type Props = {linux?: boolean; agent: Agent; pending?: PendingAgentGroups; initialGroup?: PendingGroup; onClose: () => void; onChanged: () => Promise<void>};
export function JoinGroupDialog({linux, agent, pending, initialGroup, onClose, onChanged}: Props) {
  const {navigate} = useDraftGuard();
  const client = useClient();
  const pickDirectory = useDirectoryPicker();
  const [mode, setMode] = useState<Mode>(initialGroup ? {kind: 'bind', group: initialGroup} : {kind: 'create'});
  const [name, setName] = useState(initialGroup?.name ?? '');
  const [folder, setFolder] = useState<FolderChoice>();
  const [existingDirectory, setExistingDirectory] = useState(false);
  const [tool, setTool] = useState<'codex' | 'claude'>('codex');
  const [conversation, setConversation] = useState<Conversation>();
  /** Set once the user picks 免@ by hand; until then it follows the 会话方式. */
  const [response, setResponse] = useState<'all' | 'mention'>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Set once a creation may have made a group: this dialog then creates nothing more, binding still works. */
  const [lock, setLock] = useState<CreationFailure>();
  const locked = mode.kind === 'create' && lock !== undefined;
  const [manual, setManual] = useState<Extract<CommandResult, {kind: 'groups'}>>();
  const active = useRef(true);
  useEffect(() => () => {active.current = false;}, []);
  const nameProblem = projectNameProblem(name);
  const freeAt = shownResponse(conversation, response);
  const dirty = Boolean(name !== (mode.kind === 'bind' ? mode.group.name : '') || folder || existingDirectory || tool !== 'codex' || conversation || response);
  function discard() {setName(''); setFolder(undefined); setExistingDirectory(false); setTool('codex'); setConversation(undefined); setResponse(undefined);}
  function close() {if (!busy) navigate(() => {active.current = false; onClose();});}
  function switchMode(next: Mode) {
    if (busy) return;
    navigate(() => {setMode(next); setName(next.kind === 'bind' ? next.group.name : ''); setFolder(undefined); setExistingDirectory(false); setError('');});
  }
  async function save() {
    if (busy || mode.kind === 'existing' || locked) return false;
    if (!name.trim() || (existingDirectory && !folder)) {setError('请填写名称并选择工作目录。'); return false;}
    if (!conversation) {setError('请选择会话方式。'); return false;}
    const picked = sentResponse(mode.kind, conversation, freeAt);
    if (nameProblem) {setError(nameProblem); return false;}
    setBusy(true); setError('');
    try {
      const reply = mode.kind === 'create'
        ? await client.collaboration({action: 'createProject', agentId: agent.id, name: name.trim(), folder: existingDirectory && folder ? {kind: 'existing', folderToken: folder.token} : {kind: 'default'}, tool, conversation, ...picked})
        : await client.run({type: 'bindGroup', agentId: agent.id, groupId: mode.group.chatId, projectName: name.trim(), folder: existingDirectory && folder ? {kind: 'existing', folderToken: folder.token} : {kind: 'default'}, tool, conversation, ...picked});
      if (!reply || reply.kind !== 'applied') {setError(reply && 'message' in reply ? reply.message : '操作未完成，请重试。'); return false;}
      await onChanged();
      active.current = false;
      onClose();
      return true;
    } catch (failure) {
      if (mode.kind === 'create') {
        const outcome = creationFailure(failure);
        if (outcome.kind === 'refused') setError(outcome.message);
        else setLock(outcome);
      } else setError(failure instanceof Error ? failure.message : '操作失败，填写的内容已保留。');
      return false;
    }
    finally {setBusy(false);}
  }
  // No save action: "保存并离开" would create a real Feishu group on the way out.
  useDraft(dirty, {title: '加入飞书群', discard});
  async function chooseFolder() {
    setBusy(true); setError('');
    try {
      const choice = await pickDirectory();
      if (active.current && choice) setFolder(choice);
    } catch (failure) {setError(failure instanceof Error ? failure.message : '无法选择目录。');}
    finally {setBusy(false);}
  }
  async function findGroups(cursor?: string) {
    setBusy(true); setError('');
    try {
      const reply = await client.run({type: 'listJoinedGroups', agentId: agent.id, ...(cursor ? {cursor} : {})});
      if (reply.kind === 'groups') setManual(previous => ({...reply, groups: cursor ? [...(previous?.groups ?? []), ...reply.groups.filter(item => !previous?.groups.some(old => old.id === item.id))] : reply.groups}));
      else setError('message' in reply ? reply.message : '无法读取飞书群。');
    } catch (failure) {setError(failure instanceof Error ? failure.message : '无法读取飞书群。');}
    finally {setBusy(false);}
  }
  return <Dialog open title="让 Bot 加入飞书群" onClose={busy ? undefined : close}>
    <div className="page-stack join-group-flow">
      <p className="join-group-flow__agent">Bot · {agent.name}</p>
      {mode.kind !== 'bind' && <div className="join-group-flow__modes" role="group" aria-label="加入方式">
        <Button aria-pressed={mode.kind === 'create'} disabled={busy} onClick={() => switchMode({kind: 'create'})}>创建新飞书群</Button>
        <Button aria-pressed={mode.kind === 'existing'} disabled={busy} onClick={() => switchMode({kind: 'existing'})}>加入现有飞书群</Button>
      </div>}
      {mode.kind === 'existing' ? <>
        <p>在飞书客户端打开目标群，进入「设置 → 群机器人 → 添加机器人」，搜索并添加「{agent.name}」。拉我进群的人不是主人或管理员时，设置卡会发给主人。</p>
        <p role="status">添加后，Vonvon 会显示绑定通知。点击「继续绑定」设置独立目录或选择现有目录。</p>
        {pending?.problem && <InlineNotice title={pending.problem.kind === 'unsupported' ? '当前后台不支持绑定通知' : '绑定通知读取失败'} tone="warning">{pending.problem.message} {pending.problem.kind === 'unsupported' && '请更新 Vonvon daemon，或使用下方的群查找入口。'}</InlineNotice>}
        {pending?.groups.map(group => <InlineNotice key={group.chatId} title={`${agent.name} 已加入 ${group.name}`} actions={<Button disabled={busy} onClick={() => switchMode({kind: 'bind', group})}>继续绑定</Button>}>还没设置好：选会话方式就能用。</InlineNotice>)}
        <Button disabled={busy} onClick={() => void findGroups()}>查找已经加入的群</Button>
        <small>用于离线期间、升级前加入的群，或未收到通知的情况。</small>
        {manual && <><FormField label="已经加入的飞书群"><select aria-label="选择飞书群" value="" disabled={busy} onChange={event => {const group = manual.groups.find(item => item.id === event.target.value); if (group) switchMode({kind: 'bind', group: {chatId: group.id, name: group.name, addedAt: 0}});}}><option value="">请选择已加入的群</option>{manual.groups.map(group => <option key={group.id} value={group.id} disabled={group.bound}>{group.name}{group.bound ? '（已绑定）' : ''}</option>)}</select></FormField>{!manual.groups.length && <p>没有可显示的群。请确认机器人已加入目标群。</p>}{manual.nextCursor && <Button disabled={busy} onClick={() => void findGroups(manual.nextCursor)}>加载更多</Button>}</>}
      </> : <>
        {mode.kind === 'bind' && <InlineNotice title={`绑定 ${mode.group.name}`}>Bot · {agent.name}</InlineNotice>}
        <FormField label={mode.kind === 'create' ? '飞书群名称' : '本地绑定名称'} error={nameProblem}><input aria-label={mode.kind === 'create' ? '飞书群名称' : '本地绑定名称'} maxLength={100} disabled={busy} value={name} onChange={event => setName(event.target.value)} /></FormField>
        <SettingsGroup>
          <SettingsRow title="工作目录来源" trailing={<select aria-label="目录来源" disabled={busy} value={existingDirectory ? 'existing' : 'default'} onChange={event => {setExistingDirectory(event.target.value === 'existing'); setFolder(undefined);}}><option value="default">新建空白目录</option><option value="existing">使用现有目录</option></select>} />
          <SettingsRow title="工作目录" value={!existingDirectory ? '为本群创建独立空白目录' : folder?.displayPath ?? '未选择'} trailing={existingDirectory && <Button disabled={busy} onClick={() => void chooseFolder()}>选择文件夹</Button>} />
          <SettingsRow title="执行工具" trailing={<select aria-label="执行工具" disabled={busy} value={tool} onChange={event => setTool(toolSchema.parse(event.target.value))}><option value="codex">Codex</option><option value="claude">Claude</option></select>} />
          {mode.kind === 'bind' && <SettingsRow title="权限档和网络" value="只读 · 网络关（设置好以后在群详情页改）" />}
        </SettingsGroup>
        <FormField label="会话方式">
          <ChoiceGroup<Conversation | ''> label="会话方式" aria-required disabled={busy} value={conversation ?? ''} options={conversationsFor(mode.kind === 'bind' && mode.group.topic === true)} onChange={value => {if (value) {setConversation(value); setResponse(picked => keptResponse(value, picked));}}} />
        </FormField>
        {freeAt && <SettingsGroup>
          <SettingsRow title="免 @" value={freeAt === 'all' ? '不 @ 也回' : '@ 我才回'} trailing={<select aria-label="免 @" disabled={busy} value={freeAt} onChange={event => setResponse(event.target.value === 'all' ? 'all' : 'mention')}><option value="all">开</option><option value="mention">关</option></select>} />
        </SettingsGroup>}
        {linux && mode.kind === 'bind' && tool === 'codex' && <InlineNotice title="Linux 上的 Codex 只能用完全访问" tone="info">照常绑定。群里 @ 时 Bot 会回一句说明；要用，绑定后在群详情页把权限档改成完全访问。</InlineNotice>}
        <Button variant="primary" loading={busy} disabled={locked || !name.trim() || Boolean(nameProblem) || (existingDirectory && !folder) || !conversation} onClick={() => void save()}>{mode.kind === 'create' ? '创建飞书群并加入' : '绑定工作目录并发送欢迎卡片'}</Button>
      </>}
      {mode.kind === 'create' && lock && <CreationLockNotice failure={lock} />}
      {error && <InlineNotice title="操作未完成" tone="danger">{error}</InlineNotice>}
    </div>
  </Dialog>;
}
