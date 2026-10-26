import {useRef, useState} from 'react';
import {Combobox} from '@base-ui/react/combobox';
import {Check, ChevronDown, Search} from 'lucide-react';
import {backendLabel, type ModelCatalog, type ModelSelection} from '@vonvon/protocol';
import {Button, SelectControl} from '../reference/components/ui';
import './decision-picker.css';
import './native-model-picker.css';

export type NativeModelValue = {backend: string; selection: ModelSelection};
export const nativeModelProviders = [{id: 'codex-appserver', name: 'Codex'}, {id: 'claude-agent', name: 'Claude'}] as const;
type Effort = Extract<ModelSelection, {kind: 'explicit'}>['effort'];
type Item = {id: string; backend: string; name: string; model?: ModelCatalog['models'][number]; detail?: string; saved?: boolean; unavailable?: boolean};
type CustomDraft = {backend: string; model: string; effort: Effort};
const providerEfforts: Record<string, Effort[]> = {
  'codex-appserver': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'claude-agent': ['low', 'medium', 'high', 'xhigh', 'max'],
};
const aliases: Record<string, string> = {haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', opusplan: 'Opus Plan', 'haiku[1m]': 'Haiku · 1M', 'sonnet[1m]': 'Sonnet · 1M', 'opus[1m]': 'Opus · 1M'};
const itemId = (backend: string, model?: string) => JSON.stringify([backend, model ?? null]);
const effortLabel = (effort: string) => effort === 'none' ? '关闭思考' : effort;
const catalogUsable = (catalog?: ModelCatalog) => catalog?.state === 'ready' || catalog?.state === 'fallback';
function ProviderIcon({backend}: {backend: string}) {
  const src = backend === 'codex-appserver' ? './agent-icons/codex-light.png' : backend === 'claude-agent' ? './agent-icons/claude-code.svg' : undefined;
  return src ? <img className={`decision-picker-icon${backend === 'codex-appserver' ? ' decision-picker-icon--codex' : ''}`} src={src} alt=""/> : null;
}

/** A provider and model are one choice; settings-section Save owns persistence. */
export function NativeModelPicker({label, value, catalogs, providerIds, allowDefault = false, allowCustom = false, disabled = false, onChange, onRetry, inherited}: {
  label: string; value: NativeModelValue; catalogs: Partial<Record<string, ModelCatalog>>; providerIds?: readonly string[];
  allowDefault?: boolean; allowCustom?: boolean; disabled?: boolean; onChange: (value: NativeModelValue) => void; onRetry?: () => void; inherited?: NativeModelValue;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState<CustomDraft>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  const providers = nativeModelProviders.filter(provider => !providerIds || providerIds.includes(provider.id));
  const matchingCatalog = (backend: string) => catalogs[backend]?.backend === backend ? catalogs[backend] : undefined;
  const customEfforts = (backend: string): Effort[] => {
    const known = providerEfforts[backend] ?? [];
    const catalog = matchingCatalog(backend);
    const listed = catalogUsable(catalog) ? catalog?.titleEfforts.filter(effort => known.includes(effort)) : undefined;
    return listed?.length ? listed : known;
  };
  const initialEffort = (backend: string): Effort => {
    const efforts = customEfforts(backend);
    const preferred = matchingCatalog(backend)?.models.find(model => model.isDefault)?.defaultEffort;
    return preferred && efforts.includes(preferred) ? preferred : efforts.includes('medium') ? 'medium' : efforts[0] ?? 'medium';
  };
  const items: Item[] = providers.flatMap(provider => {
    const catalog = matchingCatalog(provider.id);
    const models = catalog?.models.filter(model => !model.hidden) ?? [];
    return [
      ...(allowDefault ? [{id: itemId(provider.id), backend: provider.id, name: '使用 Bot 默认模型'}] : []),
      ...models.map(model => {
        const alias = provider.id === 'claude-agent' ? aliases[model.id] : undefined;
        const name = alias ?? model.displayName;
        const duplicate = models.some(other => other.id !== model.id && other.displayName === model.displayName);
        const detail = alias && model.displayName !== model.id && model.displayName.toLowerCase() !== alias.toLowerCase() ? model.displayName : duplicate ? model.id : undefined;
        return {id: itemId(provider.id, model.id), backend: provider.id, name, model, detail, unavailable: !catalogUsable(catalog)};
      }),
    ];
  });
  const selection = value.selection;
  const selectedId = selection.kind === 'explicit' ? itemId(value.backend, selection.model) : allowDefault ? itemId(value.backend) : null;
  if (selection.kind === 'explicit' && !items.some(item => item.id === selectedId)) {
    items.push({id: selectedId!, backend: value.backend, name: selection.model, saved: true, unavailable: true, detail: selection.custom && allowCustom ? '自定义模型' : '已保存，当前目录未列出'});
  }
  const current = items.find(item => item.id === selectedId);
  const catalog = matchingCatalog(value.backend);
  const customSelection = selection.kind === 'explicit' && Boolean(selection.custom);
  const efforts = customSelection && allowCustom ? customEfforts(value.backend) : current?.model?.supportedEfforts ?? [];
  const effortOptions: {value: string; label: string; disabled?: boolean}[] = efforts.map(effort => ({value: effort, label: effortLabel(effort)}));
  if (selection.kind === 'explicit' && !effortOptions.some(option => option.value === selection.effort)) {
    effortOptions.push({value: selection.effort, label: `${effortLabel(selection.effort)} · 已保存`, disabled: true});
  }
  const effortDisabled = disabled || !providers.some(provider => provider.id === value.backend) || !(customSelection && allowCustom) && (!catalogUsable(catalog) || !current?.model);
  const filtered = items.filter(item => `${backendLabel(item.backend)} ${item.name} ${item.model?.id ?? ''} ${item.detail ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const groups = [...new Set([...providers.map(provider => provider.id), ...items.map(item => item.backend)])];
  function select(id: string | null) {
    if (disabled || !id) return;
    const item = items.find(entry => entry.id === id);
    if (!item || item.unavailable || !providers.some(provider => provider.id === item.backend)) return;
    if (selectedId === id && !customSelection) return;
    onChange({backend: item.backend, selection: item.model ? {kind: 'explicit', model: item.model.id, effort: item.model.defaultEffort} : {kind: 'default'}});
  }
  function startCustom() {
    if (disabled || !allowCustom || !providers.length) return;
    const backend = providers.some(provider => provider.id === value.backend) ? value.backend : providers[0]!.id;
    const saved = selection.kind === 'explicit' && backend === value.backend;
    const efforts = customEfforts(backend);
    setCustom({backend, model: saved ? selection.model : '', effort: saved && efforts.includes(selection.effort) ? selection.effort : initialEffort(backend)});
    setOpen(false); setQuery('');
  }
  function closeCustom() {
    if (disabled) return;
    setCustom(undefined);
    triggerRef.current?.focus();
  }
  return <div className="decision-picker native-model-picker">
    <div className={`decision-picker-controls${selection.kind === 'explicit' ? '' : ' decision-picker-controls--single'}`}>
      <div className="decision-picker-model"><label>模型</label>
        <Combobox.Root modal={false} open={open} onOpenChange={next => {setOpen(next); setQuery('');}} items={items.map(item => item.id)} filteredItems={filtered.map(item => item.id)}
          value={selectedId} inputValue={query} onInputValueChange={setQuery} itemToStringLabel={id => items.find(item => item.id === id)?.name ?? id} onValueChange={select}>
          <Combobox.Trigger ref={triggerRef} className="decision-picker-trigger" aria-label={`选择${label}`} disabled={disabled}>
            {selectedId && <ProviderIcon backend={value.backend}/>}<span className="decision-picker-selected-copy" title={current?.detail ? `${current.name} · ${current.detail}` : current?.name}><span className="decision-picker-selected-model">{current?.name ?? '选择模型'}</span>{current?.detail && <small>{current.detail}</small>}</span>
            {selectedId && <span className="decision-picker-selected-provider">{backendLabel(value.backend)}</span>}<ChevronDown size={14} aria-hidden="true"/>
          </Combobox.Trigger>
          <Combobox.Portal><Combobox.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={12} className="decision-picker-positioner"><Combobox.Popup className="decision-picker-popup" aria-label={`${label}列表`} finalFocus={() => customInputRef.current ?? triggerRef.current}>
            <label className="decision-picker-search"><Search size={15} aria-hidden="true"/><Combobox.Input placeholder="搜索模型或 Provider" aria-label={`搜索${label}`}/></label>
            <Combobox.List className="decision-picker-list">
              {groups.map(backend => {
                const group = filtered.filter(item => item.backend === backend);
                const providerCatalog = matchingCatalog(backend);
                if (!group.length && query.trim()) return null;
                return <div role="group" aria-label={backendLabel(backend)} key={backend}><div className="decision-picker-group-label">{backendLabel(backend)}</div>
                  {group.map(item => <Combobox.Item key={item.id} value={item.id} className="decision-picker-option" disabled={disabled || item.unavailable}>
                    <ProviderIcon backend={backend}/><span className={`decision-picker-option-copy${item.detail ? ' decision-picker-option-copy--stacked' : ''}`}><strong>{item.name}</strong>{item.detail && <small>{item.detail}</small>}</span>
                    <Combobox.ItemIndicator className="decision-picker-check"><Check size={15} aria-hidden="true"/></Combobox.ItemIndicator>
                  </Combobox.Item>)}
                  {!catalogUsable(providerCatalog) && <div className="decision-picker-catalog-note">{providerCatalog ? providerCatalog.error || '模型目录暂不可用，已保存的选择仍保留。' : '正在读取模型…'}</div>}
                </div>;
              })}
              <Combobox.Empty className="decision-picker-empty">{query.trim() ? '没有匹配的模型' : '暂无可选模型'}</Combobox.Empty>
            </Combobox.List>
            {(allowCustom || onRetry) && <div className="decision-picker-menu-actions">{allowCustom && <Button size="sm" variant="ghost" disabled={disabled} onClick={startCustom}>自定义模型 ID</Button>}{onRetry && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => {if (!disabled) onRetry();}}>重新读取模型</Button>}</div>}
          </Combobox.Popup></Combobox.Positioner></Combobox.Portal>
        </Combobox.Root>
      </div>
      {selection.kind === 'explicit' && <div className="decision-picker-effort"><label>思考强度 · Effort</label><SelectControl presentation="dropdown" label={`${label}思考强度`} value={selection.effort} options={effortOptions} disabled={effortDisabled}
        onChange={next => {const effort = efforts.find(effort => effort === next); if (!effortDisabled && effort && effort !== selection.effort) onChange({...value, selection: {...selection, effort}});}}/></div>}
    </div>
    {selection.kind === 'default' && allowDefault && inherited?.selection.kind === 'explicit' && <p className="native-model-picker-note">{`当前使用 ${backendLabel(inherited.backend)} · ${inherited.selection.model} · ${effortLabel(inherited.selection.effort)}，随 Bot 默认模型设置更新。`}</p>}
    {custom && allowCustom && <div className="decision-picker-custom native-model-picker-custom">
      {providers.length > 1 && <SelectControl presentation="dropdown" label={`自定义${label} Provider`} value={custom.backend} options={providers.map(provider => ({value: provider.id, label: provider.name}))} disabled={disabled} onChange={backend => {if (!disabled && providers.some(provider => provider.id === backend)) setCustom({...custom, backend, effort: initialEffort(backend)});}}/>}
      <input ref={customInputRef} autoFocus className="settings-field" aria-label={`自定义${label} ID`} placeholder="模型 ID" value={custom.model} disabled={disabled} maxLength={1000} onChange={event => setCustom({...custom, model: event.target.value})}/>
      <SelectControl presentation="dropdown" label={`自定义${label}思考强度`} value={custom.effort} options={customEfforts(custom.backend).map(effort => ({value: effort, label: effortLabel(effort)}))} disabled={disabled} onChange={next => {const effort = customEfforts(custom.backend).find(effort => effort === next); if (!disabled && effort) setCustom({...custom, effort});}}/>
      <Button size="sm" disabled={disabled || !custom.model.trim() || custom.model.trim().length > 1000} onClick={() => {if (disabled || !custom.model.trim() || custom.model.trim().length > 1000 || !providers.some(provider => provider.id === custom.backend) || !customEfforts(custom.backend).includes(custom.effort)) return; onChange({backend: custom.backend, selection: {kind: 'explicit', model: custom.model.trim(), effort: custom.effort, custom: true}}); closeCustom();}}>使用</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={closeCustom}>取消</Button>
    </div>}
  </div>;
}
