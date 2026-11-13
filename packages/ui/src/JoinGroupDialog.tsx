import {ArrowLeft, Folder, ChevronRight, RefreshCw} from 'lucide-react';
import {DirectorySearchStep} from './DirectorySearchStep';
import {RpcError} from '@vonvon/client/browser';
import {useActiveDevice, useClient, type ActiveDevice} from './client-context';
import {configureProvider, onDevice} from './device-copy';
import {useEffect, useRef, useState, type Dispatch, type SetStateAction} from 'react';
import type {Agent, AgentSettingsView, HostSettingsView, DecisionModelsView, JudgeSelectionView, DesktopSnapshot, CommandResult, Conversation, FolderChoice, PendingGroup, ToolState, RecipeJoinInput} from '@vonvon/protocol';
import {FULL_ACCESS_WARNING, toolSchema} from '@vonvon/protocol';
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

type Mode = {kind: 'create'} | {kind: 'existing'} | {kind: 'bind'; group: PendingGroup};
// One vocabulary for the Bot settings and group setup. Do not preselect a communication mode.
export const CONVERSATIONS = communicationModes.map(({value, label, description}) => ({value, label, description}));
export function conversationsFor(topic: boolean) {return CONVERSATIONS.filter(option => !topic || option.value !== 'shared');}
export function judgeSetupProblem(selection: JudgeSelectionView, services?: DecisionModelsView, usableBackends: readonly string[] = [], configuration?: DecisionConfigurationState, where?: Pick<ActiveDevice, 'isRemote' | 'name'>): string | undefined {
  return providerDecisionProblem(selection, usableBackends.map(id => ({id, displayName: id})), services, configuration, where);
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
type ProviderTool = 'codex' | 'claude';
/** Local choices only. A folder token, provider status or directory search result belongs to the live connection. */
export type JoinGroupDraft = {
  mode: Mode; name: string; existingDirectory: boolean; pickedTool?: ProviderTool;
  conversation?: Conversation; response?: 'all' | 'mention';
};
/** A setup suggestion is accepted only if the current snapshot says it can run. */
export function initialGroupProvider(initialProvider?: ProviderTool, tools?: ToolState[]): ProviderTool | undefined {
  const ready = (provider: ProviderTool) => providerUsable(tools?.find(item => item.tool === provider));
  if (initialProvider && ready(initialProvider)) return initialProvider;
  return (['codex', 'claude'] as const).find(ready);
}
type Props = {snapshot?: DesktopSnapshot; open?: boolean; agent: Agent; pending?: PendingAgentGroups; initialGroup?: PendingGroup; initialProvider?: ProviderTool; tools?: ToolState[]; onClose: () => void; onChanged: (target: {agentId: Agent['id']; chatId: string}) => Promise<void>; onOpenProviders?: () => void; onOpenDecisionModel?: (provider?: string) => void;
  recipeDraft?: [JoinGroupDraft | undefined, Dispatch<SetStateAction<JoinGroupDraft | undefined>>];
  recipe?: {name: string; version: string}; onRecipeJoin?: (input: RecipeJoinInput) => Promise<void>; onRecipeGroup?: (groupId: string) => void; onRecipeCancel?: () => void; existingOnly?: boolean};
export function JoinGroupDialog({open = true, agent, pending, initialGroup, initialProvider, tools, onClose, onChanged, onOpenProviders, onOpenDecisionModel, recipe, onRecipeJoin, onRecipeGroup, onRecipeCancel, existingOnly, recipeDraft}: Props) {
  const {navigate} = useDraftGuard();
  const client = useClient();
  const device = useActiveDevice();
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
  const localDraft = useState<JoinGroupDraft>();
  const [savedDraft, setDraft] = recipeDraft ?? localDraft;
  const initial = useRef<JoinGroupDraft>({
    mode: initialGroup ? {kind: 'bind', group: initialGroup} : {kind: existingOnly ? 'existing' : 'create'},
    name: initialGroup?.name ?? '', existingDirectory: false,
  }).current;
  const {mode, name, existingDirectory, pickedTool, conversation, response} = savedDraft ?? initial;
  function edit(fields: Partial<JoinGroupDraft>) {
    setDraft(previous => ({...(previous ?? initial), ...fields}));
  }
  const [folder, setFolder] = useState<FolderChoice>();
  const ready = (provider: ProviderTool) => providerUsable(tools?.find(item => item.tool === provider));
  const tool = pickedTool ?? initialGroupProvider(initialProvider, tools);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (choosingDirectory) directoryWasOpen.current = true;
    else if (!busy && directoryWasOpen.current) {
      directoryTrigger.current?.focus(); directoryWasOpen.current = false;
    }
  }, [choosingDirectory, busy]);
  const [error, setError] = useState('');
  /** Set once a creation may have made a group: this dialog then creates nothing more, binding still works. */
  const [lock, setLock] = useState<CreationFailure>();
  const locked = mode.kind === 'create' && lock !== undefined;
  const [manual, setManual] = useState<Extract<CommandResult, {kind: 'groups'}>>();
  const active = useRef(true);
  useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
  const nameProblem = projectNameProblem(name);
  const freeAt = shownResponse(conversation, response);
  const decisionFresh = open && decisionReady.serial === decisionSerial.current && decisionReady.epoch === decisionOpenEpoch.current;
  const judgeProblem = conversation === 'smart' ? decisionReadError || (!decisionFresh || !decisionView ? '正在读取默认决策模型，请稍候。' : judgeSetupProblem({kind: 'default'}, decisionView.services, providers.map(item => item.id), {kind: 'ready', configuration: decisionView.configuration}, device)) : undefined;
  const dirty = Boolean(name !== (mode.kind === 'bind' ? mode.group.name : '') || folder || existingDirectory || pickedTool !== undefined || conversation || response);
  function discard() {edit({name: '', existingDirectory: false, pickedTool: undefined, conversation: undefined, response: undefined}); setFolder(undefined);}
  function close() {if (!busy) navigate(() => {active.current = false; onClose();});}
  function switchMode(next: Mode) {
    if (busy) return;
    navigate(() => {edit({mode: next, name: next.kind === 'bind' ? next.group.name : '', existingDirectory: false}); setFolder(undefined); setError('');});
  }
  async function save() {
    if (busy || mode.kind === 'existing' || locked) return false;
    if (!name.trim() || (existingDirectory && !folder)) {setError('请填写名称并选择工作目录。'); return false;}
    if (!conversation) {setError('请选择沟通方式。'); return false;}
    if (!tool || !ready(tool)) {setError(`请先${onDevice(device, '安装 Provider')}并配置好。`); return false;}
    if (conversation === 'smart' && (decisionReady.serial !== decisionSerial.current || decisionReady.epoch !== decisionOpenEpoch.current)) {setError('正在读取决策模型设置，请稍候。'); return false;}
    if (judgeProblem) {setError(judgeProblem); return false;}
    const picked = sentResponse(mode.kind, conversation, freeAt);
    // Explicitly track the host default; older saved groups retain their previous override.
    const decision = conversation === 'smart' ? {judge: {kind: 'default' as const}} : {};
    if (nameProblem) {setError(nameProblem); return false;}
    setBusy(true); setError('');
    try {
      const where = {folder: existingDirectory && folder ? {kind: 'existing' as const, folderToken: folder.token} : {kind: 'default' as const}};
      const input: RecipeJoinInput = mode.kind === 'create'
        ? {action: 'createProject', agentId: agent.id, name: name.trim(), ...where, tool, conversation, ...picked, ...decision}
        : {type: 'bindGroup', agentId: agent.id, groupId: mode.group.chatId, projectName: name.trim(), ...where, tool, conversation, ...picked, ...decision};
      if (onRecipeJoin) {await onRecipeJoin(input); return true;}
      const reply = 'action' in input ? await client.collaboration(input) : await client.run(input);
      if (!reply || reply.kind !== 'applied') {setError(reply && 'message' in reply && typeof reply.message === 'string' ? reply.message : '操作未完成，请重试。'); return false;}
      const chatId = mode.kind === 'bind' ? mode.group.chatId : 'project' in reply ? reply.project?.chatId : undefined;
      if (!chatId) {
        setLock({kind: 'unknown', message: CREATION_UNKNOWN});
        setError('群已创建，但暂时无法定位；请刷新群列表后打开。');
        return false;
      }
      await onChanged({agentId: agent.id, chatId});
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
    footer={choosingDirectory ? <><span className="directory-key-hints">↑ ↓ 选择 <span>↵ 使用目录</span></span><Button disabled={busy} onClick={() => setChoosingDirectory(false)}>返回</Button></> : mode.kind !== 'existing' ? <><Button disabled={busy} onClick={onRecipeCancel ? () => navigate(onRecipeCancel) : close}>取消</Button><Button variant="primary" loading={busy} disabled={locked || !tool || !ready(tool) || !name.trim() || Boolean(nameProblem) || (existingDirectory && !folder) || !conversation || Boolean(judgeProblem)} onClick={() => void save()}>{mode.kind === 'create' ? '创建并连接' : '连接并发送欢迎卡片'}</Button></> : onRecipeCancel ? <Button disabled={busy} onClick={() => navigate(onRecipeCancel)}>取消</Button> : undefined}>
    {choosingDirectory ? <DirectorySearchStep onBusyChange={setBusy} onChoose={choice => {setFolder(choice); setChoosingDirectory(false);}}/> : <div className="page-stack join-group-flow">
      {recipe && <SettingsGroup><SettingsRow title="配方" value={<span className="recipe-use-name">{recipe.name} · {recipe.version}</span>} description="已获取，连接群聊后预览并确认应用。"/></SettingsGroup>}
      {mode.kind !== 'bind' && <div className="join-group-flow__modes" role="group" aria-label="加入方式">
        {!existingOnly && <Button aria-pressed={mode.kind === 'create'} disabled={busy} onClick={() => switchMode({kind: 'create'})}>创建群聊</Button>}
        <Button aria-pressed={mode.kind === 'existing'} disabled={busy} onClick={() => switchMode({kind: 'existing'})}>连接已有群聊</Button>
      </div>}
      {mode.kind === 'existing' ? <>
        <p className="join-group-flow__hint">在飞书群的「设置 → 群机器人」中添加「{agent.name}」，再回来连接。</p>
        {pending?.problem && <InlineNotice title={pending.problem.kind === 'unsupported' ? '暂不支持自动发现' : '暂未获取新群聊'} tone="warning">{pending.problem.message} {pending.problem.kind === 'unsupported' && '请更新应用，或使用下方的群查找。'}</InlineNotice>}
        {pending?.groups.map(group => <InlineNotice key={group.chatId} title={`${agent.name} 已加入 ${group.name}`} actions={<Button disabled={busy} onClick={() => switchMode({kind: 'bind', group})}>继续连接</Button>}>选择沟通方式和工作目录。</InlineNotice>)}
        <Button loading={busy} disabled={busy} onClick={() => void findGroups()}>查找已经加入的群</Button>
        {manual && <><div className="join-group-list" aria-label="已经加入的飞书群">{manual.groups.map(group => <button type="button" key={group.id} disabled={busy || group.bound && !onRecipeGroup} onClick={() => group.bound && onRecipeGroup ? onRecipeGroup(group.id) : switchMode({kind: 'bind', group: {chatId: group.id, name: group.name, addedAt: 0, hasOtherBots: group.hasOtherBots}})}><span>{group.name}</span><small>{group.bound ? onRecipeGroup ? '应用配方' : '已连接' : '连接'}</small></button>)}</div>{!manual.groups.length && <p>未找到群聊，请确认 Bot 已加入。</p>}{manual.nextCursor && <Button disabled={busy} onClick={() => void findGroups(manual.nextCursor)}>加载更多</Button>}</>}
      </> : <>
        <FormField label={mode.kind === 'create' ? '飞书群名称' : '本地绑定名称'} error={nameProblem}><input aria-label={mode.kind === 'create' ? '飞书群名称' : '本地绑定名称'} placeholder={mode.kind === 'create' ? '例如：产品讨论' : undefined} autoComplete="off" maxLength={100} disabled={busy} value={name} onChange={event => edit({name: event.target.value})} /></FormField>
        <SettingsGroup>
          <SettingsRow className="group-choice-row" title="工作目录" trailing={<SettingChoices label="目录来源" disabled={busy} value={existingDirectory ? 'existing' : 'default'} choices={[{value: 'default', label: '自动创建'}, {value: 'existing', label: '选择目录'}]} onChange={value => {edit({existingDirectory: value === 'existing'}); if(value === 'existing' && !folder) setChoosingDirectory(true);}}/>} />
          {existingDirectory && <button type="button" className="join-directory-field" ref={directoryTrigger} disabled={busy} onClick={() => setChoosingDirectory(true)} aria-label="选择工作目录"><Folder size={16}/><span title={folder?.displayPath}>{folder?.displayPath ?? (recipeDraft && savedDraft?.existingDirectory ? '请重新选择工作目录' : '搜索目录或输入路径')}</span><ChevronRight size={15}/></button>}
          <SettingsRow className="group-choice-row" title="Provider" trailing={<SettingChoices<ProviderTool | ''> label="执行工具" disabled={busy} value={tool ?? ''} choices={[{value: 'codex', label: 'Codex', disabled: !ready('codex')}, {value: 'claude', label: 'Claude', disabled: !ready('claude')}]} onChange={value => {if ((value === 'codex' || value === 'claude') && ready(value)) edit({pickedTool: toolSchema.parse(value)});}}/>} />
          {(!tool || !ready(tool)) && <SettingsRow title="Provider 尚未就绪" description={tool ? `当前选择不可用：${configureProvider(device, tool)}或选别的 Provider。` : `请先${onDevice(device, '安装 Codex 或 Claude')} 并配置好（账号或自定义 API 都行）。`} trailing={onOpenProviders && <Button disabled={busy} onClick={onOpenProviders}>设置 Provider</Button>}/>}
          {mode.kind === 'bind' && <SettingsRow title="权限" value="只读（不联网）" />}
          {/* 新建的群默认就是完全访问（devices-ui-2 4.10），在这里说出来并带上第 15 节的警示。 */}
          {mode.kind === 'create' && <SettingsRow title="权限" value="完全访问" description={FULL_ACCESS_WARNING} />}
        </SettingsGroup>
        <FormField label="沟通方式">
          <ChoiceGroup<Conversation | ''> label="沟通方式" aria-required disabled={busy} value={conversation ?? ''} options={conversationsFor(mode.kind === 'bind' && mode.group.topic === true)} onChange={value => {if (value) {edit({conversation: value, response: keptResponse(value, response)});}}} />
        </FormField>
        {conversation === 'smart' && judgeProblem && <div className="join-decision-problem" role="status"><span>{judgeProblem}</span><span className="join-decision-actions">{decisionReadError ? <IconButton size="sm" variant="ghost" label="重试读取默认决策模型" disabled={busy} onClick={() => void readDecision()}><RefreshCw size={15}/></IconButton> : !decisionFresh ? null : <Button size="sm" onClick={() => onOpenDecisionModel?.()}>前往设置</Button>}</span></div>}
        {mode.kind === 'bind' && mode.group.hasOtherBots && <p className="join-group-flow__hint">群内 Bot 都使用智能模式后，可互相 @ 并判断是否接话。</p>}
        {freeAt && <SettingsGroup>
          <SettingsRow className="group-choice-row" title="响应方式" trailing={<SettingChoices label="免 @" disabled={busy} value={freeAt} choices={[{value: 'all', label: '无需 @'}, {value: 'mention', label: '仅 @ 时'}]} onChange={value => edit({response: value === 'all' ? 'all' : 'mention'})}/>} />
        </SettingsGroup>}
      </>}
      {mode.kind === 'create' && lock && <CreationLockNotice failure={lock} />}
      {error && <InlineNotice title="操作未完成" tone="danger">{error}</InlineNotice>}
    </div>}
  </Dialog>;
}
