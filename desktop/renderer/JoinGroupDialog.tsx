import {useEffect, useRef, useState} from 'react';
import type {Agent, CommandResult, FolderChoice, PendingGroup} from '../shared/bridge';
import {conversationSchema, toolSchema} from '../shared/bridge';
import {Button, FormField, InlineNotice} from './reference/components/ui';
import {Dialog} from './reference/components/ui/Dialog';
import {SettingsGroup, SettingsRow} from './reference/components/system-settings';
import {useDraft, useDraftGuard} from './settings/DraftGuard';
import type {PendingAgentGroups} from './pending-groups';

type Mode = {kind: 'create'} | {kind: 'existing'} | {kind: 'bind'; group: PendingGroup};
type Props = {agent: Agent; pending?: PendingAgentGroups; initialGroup?: PendingGroup; onClose: () => void; onChanged: () => Promise<void>};
export function JoinGroupDialog({agent, pending, initialGroup, onClose, onChanged}: Props) {
  const {navigate} = useDraftGuard();
  const [mode, setMode] = useState<Mode>(initialGroup ? {kind: 'bind', group: initialGroup} : {kind: 'create'});
  const [name, setName] = useState(initialGroup?.name ?? '');
  const [folder, setFolder] = useState<FolderChoice>();
  const [existingDirectory, setExistingDirectory] = useState(false);
  const [tool, setTool] = useState<'codex' | 'claude'>('codex');
  const [conversation, setConversation] = useState<'threads' | 'shared'>('threads');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [manual, setManual] = useState<Extract<CommandResult, {kind: 'groups'}>>();
  const active = useRef(true);
  useEffect(() => () => {active.current = false;}, []);
  const dirty = Boolean(name !== (mode.kind === 'bind' ? mode.group.name : '') || folder || existingDirectory || tool !== 'codex' || conversation !== 'threads');
  function discard() {setName(''); setFolder(undefined); setExistingDirectory(false); setTool('codex'); setConversation('threads');}
  function close() {if (!busy) navigate(() => {active.current = false; onClose();});}
  function switchMode(next: Mode) {
    if (busy) return;
    navigate(() => {setMode(next); setName(next.kind === 'bind' ? next.group.name : ''); setFolder(undefined); setExistingDirectory(false); setError('');});
  }
  async function save() {
    if (busy || mode.kind === 'existing') return false;
    if (!name.trim() || ((mode.kind === 'bind' || existingDirectory) && !folder)) {setError('请填写名称并选择工作目录。'); return false;}
    setBusy(true); setError('');
    try {
      const reply = mode.kind === 'create'
        ? await window.bridge.collaboration({action: 'createProject', agentId: agent.id, name: name.trim(), folder: existingDirectory && folder ? {kind: 'existing', folderToken: folder.token} : {kind: 'default'}, tool, conversation})
        : folder && await window.bridge.run({type: 'bindGroup', agentId: agent.id, groupId: mode.group.chatId, projectName: name.trim(), folderToken: folder.token, tool, conversation});
      if (!reply || reply.kind !== 'applied') {setError(reply && 'message' in reply ? reply.message : '操作未完成，请重试。'); return false;}
      await onChanged();
      active.current = false;
      onClose();
      return true;
    } catch (failure) {setError(failure instanceof Error ? failure.message : '操作失败，填写的内容已保留。'); return false;}
    finally {setBusy(false);}
  }
  useDraft(dirty, {title: '加入飞书群', save, discard});
  async function chooseFolder() {
    setBusy(true); setError('');
    try {
      const reply = await window.bridge.run({type: 'chooseFolder'});
      if (active.current && reply.kind === 'folderChosen') setFolder(reply.folder);
      else if (reply.kind === 'refused') setError(reply.message);
    } catch (failure) {setError(failure instanceof Error ? failure.message : '无法选择目录。');}
    finally {setBusy(false);}
  }
  async function findGroups(cursor?: string) {
    setBusy(true); setError('');
    try {
      const reply = await window.bridge.run({type: 'listJoinedGroups', agentId: agent.id, ...(cursor ? {cursor} : {})});
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
        <p>在飞书客户端打开目标群，进入「设置 → 群机器人 → 添加机器人」，搜索并添加「{agent.name}」。请使用这个 Bot 的管理员身份操作。</p>
        <p role="status">添加后，Vonvon 会显示绑定通知。点击「继续绑定」选择工作目录。</p>
        {pending?.problem && <InlineNotice title={pending.problem.kind === 'unsupported' ? '当前后台不支持绑定通知' : '绑定通知读取失败'} tone="warning">{pending.problem.message} {pending.problem.kind === 'unsupported' && '请更新 Bridge 后台，或使用下方的群查找入口。'}</InlineNotice>}
        {pending?.groups.map(group => <InlineNotice key={group.chatId} title={`${agent.name} 已加入 ${group.name}`} actions={<Button disabled={busy} onClick={() => switchMode({kind: 'bind', group})}>继续绑定</Button>}>选择工作目录后即可开始协作。</InlineNotice>)}
        <Button disabled={busy} onClick={() => void findGroups()}>查找已经加入的群</Button>
        <small>用于离线期间、升级前加入的群，或未收到通知的情况。</small>
        {manual && <><FormField label="已经加入的飞书群"><select aria-label="选择飞书群" value="" disabled={busy} onChange={event => {const group = manual.groups.find(item => item.id === event.target.value); if (group) switchMode({kind: 'bind', group: {chatId: group.id, name: group.name, addedAt: 0}});}}><option value="">请选择已加入的群</option>{manual.groups.map(group => <option key={group.id} value={group.id} disabled={group.bound}>{group.name}{group.bound ? '（已绑定）' : ''}</option>)}</select></FormField>{!manual.groups.length && <p>没有可显示的群。请确认机器人已加入目标群。</p>}{manual.nextCursor && <Button disabled={busy} onClick={() => void findGroups(manual.nextCursor)}>加载更多</Button>}</>}
      </> : <>
        {mode.kind === 'bind' && <InlineNotice title={`绑定 ${mode.group.name}`}>Bot · {agent.name}</InlineNotice>}
        <FormField label={mode.kind === 'create' ? '飞书群名称' : '本地绑定名称'}><input aria-label={mode.kind === 'create' ? '飞书群名称' : '本地绑定名称'} maxLength={100} disabled={busy} value={name} onChange={event => setName(event.target.value)} /></FormField>
        <SettingsGroup>
          {mode.kind === 'create' && <SettingsRow title="工作目录来源" trailing={<select aria-label="目录来源" disabled={busy} value={existingDirectory ? 'existing' : 'default'} onChange={event => {setExistingDirectory(event.target.value === 'existing'); setFolder(undefined);}}><option value="default">新建空白目录</option><option value="existing">使用现有目录</option></select>} />}
          <SettingsRow title="工作目录" value={mode.kind === 'create' && !existingDirectory ? '在 Bot 的默认项目目录中创建空白目录' : folder?.displayPath ?? '未选择'} trailing={(mode.kind === 'bind' || existingDirectory) && <Button disabled={busy} onClick={() => void chooseFolder()}>选择文件夹</Button>} />
          <SettingsRow title="执行工具" trailing={<select aria-label="执行工具" disabled={busy} value={tool} onChange={event => setTool(toolSchema.parse(event.target.value))}><option value="codex">Codex</option><option value="claude">Claude</option></select>} />
          <SettingsRow title="会话方式" trailing={<select aria-label="会话方式" disabled={busy} value={conversation} onChange={event => setConversation(conversationSchema.parse(event.target.value))}><option value="threads">按话题独立会话</option><option value="shared">整群连续会话</option></select>} />
        </SettingsGroup>
        <Button variant="primary" loading={busy} disabled={!name.trim() || ((mode.kind === 'bind' || existingDirectory) && !folder)} onClick={() => void save()}>{mode.kind === 'create' ? '创建飞书群并加入' : '绑定工作目录并发送欢迎卡片'}</Button>
      </>}
      {error && <InlineNotice title="操作未完成" tone="danger">{error}</InlineNotice>}
    </div>
  </Dialog>;
}
