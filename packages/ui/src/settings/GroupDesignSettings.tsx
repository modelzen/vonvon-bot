import {useCallback, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import {DEFAULT_DM_SMART_RULES_TEXT, smartRulesText} from '@vonvon/protocol';
import {Blocks, ChevronDown, ChevronRight, Folder, GitBranch, Plus, RefreshCw, Search, X} from 'lucide-react';
import {backendLabel, isKnownJudgeSelection, type Agent, type AgentId, type DecisionModelsView, type JudgeSelectionView, type ModelCatalog, type ProjectSettingsView, type SettingsReply, type SkillSource, type ToolState} from '@vonvon/protocol';
import {useActiveDevice, useClient} from '../client-context';
import {settingAnchor} from '../search';
import {onDevice, updateServerText, whereName} from '../device-copy';
import {useDirectoriesPicker} from '../directory-picker';
import {Button, IconButton, InlineNotice, SelectControl, Toggle} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Catalog, Editor, ProjectPanel, type CatalogControls, type Section, type SettingsFieldIssue} from './SettingsPanel';
import {PersonaEditor} from './PersonaEditor';
import {SmartRulesEditor, SMART_RULES_MAX_LENGTH} from './SmartRulesEditor';
import {SettingChoices} from './SettingChoices';
import {ConversationSlider, dmConversationModes} from './ConversationSlider';
import {useDraftGuard} from './DraftGuard';
import {useProviderDiscovery} from './useProviderDiscovery';
import {DecisionFields, providerDecisionProblem} from './DecisionFields';
export {DecisionFields} from './DecisionFields';
import {AnnouncedReadonlyMessages, hasReadonlyMessage, type ReadonlyMessage} from './readonly-messages';
import {CompactModelSelection} from './CompactModelSelection';
import {modelAccessDefault} from './model-access-draft';
import {useDecisionCatalogs} from './useDecisionCatalogs';
import './group-design-settings.css';
import {BotAdministrators} from '../management/AdministratorsPanel';
import {CardDisplayEntry} from './card-display/CardDisplayStudio';

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
  agent?: Agent;
  botName?: string;
  groupName?: string;
  onOpenTools?: () => void;
  onOpenProviders?: () => void;
  onOpenSecrets?: (provider?: string) => void;
  responseHeader?: ReactNode | ((ordinaryResponse: ReactNode) => ReactNode);
  refreshVersion?: number;
  /** The private chat's row: its permission and folder are only shown, and it has no topics or members (dm-agent 4.2). */
  dm?: boolean;
};
const failText = (error: unknown) => error instanceof Error ? error.message : '暂时无法读取，请重试。';
const pathName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const toggleItem = <T,>(items: T[], value: T, checked: boolean) => checked ? [...new Set([...items, value])] : items.filter(item => item !== value);

function MissingSection() {
  return <InlineNotice title="这项设置暂不可用" tone="warning">{updateServerText(useActiveDevice())}</InlineNotice>;
}
export function useProviders(tools?: readonly ToolState[]) {
  return useProviderDiscovery(tools).providers;
}
function providerChoices(providers: Provider[], current: string) {
  return [...providers.map(provider => ({value: provider.id, label: provider.displayName, disabled: false})), ...(!providers.some(provider => provider.id === current) && current ? [{value: current, label: `${backendLabel(current)}（当前不可用）`, disabled: true}] : [])];
}
function providerIcon(backend: string) {
  const path = backend === 'codex-appserver' ? './agent-icons/terminal.png' : backend === 'claude-agent' ? './agent-icons/code.png' : undefined;
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
  useEffect(() => {void refresh(); return () => {serial.current++;};}, [refresh, props.refreshVersion]);
  return <div className="group-design-settings">
    {error && <InlineNotice tone="warning" title="读取未完成">{error}<IconButton size="sm" variant="ghost" label="重试" title="重试" onClick={() => void refresh()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton></InlineNotice>}
    {view ? <GroupSettingsContent {...props} view={view} refresh={refresh}/> : !error && <p className="gd-empty" role="status">正在读取…</p>}
  </div>;
}

/** What a private chat shows and does not let anyone change: one tier, one folder. */
export function dmFixedRows(view: ProjectSettingsView): {title: string; value: string; description: string}[] {
  const {mode, options} = view.sections.permission.stored;
  const tier = options.tiers.find(item => item.tier === mode);
  return [
    {title: '执行权限', value: tier?.name ?? '完全访问', description: [tier?.summary, '私聊固定用这一档。'].filter(Boolean).join(' ')},
    {title: '目录', value: view.identity.cwd, description: '私聊专用，不能改'},
  ];
}
function DmFixedSettings({view}: {view: ProjectSettingsView}) {
  const [tier, folder] = dmFixedRows(view);
  return <SettingsGroup label="执行权限" id={settingAnchor('权限')} className="permission-summary">
    <SettingsRow title={tier!.value} description={tier!.description}/>
    <SettingsRow title={folder!.title} description={folder!.description} value={folder!.value}/>
  </SettingsGroup>;
}

/** The group's 聊天方式 control, on the row's own setting instead of the group's binding. */
function DmConversation({section, save}: {section: NonNullable<GroupSections['conversation']>; save: (patch: {mode: 'smart' | 'single'}, revision: string) => Promise<SettingsReply>}) {
  const guard = useDraftGuard();
  const [pending, setPending] = useState<'smart' | 'single'>();
  const [problem, setProblem] = useState(false);
  async function change(mode: 'smart' | 'single') {
    setPending(mode); setProblem(false);
    try {
      const reply = await save({mode}, section.revision);
      if (reply.kind !== 'saved' || reply.result.kind !== 'saved') setProblem(true);
    } catch {setProblem(true);}
    finally {setPending(undefined);}
  }
  return <div className="group-conversation-layout"><section id={settingAnchor('聊天方式')} className="group-conversation-choice" aria-label="聊天方式">
    <h3>聊天方式</h3><ConversationSlider label="聊天方式" modes={dmConversationModes} value={(pending ?? section.stored.mode) === 'smart' ? 'smart' : 'shared'}
      disabled={section.access.kind === 'readonly'} pending={pending !== undefined} onChange={next => guard.navigate(() => {void change(next === 'smart' ? 'smart' : 'single');})}/>
    {problem && <p className="group-control-note" role="alert">没保存上，请再试一次。</p>}
  </section></div>;
}

export function GroupSettingsContent({view, refresh, tab, tools, onOpenTools, onOpenProviders, onOpenSecrets, responseHeader, dm, agent, botName, groupName}: Omit<Props, 'scope'> & {view: ProjectSettingsView; refresh: () => Promise<void>}) {
  const client = useClient();
  const where = useActiveDevice();
  const discovery = useProviderDiscovery(tools);
  const providers = discovery.providers;
  const outerReadonly = useContext(AnnouncedReadonlyMessages);
  const sections = view.sections;
  const [rulesExpanded, setRulesExpanded] = useState(false);
  const {catalogs: decisionCatalogs} = useDecisionCatalogs(tab === 'response' && view.identity.kind === 'smart');
  // Render the server-resolved, independent snapshot for older marker-based groups.
  const storedJudge = sections.judge?.stored.selection;
  const judgeSection = sections.judge && storedJudge && isKnownJudgeSelection(storedJudge) && (storedJudge.kind === 'default' || storedJudge.kind === 'provider')
    ? {...sections.judge, stored: sections.judge.effective} : sections.judge;
  const modelCatalog = useRef<ModelCatalog | undefined>(undefined);
  const rememberCatalog = useCallback((catalog: ModelCatalog | undefined) => {modelCatalog.current = catalog;}, []);
  async function save(section: keyof GroupSections, patch: object, revision: string): Promise<SettingsReply> {
    const reply = await client.settings({type: 'save', edit: {scope: view.scope, section, patch, revision}});
    if (reply.kind === 'saved' && reply.result.kind === 'saved') await refresh();
    return reply;
  }
  const relevant: (Section<unknown> | undefined)[] = tab === 'capabilities' ? [sections.skills, ...(dm ? [] : [sections.presentation])]
    : tab === 'role' ? [sections.role] : tab === 'model' ? [sections.modelAccess, ...(dm ? [] : [sections.permission])]
    : tab === 'permission' ? [sections.permission]
    : dm ? [sections.conversation, ...(view.identity.kind === 'smart' ? [sections.smartRules, sections.judge] : [])]
    : [...(view.identity.kind !== 'smart' ? [sections.response] : []), ...(view.identity.backend !== 'claude-agent' ? [sections.run] : []), sections.permission, sections.presentation, ...(view.identity.kind === 'smart' ? [sections.judge, sections.smartRules] : [])];
  const notices: ReadonlyMessage[] = [];
  for (const section of relevant) if (section?.access.kind === 'readonly' && !hasReadonlyMessage([...outerReadonly, ...notices], section.access)) notices.push(section.access);
  return <AnnouncedReadonlyMessages.Provider value={[...outerReadonly, ...notices]}>
    {notices.map(notice => <p className="settings-readonly-notice" role="status" key={`${notice.reason}:${notice.message}`}>{notice.message}</p>)}
    <div className="gd-page">
      {(tab === 'response' || tab === 'model') && (discovery.checking || discovery.message) && <div className="gd-provider-discovery" role="status">
        {discovery.checking ? '正在检查 Provider 是否可用…' : discovery.message}
        {!discovery.checking && <IconButton size="sm" variant="ghost" label="重新检查 Provider" title="重新检查 Provider" onClick={discovery.retry}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>}
      </div>}
      {tab === 'capabilities' && <>
        {sections.skills && view.skills ? <Editor title="技能" section={sections.skills} save={(patch, revision) => save('skills', patch, revision)}
          render={(draft, _set, disabled, commit) => <SkillsList skills={view.skills!} disabledPaths={draft.disabledPaths} disabled={disabled}
            onToggle={(path, enabled) => void commit({disabledPaths: toggleItem(draft.disabledPaths, path, !enabled)})}
            refresh={refresh}/>}/> : view.skillsError ? <InlineNotice title="技能尚未读取" tone="warning">{view.skillsError}<IconButton size="sm" variant="ghost" label="重新读取" title="重新读取" onClick={() => void refresh()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton></InlineNotice> : <MissingSection/>}
        {view.skills && view.skillsError && <p className="gd-note" role="status">{view.skillsError}</p>}
        {sections.presentation && <Editor title="语音" section={sections.presentation} save={(patch, revision) => save('presentation', patch, revision)}
          render={(draft, _set, disabled, commit) => <SettingsRow title="语音转文字" trailing={<Toggle className="settings-row-switch" label="语音转文字" aria-label="语音转文字" checked={draft.voiceEnabled} disabled={disabled} onChange={event => void commit({voiceEnabled: event.target.checked})}/>}/>}/>}
        {onOpenTools && <SettingsGroup><SettingsRow title="工具" description="安装与授权" trailing={<Button size="sm" onClick={onOpenTools}>管理<ChevronRight size={13}/></Button>}/></SettingsGroup>}
      </>}
      {tab === 'role' && (sections.role ? <Editor title="本群角色" section={sections.role} save={(patch, revision) => save('role', patch, revision)}
        validate={value => [...value.supplement].length > SUPPLEMENT_MAX ? `本群角色最多 ${SUPPLEMENT_MAX} 字。` : undefined}
        render={(draft, set, disabled) => <>
          <PersonaEditor label="本群角色" value={draft.supplement} onChange={supplement => set({...draft, supplement})} disabled={disabled}
            placeholder="例如：在这个群负责发版检查和排障。留空时使用 Bot 页的角色设定。"/>
          <p className="gd-note">{[...draft.supplement].length} / {SUPPLEMENT_MAX} 字。</p>
        </>}/> : <MissingSection/>)}
      {tab === 'model' && (sections.modelAccess ? <Editor title="模型设置" section={sections.modelAccess} save={(patch, revision) => save('modelAccess', patch, revision)}
        fieldLabels={{models: '可用模型', defaultModel: '可用模型', modelServiceTiers: '可用模型', efforts: '可用思考强度', modelEfforts: '可用思考强度', defaultEffort: '可用思考强度', backend: 'Provider', settings: '模型设置'}}
        render={(draft, set, disabled, _commit, _resetKey, _discard, fieldIssues) => <ModelAccessFields fieldIssues={fieldIssues} botId={view.scope.botId} value={draft} onChange={set} disabled={disabled} providers={providers} onCatalog={rememberCatalog}
          onCheckProviders={discovery.retry} checkingProviders={discovery.checking}
          onOpenProviders={onOpenProviders} dm={dm} permissionName={dm ? undefined : sections.permission.stored.options.tiers.find(tier => tier.tier === sections.permission.stored.mode)?.name} savedBackend={view.identity.backend}/>}
        validate={value => providers.some(provider => provider.id === value.backend) ? modelAccessProblem(value, modelCatalog.current) : `这个 Provider 现在不可用，先${onDevice(where, '安装')}并配置好。`}/> : <MissingSection/>)}
      {(tab === 'model' || tab === 'permission') && (dm ? <DmFixedSettings view={view}/> : <ProjectPanel view={view} refresh={refresh} partition="permission" independent/>)}
      {tab === 'response' && <>
        <section className="gd-conversation-section" aria-label="聊天方式">
        {typeof responseHeader === 'function' ? responseHeader(!dm && view.identity.kind !== 'smart' ? <div className="group-no-mention"><ProjectPanel view={view} refresh={refresh} partition="response" independent hideJudge/></div> : null) : responseHeader}
        {dm && sections.conversation && <DmConversation section={sections.conversation} save={(patch, revision) => save('conversation', patch, revision)}/>}
        {view.identity.kind === 'smart' && <details className="gd-disclosure"><summary>智能回应设置</summary>
          {judgeSection ? <Editor title="决策模型" section={judgeSection} autoSave save={(patch, revision) => save('judge', patch, revision)}
            validate={value => providerDecisionProblem(value.selection, providers, view.decisionModels, undefined, where)}
            render={(draft, set, disabled, _commit, resetKey) => <DecisionFields key={resetKey} botId={view.scope.botId} groupBackend={view.identity.backend} value={draft.selection} effective={sections.judge!.effective.selection}
              onChange={selection => set({selection})} disabled={disabled} providers={providers} services={view.decisionModels} catalogs={decisionCatalogs} tools={tools} onOpenProviders={onOpenProviders} onOpenSecrets={onOpenSecrets}/>}/> : <MissingSection/>}
          {sections.smartRules ? <Editor title="判断规则" section={sections.smartRules} save={(patch, revision) => save('smartRules', patch, revision)}
            validate={draft => smartRulesText(draft).length > SMART_RULES_MAX_LENGTH ? `规则超过 ${SMART_RULES_MAX_LENGTH} 字，请缩短后保存。` : undefined}
            render={(draft, set, disabled, _commit, resetKey) => <SmartRulesEditor key={resetKey} defaultText={dm ? DEFAULT_DM_SMART_RULES_TEXT : undefined} expanded={rulesExpanded} onExpandedChange={setRulesExpanded} value={smartRulesText(draft)} disabled={disabled} onChange={respond => set({respond, newTopic: ''})}/>}/> : <MissingSection/>}
        </details>}
        {!dm && view.identity.kind !== 'smart' && typeof responseHeader !== 'function' && <ProjectPanel view={view} refresh={refresh} partition="response" independent hideJudge/>}
        <div className="gd-conversation-run"><ProjectPanel view={view} refresh={refresh} partition="run" independent hideJudge/></div>
        </section>
        {dm ? agent && <BotAdministrators key={agent.id} agent={agent} embedded/> : <ProjectPanel view={view} refresh={refresh} partition="members" independent hideJudge/>}
        {sections.presentation && <CardDisplayEntry key={`${view.scope.botId}:${view.scope.projectName}`} scopeLabel={dm ? '此私聊' : '此群聊'} saved={sections.presentation.stored.cardDisplay} revision={sections.presentation.revision} agent={agent}
          readonly={sections.presentation.access.kind === 'readonly'} botName={botName} groupName={dm ? '私聊' : groupName}
          completionMode={sections.presentation.effective.completionMode} longTaskMinutes={sections.presentation.effective.longTaskMinutes} completionTemplate={sections.presentation.effective.completionTemplate}
          onSave={(patch, revision) => save('presentation', patch, revision)} onRefresh={refresh}/>}

      </>}
    </div>
  </AnnouncedReadonlyMessages.Provider>;
}

export function modelAccessProblems(value: ModelAccess, catalog?: ModelCatalog): {models?: string; efforts?: string; catalog?: string} {
  if (!catalog || catalog.backend !== value.backend || catalog.state !== 'ready') return {catalog: '实时模型目录暂不可用。'};
  const problems: {models?: string; efforts?: string} = {};
  const missing = value.models.filter(id => !catalog.models.some(model => model.id === id && !model.hidden));
  if (!value.models.length) problems.models = '至少选择一个模型。';
  else if (missing.length) problems.models = `当前目录中没有：${missing.join('、')}。请取消勾选或刷新后重试。`;
  const models = catalog.models.filter(model => value.models.includes(model.id) && !model.hidden);
  const allowed = (id: string) => value.modelEfforts?.[id] ?? value.efforts;
  const unsupported = value.modelEfforts
    ? models.flatMap(model => (value.modelEfforts?.[model.id] ?? []).filter(e => !model.supportedEfforts.includes(e)).map(e => `${model.displayName} · ${e}`))
    : value.efforts.filter(e => !catalog.models.some(model => !model.hidden && model.supportedEfforts.includes(e)));
  if (unsupported.length) problems.efforts = `已不可用：${unsupported.join('、')}。请在下拉框中取消勾选。`;
  const incompatible = models.filter(model => model.supportedEfforts.length > 0 && !model.supportedEfforts.some(e => allowed(model.id).includes(e)));
  if (!problems.efforts && incompatible.length) problems.efforts = `请选择 ${incompatible.map(model => model.displayName).join('、')} 支持的思考强度。`;
  const defaultModel = models.find(m => m.id === (value.defaultModel ?? value.models[0]));
  if (!problems.models && !defaultModel) problems.models = '请在已勾选的模型中设置新话题默认模型。';
  if (!problems.efforts && value.defaultEffort && defaultModel?.supportedEfforts.length && (!defaultModel.supportedEfforts.includes(value.defaultEffort) || !allowed(defaultModel.id).includes(value.defaultEffort))) problems.efforts = `默认强度 ${value.defaultEffort} 不在 ${defaultModel.displayName} 的可用范围内，请重新选择默认强度。`;
  const removedTiers = models.filter(model => (value.modelServiceTiers?.[model.id] ?? []).some(tier => !model.serviceTiers?.some(t => t.id === tier)));
  if (!problems.models && removedTiers.length) problems.models = `${removedTiers.map(model => model.displayName).join('、')} 的部分加速选项已不可用，请打开模型旁的加速设置取消勾选。`;
  return problems;
}
export function modelAccessProblem(value: ModelAccess, catalog?: ModelCatalog): string | undefined {
  const problems = modelAccessProblems(value, catalog);
  return problems.models ?? problems.efforts ?? problems.catalog;
}
export function ModelAccessFields({botId, value, onChange, disabled, providers, onCatalog, permissionName, savedBackend, onOpenProviders, onCheckProviders, checkingProviders, fieldIssues, dm}: {dm?: boolean; fieldIssues?: SettingsFieldIssue[]; botId: AgentId; value: ModelAccess; onChange: (value: ModelAccess) => void; disabled: boolean; providers: Provider[]; onCatalog?: (catalog: ModelCatalog | undefined) => void; permissionName?: string; savedBackend?: string; onOpenProviders?: () => void; onCheckProviders?: () => void; checkingProviders?: boolean}) {
  const available = providers.some(provider => provider.id === value.backend);
  const choices = providerChoices(providers, value.backend);
  return <div className="gd-model-fields gd-model-fields--compact">
    <div className="gd-model-summary-row gd-model-provider-row"><span className="gd-model-summary-label">Provider</span>
      <div className="gd-model-provider-control"><SelectControl label="模型 Provider" getOptionIcon={providerIcon} className="gd-model-provider-select" options={choices} value={value.backend} disabled={disabled}
        onChange={backend => {if (!disabled && backend !== value.backend && providers.some(provider => provider.id === backend)) onChange({backend, models: [], efforts: [], modelEfforts: {}, modelServiceTiers: {}, defaultModel: undefined, defaultEffort: undefined});}}/>
        {!available && <span className="gd-model-provider-state">当前不可用</span>}
        {onCheckProviders && <IconButton size="sm" variant="ghost" label="重新检查 Provider" title="重新检查 Provider 是否可用" disabled={checkingProviders} onClick={onCheckProviders}><RefreshCw size={14}/></IconButton>}</div>
      {onOpenProviders && <Button size="sm" variant="ghost" onClick={onOpenProviders}>Provider 设置<ChevronRight size={13}/></Button>}
    </div>
    {permissionName && value.backend !== savedBackend && <p className="gd-model-compact-notice" role="status">换 Provider 后，权限仍是「{permissionName}」；自定义设置会清掉。</p>}
    {!available && <div className="gd-model-compact-notice" role="status"><span>此 Provider 暂不可用，已保存的选择仍保留。</span>{onOpenProviders && <Button size="sm" onClick={onOpenProviders}>检查 Provider</Button>}</div>}
    <Catalog key={value.backend} botId={botId} backend={value.backend} purpose="project" showStatus={false}>{(catalog, catalogControls) => <ModelAccessChoices dm={dm} fieldIssues={fieldIssues} value={value} onChange={onChange} catalog={catalog?.backend === value.backend ? catalog : undefined} catalogControls={catalogControls} disabled={disabled || !available} onCatalog={onCatalog}/>}</Catalog>
  </div>;
}
export function ModelAccessChoices({value, onChange, catalog, catalogControls, disabled, onCatalog, fieldIssues, dm}: {dm?: boolean; fieldIssues?: SettingsFieldIssue[]; value: ModelAccess; onChange: (value: ModelAccess) => void; catalog?: ModelCatalog; catalogControls?: CatalogControls; disabled: boolean; onCatalog?: (catalog: ModelCatalog | undefined) => void}) {
  useEffect(() => {onCatalog?.(catalogControls?.loading ? undefined : catalog);}, [catalog, catalogControls?.loading, onCatalog]);
  const problems = modelAccessProblems(value, catalogControls?.loading ? undefined : catalog);
  const fieldError = (fields: string[]) => fieldIssues?.filter(issue => fields.includes(issue.field)).map(issue => issue.message).join('；') || undefined;
  const errors = {models: fieldError(['models', 'defaultModel', 'modelServiceTiers']) ?? problems.models, efforts: fieldError(['efforts', 'modelEfforts', 'defaultEffort']) ?? problems.efforts};
  const problem = errors.models ?? errors.efforts ?? problems.catalog;
  const status = catalogControls?.loading ? '正在刷新模型和思考强度，已保存的选择仍保留。' : catalogControls?.error;
  const {id, model, effort} = modelAccessDefault(value, catalog?.backend === value.backend ? catalog.models : []);
  const defaults = `${model?.displayName ?? id ?? '请选择'}${model?.supportedEfforts.length && effort ? ` · ${effort}` : ''}`;
  return <>
    <CompactModelSelection errors={errors} value={value} onChange={onChange} catalog={catalog} catalogControls={catalogControls} disabled={disabled}/>
    {status ? <p className="gd-model-compact-note" role="status">{status}</p> : !problem && <p className="gd-model-compact-note">{dm ? `新会话默认：${defaults}。` : `群内通过 /model 切换；新话题默认：${defaults}。`}</p>}
  </>;
}

export function WorkspaceFields({value, onChange, disabled}: {value: Workspace; onChange: (value: Workspace) => void; disabled: boolean}) {
  const pick = useDirectoriesPicker();
  // The folders are the shown device's (devices-ui-2 第 8 节第 1 条).
  const where = useActiveDevice();
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
          <button type="button" className="gd-icon-action" disabled={disabled || picking || field === 'directories' && value.primary === path} aria-label={`移除${pathName(path)}`} title={field === 'directories' && value.primary === path ? '请先选择其他主目录' : where.isRemote ? `移除引用，保留${whereName(where)}上的文件` : '移除引用，保留本机文件'} onClick={() => onChange({...value, [field]: value[field].filter(item => item !== path)})}><X size={14}/></button>
        </div>
      </li>)}</ul>
      {!value[field].length && <p className="gd-note">{field === 'directories' ? '尚未添加目录' : '尚未添加代码仓库'}</p>}
    </div>)}
    {error && <p className="gd-empty gd-warning" role="alert">{error}</p>}
  </>;
}

const SKILL_REGION_ORDER: readonly SkillSource[] = ['builtin', 'workspace', 'user', 'plugin', 'system', 'provider'];
const SKILL_REGION_META: Record<SkillSource, {label: string; shortLabel: string}> = {
  builtin: {label: 'VonVon', shortLabel: 'VonVon'},
  workspace: {label: '本项目技能', shortLabel: '项目'},
  user: {label: 'Provider 全局技能', shortLabel: '全局'},
  plugin: {label: 'Provider 插件技能', shortLabel: '插件'},
  system: {label: 'Provider 系统技能', shortLabel: '系统'},
  provider: {label: 'Provider 技能', shortLabel: 'Provider'},
};

function SkillsList({skills, disabledPaths, disabled, onToggle, refresh}: {
  skills: NonNullable<ProjectSettingsView['skills']>; disabledPaths: string[]; disabled: boolean; onToggle: (path: string, enabled: boolean) => void; refresh: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<(typeof skills)[number]>();
  const [query, setQuery] = useState('');
  const [activeRegion, setActiveRegion] = useState<'all' | SkillSource>('all');
  const [collapsedRegions, setCollapsedRegions] = useState<Partial<Record<SkillSource, boolean>>>({});
  const isSkillChecked = (skill: (typeof skills)[number]) => skill.source === 'builtin'
    ? !disabledPaths.includes(skill.path)
    : skill.enabled && !disabledPaths.includes(skill.path);
  const isProviderDisabled = (skill: (typeof skills)[number]) => skill.source !== 'builtin' && !skill.enabled && !disabledPaths.includes(skill.path);
  const needle = query.trim().toLocaleLowerCase();
  const presentRegions = SKILL_REGION_ORDER.filter(region => skills.some(skill => skill.source === region));
  const selectedRegion = activeRegion !== 'all' && presentRegions.includes(activeRegion) ? activeRegion : 'all';
  const matched = skills.filter(skill => `${skill.name} ${skill.description ?? ''}`.toLocaleLowerCase().includes(needle));
  const visibleRegions = (selectedRegion === 'all' ? presentRegions : [selectedRegion])
    .map(region => ({region, items: matched.filter(skill => skill.source === region)}))
    .filter(group => group.items.length > 0);
  const visibleCount = visibleRegions.reduce((total, group) => total + group.items.length, 0);
  const enabledCount = skills.filter(isSkillChecked).length;
  const toggleRegion = (region: SkillSource) => setCollapsedRegions(current => ({...current, [region]: !current[region]}));
  return <>
    <div className="gd-skill-toolbar">
      <div className="gd-section-heading gd-skill-heading">
        <label className="gd-skill-search"><Search size={14} aria-hidden="true"/><input type="search" aria-label="搜索技能" placeholder="搜索技能" value={query} onChange={event => setQuery(event.target.value)}/></label>
        <div className="gd-skill-actions"><span className="gd-skill-count">{needle || selectedRegion !== 'all' ? `${visibleCount} / ${skills.length} 项` : `${skills.length} 项 · ${enabledCount} 已启用`}</span><IconButton size="sm" variant="ghost" label="重新读取" title="重新读取技能" onClick={() => void refresh()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton></div>
      </div>
      {presentRegions.length > 1 && <div className="gd-skill-filters" role="group" aria-label="按来源筛选技能">
        <button type="button" className={`gd-skill-filter${selectedRegion === 'all' ? ' is-active' : ''}`} aria-pressed={selectedRegion === 'all'} onClick={() => setActiveRegion('all')}>全部<span>{matched.length}</span></button>
        {presentRegions.map(region => {
          const count = matched.filter(skill => skill.source === region).length;
          return <button type="button" key={region} className={`gd-skill-filter${selectedRegion === region ? ' is-active' : ''}`} aria-pressed={selectedRegion === region} onClick={() => setActiveRegion(region)}>{SKILL_REGION_META[region].shortLabel}<span>{count}</span></button>;
        })}
      </div>}
    </div>
    <div className="gd-skill-list">
    {visibleRegions.length ? visibleRegions.map(({region, items}) => {
      const collapsed = !needle && selectedRegion === 'all' && Boolean(collapsedRegions[region]);
      const regionEnabled = items.filter(isSkillChecked).length;
      return <section className="gd-skill-region" key={region} aria-label={SKILL_REGION_META[region].label}>
        <button type="button" className="gd-skill-region-header" aria-expanded={!collapsed} onClick={() => toggleRegion(region)}>
          <span className="gd-skill-region-title">
            <ChevronDown size={14} className={collapsed ? 'is-collapsed' : undefined} aria-hidden="true"/>
            <strong>{SKILL_REGION_META[region].label}</strong>
          </span>
          <span className="gd-skill-region-count">{regionEnabled} / {items.length} 已启用</span>
        </button>
        {!collapsed && items.map(skill => <div className="gd-skill-row" key={skill.path}>
          <button type="button" className="gd-skill-detail" onClick={() => setSelected(skill)}><span><strong>{skill.name}</strong>{skill.description && <small>{skill.description}</small>}{isProviderDisabled(skill) && <small>Provider 已停用</small>}</span><ChevronRight size={14}/></button>
          <Toggle className="settings-row-switch" label={`使用 ${skill.name}`} aria-label={`使用 ${skill.name}`} checked={isSkillChecked(skill)} disabled={disabled || isProviderDisabled(skill)} onChange={event => onToggle(skill.path, event.target.checked)}/>
        </div>)}
      </section>;
    }) : <div className="gd-empty" role="status">{skills.length ? <>没有匹配的技能。<button type="button" className="gd-text-action" onClick={() => {setQuery(''); setActiveRegion('all');}}>清除筛选</button></> : '工作区中尚未发现技能。'}</div>}
    </div>
    <Dialog open={Boolean(selected)} title={selected?.name ?? '技能'} onClose={() => setSelected(undefined)} footer={<Button onClick={() => setSelected(undefined)}>完成</Button>}>
      {selected && <dl className="gd-skill-facts">
        <div><dt>说明</dt><dd>{selected.description || '未提供说明'}</dd></div>
        <div><dt>来源</dt><dd>{SKILL_REGION_META[selected.source].label}</dd></div>
        <div><dt>位置</dt><dd className="gd-skill-location">{selected.location ?? selected.path}</dd></div>
        {selected.content && <div><dt>内容</dt><dd><details className="gd-skill-preview"><summary>查看 SKILL.md</summary><pre className="gd-skill-content">{selected.content}</pre></details></dd></div>}
      </dl>}
    </Dialog>
  </>;
}
