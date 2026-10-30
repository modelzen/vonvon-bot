import {useId, useState} from 'react';
import {Combobox} from '@base-ui/react/combobox';
import {ArrowUpRight, Check, ChevronDown, Search} from 'lucide-react';
import {backendLabel, DECISION_API_PROVIDERS, decisionApiProviderLabel, defaultCodexDecisionModel, type CollaborationReply, type DecisionReasoningEffort} from '@vonvon/protocol';
import {Button, SelectControl} from '../reference/components/ui';
import {effortChoices} from '../management/decisionEffort';
import './decision-picker.css';

export type DecisionCatalogs = Partial<Record<string, Extract<CollaborationReply, {kind: 'providerModels'}>>>;
export type DecisionPickerValue = {provider: string; model: string; effort?: DecisionReasoningEffort; custom?: boolean};
export type DecisionKeyState = 'ready' | 'missing' | 'invalid' | 'unreadable' | 'loading';
type ServiceModel = {id: string; displayName: string};
export type DecisionPickerService = {provider: string; displayName?: string; models: readonly ServiceModel[]; keyState: DecisionKeyState; endpointConfigured?: boolean};
export const isDecisionApiProvider = (provider: string): provider is typeof DECISION_API_PROVIDERS[number] => DECISION_API_PROVIDERS.some(id => id === provider);
export const decisionApiModels: Record<typeof DECISION_API_PROVIDERS[number], readonly ServiceModel[]> = {
  typesafe: [{id: 'jev-latest', displayName: 'Jev'}],
  openrouter: [{id: 'typesafe/jev-1.14', displayName: 'Jev'}],
  vercel: [{id: 'typesafe-ai/jev', displayName: 'Jev'}],
  custom: [{id: 'jev-latest', displayName: 'Jev / System One'}],
};
export type DecisionPickerModel = {id: string; provider: string; model: string; name: string; detail?: string; efforts: DecisionReasoningEffort[]; recommended?: boolean; unavailable?: boolean};
export const decisionNativeProviders = [{id: 'codex-appserver', name: 'Codex'}, {id: 'claude-agent', name: 'Claude'}] as const;
const customEfforts: Record<string, DecisionReasoningEffort[]> = {
  'codex-appserver': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'claude-agent': ['low', 'medium', 'high', 'max'],
};
const modelId = (provider: string, model: string) => JSON.stringify([provider, model]);
const providerName = (provider: string) => isDecisionApiProvider(provider) ? decisionApiProviderLabel(provider) : backendLabel(provider);
const claudeAliases: Record<string, string> = {haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', opusplan: 'Opus Plan', 'haiku[1m]': 'Haiku · 1M', 'sonnet[1m]': 'Sonnet · 1M', 'opus[1m]': 'Opus · 1M'};

/** An alias is the persisted choice; a gateway may map several aliases to the same target. */
function decisionModelLabel(provider: string, model: ServiceModel) {
  const alias = provider === 'claude-agent' && Object.hasOwn(claudeAliases, model.id) ? claudeAliases[model.id] : undefined;
  const name = alias ?? model.displayName;
  const detail = alias && model.displayName.toLocaleLowerCase() !== alias.toLocaleLowerCase() && model.displayName !== model.id ? model.displayName : undefined;
  return {name, ...(detail ? {detail} : {})};
}

/** Build from live catalogs, retaining a saved value even when discovery no longer lists it. */
export function decisionPickerModels({catalogs, jevModels = decisionApiModels.typesafe, decisionServices, value}: {catalogs: DecisionCatalogs; jevModels?: readonly ServiceModel[]; decisionServices?: readonly DecisionPickerService[]; value?: DecisionPickerValue}): DecisionPickerModel[] {
  const models: DecisionPickerModel[] = decisionNativeProviders.flatMap(provider => {
    const catalog = catalogs[provider.id];
    const visible = catalog?.models.filter(model => !model.hidden) ?? [];
    const recommended = provider.id === 'codex-appserver' ? defaultCodexDecisionModel(visible)
      : visible.find(model => model.id === 'haiku')?.id ?? visible.find(model => /(?:^|[-_])haiku(?:[-_]|$)/i.test(model.id))?.id;
    return visible.map(model => ({id: modelId(provider.id, model.id), provider: provider.id, model: model.id, ...decisionModelLabel(provider.id, model),
      efforts: model.supportedEfforts, recommended: model.id === recommended, unavailable: catalog?.state !== 'ready'}));
  });
  for (const service of decisionServices ?? [{provider: 'typesafe', models: jevModels}]) {
    models.push(...service.models.map(model => ({id: modelId(service.provider, model.id), provider: service.provider, model: model.id, name: model.displayName, efforts: []})));
  }
  if (value && !models.some(model => model.id === modelId(value.provider, value.model))) models.push({id: modelId(value.provider, value.model), provider: value.provider, model: value.model, name: value.model, efforts: [], unavailable: true});
  // Unknown catalog IDs remain truthful, but repeated display names must still be distinguishable.
  return models.map(model => models.some(other => other.id !== model.id && other.provider === model.provider && other.name === model.name)
    ? {...model, detail: model.detail ? `${model.detail} · ${model.model}` : model.model} : model);
}

export function chosenDecisionModel(model: DecisionPickerModel): DecisionPickerValue {
  if (isDecisionApiProvider(model.provider)) return {provider: model.provider, model: model.model};
  const choice = effortChoices({provider: model.provider, model: model.model, efforts: model.efforts, catalogReady: true});
  const effort = model.efforts.find(item => item === choice.value);
  return {provider: model.provider, model: model.model, ...(effort ? {effort} : {})};
}

function ProviderIcon({provider}: {provider: string}) {
  if (isDecisionApiProvider(provider)) return <span className="decision-picker-jev-icon" aria-hidden="true">J</span>;
  const path = provider === 'codex-appserver' ? './agent-icons/codex-light.png' : provider === 'claude-agent' ? './agent-icons/claude-code.svg' : undefined;
  return path ? <img className={`decision-picker-icon${provider === 'codex-appserver' ? ' decision-picker-icon--codex' : ''}`} src={path} alt=""/> : null;
}

/** The same local draft control is used for a host default and an independent group choice. */
export function DecisionPicker({value, catalogs, jevModels, decisionServices, keyState = 'loading', context, disabled = false, availableProviders, onChange, onManageKey, onOpenProviders}: {
  value?: DecisionPickerValue; catalogs: DecisionCatalogs; jevModels?: readonly ServiceModel[]; decisionServices?: readonly DecisionPickerService[]; keyState?: DecisionKeyState;
  context: 'global' | 'group'; disabled?: boolean; availableProviders?: readonly string[];
  onChange: (value: DecisionPickerValue) => void; onManageKey?: (provider?: string) => void; onOpenProviders?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customProvider, setCustomProvider] = useState('codex-appserver');
  const [customModel, setCustomModel] = useState('');
  const labelId = useId();
  const models = decisionPickerModels({catalogs, jevModels, decisionServices, value});
  const current = models.find(model => value && model.id === modelId(value.provider, value.model));
  const filtered = models.filter(model => `${providerName(model.provider)} ${model.name} ${model.model} ${model.detail ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const groups = [...decisionNativeProviders.map(provider => provider.id), ...DECISION_API_PROVIDERS, ...models.map(model => model.provider)];
  const providerLabel = (provider: string) => decisionServices?.find(service => service.provider === provider)?.displayName ?? providerName(provider);
  const serviceKeyState = (provider: string): DecisionKeyState => decisionServices?.find(service => service.provider === provider)?.keyState ?? (provider === 'typesafe' ? keyState : 'unreadable');
  const keyProblem = (provider: string) => isDecisionApiProvider(provider) && serviceKeyState(provider) !== 'ready';
  const connectionProblem = (provider: string) => provider === 'custom' && decisionServices?.find(service => service.provider === provider)?.endpointConfigured === false;
  const setupProblem = (provider: string) => keyProblem(provider) || connectionProblem(provider);
  const setupText = (provider: string) => connectionProblem(provider) ? '接口地址未配置' : keyText(provider);
  const keyText = (provider: string) => {const state = serviceKeyState(provider); return state === 'missing' ? '未配置 API 密钥' : state === 'invalid' ? 'API 密钥不可用' : state === 'loading' ? '正在读取密钥…' : '密钥读取失败';};
  const native = value && decisionNativeProviders.some(provider => provider.id === value.provider);
  const efforts = value?.custom ? customEfforts[value.provider] ?? [] : current?.efforts ?? [];
  const control = value ? effortChoices({provider: value.provider, model: value.model, stored: value.effort, efforts, custom: value.custom,
    catalogReady: catalogs[value.provider]?.state === 'ready' && Boolean(current && !current.unavailable)}) : undefined;
  const showEffort = Boolean(native && (value?.provider === 'claude-agent' || efforts.length || value?.effort || value?.custom));
  const unavailable = (model: DecisionPickerModel) => model.unavailable || !isDecisionApiProvider(model.provider) && availableProviders !== undefined && !availableProviders.includes(model.provider);
  function manageKey(provider: string) {setOpen(false); setQuery(''); onManageKey?.(provider);}
  function select(id: string | null) {
    if (disabled || !id) return;
    const chosen = models.find(model => model.id === id);
    if (!chosen) return;
    if (setupProblem(chosen.provider)) {manageKey(chosen.provider); return;}
    if (unavailable(chosen)) return;
    if (value?.provider === chosen.provider && value.model === chosen.model && !value.custom) return;
    onChange(chosenDecisionModel(chosen));
  }
  return <div className="decision-picker">
    <div className={`decision-picker-controls${showEffort ? '' : ' decision-picker-controls--single'}`}>
      <div className="decision-picker-model"><label id={labelId}>模型</label>
        <Combobox.Root modal={false} open={open} onOpenChange={next => {setOpen(next); setQuery('');}} items={models.map(model => model.id)} filteredItems={filtered.map(model => model.id)}
          value={value ? modelId(value.provider, value.model) : null} inputValue={query} onInputValueChange={setQuery} itemToStringLabel={id => models.find(model => model.id === id)?.name ?? id} onValueChange={select}>
          <Combobox.Trigger className="decision-picker-trigger" aria-label="选择决策模型" disabled={disabled}>
            {value && <ProviderIcon provider={value.provider}/>}<span className="decision-picker-selected-copy" title={current?.detail ? `${current.name} · ${current.detail}` : current?.name}><span className="decision-picker-selected-model">{current?.name ?? '选择模型'}</span>{current?.detail && <small>{current.detail}</small>}</span>
            {value && <span className="decision-picker-selected-provider">{setupProblem(value.provider) ? setupText(value.provider) : providerLabel(value.provider)}</span>}<ChevronDown size={14} aria-hidden="true"/>
          </Combobox.Trigger>
          <Combobox.Portal><Combobox.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={12} className="decision-picker-positioner">
            <Combobox.Popup className="decision-picker-popup" aria-label="决策模型列表">
              <label className="decision-picker-search"><Search size={15} aria-hidden="true"/><Combobox.Input placeholder="搜索模型或 Provider" aria-label="搜索决策模型"/></label>
              <Combobox.List className="decision-picker-list">
                {[...new Set(groups)].map(provider => {
                  const items = filtered.filter(model => model.provider === provider);
                  const catalog = catalogs[provider];
                  if (!items.length && (query.trim() || isDecisionApiProvider(provider))) return null;
                  return <div role="group" aria-label={providerLabel(provider)} key={provider}><div className="decision-picker-group-label">{providerLabel(provider)}</div>
                    {items.map(model => {
                      const needsKey = setupProblem(model.provider);
                      return <Combobox.Item key={model.id} value={model.id} className={`decision-picker-option${needsKey ? ' decision-picker-option--needs-key' : ''}`} disabled={disabled || !needsKey && unavailable(model)}
                        onClick={event => {if (needsKey) {event.preventBaseUIHandler(); if (!disabled) manageKey(model.provider);}}}>
                        <ProviderIcon provider={model.provider}/><span className={`decision-picker-option-copy${needsKey || model.detail ? ' decision-picker-option-copy--stacked' : ''}`}><strong>{model.name}</strong>{needsKey ? <small>{setupText(model.provider)}</small> : model.detail && <small>{model.detail}</small>}{!needsKey && model.unavailable && <small>已保存</small>}</span>
                        {model.recommended && <span className="decision-picker-recommendation">推荐</span>}{needsKey ? <span className="decision-picker-key-action">{context === 'group' ? '前往设置' : model.provider === 'custom' ? '配置接口' : serviceKeyState(model.provider) === 'missing' ? '添加密钥' : '检查密钥'}<ArrowUpRight size={12} aria-hidden="true"/></span> : <Combobox.ItemIndicator className="decision-picker-check"><Check size={15} aria-hidden="true"/></Combobox.ItemIndicator>}
                      </Combobox.Item>;
                    })}
                    {!items.length && <div className="decision-picker-catalog-note">{catalog ? catalog.message || '模型目录暂不可用。' : '正在读取模型…'}</div>}
                  </div>;
                })}
                <Combobox.Empty className="decision-picker-empty">{query.trim() ? '没有匹配的模型' : '暂无可选模型'}</Combobox.Empty>
              </Combobox.List>
              <div className="decision-picker-menu-actions"><Button size="sm" variant="ghost" onClick={() => {setCustomProvider(native && value ? value.provider : 'codex-appserver'); setCustomModel(value?.custom ? value.model : ''); setCustomOpen(true); setOpen(false);}}>自定义模型 ID</Button>{onOpenProviders && <Button size="sm" variant="ghost" onClick={onOpenProviders}>设置 Provider</Button>}</div>
            </Combobox.Popup>
          </Combobox.Positioner></Combobox.Portal>
        </Combobox.Root>
      </div>
      {showEffort && value && control && <div className="decision-picker-effort"><label>思考强度 · Effort</label><SelectControl presentation="dropdown" label="决策 Effort" value={control.value} disabled={disabled || !value.custom && catalogs[value.provider]?.state !== 'ready'} options={control.options}
        onChange={next => {if (disabled || !value.custom && catalogs[value.provider]?.state !== 'ready' || next && !efforts.some(item => item === next)) return; const {effort: _old, ...rest} = value; const effort = efforts.find(item => item === next); onChange({...rest, ...(effort ? {effort} : {})});}}/></div>}
    </div>
    {customOpen && <div className="decision-picker-custom"><SelectControl presentation="dropdown" label="自定义模型 Provider" value={customProvider} options={decisionNativeProviders.map(provider => ({value: provider.id, label: provider.name, disabled: availableProviders !== undefined && !availableProviders.includes(provider.id)}))} disabled={disabled} onChange={setCustomProvider}/><input className="settings-field" aria-label="自定义决策模型 ID" placeholder="模型 ID" value={customModel} disabled={disabled} onChange={event => setCustomModel(event.target.value)}/><Button size="sm" disabled={disabled || !customModel.trim() || availableProviders !== undefined && !availableProviders.includes(customProvider)} onClick={() => {if (disabled || !customModel.trim() || availableProviders !== undefined && !availableProviders.includes(customProvider)) return; onChange({provider: customProvider, model: customModel.trim(), custom: true, ...(value?.provider === customProvider && value.model === customModel.trim() && value.effort ? {effort: value.effort} : {})}); setCustomOpen(false);}}>使用</Button><Button size="sm" variant="ghost" onClick={() => setCustomOpen(false)}>取消</Button></div>}
    {context === 'group' && value && isDecisionApiProvider(value.provider) && !setupProblem(value.provider) && <div className="decision-picker-key-note"><span><Check size={13} aria-hidden="true"/>密钥已配置</span>{onManageKey && <button type="button" onClick={() => onManageKey(value.provider)}>前往设置管理密钥 <ArrowUpRight size={13} aria-hidden="true"/></button>}</div>}
  </div>;
}
