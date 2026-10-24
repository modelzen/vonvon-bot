import {useCallback, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import {smartRulesText} from '@vonvon/protocol';
import {Blocks, ChevronRight, Folder, GitBranch, Plus, RefreshCw, Search, X} from 'lucide-react';
import {backendLabel, isKnownJudgeSelection, type AgentId, type AgentSettingsView, type DecisionModelsView, type JudgeSelectionView, type ModelCatalog, type ProjectSettingsView, type SettingsReply, type ToolState} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {useDirectoriesPicker} from '../directory-picker';
import {Button, IconButton, InlineNotice, SelectControl, Toggle} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Catalog, Editor, ProjectPanel, type Section} from './SettingsPanel';
import {PersonaEditor} from './PersonaEditor';
import {SmartRulesEditor, SMART_RULES_MAX_LENGTH} from './SmartRulesEditor';
import {SettingChoices} from './SettingChoices';
import {useProviderDiscovery} from './useProviderDiscovery';
import {DecisionFields, providerDecisionProblem} from './DecisionFields';
export {DecisionFields} from './DecisionFields';
import {AnnouncedReadonlyMessages, hasReadonlyMessage, type ReadonlyMessage} from './readonly-messages';
import {CompactModelSelection} from './CompactModelSelection';
import {useDecisionConfiguration} from './useDecisionConfiguration';
import './group-design-settings.css';

/** 模型与权限 shares one settings view; permission remains a compatible internal section key. */
export type GroupSettingsTab = 'capabilities' | 'role' | 'model' | 'response' | 'permission';
const SUPPLEMENT_MAX = 5_000;
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
  onOpenSecrets?: (provider?: string) => void;
  responseHeader?: ReactNode;
};
const failText = (error: unknown) => error instanceof Error ? error.message : '暂时无法读取，请重试。';
const pathName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const toggleItem = <T,>(items: T[], value: T, checked: boolean) => checked ? [...new Set([...items, value])] : items.filter(item => item !== value);

function MissingSection() {
  return <InlineNotice title="这项设置暂不可用" tone="warning">请更新并重新连接本机服务。</InlineNotice>;
}
export function useProviders(tools?: readonly ToolState[]) {
  return useProviderDiscovery(tools).providers;
}
function providerChoices(providers: Provider[], current: string) {
  return [...providers.map(provider => ({value: provider.id, label: provider.displayName, disabled: false})), ...(!providers.some(provider => provider.id === current) && current ? [{value: current, label: `${backendLabel(current)}（当前不可用）`, disabled: true}] : [])];
}
function providerIcon(backend: string) {
  const path = backend === 'codex-appserver' ? './agent-icons/codex-light.png' : backend === 'claude-agent' ? './agent-icons/claude-code.svg' : undefined;
  return path ? <img src={path} className={backend === 'codex-appserver' ? 'gd-provider-icon--codex' : undefined} alt="" width={16} height={16}/> : <Blocks size={16} aria-hidden="true"/>;
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

export function GroupSettingsContent({view, refresh, tab, tools, onOpenTools, onOpenProviders, onOpenSecrets, responseHeader}: Omit<Props, 'scope'> & {view: ProjectSettingsView; refresh: () => Promise<void>}) {
  const client = useClient();
  const discovery = useProviderDiscovery(tools);
  const providers = discovery.providers;
  const outerReadonly = useContext(AnnouncedReadonlyMessages);
  const sections = view.sections;
  const decisionConfiguration = useDecisionConfiguration(tab === 'response' && view.identity.kind === 'smart');
  const modelCatalog = useRef<ModelCatalog | undefined>(undefined);
  const rememberCatalog = useCallback((catalog: ModelCatalog | undefined) => {modelCatalog.current = catalog;}, []);
  async function save(section: keyof GroupSections, patch: object, revision: string): Promise<SettingsReply> {
    const reply = await client.settings({type: 'save', edit: {scope: view.scope, section, patch, revision}});
    if (reply.kind === 'saved' && reply.result.kind === 'saved') await refresh();
    return reply;
  }
  const relevant: (Section<unknown> | undefined)[] = tab === 'capabilities' ? [sections.skills, sections.presentation]
    : tab === 'role' ? [sections.role] : tab === 'model' ? [sections.modelAccess, sections.permission]
    : tab === 'permission' ? [sections.permission]
    : [...(view.identity.kind !== 'smart' ? [sections.response] : []), ...(view.identity.backend !== 'claude-agent' ? [sections.run] : []), sections.permission, sections.presentation, ...(view.identity.kind === 'smart' ? [sections.judge, sections.smartRules] : [])];
  const notices: ReadonlyMessage[] = [];
  for (const section of relevant) if (section?.access.kind === 'readonly' && !hasReadonlyMessage([...outerReadonly, ...notices], section.access)) notices.push(section.access);
  return <AnnouncedReadonlyMessages.Provider value={[...outerReadonly, ...notices]}>
    {notices.map(notice => <p className="settings-readonly-notice" role="status" key={`${notice.reason}:${notice.message}`}>{notice.message}</p>)}
    <div className="gd-page">
      {(tab === 'response' || (tab === 'model' && (discovery.checking || discovery.message))) && <div className="gd-provider-discovery" role="status">
        {discovery.checking ? '正在检查 Provider 登录状态…' : discovery.message}
        {!discovery.checking && <Button size="sm" variant="ghost" onClick={discovery.retry}>重新检查 Provider</Button>}
      </div>}
      {tab === 'capabilities' && <>
        {sections.skills && view.skills ? <Editor title="技能" section={sections.skills} save={(patch, revision) => save('skills', patch, revision)}
          render={(draft, _set, disabled, commit) => <SkillsList skills={view.skills!} disabledPaths={draft.disabledPaths} disabled={disabled}
            onToggle={(path, enabled) => void commit({disabledPaths: toggleItem(draft.disabledPaths, path, !enabled)})}
            refresh={refresh}/>}/> : view.skillsError ? <InlineNotice title="技能尚未读取" tone="warning">{view.skillsError}<Button size="sm" onClick={() => void refresh()}>重新读取</Button></InlineNotice> : <MissingSection/>}
        {view.skills && view.skillsError && <p className="gd-note" role="status">{view.skillsError}</p>}
        {sections.presentation && <Editor title="语音" section={sections.presentation} save={(patch, revision) => save('presentation', patch, revision)}
          render={(draft, _set, disabled, commit) => <SettingsRow title="语音转文字" trailing={<Toggle className="settings-row-switch" label="语音转文字" aria-label="语音转文字" checked={draft.voiceEnabled} disabled={disabled} onChange={event => void commit({voiceEnabled: event.target.checked})}/>}/>}/>}
        {onOpenTools && <SettingsGroup><SettingsRow title="工具与连接" description="安装与授权" trailing={<Button size="sm" onClick={onOpenTools}>管理<ChevronRight size={13}/></Button>}/></SettingsGroup>}
      </>}
      {tab === 'role' && (sections.role ? <Editor title="本群角色" section={sections.role} save={(patch, revision) => save('role', patch, revision)}
        validate={value => [...value.supplement].length > SUPPLEMENT_MAX ? `本群角色最多 ${SUPPLEMENT_MAX} 字。` : undefined}
        render={(draft, set, disabled) => <>
          <PersonaEditor label="本群角色" value={draft.supplement} onChange={supplement => set({...draft, supplement})} disabled={disabled}
            placeholder="例如：在这个群负责发版检查和排障。留空时使用 Bot 页的角色设定。"/>
          <p className="gd-note">{[...draft.supplement].length} / {SUPPLEMENT_MAX} 字。</p>
        </>}/> : <MissingSection/>)}
      {tab === 'model' && (sections.modelAccess ? <Editor title="可用模型" section={sections.modelAccess} save={(patch, revision) => save('modelAccess', patch, revision)}
        render={(draft, set, disabled) => <ModelAccessFields botId={view.scope.botId} value={draft} onChange={set} disabled={disabled} providers={providers} onCatalog={rememberCatalog}
          onCheckProviders={discovery.retry} checkingProviders={discovery.checking}
          onOpenProviders={onOpenProviders} permissionName={sections.permission.stored.options.tiers.find(tier => tier.tier === sections.permission.stored.mode)?.name} savedBackend={view.identity.backend}/>}
        validate={value => providers.some(provider => provider.id === value.backend) ? modelAccessProblem(value, modelCatalog.current) : '此 Provider 当前不可用，请先安装并登录。'}/> : <MissingSection/>)}
      {(tab === 'model' || tab === 'permission') && <ProjectPanel view={view} refresh={refresh} partition="permission" independent/>}
      {tab === 'response' && <>
        {responseHeader}
        {view.identity.kind === 'smart' && <>
          {sections.judge ? <Editor title="决策模型" section={sections.judge} autoSave save={(patch, revision) => save('judge', patch, revision)}
            validate={value => providerDecisionProblem(value.selection, providers, view.decisionModels)}
            render={(draft, set, disabled, _commit, resetKey) => <DecisionFields key={resetKey} botId={view.scope.botId} groupBackend={view.identity.backend} value={draft.selection} effective={sections.judge!.effective.selection}
              onChange={selection => set({selection})} disabled={disabled} providers={providers} services={view.decisionModels} configuration={decisionConfiguration} tools={tools} onOpenProviders={onOpenProviders} onOpenSecrets={onOpenSecrets}/>}/> : <MissingSection/>}
          {sections.smartRules ? <Editor title="判断规则" section={sections.smartRules} save={(patch, revision) => save('smartRules', patch, revision)}
            validate={draft => smartRulesText(draft).length > SMART_RULES_MAX_LENGTH ? `规则超过 ${SMART_RULES_MAX_LENGTH} 字，请缩短后保存。` : undefined}
            render={(draft, set, disabled, _commit, resetKey) => <SmartRulesEditor key={resetKey} value={smartRulesText(draft)} disabled={disabled} onChange={respond => set({respond, newTopic: ''})}/>}/> : <MissingSection/>}
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
export function ModelAccessFields({botId, value, onChange, disabled, providers, onCatalog, permissionName, savedBackend, onOpenProviders, onCheckProviders, checkingProviders}: {botId: AgentId; value: ModelAccess; onChange: (value: ModelAccess) => void; disabled: boolean; providers: Provider[]; onCatalog?: (catalog: ModelCatalog | undefined) => void; permissionName?: string; savedBackend?: string; onOpenProviders?: () => void; onCheckProviders?: () => void; checkingProviders?: boolean}) {
  const available = providers.some(provider => provider.id === value.backend);
  const choices = providerChoices(providers, value.backend);
  return <div className="gd-model-fields gd-model-fields--compact">
    <div className="gd-model-summary-row gd-model-provider-row"><span className="gd-model-summary-label">Provider</span>
      <div className="gd-model-provider-control"><SelectControl label="模型 Provider" getOptionIcon={providerIcon} className="gd-model-provider-select" options={choices} value={value.backend} disabled={disabled}
        onChange={backend => {if (!disabled && backend !== value.backend && providers.some(provider => provider.id === backend)) onChange({backend, models: [], efforts: []});}}/>
        {!available && <span className="gd-model-provider-state">当前不可用</span>}
        {onCheckProviders && <IconButton size="sm" variant="ghost" label="重新检查 Provider" title="重新检查 Provider 登录状态" disabled={checkingProviders} onClick={onCheckProviders}><RefreshCw size={14}/></IconButton>}</div>
      {onOpenProviders && <Button size="sm" variant="ghost" onClick={onOpenProviders}>Provider 设置<ChevronRight size={13}/></Button>}
    </div>
    {permissionName && value.backend !== savedBackend && <p className="gd-model-compact-notice" role="status">换 Provider 后，权限仍是「{permissionName}」；自定义设置会清掉。</p>}
    {!available && <div className="gd-model-compact-notice" role="status"><span>此 Provider 暂不可用，已保存的选择仍保留。</span>{onOpenProviders && <Button size="sm" onClick={onOpenProviders}>检查 Provider</Button>}</div>}
    <Catalog key={value.backend} botId={botId} backend={value.backend} purpose="project">{catalog => <ModelAccessChoices value={value} onChange={onChange} catalog={catalog?.backend === value.backend ? catalog : undefined} disabled={disabled || !available} onCatalog={onCatalog}/>}</Catalog>
  </div>;
}
export function ModelAccessChoices({value, onChange, catalog, disabled, onCatalog}: {value: ModelAccess; onChange: (value: ModelAccess) => void; catalog?: ModelCatalog; disabled: boolean; onCatalog?: (catalog: ModelCatalog | undefined) => void}) {
  useEffect(() => {onCatalog?.(catalog);}, [catalog, onCatalog]);
  const problem = modelAccessProblem(value, catalog);
  return <>
    <CompactModelSelection value={value} onChange={onChange} catalog={catalog} disabled={disabled}/>
    {problem && catalog?.state === 'ready' && <p className="gd-model-compact-note" role="status">{problem}</p>}
    {!problem && <p className="gd-model-compact-note">群内只显示允许的模型及其支持的强度。</p>}
  </>;
}

export function WorkspaceFields({value, onChange, disabled}: {value: Workspace; onChange: (value: Workspace) => void; disabled: boolean}) {
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

function SkillsList({skills, disabledPaths, disabled, onToggle, refresh}: {
  skills: NonNullable<ProjectSettingsView['skills']>; disabledPaths: string[]; disabled: boolean; onToggle: (path: string, enabled: boolean) => void; refresh: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<(typeof skills)[number]>();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const visible = skills.filter(skill => `${skill.name} ${skill.description ?? ''}`.toLocaleLowerCase().includes(needle))
    .sort((a,b) => ({workspace:0,user:1,provider:2}[a.source] - {workspace:0,user:1,provider:2}[b.source]));
  return <>
    <div className="gd-section-heading gd-skill-heading">
      <label className="gd-skill-search"><Search size={14} aria-hidden="true"/><input type="search" aria-label="搜索技能" placeholder="搜索技能" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <div className="gd-skill-actions"><button type="button" className="gd-text-action" onClick={() => void refresh()}><RefreshCw size={13}/>重新读取</button></div>
    </div>
    {visible.length ? visible.map(skill => <div className="gd-skill-row" key={skill.path}>
      <button type="button" className="gd-skill-detail" onClick={() => setSelected(skill)}><span><strong>{skill.name}</strong>{skill.description && <small>{skill.description}</small>}{!skill.enabled && !disabledPaths.includes(skill.path) && <small>Provider 已停用</small>}</span><ChevronRight size={14}/></button>
      <Toggle className="settings-row-switch" label={`使用 ${skill.name}`} aria-label={`使用 ${skill.name}`} checked={skill.enabled && !disabledPaths.includes(skill.path)} disabled={disabled || !skill.enabled && !disabledPaths.includes(skill.path)} onChange={event => onToggle(skill.path, event.target.checked)}/>
    </div>) : <div className="gd-empty" role="status">{skills.length ? <>没有匹配的技能。<button type="button" className="gd-text-action" onClick={() => setQuery('')}>清除搜索</button></> : '工作区中尚未发现技能。'}</div>}
    <Dialog open={Boolean(selected)} title={selected?.name ?? '技能'} onClose={() => setSelected(undefined)} footer={<Button onClick={() => setSelected(undefined)}>完成</Button>}>
      {selected && <dl className="gd-skill-facts"><div><dt>说明</dt><dd>{selected.description || '未提供说明'}</dd></div><div><dt>来源</dt><dd>{{workspace: '本群工作区', user: '用户目录', provider: 'Provider'}[selected.source]}</dd></div><div><dt>位置</dt><dd>{selected.path}</dd></div></dl>}
    </Dialog>
  </>;
}
export function AgentProfileSettings({botId, onSaved}: {botId: AgentId; onSaved?: () => void}) {
  return <AgentProfileLoader key={botId} botId={botId} onSaved={onSaved}/>;
}
function AgentProfileLoader({botId, onSaved}: {botId: AgentId; onSaved?: () => void}) {
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
    {view?.sections.role ? <>
      {view.roleInfo?.mergedNotice && <p className="settings-readonly-notice" role="status">原来 AGENTS.md 里的内容已并到「其他说明」末尾。</p>}
      {view.roleInfo?.oversized && <p className="settings-readonly-notice" role="status">这份角色设定比现在的上限长，能打开，下次修改时请精简。</p>}
      {view.roleInfo?.integrity === 'changed' && <p className="settings-readonly-notice" role="status">角色设定文件在 vonvon 之外被改过。</p>}
      <Editor title="角色设定" section={view.sections.role} initialDraft={view.roleInfo?.draft ? {identity: view.roleInfo.draft} : undefined} save={async (patch, revision) => {
        const reply = await client.settings({type: 'save', edit: {scope: {kind: 'agent', botId}, section: 'role', patch, revision}});
        if (reply.kind === 'saved' && reply.result.kind === 'saved') {await refresh(); onSaved?.();}
        return reply;
      }} render={(draft, set, disabled) => <>
        <PersonaEditor label="身份与职责" value={draft.identity} onChange={identity => set({...draft, identity})} disabled={disabled} maxLength={500}/>
        <p className="gd-note">{[...draft.identity].length} / 500</p>
        <PersonaEditor label="其他说明" value={draft.notes} onChange={notes => set({...draft, notes})} disabled={disabled}/>
      </>}/>
    </> : view ? <MissingSection/> : !error && <p className="gd-empty" role="status">正在读取…</p>}
  </div>;
}
