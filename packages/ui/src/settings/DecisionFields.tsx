import {useEffect, useState} from 'react';
import {backendLabel, isKnownJudgeSelection, type AgentId, type DecisionModelsView, type JudgeSelectionView, type ModelCatalog, type ToolState} from '@vonvon/protocol';
import {Button, InlineNotice, SelectControl} from '../reference/components/ui';
import {providerBackends, providerNames} from '../setup/provider-state';
import {useClaudeLoginCheck} from '../setup/useClaudeLoginCheck';
import {Catalog} from './SettingsPanel';
import {SettingChoices} from './SettingChoices';

type Provider = {id: string; displayName: string};
type Selection = Extract<JudgeSelectionView, {kind: 'llm'}>;

export function decisionProviderProblem(value: JudgeSelectionView, provider: string | undefined, groupBackend: string): string | undefined {
  if (!provider || !isKnownJudgeSelection(value) || value.kind === 'default') return undefined;
  const selected = value.kind === 'decision' ? `decision:${value.provider}` : value.backend ?? groupBackend;
  return selected === provider ? undefined : '请先选择当前 Provider 的模型。';
}

// Intent: help a group owner choose how the Bot decides to join a conversation.
// Hierarchy: purpose, three Provider choices, one compact model control; rules follow.
// Palette/depth/surfaces: existing neutral settings surface and border; blue only marks selection.
// Typography/spacing: system 13px controls, secondary 12px explanation, 4px rhythm and 16px insets.
export function DecisionFields({botId, groupBackend, value, effective, onChange, disabled, providers, services, tools = [], onOpenProviders, onOpenSecrets, onProviderChange, initial = false}: {
  botId: AgentId; groupBackend: string; value: JudgeSelectionView; effective: JudgeSelectionView; onChange: (value: JudgeSelectionView) => void; disabled: boolean;
  providers: Provider[]; services?: DecisionModelsView; tools?: readonly ToolState[];
  onProviderChange?: (provider: string) => void; onOpenProviders?: () => void; onOpenSecrets?: (provider?: string) => void; initial?: boolean;
}) {
  const known = isKnownJudgeSelection(value) ? value : undefined;
  const active = !initial && known?.kind === 'default' && isKnownJudgeSelection(effective) ? effective : known;
  const [provider, setProvider] = useState(active?.kind === 'decision' ? `decision:${active.provider}` : active?.kind === 'llm' ? active.backend ?? groupBackend : groupBackend);
  const [custom, setCustom] = useState(active?.kind === 'llm' && Boolean(active.custom));
  const [error, setError] = useState<string>();
  useEffect(() => {onProviderChange?.(provider);}, [provider, onProviderChange]);
  const claude = useClaudeLoginCheck(tools, setError);
  const service = services?.find(item => `decision:${item.provider}` === provider);
  const serviceLabel = service?.models.map(model => model.displayName).join('、') || service?.displayName;
  const serviceReady = (item: DecisionModelsView[number]) => item.keySet && !item.keyUnreadable;
  const nativeReady = providers.some(item => item.id === provider);
  const nativeChoices = Object.entries(providerBackends).map(([tool, id]) => ({value: id, label: providerNames[tool as keyof typeof providerNames]}));
  const options = [...nativeChoices, ...(services ?? []).map(item => ({value: `decision:${item.provider}`, label: item.models.some(model => model.displayName === 'Jev') ? 'Jev' : item.displayName}))];
  if (provider && !options.some(item => item.value === provider)) options.push({value: provider, label: backendLabel(provider)});
  const selection = active?.kind === 'llm' && (active.backend ?? groupBackend) === provider ? active : undefined;
  return <div className="gd-model-fields gd-decision-fields">
    <p className="gd-decision-purpose">在智能模式下，判断群消息要不要回、回在哪里，以及是否创建新话题。<br/>实际回复和执行任务使用本群的任务模型。</p>
    {!known && <p className="gd-note" role="alert">当前客户端无法编辑已保存的决策模型类型。</p>}
    <fieldset><legend>Provider</legend><SettingChoices label="决策 Provider" value={provider} disabled={disabled} choices={options} onChange={next => {
      if (disabled) return;
      setProvider(next); setCustom(false); setError(undefined); onProviderChange?.(next);
      // Browsing setup guidance must not clear the group's current choice or create an unsaved draft.
      const nextService = services?.find(item => `decision:${item.provider}` === next);
      if (nextService && serviceReady(nextService) && nextService.models.length === 1) onChange({kind: 'decision', provider: nextService.provider, model: nextService.models[0]!.id});
    }}/></fieldset>
    {service ? <>
      {serviceReady(service) ? <fieldset><legend>模型</legend><SelectControl label="决策模型" className="gd-decision-select" disabled={disabled}
        value={active?.kind === 'decision' && active.provider === service.provider ? active.model : ''}
        options={[{value: '', label: '选择模型', disabled: true}, ...service.models.map(model => ({value: model.id, label: model.displayName}))]}
        onChange={model => {if (!disabled && service.models.some(item => item.id === model)) onChange({kind: 'decision', provider: service.provider, model});}}/>
      </fieldset> : <InlineNotice title={service.keyUnreadable ? `无法读取 ${serviceLabel} 密钥` : `${serviceLabel} 尚未配置`} tone="warning">
        {service.keyUnreadable ? '请到密钥设置检查，恢复后再选择模型。' : `需要先添加 ${service.displayName} API key。配置完成后，返回本群选择 ${serviceLabel}。`}
        {onOpenSecrets && <Button size="sm" onClick={() => onOpenSecrets(service.provider)}>设置密钥</Button>}
      </InlineNotice>}
    </> : provider.startsWith('decision:') ? <InlineNotice title="决策服务暂不可用" tone="warning">请重新读取设置或更新本机服务。{onOpenSecrets && <Button size="sm" onClick={() => onOpenSecrets(provider.slice(9))}>检查密钥设置</Button>}</InlineNotice>
      : !nativeReady ? <InlineNotice title={provider === 'claude-agent' && claude.checking ? '正在检查 Claude 登录…' : `${backendLabel(provider)} 尚未就绪`} tone="warning">
        {provider === 'claude-agent' && claude.checking ? '检查完成后即可选择模型。' : '完成安装与登录后，就可以用它判断本群消息。'}
        {onOpenProviders && <Button size="sm" onClick={onOpenProviders}>设置 Provider</Button>}
        {provider === 'claude-agent' && !claude.checking && <Button size="sm" onClick={() => void claude.check(true)}>检查登录</Button>}
      </InlineNotice> : <Catalog key={provider} botId={botId} backend={provider} purpose="judge">{catalog => <DecisionModelChoices
        provider={provider} selection={selection} catalog={catalog} disabled={disabled} custom={custom} onCustom={setCustom} onChange={onChange}/>}</Catalog>}
    {error && <p className="gd-note" role="alert">{error}</p>}
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
