import {useState} from 'react';
import './recipe-group-settings.css';
import {backendLabel, type RecipeRichSetting} from '@vonvon/protocol';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Dialog} from '../reference/components/ui/Dialog';
import {DefaultBadge, ModelSummaryMenu} from '../settings/CompactModelSelection';
import {ConversationSlider} from '../settings/ConversationSlider';
import {ExecutionPermissionSummary, groupProviderIcon} from '../settings/GroupSettingsSummary';
import {allowedEfforts, modelAccessDefaultId} from '../settings/model-access-draft';
import {judgeLabel} from '../settings/judgeChoice';

type Settings = readonly RecipeRichSetting[];
function setting<F extends RecipeRichSetting['field']>(settings: Settings, field: F): Extract<RecipeRichSetting, {field: F}> | undefined {
  return settings.find((item): item is Extract<RecipeRichSetting, {field: F}> => item.field === field);
}
const tiers = {inherit:'跟着 Bot 默认', standard:'标准', fast:'快速', ultrafast:'极速'} as const;
const permissionNames = {qa:'只读', write:'工作区可写', full:'完全访问'};
const permissionNotes = {qa:'仅查看，不修改文件。', write:'可在工作区内修改文件。', full:'可访问工作区以外的文件。'};
const sandboxNames = {'read-only':'只读','workspace-write':'工作区可写','danger-full-access':'完全访问'};
const claudeModes = {default:'手动确认',acceptEdits:'自动接受编辑',plan:'先出方案',auto:'自动判断',bypassPermissions:'跳过权限检查'};
const unset = (omitted?: number) => omitted ? '概览未提供' : '沿用目标群设置';
const toggle = (value: boolean) => value ? '开启' : '关闭';

function RecipePermissions({settings, omitted}: {settings: Settings; omitted?: number}) {
  const [open, setOpen] = useState(false);
  const preset = setting(settings,'permission.requirement')?.value;
  const codex = setting(settings,'permission.codex.requirement')?.value;
  const claude = setting(settings,'permission.claude.requirement')?.value;
  const providers = [codex && backendLabel('codex-appserver'), claude && backendLabel('claude-agent')].filter(Boolean).join('、');
  const label = codex || claude ? '自定义权限' : preset ? permissionNames[preset.mode] : unset(omitted);
  const description = providers ? providers + ' 的原生权限设置' : preset ? permissionNotes[preset.mode] : undefined;
  return <>
    <ExecutionPermissionSummary label={label} description={description} action="查看权限"
      onAction={preset || codex || claude ? () => setOpen(true) : undefined}/>
    <Dialog open={open} title="执行权限" onClose={() => setOpen(false)}>
      <div className="permission-dialog">
        {preset && <SettingsGroup label="权限档位"><SettingsRow title={permissionNames[preset.mode]} description={permissionNotes[preset.mode]}/></SettingsGroup>}
        {codex && <SettingsGroup label={backendLabel('codex-appserver')}>
          <SettingsRow title="文件访问范围" value={sandboxNames[codex.sandbox]}/>
          <SettingsRow title="网络访问" value={toggle(codex.network)}/>
        </SettingsGroup>}
        {claude && <SettingsGroup label={backendLabel('claude-agent')}>
          <SettingsRow title="权限模式" value={claudeModes[claude.permissionMode]}/>
          <SettingsRow title="命令沙箱" value={toggle(claude.sandbox)}/>
          <SettingsRow title="网络访问" value={claude.network === 'all' ? '全部' : '关闭'}/>
        </SettingsGroup>}
      </div>
    </Dialog>
  </>;
}

export function RecipeModelSettings({settings, omitted}: {settings: Settings; omitted?: number}) {
  const recommendation = setting(settings,'model.recommendation')?.value, access = setting(settings,'modelAccess.recommendation')?.value;
  const speed = setting(settings,'speed.recommendation')?.value;
  const backend = access?.backend ?? recommendation?.backend;
  const selection = recommendation?.selection;
  const defaultId = access && modelAccessDefaultId(access);
  const effortFor = (model: string) => access ? allowedEfforts(access, model) : [];
  const allEfforts = [...new Set(access?.models.flatMap(effortFor) ?? [])];
  return <div className="gd-page recipe-group-settings">
    <SettingsGroup label="模型设置">
      <SettingsRow title="Provider" value={backend ? <span className="recipe-provider">{groupProviderIcon(backend)}{backendLabel(backend)}</span> : unset(omitted)}/>
      {access && <>
        <ModelSummaryMenu label="可用模型" trigger="查看可用模型" summary={access.models.join('、')}>
          <div className="gd-model-menu-list">{access.models.map(id => <div className="gd-model-menu-item" key={id}>
            <span className="gd-model-menu-copy"><strong>{id}</strong>{Boolean(access.modelServiceTiers?.[id]?.length) &&
              <small>允许加速 · {access.modelServiceTiers![id]!.map(tier => tiers[tier]).join('、')}</small>}</span>
            {id === defaultId && <DefaultBadge/>}
          </div>)}</div>
        </ModelSummaryMenu>
        {allEfforts.length ? <ModelSummaryMenu label="可用思考强度" trigger="查看可用思考强度" summary={allEfforts.join('、')}>
          <div className="gd-model-effort-list">{access.models.map(id => <section className="gd-model-effort-group" key={id}>
            <div className="gd-model-effort-heading">{id}</div>
            {effortFor(id).length ? effortFor(id).map(effort => <div className="gd-model-menu-item" key={effort}>
              <span>{effort}</span>{id === defaultId && effort === access.defaultEffort && <DefaultBadge/>}
            </div>) : <p className="gd-model-menu-empty">此模型未指定思考强度。</p>}
          </section>)}</div>
        </ModelSummaryMenu> : <SettingsRow title="可用思考强度" value="未指定"/>}
      </>}
      <SettingsRow title="推荐模型" value={selection?.kind === 'explicit' ? selection.model : selection ? 'Provider 默认模型' : unset(omitted)}
        description={recommendation && recommendation.backend !== backend ? backendLabel(recommendation.backend) : undefined}/>
      {selection?.kind === 'explicit' && selection.effort && <SettingsRow title="推荐思考强度" value={selection.effort}/>}
      {speed && <SettingsRow title="新话题速度" value={tiers[speed.tier]}/>}
    </SettingsGroup>
    <RecipePermissions settings={settings} omitted={omitted}/>
  </div>;
}

export function RecipeCommunication({settings, omitted, ruleCount}: {settings: Settings; omitted?: number; ruleCount: number}) {
  const mode = setting(settings,'sessionMode')?.value, noMention = setting(settings,'response.noMention')?.value, pending = setting(settings,'run.pendingPolicy')?.value;
  const judge = setting(settings,'judge.recommendation')?.value;
  const tools = setting(settings,'presentation.showToolCalls')?.value, model = setting(settings,'presentation.showModel')?.value;
  const completion = setting(settings,'presentation.completionMode')?.value, minutes = setting(settings,'presentation.longTaskMinutes')?.value;
  const template = setting(settings,'presentation.completionTemplate')?.value, card = setting(settings,'presentation.cardDisplay')?.value;
  return <div className="gd-page recipe-group-settings">
    <SettingsGroup label="聊天方式">
      {mode ? <ConversationSlider label="聊天方式" value={mode === 'multi' ? 'threads' : mode === 'single' ? 'shared' : 'smart'} disabled onChange={() => {}}/>
        : <SettingsRow title="会话模式" value={unset(omitted)}/>}
      {mode === 'smart' ? <SettingsRow title="免 @" value="由 Bot 判断"/> :
        noMention !== undefined && <SettingsRow title="不 @ 也能发起任务" value={toggle(noMention)}/>}
      {pending && <SettingsRow title="新消息处理" value={{queue:'排队等待',steer:'立即插话',default:'跟着 Bot 默认'}[pending]}/>}
    </SettingsGroup>
    <SettingsGroup label="群内规则与判断">
      <SettingsRow title="决策模型" value={judge ? judgeLabel(judge) : unset(omitted)} description={judge?.kind === 'llm' && judge.backend ? backendLabel(judge.backend) : undefined}/>
      {ruleCount > 0 && <SettingsRow title="群内规则" value={`${ruleCount} 项`}/>}
    </SettingsGroup>
    <SettingsGroup label="回复与通知">
      {tools !== undefined && <SettingsRow title="展示工具调用" value={toggle(tools)}/>}
      {model && <SettingsRow title="模型标记" value={{off:'关闭',running:'运行时展示',always:'始终展示'}[model]}/>}
      <SettingsRow title="提醒方式" value={completion ? {manual:'手动',long:'长任务',failures:'失败时',always:'每次'}[completion] : unset(omitted)}/>
      {minutes !== undefined && <SettingsRow title="长任务提醒阈值" value={`${minutes} 分钟`}/>}
      {template !== undefined && <SettingsRow title="完成通知模板" description={template || '使用默认模板'}/>}
      {card !== undefined && <SettingsRow title="消息卡片" value={card ? `${card.blocks.length} 个区块` : '使用默认布局'}/>}
      {card?.reply && <>
        <SettingsRow title="流式回复" value={toggle(card.reply.streamText)}/>
        <SettingsRow title="完成后折叠" value={toggle(card.reply.collapseAfterRun)}/>
      </>}
    </SettingsGroup>
  </div>;
}
