import {useRef, useState} from 'react';
import {Check, ChevronRight, Search} from 'lucide-react';
import type {ModelCatalog, ProjectSettingsView} from '@vonvon/protocol';
import {Button, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import './compact-model-selection.css';

type ModelAccess = NonNullable<ProjectSettingsView['sections']['modelAccess']>['stored'];
type Picker = 'models';
const toggleItem = <T,>(items: T[], value: T, checked: boolean) => checked ? [...new Set([...items, value])] : items.filter(item => item !== value);

/** Selection is staged inside the dialog, then handed to the section's existing save draft. */
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
  const selectedModels = value.models.map(id => models.find(model => model.id === id)?.displayName ?? id);
  const visibleModels = models.filter(model => `${model.displayName} ${model.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const unlistedModels = value.models.filter(id => !models.some(model => model.id === id));
  const visibleUnlisted = unlistedModels.filter(id => id.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const catalogReady = catalog?.state === 'ready' && catalog.backend === value.backend;
  const editingDisabled = disabled || !catalogReady;
  const selectionChanged = Boolean(picker) && baseline !== JSON.stringify(value);
  function open(next: Picker) {
    setPending([...value[next]]);
    setBaseline(JSON.stringify(value));
    setQuery('');
    setPicker(next);
  }
  function complete() {
    if (!picker || editingDisabled || selectionChanged || picker === 'models' && pending.length === 0) return;
    onChange({...value, models: pending});
    setPicker(undefined);
  }
  return <>
    <div className="gd-model-summary-row gd-model-summary-row--value">
      <span className="gd-model-summary-label">允许的模型</span>
      <div className="gd-model-selection-value">
        <div className="gd-selected-models" aria-label="已选模型">{selectedModels.length ? selectedModels.map((name, index) => <span className="gd-selected-model" key={value.models[index]}>{name}</span>) : <span className="gd-model-edit-value--empty">尚未选择</span>}</div>
        <Button size="sm" variant="ghost" className="gd-model-change" aria-label={editingDisabled ? '查看模型' : '选择模型'} aria-haspopup="dialog" aria-expanded={picker === 'models'} onClick={() => open('models')}>{editingDisabled ? '查看' : '更改'}<ChevronRight size={13} aria-hidden="true"/></Button>
      </div>
    </div>
    <div className="gd-model-summary-row gd-model-summary-row--value">
      <span className="gd-model-summary-label">思考强度</span>
      <div className="gd-inline-efforts" role="group" aria-label="允许的思考强度">{efforts.map(effort => <label className="gd-inline-effort" key={effort}>
        <input className="gd-model-option-input" type="checkbox" checked={value.efforts.includes(effort)} disabled={editingDisabled} aria-label={`允许本群使用 ${effort} Effort`} onChange={event => {if (!editingDisabled) onChange({...value, efforts: toggleItem(value.efforts, effort, event.target.checked)});}}/>
        <Check size={12} aria-hidden="true"/><span>{effort}</span>
      </label>)}{!efforts.length && <span className="gd-model-edit-value--empty">{catalog?.state === 'ready' ? '模型未提供可选强度' : '正在读取…'}</span>}</div>
    </div>
    <Dialog open={Boolean(picker)} title="选择可用模型"
      description={editingDisabled ? '当前配置仅可查看，已保存的选择仍保留。' : '选择本群可以使用的模型。完成后保存更改。'}
      initialFocusRef={searchRef} onClose={() => setPicker(undefined)}
      footer={<><span className="gd-model-picker-count" role="status"><span className="gd-selection-count">{pending.length}</span>已选模型</span><Button onClick={() => setPicker(undefined)}>取消</Button><Button variant="primary" disabled={editingDisabled || selectionChanged || picker === 'models' && !pending.length} onClick={complete}>完成</Button></>}>
      {selectionChanged && <InlineNotice title="模型设置已在别处更改" tone="warning">当前选择已保留。重新读取后再修改，避免覆盖新设置。<Button size="sm" onClick={() => {if (picker) open(picker);}}>重新读取并放弃选择</Button></InlineNotice>}
      <div className="gd-model-picker">
        <label className="gd-model-picker-search"><Search size={16} aria-hidden="true"/><input ref={searchRef} type="search" aria-label="搜索模型" placeholder="搜索模型名称或 ID" value={query} onChange={event => setQuery(event.target.value)}/></label>
        <div className="gd-model-picker-heading"><span>可用模型</span><small>可多选</small></div>
        <div className="gd-model-picker-options">
          {visibleModels.map(model => <label className="gd-model-option" key={model.id}><input className="gd-model-option-input" type="checkbox" checked={pending.includes(model.id)} disabled={editingDisabled} aria-label={`允许本群使用 ${model.displayName}`} onChange={event => setPending(current => toggleItem(current, model.id, event.target.checked))}/>
            <span className="gd-model-option-mark" aria-hidden="true"><Check size={12} strokeWidth={2.5}/></span>
            <span className="gd-model-option-copy" title={model.displayName.toLocaleLowerCase().replace(/[\s_-]+/g, '') !== model.id.toLocaleLowerCase().replace(/[\s_-]+/g, '') ? model.id : undefined}><strong>{model.displayName}</strong>{model.description.trim() && <small>{model.description}</small>}</span>
            <span className="gd-model-option-state" aria-hidden="true">{pending.includes(model.id) ? '已选' : ''}</span>
          </label>)}
          {visibleUnlisted.map(id => <label key={id} className="gd-model-option" data-unavailable><input className="gd-model-option-input" type="checkbox" checked={pending.includes(id)} disabled={editingDisabled} aria-label={`移除未列出的模型 ${id}`} onChange={event => setPending(current => toggleItem(current, id, event.target.checked))}/>
            <span className="gd-model-option-mark" aria-hidden="true"><Check size={12} strokeWidth={2.5}/></span><span className="gd-model-option-copy"><strong>{id}</strong><small>已保存，当前目录未列出</small></span>
            <span className="gd-model-option-state" aria-hidden="true">{pending.includes(id) ? '已选' : ''}</span>
          </label>)}
          {!visibleModels.length && !visibleUnlisted.length && <p className="gd-model-picker-empty" role="status">{query.trim() ? '没有匹配的模型。' : catalog ? catalog.error || '当前没有可选模型。' : '正在读取模型…'}</p>}
        </div>
      </div>
    </Dialog>
  </>;
}
