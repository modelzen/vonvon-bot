import {isKnownJudgeSelection, type AgentId, type DecisionModelsView, type JudgeSelectionView, type ModelCatalog, type ToolState} from '@vonvon/protocol';
import {SelectControl} from '../reference/components/ui';
import type {DecisionConfigurationState} from './useDecisionConfiguration';
import {DecisionPicker, type DecisionPickerValue, type DecisionCatalogs} from './DecisionPicker';
import {useDecisionCatalogs} from './useDecisionCatalogs';

type Provider = {id: string; displayName: string};
type Selection = Extract<JudgeSelectionView, {kind: 'llm'}>;
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
  if (!isKnownJudgeSelection(value)) return '当前客户端无法编辑已保存的决策设置。';
  const provider = value.kind === 'llm' ? value.backend : value.kind === 'provider' || value.kind === 'decision' ? value.provider : undefined;
  if (!provider) return '请选择决策模型。';
  if ((value.kind === 'llm' || value.kind === 'decision') && !value.model.trim()) return '请填写模型 ID。';
  if (provider === 'typesafe') {
    const service = services?.find(item => item.provider === 'typesafe');
    if (!service || service.keyUnreadable) return '无法读取 Jev 密钥，请检查决策模型设置。';
    return service.keySet ? undefined : '请先添加 Jev 密钥。';
  }
  return providers.some(item => item.id === provider) ? undefined : '此决策 Provider 当前不可用，请先安装并登录。';
}

/** Legacy markers are displayed through their server-resolved snapshot, never through live host state. */
export function groupDecisionPickerValue(value: JudgeSelectionView, effective: JudgeSelectionView, groupBackend: string): DecisionPickerValue | undefined {
  if (!isKnownJudgeSelection(value)) return undefined;
  const selection = value.kind === 'default' || value.kind === 'provider' ? effective : value;
  if (!isKnownJudgeSelection(selection)) return undefined;
  if (selection.kind === 'decision') return {provider: selection.provider, model: selection.model};
  if (selection.kind === 'llm') return {provider: selection.backend ?? groupBackend, model: selection.model, ...(selection.effort ? {effort: selection.effort} : {}), ...(selection.custom ? {custom: true} : {})};
  return undefined;
}

export function DecisionFields({groupBackend, value, effective, onChange, disabled, providers, services, catalogs: suppliedCatalogs, onOpenProviders, onOpenSecrets, onProviderChange}: {
  botId: AgentId; groupBackend: string; value: JudgeSelectionView; effective: JudgeSelectionView; onChange: (value: JudgeSelectionView) => void; disabled: boolean;
  providers: Provider[]; services?: DecisionModelsView; catalogs?: DecisionCatalogs; tools?: readonly ToolState[]; configuration?: DecisionConfigurationState;
  onProviderChange?: (provider: string) => void; onOpenProviders?: () => void; onOpenSecrets?: (provider?: string) => void; initial?: boolean;
}) {
  const {catalogs: loadedCatalogs} = useDecisionCatalogs(suppliedCatalogs === undefined);
  const catalogs = suppliedCatalogs ?? loadedCatalogs;
  const service = services?.find(item => item.provider === 'typesafe');
  const selection = groupDecisionPickerValue(value, effective, groupBackend);
  const editable = isKnownJudgeSelection(value);
  return <div className="gd-decision-fields">
    {!editable && <p className="gd-note" role="alert">当前客户端无法编辑已保存的决策设置。</p>}
    <DecisionPicker value={selection} catalogs={catalogs} jevModels={service?.models} context="group" disabled={disabled || !editable}
      availableProviders={providers.map(provider => provider.id)} keyState={!services ? 'loading' : !service || service.keyUnreadable ? 'unreadable' : service.keySet ? 'ready' : 'missing'}
      onOpenProviders={onOpenProviders} onManageKey={onOpenSecrets ? () => onOpenSecrets('typesafe') : undefined}
      onChange={next => {
        if (disabled || !editable) return;
        onProviderChange?.(next.provider);
        if (next.provider === 'typesafe') onChange({kind: 'decision', provider: next.provider, model: next.model});
        else {const {provider, ...profile} = next; onChange({kind: 'llm', backend: provider, ...profile});}
      }}/>
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
