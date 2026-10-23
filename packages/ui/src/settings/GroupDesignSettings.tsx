import {useCallback, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import {DEFAULT_SMART_RULES} from '@vonvon/protocol';
import {ChevronRight, Folder, GitBranch, Plus, RefreshCw, Search, X} from 'lucide-react';
import {backendLabel, isKnownJudgeSelection, type AgentId, type AgentSettingsView, type DecisionModelsView, type JudgeSelectionView, type ModelCatalog, type ProjectSettingsView, type SettingsReply, type ToolState} from '@vonvon/protocol';
import {useClient, useShellCapabilities} from '../client-context';
import {useDirectoriesPicker} from '../directory-picker';
import {Button, InlineNotice, Toggle} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {botChatUrl, copyShortcut, openExternalUrl} from '../url-actions';
import {Catalog, Editor, ProjectPanel, type Section} from './SettingsPanel';
import {PersonaEditor} from './PersonaEditor';
import {SettingChoices} from './SettingChoices';
import {providerBackends, providerUsable} from '../setup/provider-state';
import {DecisionFields, providerDecisionProblem} from './DecisionFields';
export {DecisionFields} from './DecisionFields';
import {AnnouncedReadonlyMessages, hasReadonlyMessage, type ReadonlyMessage} from './readonly-messages';
import './group-design-settings.css';

export type GroupSettingsTab = 'capabilities' | 'profile' | 'model' | 'workspace' | 'response';
type Scope = ProjectSettingsView['scope'];
type GroupSections = ProjectSettingsView['sections'];
type ModelAccess = NonNullable<GroupSections['modelAccess']>['stored'];
type Workspace = NonNullable<GroupSections['workspace']>['stored'];
type Provider = {id: string; displayName: string};
type Props = {
  scope: Scope;
  tab: GroupSettingsTab;
  tools?: readonly ToolState[];
  botName?: string;
  groupName?: string;
  onOpenTools?: () => void;
  onOpenProviders?: () => void;
  onOpenSecrets?: () => void;
  responseHeader?: ReactNode;
  decisionSetupOnly?: boolean;
  onDecisionSaved?: () => Promise<void>;
};
const failText = (error: unknown) => error instanceof Error ? error.message : '暂时无法读取，请重试。';
const pathName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const toggleItem = <T,>(items: T[], value: T, checked: boolean) => checked ? [...new Set([...items, value])] : items.filter(item => item !== value);

function MissingSection() {
  return <InlineNotice title="这项设置暂不可用" tone="warning">请更新并重新连接本机服务。</InlineNotice>;
}
export function useProviders(tools?: readonly ToolState[]) {
  const client = useClient();
  const readiness = tools?.map(tool => `${tool.tool}:${tool.installation}:${tool.compatibility?.status}:${tool.authentication}`).join('|');
  const key = readiness ?? 'snapshot';
  const [result, setResult] = useState<{key: string; providers: Provider[]}>({key, providers: []});
  useEffect(() => {
    let active = true;
    setResult({key, providers: []});
    void Promise.all([client.environment({type: 'backendCatalog'}), tools ? Promise.resolve(tools) : client.snapshot().then(snapshot => snapshot.tools)]).then(([reply, states]) => {
      if (active) setResult({key, providers: reply.kind === 'backends' ? reply.entries.filter(entry =>
        (Object.entries(providerBackends) as Array<['codex' | 'claude', string]>).some(([tool, backend]) => backend === entry.id && providerUsable(states.find(item => item.tool === tool)))
      ).map(entry => ({id: entry.id, displayName: entry.displayName})) : []});
    }).catch(() => {if (active) setResult({key, providers: []});});
    return () => {active = false;};
  }, [client, readiness]);
  return result.key === key ? result.providers : [];
}
function providerChoices(providers: Provider[], current: string) {
  return [...providers.map(provider => ({value: provider.id, label: provider.displayName, disabled: false})), ...(!providers.some(provider => provider.id === current) && current ? [{value: current, label: `${backendLabel(current)}（当前不可用）`, disabled: true}] : [])];
}
export function GroupDesignSettings(props: Props) {
  return <GroupSettingsLoader key={`${props.scope.botId}:${props.scope.projectName}`} {...props}/>;
}
function GroupSettingsLoader(props: Props) {
  const client = useClient();
  const [view, setView] = useState<ProjectSettingsView>();
  const [error, setError] = useState<string>();
  const serial = useRef(0);
  const {botId, projectName} = props.scope;
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    try {
      const reply = await client.settings({type: 'read', scope: {kind: 'project', botId, projectName}});
      if (request !== serial.current) return;
      if (reply.kind !== 'view' || !('members' in reply.view) || reply.view.scope.botId !== botId || reply.view.scope.projectName !== projectName) throw new Error(reply.kind === 'refused' ? reply.message : '群设置已变化，请重新打开。');
      setView(reply.view); setError(undefined);
    } catch (failure) {if (request === serial.current) setError(failText(failure));}
  }, [client, botId, projectName]);
  useEffect(() => {void refresh(); return () => {serial.current++;};}, [refresh]);
  return <div className="group-design-settings">
    {error && <InlineNotice tone="warning" title="读取未完成">{error}<Button size="sm" onClick={() => void refresh()}>重试</Button></InlineNotice>}
    {view ? <GroupSettingsContent {...props} view={view} refresh={refresh}/> : !error && <p className="gd-empty" role="status">正在读取…</p>}
  </div>;
}

export function GroupSettingsContent({view, refresh, tab, tools, botName = 'Bot', groupName, onOpenTools, onOpenProviders, onOpenSecrets, responseHeader, decisionSetupOnly, onDecisionSaved}: Omit<Props, 'scope'> & {view: ProjectSettingsView; refresh: () => Promise<void>}) {
  const client = useClient();
  const providers = useProviders(tools);
  const outerReadonly = useContext(AnnouncedReadonlyMessages);
  const sections = view.sections;
  const modelCatalog = useRef<ModelCatalog | undefined>(undefined);
  const rememberCatalog = useCallback((catalog: ModelCatalog | undefined) => {modelCatalog.current = catalog;}, []);
  async function save(section: keyof GroupSections, patch: object, revision: string): Promise<SettingsReply> {
    const reply = await client.settings({type: 'save', edit: {scope: view.scope, section, patch, revision}});
    if (reply.kind === 'saved' && reply.result.kind === 'saved') await refresh();
    return reply;
  }
  if (decisionSetupOnly) return sections.judge ? <Editor title="决策模型" section={sections.judge} allowUnchanged submitLabel="保存并使用智能模式" afterSave={onDecisionSaved}
    save={(patch, revision) => save('judge',patch,revision)}
    validate={value => providerDecisionProblem(value.selection, providers, view.decisionModels)}
    render={(draft,set,disabled,_commit,resetKey) => <DecisionFields initial key={resetKey} botId={view.scope.botId} groupBackend={view.identity.backend} value={draft.selection} effective={sections.judge!.effective.selection} onChange={selection=>set({selection})} disabled={disabled} providers={providers} services={view.decisionModels} tools={tools} onOpenProviders={onOpenProviders} onOpenSecrets={onOpenSecrets}/>}/> : <MissingSection/>;
  const relevant: (Section<unknown> | undefined)[] = tab === 'capabilities' ? [sections.skills, sections.presentation]
    : tab === 'profile' ? [sections.profile] : tab === 'model' ? [sections.modelAccess]
    : tab === 'workspace' ? [sections.workspace, sections.permission]
    : [...(view.identity.kind !== 'smart' ? [sections.response] : []), ...(view.identity.backend !== 'claude-agent' ? [sections.run] : []), sections.permission, sections.presentation, ...(view.identity.kind === 'smart' ? [sections.judge, sections.smartRules] : [])];
  const notices: ReadonlyMessage[] = [];
  for (const section of relevant) if (section?.access.kind === 'readonly' && !hasReadonlyMessage([...outerReadonly, ...notices], section.access)) notices.push(section.access);
  return <AnnouncedReadonlyMessages.Provider value={[...outerReadonly, ...notices]}>
    {notices.map(notice => <p className="settings-readonly-notice" role="status" key={`${notice.reason}:${notice.message}`}>{notice.message}</p>)}
    <div className="gd-page">
      {tab === 'capabilities' && <>
        {sections.skills && view.skills ? <Editor title="技能" section={sections.skills} save={(patch, revision) => save('skills', patch, revision)}
          render={(draft, _set, disabled, commit) => <SkillsList skills={view.skills!} disabledPaths={draft.disabledPaths} disabled={disabled}
            onToggle={(path, enabled) => void commit({disabledPaths: toggleItem(draft.disabledPaths, path, !enabled)})}
            botId={view.scope.botId} chatId={view.identity.chatId} botName={botName} groupName={groupName ?? view.scope.projectName} refresh={refresh}/>}/> : view.skillsError ? <InlineNotice title="技能尚未读取" tone="warning">{view.skillsError}<Button size="sm" onClick={() => void refresh()}>重新读取</Button></InlineNotice> : <MissingSection/>}
        {view.skills && view.skillsError && <p className="gd-note" role="status">{view.skillsError}</p>}
        {sections.presentation && <Editor title="语音" section={sections.presentation} save={(patch, revision) => save('presentation', patch, revision)}
          render={(draft, _set, disabled, commit) => <SettingsRow title="语音转文字" trailing={<Toggle className="settings-row-switch" label="语音转文字" aria-label="语音转文字" checked={draft.voiceEnabled} disabled={disabled} onChange={event => void commit({voiceEnabled: event.target.checked})}/>}/>}/>}
        {onOpenTools && <SettingsGroup><SettingsRow title="工具与连接" description="安装与授权" trailing={<Button size="sm" onClick={onOpenTools}>管理<ChevronRight size={13}/></Button>}/></SettingsGroup>}
      </>}
      {tab === 'profile' && (sections.profile && view.botProfile ? <Editor title="个性与记忆" section={sections.profile} save={(patch, revision) => save('profile', patch, revision)}
        render={(draft, set, disabled) => <>
          <PersonaEditor label="个性" value={draft.persona} onChange={persona => set({...draft, persona})} disabled={disabled} maxLength={30000}
            inheritance={{enabled: draft.inheritPersona, source: view.botProfile!.persona, botName, onChange: inheritPersona => set({...draft, inheritPersona})}}/>
          <PersonaEditor label="记忆" value={draft.memory} onChange={memory => set({...draft, memory})} disabled={disabled} maxLength={30000}
            inheritance={{enabled: draft.inheritMemory, source: view.botProfile!.memory, botName, onChange: inheritMemory => set({...draft, inheritMemory})}}/>
        </>}/> : <MissingSection/>)}
      {tab === 'model' && (sections.modelAccess ? <Editor title="可用模型" section={sections.modelAccess} save={(patch, revision) => save('modelAccess', patch, revision)}
        render={(draft, set, disabled) => <ModelAccessFields botId={view.scope.botId} value={draft} onChange={set} disabled={disabled} providers={providers} onCatalog={rememberCatalog}/>}
        validate={value => providers.some(provider => provider.id === value.backend) ? modelAccessProblem(value, modelCatalog.current) : '此 Provider 当前不可用，请先安装并登录。'}/> : <MissingSection/>)}
      {tab === 'workspace' && <>
        {sections.workspace ? <Editor title="工作区" section={sections.workspace} save={(patch, revision) => save('workspace', patch, revision)}
          render={(draft, set, disabled) => <WorkspaceFields value={draft} onChange={set} disabled={disabled}/>}
          validate={value => value.directories.includes(value.primary) ? undefined : '请选择一个主目录。'}/> : <MissingSection/>}
        <ProjectPanel view={view} refresh={refresh} partition="workspace" independent/>
      </>}
      {tab === 'response' && <>
        {responseHeader}
        {view.identity.kind === 'smart' && <>
          {sections.judge ? <Editor title="决策模型" section={sections.judge} save={(patch, revision) => save('judge', patch, revision)}
            validate={value => providerDecisionProblem(value.selection, providers, view.decisionModels)}
            render={(draft, set, disabled, _commit, resetKey) => <DecisionFields key={resetKey} botId={view.scope.botId} groupBackend={view.identity.backend} value={draft.selection} effective={sections.judge!.effective.selection}
              onChange={selection => set({selection})} disabled={disabled} providers={providers} services={view.decisionModels} tools={tools} onOpenProviders={onOpenProviders} onOpenSecrets={onOpenSecrets}/>}/> : <MissingSection/>}
          {sections.smartRules ? <Editor title="判断规则" section={sections.smartRules} save={(patch, revision) => save('smartRules', patch, revision)} render={(draft, set, disabled) => <>
            <div className="gd-section-heading gd-prompt-toolbar"><span className="gd-note">保存后，下次判断生效</span><button type="button" className="gd-text-action" disabled={disabled || draft.respond === DEFAULT_SMART_RULES.respond && draft.newTopic === DEFAULT_SMART_RULES.newTopic} onClick={() => set({...DEFAULT_SMART_RULES})}>恢复默认</button></div>
            <label className="gd-prompt"><span>什么时候回复</span><textarea aria-label="什么时候回复" rows={8} maxLength={30000} value={draft.respond} disabled={disabled} onChange={event => set({...draft, respond: event.target.value})}/></label>
            <label className="gd-prompt"><span>什么时候创建新话题</span><textarea aria-label="什么时候创建新话题" rows={4} maxLength={30000} value={draft.newTopic} disabled={disabled} onChange={event => set({...draft, newTopic: event.target.value})}/></label>
          </>}/> : <MissingSection/>}
        </>}
        {view.identity.kind !== 'smart' && <ProjectPanel view={view} refresh={refresh} partition="response" independent hideJudge/>}
        <details className="gd-disclosure"><summary>响应成员</summary><ProjectPanel view={view} refresh={refresh} partition="members" independent hideJudge/></details>
        <ProjectPanel view={view} refresh={refresh} partition="run" independent hideJudge/>
        {sections.presentation && <Editor title="消息与提醒" section={sections.presentation} save={(patch, revision) => save('presentation', patch, revision)} render={(draft, set, disabled, commit) => <>
          <SettingsRow title="显示工具调用" trailing={<Toggle className="settings-row-switch" label="显示工具调用" aria-label="显示工具调用" checked={draft.showToolCalls} disabled={disabled} onChange={event => void commit({showToolCalls: event.target.checked})}/>}/>
          <SettingsRow className="group-choice-row" title="显示模型" trailing={<SettingChoices label="显示模型" disabled={disabled} value={draft.showModel ?? ''} choices={[{value: 'off', label: '不显示'}, {value: 'running', label: '运行时'}, {value: 'always', label: '始终'}]} onChange={showModel => {if (showModel === 'off' || showModel === 'running' || showModel === 'always') void commit({showModel});}}/>}/>
          <SettingsRow className="group-choice-row" title="完成提醒" trailing={<SettingChoices label="完成提醒" disabled={disabled} value={draft.completionMode} choices={[{value: 'manual', label: '手动'}, {value: 'long', label: '长任务'}, {value: 'failures', label: '失败时'}, {value: 'always', label: '每次'}]} onChange={completionMode => void commit({completionMode})}/>}/>
          {draft.completionMode === 'long' && <SettingsRow title="超过几分钟提醒" trailing={<input className="settings-field" type="number" aria-label="长任务分钟数" min={1} max={1440} value={draft.longTaskMinutes} disabled={disabled} onChange={event => set({...draft, longTaskMinutes: Number(event.target.value)})}/>}/>}
        </>}/>}
      </>}
    </div>
  </AnnouncedReadonlyMessages.Provider>;
}

export function modelAccessProblem(value: ModelAccess, catalog?: ModelCatalog): string | undefined {
  if (!value.models.length) return '至少选择一个模型。';
  if (!catalog || catalog.backend !== value.backend || catalog.state !== 'ready') return '实时模型目录暂不可用。';
  const missing = value.models.filter(id => !catalog.models.some(model => model.id === id && !model.hidden));
  if (missing.length) return `当前目录中没有：${missing.join('、')}。`;
  const supported = new Set(catalog.models.flatMap(model => model.supportedEfforts));
  if (value.efforts.some(effort => !supported.has(effort))) return '已选 Effort 不在当前 Provider 的目录中。';
  const incompatible = catalog.models.filter(model => value.models.includes(model.id) && model.supportedEfforts.length > 0 && !model.supportedEfforts.some(effort => value.efforts.includes(effort)));
  return incompatible.length ? `请选择 ${incompatible.map(model => model.displayName).join('、')} 支持的 Effort。` : undefined;
}
export function ModelAccessFields({botId, value, onChange, disabled, providers, onCatalog}: {botId: AgentId; value: ModelAccess; onChange: (value: ModelAccess) => void; disabled: boolean; providers: Provider[]; onCatalog?: (catalog: ModelCatalog | undefined) => void}) {
  const available = providers.some(provider => provider.id === value.backend);
  return <div className="gd-model-fields">
    <fieldset><legend>Provider</legend><SettingChoices label="模型 Provider" choices={providerChoices(providers, value.backend)} value={value.backend} disabled={disabled} onChange={backend => {if (providers.some(provider => provider.id === backend)) onChange({backend, models: [], efforts: []});}}/></fieldset>
    {!available && <p className="gd-note" role="status">此 Provider 暂不可用。完成安装与登录后可继续，原配置已保留。</p>}
    <Catalog key={value.backend} botId={botId} backend={value.backend} purpose="project">{catalog => <ModelAccessChoices value={value} onChange={onChange} catalog={catalog?.backend === value.backend ? catalog : undefined} disabled={disabled || !available} onCatalog={onCatalog}/>}</Catalog>
  </div>;
}
export function ModelAccessChoices({value, onChange, catalog, disabled, onCatalog}: {value: ModelAccess; onChange: (value: ModelAccess) => void; catalog?: ModelCatalog; disabled: boolean; onCatalog?: (catalog: ModelCatalog | undefined) => void}) {
  useEffect(() => {onCatalog?.(catalog);}, [catalog, onCatalog]);
  const models = catalog?.models.filter(model => !model.hidden) ?? [];
  const efforts = [...new Set([...(catalog?.models.flatMap(model => model.supportedEfforts) ?? []), ...value.efforts])];
  const problem = modelAccessProblem(value, catalog);
  return <>
    <fieldset><legend>可用模型</legend><div className="gd-model-list">
      {models.map(model => <label className="gd-model-choice" key={model.id}><input type="checkbox" checked={value.models.includes(model.id)} disabled={disabled || catalog?.state === 'unavailable'} aria-label={`允许本群使用 ${model.displayName}`} onChange={event => onChange({...value, models: toggleItem(value.models, model.id, event.target.checked)})}/><span title={model.displayName.toLocaleLowerCase().replace(/[\s_-]+/g, '') !== model.id.toLocaleLowerCase().replace(/[\s_-]+/g, '') ? model.id : undefined}><strong>{model.displayName}</strong></span></label>)}
      {value.models.filter(id => !models.some(model => model.id === id)).map(id => <label key={id} className="gd-model-choice" data-unavailable><input type="checkbox" checked disabled={disabled} aria-label={`移除未列出的模型 ${id}`} onChange={() => onChange({...value, models: value.models.filter(model => model !== id)})}/><span><strong>{id}</strong><small>已保存，当前目录未列出</small></span></label>)}
      {!models.length && !value.models.length && <p className="gd-note">{catalog ? catalog.error || '当前没有可选模型。' : '正在读取模型…'}</p>}
    </div></fieldset>
    {efforts.length > 0 && <fieldset><legend>可用 Effort</legend><div className="gd-efforts">{efforts.map(effort => <label className="gd-effort-choice" key={effort}><input type="checkbox" checked={value.efforts.includes(effort)} disabled={disabled} aria-label={`允许本群使用 ${effort} Effort`} onChange={event => onChange({...value, efforts: toggleItem(value.efforts, effort, event.target.checked)})}/>{effort}</label>)}</div><p className="gd-note">群内切换时，只显示所选模型支持的 Effort。</p></fieldset>}
    {catalog?.state === 'fallback' && catalog.error && <p className="gd-note" role="status">{catalog.error}</p>}
    {problem && catalog && <p className="gd-note" role="status">{problem}</p>}
  </>;
}

function WorkspaceFields({value, onChange, disabled}: {value: Workspace; onChange: (value: Workspace) => void; disabled: boolean}) {
  const pick = useDirectoriesPicker();
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState(false);
  async function add(field: 'directories' | 'repositories') {
    setPicking(true); setError(undefined);
    try {
      const choices = await pick();
      if (choices?.length) onChange({...value, [field]: [...new Set([...value[field], ...choices.map(choice => choice.displayPath)])]});
    } catch (failure) {setError(failText(failure));} finally {setPicking(false);}
  }
  return <>
    {(['directories', 'repositories'] as const).map(field => <div className="gd-workspace-section" key={field}>
      <div className="gd-section-heading"><h3>{field === 'directories' ? '目录' : '代码仓库'}</h3><button type="button" className="gd-text-action" disabled={disabled || picking} onClick={() => void add(field)}><Plus size={13}/>{field === 'directories' ? '添加目录' : '添加仓库'}</button></div>
      <ul className="gd-directory-list">{value[field].map(path => <li className="gd-directory-row" key={path}>
        {field === 'directories' ? <Folder size={17}/> : <GitBranch size={17}/>}<span className="gd-directory-copy"><strong>{pathName(path)}</strong><small title={path}>{path}</small></span>
        <div className="gd-directory-actions">{field === 'directories' && (value.primary === path ? <span className="gd-primary-label">主目录</span> : <button className="gd-text-action" type="button" disabled={disabled || picking} onClick={() => onChange({...value, primary: path})}>设为主目录</button>)}
          <button type="button" className="gd-icon-action" disabled={disabled || picking || field === 'directories' && value.primary === path} aria-label={`移除${pathName(path)}`} title={field === 'directories' && value.primary === path ? '请先选择其他主目录' : '移除引用，保留本机文件'} onClick={() => onChange({...value, [field]: value[field].filter(item => item !== path)})}><X size={14}/></button>
        </div>
      </li>)}</ul>
      {!value[field].length && <p className="gd-note">{field === 'directories' ? '尚未添加目录' : '尚未添加代码仓库'}</p>}
    </div>)}
    {error && <p className="gd-empty gd-warning" role="alert">{error}</p>}
  </>;
}

function SkillsList({skills, disabledPaths, disabled, onToggle, refresh, ...target}: {
  skills: NonNullable<ProjectSettingsView['skills']>; disabledPaths: string[]; disabled: boolean; onToggle: (path: string, enabled: boolean) => void; refresh: () => Promise<void>;
  botId: AgentId; chatId: string; botName: string; groupName: string;
}) {
  const [selected, setSelected] = useState<(typeof skills)[number]>();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const visible = skills.filter(skill => `${skill.name} ${skill.description ?? ''}`.toLocaleLowerCase().includes(needle))
    .sort((a,b) => ({workspace:0,user:1,provider:2}[a.source] - {workspace:0,user:1,provider:2}[b.source]));
  return <>
    <div className="gd-section-heading gd-skill-heading">
      <label className="gd-skill-search"><Search size={14} aria-hidden="true"/><input type="search" aria-label="搜索技能" placeholder="搜索技能" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <div className="gd-skill-actions"><button type="button" className="gd-text-action" onClick={() => void refresh()}><RefreshCw size={13}/>重新读取</button><Button size="sm" disabled={disabled} onClick={() => setAdding(true)}><Plus size={13}/>添加技能</Button></div>
    </div>
    {visible.length ? visible.map(skill => <div className="gd-skill-row" key={skill.path}>
      <button type="button" className="gd-skill-detail" onClick={() => setSelected(skill)}><span><strong>{skill.name}</strong>{skill.description && <small>{skill.description}</small>}{!skill.enabled && !disabledPaths.includes(skill.path) && <small>Provider 已停用</small>}</span><ChevronRight size={14}/></button>
      <Toggle className="settings-row-switch" label={`使用 ${skill.name}`} aria-label={`使用 ${skill.name}`} checked={skill.enabled && !disabledPaths.includes(skill.path)} disabled={disabled || !skill.enabled && !disabledPaths.includes(skill.path)} onChange={event => onToggle(skill.path, event.target.checked)}/>
    </div>) : <div className="gd-empty" role="status">{skills.length ? <>没有匹配的技能。<button type="button" className="gd-text-action" onClick={() => setQuery('')}>清除搜索</button></> : '工作区中尚未发现技能。'}</div>}
    <Dialog open={Boolean(selected)} title={selected?.name ?? '技能'} onClose={() => setSelected(undefined)} footer={<Button onClick={() => setSelected(undefined)}>完成</Button>}>
      {selected && <dl className="gd-skill-facts"><div><dt>说明</dt><dd>{selected.description || '未提供说明'}</dd></div><div><dt>来源</dt><dd>{{workspace: '本群工作区', user: '用户目录', provider: 'Provider'}[selected.source]}</dd></div><div><dt>位置</dt><dd>{selected.path}</dd></div></dl>}
    </Dialog>
    <AddSkillDialog {...target} open={adding} onClose={() => setAdding(false)}/>
  </>;
}
function AddSkillDialog({open, onClose, botId, chatId, botName, groupName}: {open: boolean; onClose: () => void; botId: AgentId; chatId: string; botName: string; groupName: string}) {
  const shell = useShellCapabilities();
  const [notice, setNotice] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const command = `/skill-add ${chatId} `;
  useEffect(() => {if (open) setNotice('');}, [open]);
  async function copy() {
    try {await navigator.clipboard.writeText(command); setNotice('已复制');}
    catch {field.current?.focus(); field.current?.select(); setNotice(`按 ${copyShortcut()} 复制`);}
  }
  return <Dialog open={open} onClose={onClose} title="添加技能" footer={<><Button onClick={() => void copy()}>复制指令</Button><Button variant="primary" onClick={() => void openExternalUrl(botChatUrl(botId), 'bot-chat', shell).catch(error => setNotice(failText(error)))}>打开私聊</Button></>}>
    <div className="gd-add-skill"><div className="gd-target">{groupName}<small>{botName} · 本群工作区</small></div>
      <p>在私聊中粘贴指令，补充你想添加的技能。</p><textarea ref={field} aria-label="添加技能指令" readOnly value={command} rows={2} className="settings-field"/>
      <p className="gd-note">添加完成后发送 /skill-done，再回来重新读取。</p>{notice && <p role="status">{notice}</p>}
    </div>
  </Dialog>;
}

export function AgentProfileSettings({botId}: {botId: AgentId}) {
  return <AgentProfileLoader key={botId} botId={botId}/>;
}
function AgentProfileLoader({botId}: {botId: AgentId}) {
  const client = useClient();
  const [view, setView] = useState<AgentSettingsView>();
  const [error, setError] = useState<string>();
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    try {
      const reply = await client.settings({type: 'read', scope: {kind: 'agent', botId}});
      if (request !== serial.current) return;
      if (reply.kind !== 'view' || !('administrators' in reply.view) || reply.view.scope.botId !== botId) throw new Error(reply.kind === 'refused' ? reply.message : 'Bot 设置暂不可用。');
      setView(reply.view); setError(undefined);
    } catch (failure) {if (request === serial.current) setError(failText(failure));}
  }, [client, botId]);
  useEffect(() => {void refresh(); return () => {serial.current++;};}, [refresh]);
  return <div className="group-design-settings">{error && <InlineNotice title="读取未完成" tone="warning">{error}<Button size="sm" onClick={() => void refresh()}>重试</Button></InlineNotice>}
    {view?.sections.profile ? <Editor title="个性与记忆" section={view.sections.profile} save={async (patch, revision) => {
      const reply = await client.settings({type: 'save', edit: {scope: {kind: 'agent', botId}, section: 'profile', patch, revision}});
      if (reply.kind === 'saved' && reply.result.kind === 'saved') await refresh();
      return reply;
    }} render={(draft, set, disabled) => <>
      <PersonaEditor label="个性" value={draft.persona} onChange={persona => set({...draft, persona})} disabled={disabled} maxLength={30000}/>
      <PersonaEditor label="记忆" value={draft.memory} onChange={memory => set({...draft, memory})} disabled={disabled} maxLength={30000}/>
    </>}/> : view ? <MissingSection/> : !error && <p className="gd-empty" role="status">正在读取…</p>}
  </div>;
}
