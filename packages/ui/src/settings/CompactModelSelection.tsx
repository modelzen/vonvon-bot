import {useState} from 'react';
import {Combobox} from '@base-ui/react/combobox';
import {Check, ChevronDown, Search} from 'lucide-react';
import type {ModelCatalog, ProjectSettingsView} from '@vonvon/protocol';
import './compact-model-selection.css';

type ModelAccess = NonNullable<ProjectSettingsView['sections']['modelAccess']>['stored'];
type Picker = 'models' | 'efforts';
type Option = {id: string; label: string; description?: string; unavailable?: boolean};
const effortLabels: Record<string, string> = {none: '不启用', minimal: '最低', low: '轻度', medium: '中', high: '高', xhigh: '极高', max: 'Max', ultra: 'Ultra'};

/** Menu selections update the section draft; only the section Save persists them. */
export function CompactModelSelection({value, onChange, catalog, disabled}: {
  value: ModelAccess;
  onChange: (value: ModelAccess) => void;
  catalog?: ModelCatalog;
  disabled: boolean;
}) {
  const [picker, setPicker] = useState<{id: Picker; backend: string}>();
  const [query, setQuery] = useState('');
  const matchingCatalog = catalog?.backend === value.backend ? catalog : undefined;
  const models = matchingCatalog?.models.filter(model => !model.hidden) ?? [];
  const efforts = [...new Set([...(matchingCatalog?.models.flatMap(model => model.supportedEfforts) ?? []), ...value.efforts])];
  const catalogReady = matchingCatalog?.state === 'ready';
  const editingDisabled = disabled || !catalogReady;
  const options: Record<Picker, Option[]> = {
    models: [
      ...models.map(model => ({id: model.id, label: model.displayName, description: model.description})),
      ...value.models.filter(id => !models.some(model => model.id === id)).map(id => ({id, label: id, description: '已保存，当前目录未列出', unavailable: true})),
    ],
    efforts: efforts.map(effort => ({id: effort, label: effortLabels[effort] ?? effort})),
  };
  const fields: {id: Picker; label: string; noun: string}[] = [
    {id: 'models', label: '允许的模型', noun: '模型'},
    {id: 'efforts', label: '思考强度', noun: '强度'},
  ];
  return <>{fields.map(field => {
    const open = picker?.id === field.id && picker.backend === value.backend;
    const currentQuery = open ? query : '';
    const items = options[field.id];
    const visible = items.filter(option => `${option.label} ${option.id}`.toLocaleLowerCase().includes(currentQuery.trim().toLocaleLowerCase()));
    const unsupported = field.id === 'efforts' && catalogReady && !efforts.length;
    const selectedLabels = value[field.id].map(id => items.find(option => option.id === id)?.label ?? id);
    return <div className="gd-model-summary-row gd-model-summary-row--value" key={field.id}>
      <span className="gd-model-summary-label">{field.label}</span>
      <Combobox.Root key={`${value.backend}:${field.id}`} multiple modal={false} open={open}
        items={items.map(option => option.id)} filteredItems={visible.map(option => option.id)} value={value[field.id]}
        inputValue={currentQuery} onInputValueChange={(next, details) => {
          // Keep filtered results in place while selecting multiple models.
          if (details.reason === 'input-clear') {details.cancel(); return;}
          setQuery(next);
        }}
        itemToStringLabel={id => items.find(option => option.id === id)?.label ?? id}
        onOpenChange={next => {setPicker(next ? {id: field.id, backend: value.backend} : undefined); setQuery('');}}
        onValueChange={next => {
          if (editingDisabled) return;
          if (field.id === 'models') onChange({...value, models: next});
          else onChange({...value, efforts: next as ModelAccess['efforts']});
        }}>
        <Combobox.Trigger className="gd-model-selection-control" disabled={unsupported}
          aria-label={`${editingDisabled ? '查看' : '选择'}${field.noun}`} title={unsupported ? '此 Provider 未提供思考强度' : selectedLabels.join('、') || `选择${field.noun}`}>
          <span>{unsupported ? '此 Provider 未提供思考强度' : `已选择 ${value[field.id].length} 个`}</span>
          {!unsupported && <ChevronDown size={14} aria-hidden="true"/>}
        </Combobox.Trigger>
        <Combobox.Portal>
          <Combobox.Positioner side="bottom" align="start" sideOffset={5} collisionPadding={12} className="gd-model-menu-positioner">
            <Combobox.Popup className="gd-model-menu" aria-label={`可用${field.noun}`}>
              {field.id === 'models' && <label className="gd-model-menu-search"><Search size={14} aria-hidden="true"/><Combobox.Input type="search" aria-label="搜索模型" placeholder="搜索模型"/></label>}
              <Combobox.List className="gd-model-menu-list" aria-label={`可用${field.noun}`}>
                {visible.map(option => <Combobox.Item key={option.id} value={option.id} className="gd-model-menu-item" disabled={editingDisabled}
                  aria-label={field.id === 'efforts' ? `允许本群使用 ${option.id} Effort` : option.unavailable ? `移除未列出的模型 ${option.id}` : `允许本群使用 ${option.label}`}
                  title={option.description || (option.label !== option.id ? option.id : undefined)}>
                  <span className="gd-model-menu-copy"><span>{option.label}</span>{option.unavailable && <small>{option.description}</small>}</span>
                  <Combobox.ItemIndicator className="gd-model-menu-check" keepMounted><Check size={16} strokeWidth={1.8} aria-hidden="true"/></Combobox.ItemIndicator>
                </Combobox.Item>)}
              </Combobox.List>
              <Combobox.Empty className="gd-model-menu-empty">{currentQuery.trim() ? `没有匹配的${field.noun}。` : matchingCatalog ? matchingCatalog.error || '当前没有可选项。' : '正在读取…'}</Combobox.Empty>
              {editingDisabled && <p className="gd-model-menu-note">当前仅可查看，已保存的选择仍保留。</p>}
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    </div>;
  })}</>;
}
