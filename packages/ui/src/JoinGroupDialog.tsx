import {RpcError} from '@vonvon/client/browser';
import {useClient} from './client-context';
import {useDirectoryPicker} from './directory-picker';
import {useEffect, useRef, useState} from 'react';
import type {Agent, AgentSettingsView, DesktopSnapshot, ProjectId, CommandResult, Conversation, FolderChoice, PendingGroup, JudgeSelectionView, DecisionModelsView, ToolState} from '@vonvon/protocol';
import {conversationCopy, topicConversationCopy, toolSchema, groupDecisionSchema} from '@vonvon/protocol';
import {Button, ChoiceGroup, FormField, InlineNotice} from './reference/components/ui';
import {Dialog} from './reference/components/ui/Dialog';
import {SettingsGroup, SettingsRow} from './reference/components/system-settings';
import {useDraft, useDraftGuard} from './settings/DraftGuard';
import type {PendingAgentGroups} from './pending-groups';
import {SettingChoices} from './settings/SettingChoices';
import {DecisionFields, useProviders} from './settings/GroupDesignSettings';
import {providerDecisionProblem} from './settings/DecisionFields';
import {AgentAvatar} from './AgentAvatar';
import {crossGroupWarning, defaultProjectChoice, type ProjectChoice} from './project-model';
import './setup/join-group.css';
import {providerBackends, providerUsable} from './setup/provider-state';

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
export function judgeSetupProblem(selection: JudgeSelectionView, services?: DecisionModelsView, usableBackends: readonly string[] = []): string | undefined {
  return providerDecisionProblem(selection, usableBackends.map(id => ({id, displayName: id})), services);
}
type ProviderTool = 'codex' | 'claude';
/** A setup suggestion is accepted only if the current snapshot says it can run. */
export function initialGroupProvider(initialProvider?: ProviderTool, tools?: ToolState[]): ProviderTool | undefined {
  const ready = (provider: ProviderTool) => providerUsable(tools?.find(item => item.tool === provider));
  if (initialProvider && ready(initialProvider)) return initialProvider;
  return (['codex', 'claude'] as const).find(ready);
}
type Props = {snapshot?: DesktopSnapshot; linux?: boolean; open?: boolean; agent: Agent; pending?: PendingAgentGroups; initialGroup?: PendingGroup; initialProvider?: ProviderTool; /** Start the 项目 row on joining this project (the project page's 把一个群加进来…). */ initialProject?: ProjectId; tools?: ToolState[]; onClose: () => void; onChanged: (target: {agentId: Agent['id']; chatId: string}) => Promise<void>; onOpenProviders?: () => void; onOpenDecisionModel?: () => void};
export function JoinGroupDialog({snapshot, linux, open = true, agent, pending, initialGroup, initialProvider, initialProject, tools, onClose, onChanged, onOpenProviders, onOpenDecisionModel}: Props) {
  const {navigate} = useDraftGuard();
  const client = useClient();
  const pickDirectory = useDirectoryPicker();
  const [decisionView, setDecisionView] = useState<AgentSettingsView>();
  const [decisionReadError, setDecisionReadError] = useState('');
  const decisionSerial = useRef(0);
  const decisionOpenEpoch = useRef(0);
  if (!open) decisionOpenEpoch.current++;
  const [decisionReady, setDecisionReady] = useState({serial: -1, epoch: -1});
  const providers = useProviders(tools);
  async function readDecision() {
    const serial = ++decisionSerial.current;
    const epoch = decisionOpenEpoch.current;
    try {
      const reply = await client.settings({type: 'read', scope: {kind: 'agent', botId: agent.id}});
      if (serial !== decisionSerial.current) return;
      if (reply.kind !== 'view' || !('administrators' in reply.view) || reply.view.scope.kind !== 'agent') throw new Error(reply.kind === 'refused' ? reply.message : '无法读取决策模型设置。');
      setDecisionView(reply.view); setDecisionReady({serial, epoch}); setDecisionReadError('');
    } catch (failure) {if (serial === decisionSerial.current) setDecisionReadError(failure instanceof Error ? failure.message : '无法读取决策模型设置。');}
  }
  useEffect(() => {if (open) void readDecision(); return () => {decisionSerial.current++;};}, [client, agent.id, open]);
  const [mode, setMode] = useState<Mode>(initialGroup ? {kind: 'bind', group: initialGroup} : {kind: 'create'});
  const [name, setName] = useState(initialGroup?.name ?? '');
  const [folder, setFolder] = useState<FolderChoice>();
  const [existingDirectory, setExistingDirectory] = useState(false);
  // 项目 (§5.6): what the daemon remembers for this group, and the owner's own pick over the default.
  const [previousId, setPreviousId] = useState<ProjectId>();
  const [pickedProject, setPickedProject] = useState<ProjectChoice | undefined>(initialProject ? {kind: 'join', id: initialProject, reason: 'picked'} : undefined);
  // A snapshot refresh can improve the suggested default, but never replaces a hand pick.
  const [pickedTool, setPickedTool] = useState<ProviderTool | undefined>(undefined);
  const ready = (provider: ProviderTool) => providerUsable(tools?.find(item => item.tool === provider));
  const tool = pickedTool ?? initialGroupProvider(initialProvider, tools);
  const [judge, setJudge] = useState<JudgeSelectionView>({kind: 'default'});
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
  useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
  const bindingGroup = mode.kind === 'bind' ? mode.group.chatId : undefined;
  useEffect(() => {
    setPreviousId(undefined);
    if (!open || !bindingGroup) return;
    let current = true;
    void (async () => {
      try {
        const reply = await client.library({type: 'previous', agentId: agent.id, groupId: bindingGroup as never});
        if (current && reply.kind === 'previous') setPreviousId(reply.project?.id);
      } catch { /* an older daemon, or none connected: the default is then a new project */ }
    })();
    return () => {current = false;};
  }, [client, agent.id, bindingGroup, open]);
  const projects = snapshot?.projects ?? [];
  const projectChoice: ProjectChoice = pickedProject ?? (snapshot ? defaultProjectChoice(snapshot, bindingGroup, previousId) : {kind: 'new'});
  const joined = projectChoice.kind === 'join' ? projects.find(item => item.id === projectChoice.id) : undefined;
  // A group the daemon remembers a project for is picked up again when no project is named, so 新建 is not offered for it.
  const previousProject = previousId ? projects.find(item => item.id === previousId) : undefined;
  const nameProblem = projectNameProblem(name);
  const freeAt = shownResponse(conversation, response);
  const decisionFresh = open && decisionReady.serial === decisionSerial.current && decisionReady.epoch === decisionOpenEpoch.current;
  const judgeProblem = conversation === 'smart' ? decisionReadError || (!decisionFresh ? '正在读取决策模型设置，请稍候。' : judgeSetupProblem(judge, decisionView?.decisionModels, providers.map(item => item.id))) : undefined;
  const dirty = Boolean(name !== (mode.kind === 'bind' ? mode.group.name : '') || folder || existingDirectory || pickedProject || pickedTool !== undefined || conversation || response);
  function discard() {setName(''); setPickedProject(undefined); setFolder(undefined); setExistingDirectory(false); setPickedTool(undefined); setConversation(undefined); setResponse(undefined); setJudge({kind: 'default'});}
  function close() {if (!busy) navigate(() => {active.current = false; onClose();});}
  function switchMode(next: Mode) {
    if (busy) return;
    navigate(() => {setMode(next); setPickedProject(undefined); setName(next.kind === 'bind' ? next.group.name : ''); setFolder(undefined); setExistingDirectory(false); setError('');});
  }
  async function save() {
    if (busy || mode.kind === 'existing' || locked) return false;
    if (!name.trim() || (!joined && existingDirectory && !folder)) {setError('请填写名称并选择工作目录。'); return false;}
    if (!conversation) {setError('请选择会话方式。'); return false;}
    if (!tool || !ready(tool)) {setError('请先安装并登录 Provider。'); return false;}
    if (conversation === 'smart' && (decisionReady.serial !== decisionSerial.current || decisionReady.epoch !== decisionOpenEpoch.current)) {setError('正在读取决策模型设置，请稍候。'); return false;}
    if (judgeProblem) {setError(judgeProblem); return false;}
    const picked = sentResponse(mode.kind, conversation, freeAt);
    const selectedJudge = conversation === 'smart' ? groupDecisionSchema.safeParse(judge) : undefined;
    if (selectedJudge && !selectedJudge.success) {setError('请选择有效的决策模型。'); return false;}
    const decision = selectedJudge?.success ? {judge: selectedJudge.data} : {};
    if (nameProblem) {setError(nameProblem); return false;}
    setBusy(true); setError('');
    try {
      // Joining a project: its folder is the project's, so none is sent.
      const where = joined ? {folder: {kind: 'default' as const}, project: joined.id} : {folder: existingDirectory && folder ? {kind: 'existing' as const, folderToken: folder.token} : {kind: 'default' as const}};
      const reply = mode.kind === 'create'
        ? await client.collaboration({action: 'createProject', agentId: agent.id, name: name.trim(), ...where, tool, conversation, ...picked, ...decision})
        : await client.run({type: 'bindGroup', agentId: agent.id, groupId: mode.group.chatId, projectName: name.trim(), ...where, tool, conversation, ...picked, ...decision});
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
  return <Dialog open={open} size="lg" title={mode.kind === 'bind' ? '连接飞书群' : '添加飞书群'} onClose={busy ? undefined : close}>
    <div className="page-stack join-group-flow">
      <div className="join-group-flow__agent"><AgentAvatar agent={agent}/><span>{agent.name}</span></div>
      {mode.kind !== 'bind' && <div className="join-group-flow__modes" role="group" aria-label="加入方式">
        <Button aria-pressed={mode.kind === 'create'} disabled={busy} onClick={() => switchMode({kind: 'create'})}>创建群聊</Button>
        <Button aria-pressed={mode.kind === 'existing'} disabled={busy} onClick={() => switchMode({kind: 'existing'})}>连接已有群聊</Button>
      </div>}
      {mode.kind === 'existing' ? <>
        <p className="join-group-flow__hint">在飞书群的「设置 → 群机器人」中添加「{agent.name}」，再回来连接。</p>
        {pending?.problem && <InlineNotice title={pending.problem.kind === 'unsupported' ? '暂不支持自动发现' : '暂未获取新群聊'} tone="warning">{pending.problem.message} {pending.problem.kind === 'unsupported' && '请更新应用，或使用下方的群查找。'}</InlineNotice>}
        {pending?.groups.map(group => <InlineNotice key={group.chatId} title={`${agent.name} 已加入 ${group.name}`} actions={<Button disabled={busy} onClick={() => switchMode({kind: 'bind', group})}>继续连接</Button>}>选择会话方式和工作区。</InlineNotice>)}
        <Button loading={busy} disabled={busy} onClick={() => void findGroups()}>查找已经加入的群</Button>
        {manual && <><div className="join-group-list" aria-label="已经加入的飞书群">{manual.groups.map(group => <button type="button" key={group.id} disabled={busy || group.bound} onClick={() => switchMode({kind: 'bind', group: {chatId: group.id, name: group.name, addedAt: 0, hasOtherBots: group.hasOtherBots}})}><span>{group.name}</span><small>{group.bound ? '已连接' : '连接'}</small></button>)}</div>{!manual.groups.length && <p>未找到群聊，请确认 Bot 已加入。</p>}{manual.nextCursor && <Button disabled={busy} onClick={() => void findGroups(manual.nextCursor)}>加载更多</Button>}</>}
      </> : <>
        <FormField label={mode.kind === 'create' ? '飞书群名称' : '本地绑定名称'} error={nameProblem}><input aria-label={mode.kind === 'create' ? '飞书群名称' : '本地绑定名称'} placeholder={mode.kind === 'create' ? '例如：产品讨论' : undefined} autoComplete="off" maxLength={100} disabled={busy} value={name} onChange={event => setName(event.target.value)} /></FormField>
        {projects.length > 0 && <SettingsGroup>
          <SettingsRow className="group-choice-row" title="项目" trailing={<SettingChoices label="项目" disabled={busy} value={joined ? 'join' : 'new'} choices={[
            {value: 'new', label: `新建项目「${name.trim() || '…'}」`, disabled: Boolean(previousProject)},
            {value: 'join', label: previousProject && projectChoice.kind === 'join' && projectChoice.reason === 'previous' ? `接回项目「${previousProject.name}」` : '加入已有项目'}]}
            onChange={value => setPickedProject(value === 'new' ? {kind: 'new'} : {kind: 'join', id: (joined ?? projects[0]!).id, reason: 'picked'})}/>}/>
          {joined && <SettingsRow title="加入哪个项目" trailing={<select className="settings-field" aria-label="选择项目" disabled={busy} value={joined.id} onChange={event => setPickedProject({kind: 'join', id: event.target.value as ProjectId, reason: 'picked'})}>
            {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}/>}
          {joined && projectChoice.kind === 'join' && projectChoice.reason === 'sibling' && <p className="join-group-flow__hint">同一个群的 Bot 默认共用项目；要分开就新建。</p>}
          {previousProject && <p className="join-group-flow__hint">这个群以前绑过项目「{previousProject.name}」，默认接回；要换就加入别的项目。</p>}
        </SettingsGroup>}
        {crossGroupWarning(joined, bindingGroup) && <InlineNotice title="两个群会共用这个项目" tone="warning">{crossGroupWarning(joined, bindingGroup)}</InlineNotice>}
        <SettingsGroup>
          {joined ? <SettingsRow title="项目主目录" value={joined.directory}/> : <SettingsRow className="group-choice-row" title="工作区" trailing={<SettingChoices label="目录来源" disabled={busy} value={existingDirectory ? 'existing' : 'default'} choices={[{value: 'default', label: '新建目录'}, {value: 'existing', label: '选择目录'}]} onChange={value => {setExistingDirectory(value === 'existing'); setFolder(undefined);}}/>} />}
          {!joined && existingDirectory && <SettingsRow title="主目录" value={folder?.displayPath ?? '未选择'} trailing={<Button disabled={busy} onClick={() => void chooseFolder()}>选择文件夹</Button>}/> }
          <SettingsRow className="group-choice-row" title="Provider" trailing={<SettingChoices<ProviderTool | ''> label="执行工具" disabled={busy} value={tool ?? ''} choices={[{value: 'codex', label: 'Codex', disabled: !ready('codex')}, {value: 'claude', label: 'Claude', disabled: !ready('claude')}]} onChange={value => {if ((value === 'codex' || value === 'claude') && ready(value)) setPickedTool(toolSchema.parse(value));}}/>} />
          {(!tool || !ready(tool)) && <SettingsRow title="Provider 尚未就绪" description={tool ? '当前选择不可用，请重新登录或主动选择其他 Provider。' : '请先安装并登录 Codex 或 Claude。'} trailing={onOpenProviders && <Button disabled={busy} onClick={onOpenProviders}>设置 Provider</Button>}/>}
          {mode.kind === 'bind' && <SettingsRow title="权限档和网络" value="只读 · 网络关闭" />}
        </SettingsGroup>
        <FormField label="会话方式">
          <ChoiceGroup<Conversation | ''> label="会话方式" aria-required disabled={busy} value={conversation ?? ''} options={conversationsFor(mode.kind === 'bind' && mode.group.topic === true)} onChange={value => {if (value) {setConversation(value); setResponse(picked => keptResponse(value, picked));}}} />
        </FormField>
        {conversation === 'smart' && <SettingsGroup label="判断 Provider">
          <DecisionFields initial botId={agent.id} groupBackend={tool ? providerBackends[tool] : ''} value={judge} effective={decisionView?.sections.judge?.effective.selection ?? {kind: 'default'}} onChange={setJudge} disabled={busy} providers={providers} services={decisionView?.decisionModels} tools={tools} onOpenProviders={onOpenProviders} onOpenSecrets={onOpenDecisionModel}/>
          {judgeProblem && <p className="gd-note" role="status">{judgeProblem}</p>}
          {decisionReadError && <Button size="sm" disabled={busy} onClick={() => void readDecision()}>重试读取</Button>}
        </SettingsGroup>}
        {mode.kind === 'bind' && mode.group.hasOtherBots && <p className="join-group-flow__hint">群内 Bot 都使用智能模式后，可互相 @ 并判断是否接话。</p>}
        {freeAt && <SettingsGroup>
          <SettingsRow className="group-choice-row" title="响应方式" trailing={<SettingChoices label="免 @" disabled={busy} value={freeAt} choices={[{value: 'all', label: '无需 @'}, {value: 'mention', label: '仅 @ 时'}]} onChange={value => setResponse(value === 'all' ? 'all' : 'mention')}/>} />
        </SettingsGroup>}
        {linux && mode.kind === 'bind' && tool === 'codex' && <InlineNotice title="Linux 上的 Codex 只能用完全访问" tone="info">连接后，在群设置中改为完全访问才能使用。</InlineNotice>}
        <Button variant="primary" loading={busy} disabled={locked || !tool || !ready(tool) || !name.trim() || Boolean(nameProblem) || (!joined && existingDirectory && !folder) || !conversation || Boolean(judgeProblem)} onClick={() => void save()}>{mode.kind === 'create' ? '创建并连接' : '连接并发送欢迎卡片'}</Button>
      </>}
      {mode.kind === 'create' && lock && <CreationLockNotice failure={lock} />}
      {error && <InlineNotice title="操作未完成" tone="danger">{error}</InlineNotice>}
    </div>
  </Dialog>;
}
