import {Check, ChevronRight} from 'lucide-react';
import {backendLabel, isKnownJudgeSelection, type AgentId, type DecisionModelsView, type JudgeSelectionView, type ModelCatalog, type ToolState} from '@vonvon/protocol';
import {Button, InlineNotice, SelectControl} from '../reference/components/ui';
import {SettingChoices} from './SettingChoices';
import type {DecisionConfigurationState} from './useDecisionConfiguration';

type Provider = {id: string; displayName: string};
type Selection = Extract<JudgeSelectionView, {kind: 'llm'}>;
const providerIds = ['codex-appserver', 'claude-agent', 'typesafe'] as const;
type DecisionProvider = typeof providerIds[number];
export function savedDecisionProvider(value: JudgeSelectionView, groupBackend: string): string | undefined {
  if (!isKnownJudgeSelection(value)) return undefined;
  if (value.kind === 'provider') return value.provider;
  if (value.kind === 'llm') return value.backend ?? groupBackend;
  if (value.kind === 'decision') return value.provider;
  return undefined;
}
export function decisionProviderProblem(value: JudgeSelectionView, viewed: string | undefined, groupBackend: string): string | undefined {
  if (!viewed) return undefined;
  const saved = savedDecisionProvider(value, groupBackend);
  return saved === viewed ? undefined : '请选择当前 Provider。';
}
export function providerDecisionProblem(value: JudgeSelectionView, providers: Provider[], services?: DecisionModelsView, configuration?: DecisionConfigurationState): string | undefined {
  if (isKnownJudgeSelection(value) && value.kind === 'default') {
    if (configuration?.kind === 'failed') return '无法读取默认决策模型，请重新读取。';
    if (configuration?.kind !== 'ready') return '正在读取默认决策模型，请稍候。';
    const provider = configuration.configuration.defaultProvider;
    if (!provider) return '请先在设置中选定默认决策模型。';
    if (!configuration.configuration.byProvider[provider]?.model.trim()) return '默认决策模型配置无效，请前往设置。';
    return providerDecisionProblem({kind: 'provider', provider}, providers, services);
  }
  if (!isKnownJudgeSelection(value) || value.kind !== 'provider') return '请选择判断 Provider。';
  if (value.provider === 'typesafe') {
    const service = services?.find(item => item.provider === 'typesafe');
    if (!service || service.keyUnreadable) return '无法读取 Jev 密钥，请检查决策模型设置。';
    return service.keySet ? undefined : '请先添加 Jev 密钥。';
  }
  return providers.some(item => item.id === value.provider) ? undefined : '此判断 Provider 当前不可用，请先安装并登录。';
}

export function DecisionFields({groupBackend, value, effective, onChange, disabled, providers, services, configuration, onOpenProviders, onOpenSecrets, onProviderChange, initial = false}: {
  botId: AgentId; groupBackend: string; value: JudgeSelectionView; effective: JudgeSelectionView; onChange: (value: JudgeSelectionView) => void; disabled: boolean;
  providers: Provider[]; services?: DecisionModelsView; tools?: readonly ToolState[];
  configuration?: DecisionConfigurationState;
  onProviderChange?: (provider: string) => void; onOpenProviders?: () => void; onOpenSecrets?: (provider?: string) => void; initial?: boolean;
}) {
  const saved = savedDecisionProvider(value, groupBackend);
  const inherited = initial ? undefined : savedDecisionProvider(effective, groupBackend);
  const followsDefault = isKnownJudgeSelection(value) && value.kind === 'default';
  const globalProvider = configuration?.kind === 'ready' ? configuration.configuration.defaultProvider : undefined;
  const viewed = followsDefault ? globalProvider ?? inherited ?? '' : saved ?? inherited ?? '';
  const defaultProblem = providerDecisionProblem({kind: 'default'}, providers, services, configuration);
  const service = services?.find(item => item.provider === 'typesafe');
  const ready = (id: string) => id === 'typesafe' ? Boolean(service?.keySet && !service.keyUnreadable) : providers.some(item => item.id === id);
  const choices: Array<{value: string; label: string; disabled: boolean}> = [{value: 'default', label: '默认', disabled: Boolean(defaultProblem)}, ...providerIds.map(id => ({value: id, label: id === 'typesafe' ? 'Jev' : backendLabel(id), disabled: !ready(id)}))];
  if (saved && !choices.some(item => item.value === saved)) choices.push({value: saved as DecisionProvider, label: backendLabel(saved), disabled: true});
  const legacy = isKnownJudgeSelection(value) && (value.kind === 'llm' || value.kind === 'decision');
  const providerName = viewed === 'typesafe' ? 'Jev' : viewed ? backendLabel(viewed) : undefined;
  const keyState = !service || service.keyUnreadable ? 'unknown' : service.keySet ? 'added' : 'missing';
  const currentSelection = followsDefault ? undefined : value;
  const independent = currentSelection && isKnownJudgeSelection(currentSelection) && (currentSelection.kind === 'llm' || currentSelection.kind === 'decision') ? currentSelection : undefined;
  const profile = independent ?? (configuration?.kind === 'ready' ? configuration.configuration.byProvider[viewed] : undefined);
  const configured = Boolean(profile && (viewed !== 'typesafe' || keyState === 'added'));
  return <div className="gd-model-fields gd-decision-fields">
    <p className="gd-decision-purpose">判断群消息要不要回复、回在哪里，以及是否创建新话题。实际回复和执行任务使用本群的执行 Provider。</p>
    {legacy && <div className="gd-note" role="status">当前群保留旧决策模型设置。改用「设置 → 决策模型」中此 Provider 的模型和推理强度：
      <Button size="sm" disabled={disabled || !viewed || !ready(viewed)} onClick={() => {
        if (disabled || !providerIds.some(id => id === viewed) || !ready(viewed)) return;
        onChange({kind: 'provider', provider: viewed as DecisionProvider});
      }}>使用统一配置</Button>
    </div>}
    {!isKnownJudgeSelection(value) && <p className="gd-note" role="alert">当前客户端无法编辑已保存的决策设置。</p>}
    <fieldset><legend>判断 Provider</legend><SettingChoices label="判断 Provider" value={followsDefault ? 'default' : viewed} disabled={disabled} choices={choices} onChange={next => {
      if (disabled) return;
      if (next === 'default') {if (!defaultProblem) onChange({kind: 'default'}); return;}
      if (!providerIds.some(id => id === next) || !ready(next)) return;
      onProviderChange?.(next); onChange({kind: 'provider', provider: next as DecisionProvider});
    }}/></fieldset>
    {followsDefault && defaultProblem && <p className="gd-note" role="status">{defaultProblem}</p>}
    {!followsDefault && !viewed && <p className="gd-note">选择一个已就绪的 Provider。</p>}
    {viewed && !ready(viewed) && <InlineNotice title={`${viewed === 'typesafe' ? 'Jev' : backendLabel(viewed)} 尚未就绪`} tone="warning">
      {viewed === 'typesafe' ? '请到决策模型设置检查密钥。' : '请先安装并登录 Provider。'}
      {viewed !== 'typesafe' && onOpenProviders && <Button size="sm" onClick={onOpenProviders}>设置 Provider</Button>}
    </InlineNotice>}
    {onOpenSecrets && <div className="gd-decision-config">
      <div className="gd-decision-config-copy">
        {viewed && (profile ? <span className="gd-decision-config-values">
          {followsDefault && <span>默认 · {providerName}</span>}
          {configured && <span className="gd-decision-configured" role="status" aria-label="已配置" title="已配置"><Check size={13} aria-hidden="true"/></span>}
          <span title={viewed === 'typesafe' ? 'Jev 不支持单独设置思考等级' : undefined}>{profile.model}</span>
          {viewed !== 'typesafe' && <><span aria-hidden="true">·</span><span aria-label="思考等级">{'effort' in profile && profile.effort ? profile.effort === 'none' ? '关闭思考' : profile.effort : viewed === 'claude-agent' ? '关闭思考' : '默认'}</span></>}
        </span> : <span role="status">{configuration?.kind === 'failed' || configuration?.kind === 'ready' ? '配置读取失败' : '正在读取配置…'}</span>)}
        {viewed === 'typesafe' && <><span aria-hidden="true">·</span><span className="gd-decision-key-state" data-state={keyState} role="status">
          {keyState === 'added' ? '密钥已添加' : keyState === 'missing' ? '尚未添加密钥' : '密钥状态未知'}
        </span></>}
      </div>
      <Button type="button" variant="ghost" size="sm" className="gd-decision-config-link" disabled={disabled}
        aria-label={providerName ? `修改 ${providerName} 配置` : undefined}
        title={legacy ? '本群仍使用独立配置；选择「使用统一配置」后才跟随设置。' : '修改统一配置，使用同一 Provider 的群共用。'}
        onClick={() => onOpenSecrets(viewed || undefined)}>
        {providerName ? '修改' : '管理决策模型'}<ChevronRight size={14} aria-hidden="true"/>
      </Button>
    </div>}
  </div>;
}

export function DecisionModelChoices({provider, selection, catalog, disabled, custom, onCustom, onChange}: {
  provider: string; selection?: Selection; catalog?: ModelCatalog; disabled: boolean; custom: boolean;
  onCustom: (value: boolean) => void; onChange: (value: JudgeSelectionView) => void;
}) {
  const models = catalog?.backend === provider ? catalog.models.filter(model => !model.hidden) : [];
  const selected = models.find(model => model.id === selection?.model);
  const efforts = custom ? catalog?.titleEfforts ?? [] : selected?.supportedEfforts ?? [];
  const unavailable = catalog?.state === 'unavailable';
  return <>
    <fieldset><legend>模型</legend><div className="gd-decision-model-row">
      {custom ? <input className="settings-field gd-decision-select" aria-label="自定义决策模型 ID" disabled={disabled} placeholder="模型 ID" value={selection?.custom ? selection.model : ''}
        onChange={event => onChange(event.target.value.trim() ? {kind: 'llm', backend: provider, model: event.target.value.trim(), custom: true} : {kind: 'default'})}/>
        : <SelectControl label="决策模型" className="gd-decision-select" disabled={disabled || !catalog || unavailable || !models.length}
          value={selection?.model ?? ''} options={[
            {value: '', label: !catalog ? '正在读取模型…' : !models.length ? '暂无可选模型' : '选择模型', disabled: true},
            ...models.map(model => ({value: model.id, label: model.displayName})),
            ...(selection && !selected ? [{value: selection.model, label: `${selection.model}（已保存）`, disabled: true}] : []),
          ]} onChange={model => {if (!disabled && !unavailable && models.some(item => item.id === model)) onChange({kind: 'llm', backend: provider, model});}}/>}
      <button type="button" className="gd-text-action" disabled={disabled} onClick={() => onCustom(!custom)}>{custom ? '从目录选择' : '自定义模型 ID'}</button>
    </div>
      {custom && <p className="gd-note">请确认模型 ID 正确；自定义模型不经过目录校验。</p>}
      {catalog?.error && <p className="gd-note" role="status">{catalog.error}</p>}
    </fieldset>
    {selection && (efforts.length > 0 || selection.effort) && <fieldset><legend>推理强度</legend><SelectControl label="决策 Effort" className="gd-decision-select" value={selection.effort ?? ''} disabled={disabled}
      options={[{value: '', label: '默认'}, ...[...new Set([...efforts, ...(selection.effort ? [selection.effort] : [])])].map(effort => ({value: effort, label: effort}))]}
      onChange={effort => {const {effort: _old, ...rest} = selection; const selectedEffort = efforts.find(item => item === effort); onChange({...rest, backend: provider, ...(selectedEffort ? {effort: selectedEffort} : {})});}}/></fieldset>}
  </>;
}
