import {useRef, useState} from 'react';
import {Check, ChevronsUpDown, Search} from 'lucide-react';
import type {ModelCatalog, ProjectSettingsView} from '@vonvon/protocol';
import {Button, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import './compact-model-selection.css';

type ModelAccess = NonNullable<ProjectSettingsView['sections']['modelAccess']>['stored'];
type Picker = 'models' | 'efforts';
type Option = {id: string; label: string; description?: string; unavailable?: boolean};
const toggleItem = <T,>(items: T[], value: T, checked: boolean) => checked ? [...new Set([...items, value])] : items.filter(item => item !== value);

/** Both fields use the same summary, picker and staged selection behavior. */
export function CompactModelSelection({value, onChange, catalog, disabled}: {
  value: ModelAccess;
  onChange: (value: ModelAccess) => void;
  catalog?: ModelCatalog;
  disabled: boolean;
}) {
  const [picker, setPicker] = useState<Picker>();
  const [pending, setPending] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [baseline, setBaseline] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const models = catalog?.models.filter(model => !model.hidden) ?? [];
  const efforts = [...new Set([...(catalog?.models.flatMap(model => model.supportedEfforts) ?? []), ...value.efforts])];
  const catalogReady = catalog?.state === 'ready' && catalog.backend === value.backend;
  const editingDisabled = disabled || !catalogReady;
  const selectionChanged = Boolean(picker) && baseline !== JSON.stringify(value);
  const options: Record<Picker, Option[]> = {
    models: [
      ...models.map(model => ({id: model.id, label: model.displayName, description: model.description})),
      ...value.models.filter(id => !models.some(model => model.id === id)).map(id => ({id, label: id, description: '已保存，当前目录未列出', unavailable: true})),
    ],
    efforts: efforts.map(effort => ({id: effort, label: effort})),
  };
  const fields: {id: Picker; label: string; noun: string; selected: string[]; empty: string}[] = [
    {id: 'models', label: '模型', noun: '模型', selected: value.models.map(id => models.find(model => model.id === id)?.displayName ?? id), empty: '选择模型'},
    {id: 'efforts', label: '思考强度', noun: '强度', selected: value.efforts, empty: catalogReady && !efforts.length ? '此 Provider 未提供思考强度' : '选择强度'},
  ];
  const activeField = fields.find(field => field.id === picker);
  const visibleOptions = picker ? options[picker].filter(option => `${option.label} ${option.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : [];
  function open(next: Picker) {
    setPending([...value[next]]);
    setBaseline(JSON.stringify(value));
    setQuery('');
    setPicker(next);
  }
  function complete() {
    if (!picker || editingDisabled || selectionChanged || picker === 'models' && pending.length === 0) return;
    if (picker === 'models') onChange({...value, models: pending});
    else onChange({...value, efforts: pending as ModelAccess['efforts']});
    setPicker(undefined);
  }
  return <>
    {fields.map(field => <div className="gd-model-summary-row gd-model-summary-row--value" key={field.id}>
      <span className="gd-model-summary-label">{field.label}</span>
      <button type="button" className="gd-multiselect-field" disabled={field.id === 'efforts' && catalogReady && !efforts.length} aria-label={`${editingDisabled ? '查看' : '选择'}${field.noun}`} aria-haspopup="dialog" aria-expanded={picker === field.id} onClick={() => open(field.id)}>
        <span className="gd-multiselect-values">{field.selected.length ? field.selected.map((label, index) => <span className="gd-multiselect-tag" key={value[field.id][index]}>{label}</span>) : <span className="gd-multiselect-placeholder">{field.empty}</span>}</span>
        <ChevronsUpDown size={14} aria-hidden="true"/>
      </button>
    </div>)}
    <Dialog open={Boolean(picker)} title={`选择可用${activeField?.noun ?? '模型'}`}
      description={editingDisabled ? '当前配置仅可查看，已保存的选择仍保留。' : `选择本群可以使用的${activeField?.noun ?? '模型'}，可多选。完成后保存更改。`}
      initialFocusRef={searchRef} onClose={() => setPicker(undefined)}
      footer={<><span className="gd-model-picker-count" role="status"><span className="gd-selection-count">{pending.length}</span>已选{activeField?.noun ?? '模型'}</span><Button onClick={() => setPicker(undefined)}>取消</Button><Button variant="primary" disabled={editingDisabled || selectionChanged || picker === 'models' && !pending.length} onClick={complete}>完成</Button></>}>
      {selectionChanged && <InlineNotice title="模型设置已在别处更改" tone="warning">当前选择已保留。重新读取后再修改，避免覆盖新设置。<Button size="sm" onClick={() => {if (picker) open(picker);}}>重新读取并放弃选择</Button></InlineNotice>}
      <div className="gd-model-picker">
        <label className="gd-model-picker-search"><Search size={16} aria-hidden="true"/><input ref={searchRef} type="search" aria-label={`搜索${activeField?.noun ?? '模型'}`} placeholder={`搜索${activeField?.noun ?? '模型'}`} value={query} onChange={event => setQuery(event.target.value)}/></label>
        <div className="gd-model-picker-heading"><span>可用{activeField?.noun ?? '模型'}</span><small>可多选</small></div>
        <div className="gd-model-picker-options">
          {visibleOptions.map(option => <label className="gd-model-option" key={option.id} data-unavailable={option.unavailable || undefined}>
            <input className="gd-model-option-input" type="checkbox" checked={pending.includes(option.id)} disabled={editingDisabled}
              aria-label={picker === 'efforts' ? `允许本群使用 ${option.id} Effort` : option.unavailable ? `移除未列出的模型 ${option.id}` : `允许本群使用 ${option.label}`}
              onChange={event => {if (!editingDisabled) setPending(current => toggleItem(current, option.id, event.target.checked));}}/>
            <span className="gd-model-option-mark" aria-hidden="true"><Check size={12} strokeWidth={2.5}/></span>
            <span className="gd-model-option-copy" title={option.label.toLocaleLowerCase().replace(/[\s_-]+/g, '') !== option.id.toLocaleLowerCase().replace(/[\s_-]+/g, '') ? option.id : undefined}><strong>{option.label}</strong>{option.description?.trim() && <small>{option.description}</small>}</span>
            <span className="gd-model-option-state" aria-hidden="true">{pending.includes(option.id) ? '已选' : ''}</span>
          </label>)}
          {!visibleOptions.length && <p className="gd-model-picker-empty" role="status">{query.trim() ? `没有匹配的${activeField?.noun ?? '模型'}。` : catalogReady && picker === 'efforts' ? '此 Provider 未提供思考强度。' : catalog ? catalog.error || '当前没有可选项。' : '正在读取…'}</p>}
        </div>
      </div>
    </Dialog>
  </>;
}
