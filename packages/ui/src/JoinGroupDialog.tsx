import {ArrowLeft, Folder, ChevronRight, RefreshCw} from 'lucide-react';
import {DirectorySearchStep} from './DirectorySearchStep';
import {useClient} from './client-context';
import {useEffect, useRef, useState} from 'react';
import type {Agent, AgentSettingsView, HostSettingsView, DecisionModelsView, JudgeSelectionView, DesktopSnapshot, CommandResult, Conversation, FolderChoice, PendingGroup, ToolState} from '@vonvon/protocol';
import {toolSchema} from '@vonvon/protocol';
import {providerDecisionProblem} from './settings/DecisionFields';
import {useProviders} from './settings/GroupDesignSettings';
import {communicationModes} from './settings/ConversationSlider';
import type {DecisionConfigurationState} from './settings/useDecisionConfiguration';
import {Button, IconButton, ChoiceGroup, FormField, InlineNotice} from './reference/components/ui';
import {Dialog} from './reference/components/ui/Dialog';
import {SettingsGroup, SettingsRow} from './reference/components/system-settings';
import {useDraft, useDraftGuard} from './settings/DraftGuard';
import type {PendingAgentGroups} from './pending-groups';
import {SettingChoices} from './settings/SettingChoices';
import {AgentAvatar} from './AgentAvatar';
import './setup/join-group.css';
import {providerUsable} from './setup/provider-state';

type Mode = {kind: 'existing'} | {kind: 'bind'; group: PendingGroup};
// One vocabulary for the Bot settings and group setup. Do not preselect a communication mode.
export const CONVERSATIONS = communicationModes.map(({value, label, description}) => ({value, label, description}));
export function conversationsFor(topic: boolean) {return CONVERSATIONS.filter(option => !topic || option.value !== 'shared');}
export function judgeSetupProblem(selection: JudgeSelectionView, services?: DecisionModelsView, usableBackends: readonly string[] = [], configuration?: DecisionConfigurationState): string | undefined {
  return providerDecisionProblem(selection, usableBackends.map(id => ({id, displayName: id})), services, configuration);
}
/** 免@ when the user has not touched it: 多会话开，单会话关. */
const defaultResponse = (conversation: Conversation): 'all' | 'mention' => conversation === 'threads' ? 'all' : 'mention';
/** The 免@ the dialog shows: the hand pick, else the 沟通方式's default. 智能 has none (s25c). */
export function shownResponse(conversation: Conversation | undefined, picked: 'all' | 'mention' | undefined): 'all' | 'mention' | undefined {
  return conversation === undefined || conversation === 'smart' ? undefined : picked ?? defaultResponse(conversation);
}
/** A hand pick of 免@ after a 沟通方式 pick: 智能 has none and drops it, so coming back 免@ follows the 沟通方式 again (审查低). */
export function keptResponse(conversation: Conversation, picked: 'all' | 'mention' | undefined): 'all' | 'mention' | undefined {
  return conversation === 'smart' ? undefined : picked;
}
/** The daemon supplies these binding defaults; explicit overrides still go on the wire. */
export function sentResponse(conversation: Conversation, freeAt: 'all' | 'mention' | undefined): {response?: 'all' | 'mention'} {
  if (freeAt === undefined) return {};
  return freeAt === defaultResponse(conversation) ? {} : {response: freeAt};
}
/** The protocol's project-name rule, checked here so the user sees why instead of a generic request failure. */
export function projectNameProblem(value: string): string | undefined {
  const name = value.trim();
  if (/[/\\]/.test(name)) return '名称里不能有 / 或 \\，请换成别的字符。';
  if (/[\x00-\x1f]/.test(name)) return '名称里不能有换行、制表符等控制字符。';
  return undefined;
}
type ProviderTool = 'codex' | 'claude';
/** A setup suggestion is accepted only if the current snapshot says it can run. */
export function initialGroupProvider(initialProvider?: ProviderTool, tools?: ToolState[]): ProviderTool | undefined {
  const ready = (provider: ProviderTool) => providerUsable(tools?.find(item => item.tool === provider));
  if (initialProvider && ready(initialProvider)) return initialProvider;
  return (['codex', 'claude'] as const).find(ready);
}
type Props = {snapshot?: DesktopSnapshot; open?: boolean; agent: Agent; pending?: PendingAgentGroups; initialGroup?: PendingGroup; initialProvider?: ProviderTool; tools?: ToolState[]; onClose: () => void; onChanged: (target: {agentId: Agent['id']; chatId: string}) => Promise<void>; onOpenProviders?: () => void; onOpenDecisionModel?: (provider?: string) => void};
export function JoinGroupDialog({open = true, agent, pending, initialGroup, initialProvider, tools, onClose, onChanged, onOpenProviders, onOpenDecisionModel}: Props) {
  const {navigate} = useDraftGuard();
  const client = useClient();
  const [decisionView, setDecisionView] = useState<{configuration: NonNullable<HostSettingsView['sections']['judge']>['effective']; services?: AgentSettingsView['decisionModels']}>();
  const providers = useProviders(tools);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const directoryTrigger = useRef<HTMLButtonElement>(null);
  const directoryWasOpen = useRef(false);
  const [decisionReadError, setDecisionReadError] = useState('');
  const decisionSerial = useRef(0);
  const decisionOpenEpoch = useRef(0);
  if (!open) decisionOpenEpoch.current++;
  const [decisionReady, setDecisionReady] = useState({serial: -1, epoch: -1});
  async function readDecision() {
    const serial = ++decisionSerial.current;
    const epoch = decisionOpenEpoch.current;
    try {
      const [host, bot] = await Promise.all([
        client.settings({type: 'read', scope: {kind: 'host'}}),
        client.settings({type: 'read', scope: {kind: 'agent', botId: agent.id}}),
      ]);
      if (serial !== decisionSerial.current) return;
      const section = host.kind === 'view' && host.view.scope.kind === 'host' && 'runtime' in host.view ? host.view.sections.judge : undefined;
      if (!section) throw new Error(host.kind === 'refused' ? host.message : '无法读取默认决策模型。');
      if (bot.kind !== 'view' || bot.view.scope.kind !== 'agent' || !('administrators' in bot.view)) throw new Error(bot.kind === 'refused' ? bot.message : '无法读取决策模型状态。');
      setDecisionView({configuration: section.effective, services: bot.view.decisionModels});
      setDecisionReady({serial, epoch}); setDecisionReadError('');
    } catch (failure) {if (serial === decisionSerial.current) setDecisionReadError(failure instanceof Error ? failure.message : '无法读取决策模型设置。');}
  }
  useEffect(() => {if (open) void readDecision(); return () => {decisionSerial.current++;};}, [client, agent.id, open]);
  const [mode, setMode] = useState<Mode>(initialGroup ? {kind: 'bind', group: initialGroup} : {kind: 'existing'});
  const [name, setName] = useState(initialGroup?.name ?? '');
  const [folder, setFolder] = useState<FolderChoice>();
  const [existingDirectory, setExistingDirectory] = useState(false);
  // A snapshot refresh can improve the suggested default, but never replaces a hand pick.
  const [pickedTool, setPickedTool] = useState<ProviderTool | undefined>(undefined);
  const ready = (provider: ProviderTool) => providerUsable(tools?.find(item => item.tool === provider));
  const tool = pickedTool ?? initialGroupProvider(initialProvider, tools);
  const [conversation, setConversation] = useState<Conversation>();
  /** Set once the user picks 免@ by hand; until then it follows the 沟通方式. */
  const [response, setResponse] = useState<'all' | 'mention'>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (choosingDirectory) directoryWasOpen.current = true;
    else if (!busy && directoryWasOpen.current) {
      directoryTrigger.current?.focus(); directoryWasOpen.current = false;
    }
  }, [choosingDirectory, busy]);
  const [error, setError] = useState('');
  const [manual, setManual] = useState<Extract<CommandResult, {kind: 'groups'}>>();
  const active = useRef(true);
  useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
  const nameProblem = projectNameProblem(name);
  const freeAt = shownResponse(conversation, response);
  const decisionFresh = open && decisionReady.serial === decisionSerial.current && decisionReady.epoch === decisionOpenEpoch.current;
  const judgeProblem = conversation === 'smart' ? decisionReadError || (!decisionFresh || !decisionView ? '正在读取默认决策模型，请稍候。' : judgeSetupProblem({kind: 'default'}, decisionView.services, providers.map(item => item.id), {kind: 'ready', configuration: decisionView.configuration})) : undefined;
  const dirty = Boolean(name !== (mode.kind === 'bind' ? mode.group.name : '') || folder || existingDirectory || pickedTool !== undefined || conversation || response);
  function discard() {setName(''); setFolder(undefined); setExistingDirectory(false); setPickedTool(undefined); setConversation(undefined); setResponse(undefined);}
  function close() {if (!busy) navigate(() => {active.current = false; onClose();});}
  function switchMode(next: Mode) {
    if (busy) return;
    navigate(() => {setMode(next); setName(next.kind === 'bind' ? next.group.name : ''); setFolder(undefined); setExistingDirectory(false); setError('');});
  }
  async function save() {
    if (busy || mode.kind !== 'bind') return false;
    if (!name.trim() || (existingDirectory && !folder)) {setError('请填写名称并选择工作目录。'); return false;}
    if (!conversation) {setError('请选择沟通方式。'); return false;}
    if (!tool || !ready(tool)) {setError('请先安装并登录 Provider。'); return false;}
    if (conversation === 'smart' && (decisionReady.serial !== decisionSerial.current || decisionReady.epoch !== decisionOpenEpoch.current)) {setError('正在读取决策模型设置，请稍候。'); return false;}
    if (judgeProblem) {setError(judgeProblem); return false;}
    const picked = sentResponse(conversation, freeAt);
    // Explicitly track the host default; older saved groups retain their previous override.
    const decision = conversation === 'smart' ? {judge: {kind: 'default' as const}} : {};
    if (nameProblem) {setError(nameProblem); return false;}
    setBusy(true); setError('');
    try {
      const where = {folder: existingDirectory && folder ? {kind: 'existing' as const, folderToken: folder.token} : {kind: 'default' as const}};
      const reply = await client.run({type: 'bindGroup', agentId: agent.id, groupId: mode.group.chatId, projectName: name.trim(), ...where, tool, conversation, ...picked, ...decision});
      if (!reply || reply.kind !== 'applied') {setError(reply && 'message' in reply && typeof reply.message === 'string' ? reply.message : '操作未完成，请重试。'); return false;}
      await onChanged({agentId: agent.id, chatId: mode.group.chatId});
      active.current = false;
      onClose();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败，填写的内容已保留。');
      return false;
    }
    finally {setBusy(false);}
  }
  // No automatic save action: binding is an explicit choice with a welcome card.
  useDraft(open && dirty, {title: '加入飞书群', discard});
  async function findGroups(cursor?: string) {
    setBusy(true); setError('');
    try {
      const reply = await client.run({type: 'listJoinedGroups', agentId: agent.id, ...(cursor ? {cursor} : {})});
      if (reply.kind === 'groups') setManual(previous => ({...reply, groups: cursor ? [...(previous?.groups ?? []), ...reply.groups.filter(item => !previous?.groups.some(old => old.id === item.id))] : reply.groups}));
      else setError('message' in reply ? reply.message : '无法读取飞书群。');
    } catch (failure) {setError(failure instanceof Error ? failure.message : '无法读取飞书群。');}
    finally {setBusy(false);}
  }
  return <Dialog open={open} size="lg" title={<span className="join-group-title"><span className="join-group-heading">{choosingDirectory && <IconButton label="返回添加群聊" variant="ghost" size="sm" disabled={busy} onClick={() => setChoosingDirectory(false)}><ArrowLeft size={16}/></IconButton>}{choosingDirectory ? '选择工作目录' : mode.kind === 'bind' ? '连接飞书群' : '添加飞书群'}</span><span className="join-group-agent"><AgentAvatar agent={agent}/><span title={agent.name}>{agent.name}</span></span></span>} onClose={busy ? undefined : choosingDirectory ? () => setChoosingDirectory(false) : close}
    footer={choosingDirectory ? <><span className="directory-key-hints">↑ ↓ 选择 <span>↵ 使用目录</span></span><Button disabled={busy} onClick={() => setChoosingDirectory(false)}>返回</Button></> : mode.kind === 'bind' ? <><Button disabled={busy} onClick={close}>取消</Button><Button variant="primary" loading={busy} disabled={!tool || !ready(tool) || !name.trim() || Boolean(nameProblem) || (existingDirectory && !folder) || !conversation || Boolean(judgeProblem)} onClick={() => void save()}>连接并发送欢迎卡片</Button></> : undefined}>
    {choosingDirectory ? <DirectorySearchStep onBusyChange={setBusy} onChoose={choice => {setFolder(choice); setChoosingDirectory(false);}}/> : <div className="page-stack join-group-flow">
      {mode.kind === 'existing' ? <>
        <p className="join-group-flow__hint">在飞书群的「设置 → 群机器人」中添加「{agent.name}」，再回来连接。</p>
        {pending?.problem && <InlineNotice title={pending.problem.kind === 'unsupported' ? '暂不支持自动发现' : '暂未获取新群聊'} tone="warning">{pending.problem.message} {pending.problem.kind === 'unsupported' && '请更新应用，或使用下方的群查找。'}</InlineNotice>}
        {pending?.groups.map(group => <InlineNotice key={group.chatId} title={`${agent.name} 已加入 ${group.name}`} actions={<Button disabled={busy} onClick={() => switchMode({kind: 'bind', group})}>继续连接</Button>}>选择沟通方式和工作目录。</InlineNotice>)}
        <Button loading={busy} disabled={busy} onClick={() => void findGroups()}>查找已经加入的群</Button>
        {manual && <><div className="join-group-list" aria-label="已经加入的飞书群">{manual.groups.map(group => <button type="button" key={group.id} disabled={busy || group.bound} onClick={() => switchMode({kind: 'bind', group: {chatId: group.id, name: group.name, addedAt: 0, hasOtherBots: group.hasOtherBots}})}><span>{group.name}</span><small>{group.bound ? '已连接' : '连接'}</small></button>)}</div>{!manual.groups.length && <p>未找到群聊，请确认 Bot 已加入。</p>}{manual.nextCursor && <Button disabled={busy} onClick={() => void findGroups(manual.nextCursor)}>加载更多</Button>}</>}
      </> : <>
        <FormField label="本地绑定名称" error={nameProblem}><input aria-label="本地绑定名称" autoComplete="off" maxLength={100} disabled={busy} value={name} onChange={event => setName(event.target.value)} /></FormField>
        <SettingsGroup>
          <SettingsRow className="group-choice-row" title="工作目录" trailing={<SettingChoices label="目录来源" disabled={busy} value={existingDirectory ? 'existing' : 'default'} choices={[{value: 'default', label: '自动创建'}, {value: 'existing', label: '选择目录'}]} onChange={value => {setExistingDirectory(value === 'existing'); if(value === 'existing' && !folder) setChoosingDirectory(true);}}/>} />
          {existingDirectory && <button type="button" className="join-directory-field" ref={directoryTrigger} disabled={busy} onClick={() => setChoosingDirectory(true)} aria-label="选择工作目录"><Folder size={16}/><span title={folder?.displayPath}>{folder?.displayPath ?? '搜索目录或输入路径'}</span><ChevronRight size={15}/></button>}
          <SettingsRow className="group-choice-row" title="Provider" trailing={<SettingChoices<ProviderTool | ''> label="执行工具" disabled={busy} value={tool ?? ''} choices={[{value: 'codex', label: 'Codex', disabled: !ready('codex')}, {value: 'claude', label: 'Claude', disabled: !ready('claude')}]} onChange={value => {if ((value === 'codex' || value === 'claude') && ready(value)) setPickedTool(toolSchema.parse(value));}}/>} />
          {(!tool || !ready(tool)) && <SettingsRow title="Provider 尚未就绪" description={tool ? '当前选择不可用，请重新登录或主动选择其他 Provider。' : '请先安装并登录 Codex 或 Claude。'} trailing={onOpenProviders && <Button disabled={busy} onClick={onOpenProviders}>设置 Provider</Button>}/>}
          {mode.kind === 'bind' && <SettingsRow title="权限" value="只读（不联网）" />}
        </SettingsGroup>
        <FormField label="沟通方式">
          <ChoiceGroup<Conversation | ''> label="沟通方式" aria-required disabled={busy} value={conversation ?? ''} options={conversationsFor(mode.kind === 'bind' && mode.group.topic === true)} onChange={value => {if (value) {setConversation(value); setResponse(picked => keptResponse(value, picked));}}} />
        </FormField>
        {conversation === 'smart' && judgeProblem && <div className="join-decision-problem" role="status"><span>{judgeProblem}</span><span className="join-decision-actions">{decisionReadError ? <IconButton size="sm" variant="ghost" label="重试读取默认决策模型" disabled={busy} onClick={() => void readDecision()}><RefreshCw size={15}/></IconButton> : !decisionFresh ? null : <Button size="sm" onClick={() => onOpenDecisionModel?.()}>前往设置</Button>}</span></div>}
        {mode.kind === 'bind' && mode.group.hasOtherBots && <p className="join-group-flow__hint">群内 Bot 都使用智能模式后，可互相 @ 并判断是否接话。</p>}
        {freeAt && <SettingsGroup>
          <SettingsRow className="group-choice-row" title="响应方式" trailing={<SettingChoices label="免 @" disabled={busy} value={freeAt} choices={[{value: 'all', label: '无需 @'}, {value: 'mention', label: '仅 @ 时'}]} onChange={value => setResponse(value === 'all' ? 'all' : 'mention')}/>} />
        </SettingsGroup>}
      </>}
      {error && <InlineNotice title="操作未完成" tone="danger">{error}</InlineNotice>}
    </div>}
  </Dialog>;
}
