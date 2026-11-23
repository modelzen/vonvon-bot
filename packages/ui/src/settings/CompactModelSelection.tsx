import {useId, useState, type ReactNode} from 'react';
import {Popover} from '@base-ui/react/popover';
import {Check, ChevronDown, RefreshCw, Search, Star, Zap} from 'lucide-react';
import type {ModelCatalog} from '@vonvon/protocol';
import type {CatalogControls} from './SettingsPanel';
import {allowedEfforts, editModelAccess, effortGroups, modelAccessDefault, type ModelAccess, type ModelAccessAction} from './model-access-draft';
import './compact-model-selection.css';

export function DefaultBadge() {
  return <span className="gd-default-badge" title="新话题默认"><Star size={11} fill="currentColor" aria-hidden="true"/>默认</span>;
}
function CheckLabel({label, checked, mixed, disabled, onChange, children}: {label: string; checked: boolean; mixed?: boolean; disabled: boolean; onChange: () => void; children: ReactNode}) {
  return <label className="gd-model-check"><input type="checkbox" aria-label={label} checked={checked} disabled={disabled}
    ref={input => {if (input) input.indeterminate = Boolean(mixed);}} onChange={onChange}/>
    <span className="gd-model-check-mark" aria-hidden="true">{checked ? <Check size={12}/> : mixed ? '−' : null}</span>{children}</label>;
}

export function ModelSummaryMenu({label, summary, trigger, open, onOpenChange, children, error}: {
  label: string; summary: string; trigger: string; open?: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode; error?: string;
}) {
  const errorId = useId();
  return <div className="gd-model-summary-row">
    <span className="gd-model-summary-label">{label}</span>
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger className="gd-model-selection-control" aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} aria-label={trigger}>
        <span className="gd-model-selection-copy">{summary}</span><ChevronDown size={14} aria-hidden="true"/>
      </Popover.Trigger>
      <Popover.Portal><Popover.Positioner side="bottom" align="start" sideOffset={7} collisionPadding={12} className="gd-model-menu-positioner">
        <Popover.Popup className="gd-model-menu" aria-label={label}>{children}
          <div className="gd-model-menu-footer"><span><Star size={11} aria-hidden="true"/>默认仅用于新话题</span></div>
        </Popover.Popup>
      </Popover.Positioner></Popover.Portal>
    </Popover.Root>
    {error && <p id={errorId} className="gd-model-field-error" role="alert">{error}</p>}
  </div>;
}

/** Menus edit one section draft; its Save persists permissions and defaults together. */
export function CompactModelSelection({value, onChange, catalog, catalogControls, disabled, errors = {}}: {
  errors?: {models?: string; efforts?: string};
  value: ModelAccess; onChange: (value: ModelAccess) => void; catalog?: ModelCatalog; catalogControls?: CatalogControls; disabled: boolean;
}) {
  const [picker, setPicker] = useState<{id: 'models' | 'efforts'; backend: string}>();
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<string>();
  const current = catalog?.backend === value.backend ? catalog : undefined;
  const models = current?.models.filter(m => !m.hidden) ?? [];
  const ready = current?.state === 'ready' && !catalogControls?.loading;
  const readonly = disabled || !ready;
  const missing = value.models.filter(id => !models.some(m => m.id === id));
  const rows: ModelCatalog['models'] = [...models, ...missing.map(id => ({id, displayName: id, description: '', hidden: false, isDefault: false, supportedEfforts: [], defaultEffort: ''}))];
  const groups = effortGroups(value, models);
  const {id: defaultId, effort: defaultEffort} = modelAccessDefault(value, models);
  const limited = models.some(m => value.models.includes(m.id) && m.supportedEfforts.some(e => !allowedEfforts(value, m.id).includes(e)));
  const status = catalogControls?.loading ? '正在刷新，原选择仍保留…' : catalogControls?.error ?? (!ready ? current?.error || '当前仅可查看，已保存的选择仍保留。' : undefined);
  const edit = (action: ModelAccessAction) => {
    if (readonly) return;
    const result = editModelAccess(value, models, action);
    setNotice(result.notice);
    if (result.value) onChange(result.value);
  };
  const refresh = (kind: 'models' | 'efforts') => catalogControls && <button type="button" className="gd-model-icon-button" aria-label={kind === 'models' ? '刷新模型' : '刷新思考强度'} title="刷新模型及其支持的能力" disabled={catalogControls.loading} onClick={catalogControls.refresh}><RefreshCw size={15} className={catalogControls.loading ? 'gd-model-refreshing' : ''} aria-hidden="true"/></button>;
  const messages = <>{status && <p className="gd-model-menu-note" role="status">{status}</p>}{notice && <p className="gd-model-menu-notice" role="status">{notice}</p>}</>;
  const menu = (kind: 'models' | 'efforts', label: string, summary: string, children: ReactNode) => <ModelSummaryMenu
    label={label} summary={summary} trigger={kind === 'models' ? '配置可用模型' : '配置可用思考强度'} error={errors[kind]}
    open={picker?.id === kind && picker.backend === value.backend}
    onOpenChange={open => {setPicker(open ? {id: kind, backend: value.backend} : undefined); setQuery(''); setNotice(undefined);}}>
    {children}{messages}
  </ModelSummaryMenu>;
  return <>
    {menu('models', '可用模型', `${value.models.length} 个模型${ready && missing.length ? ` · ${missing.length} 个已不可用` : ''}`, <>
      <div className="gd-model-menu-heading"><label className="gd-model-menu-search"><Search size={14} aria-hidden="true"/><input type="search" aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={e => setQuery(e.target.value)}/></label>{refresh('models')}</div>
      <div className="gd-model-menu-list" role="group" aria-label="可用模型">{rows.filter(m => `${m.displayName} ${m.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(model => {
        const checked = value.models.includes(model.id);
        const unavailable = missing.includes(model.id);
        const tiers = model.serviceTiers?.filter(t => t.id === 'fast' || t.id === 'ultrafast') ?? [];
        const allowedTiers = value.modelServiceTiers?.[model.id] ?? [];
        const removedTiers = allowedTiers.filter(t => !tiers.some(native => native.id === t));
        const tierRows = [...tiers, ...removedTiers.map(id => ({id, name: id, description: ''}))];
        return <div className="gd-model-menu-item" key={model.id}>
          <CheckLabel label={`允许 ${model.displayName}`} checked={checked} disabled={readonly} onChange={() => edit({type: 'model', id: model.id})}><span className="gd-model-menu-copy" title={model.id}><strong>{model.displayName}</strong>{unavailable && <small>{ready ? '已不可用' : '已保存，当前无法核对'}</small>}</span></CheckLabel>
          {checked && !unavailable && <div className="gd-model-actions">{ready && tierRows.length > 0 && <Popover.Root><Popover.Trigger className={`gd-model-icon-button${allowedTiers.some(t => tiers.some(s => s.id === t)) ? ' is-active' : ''}`} aria-label={`${model.displayName} 允许加速`} title={removedTiers.length ? '原加速选项已不可用，请取消勾选' : `允许加速：${allowedTiers.length ? allowedTiers.join('、') : '未开启'}`} disabled={readonly}><Zap size={15} aria-hidden="true"/></Popover.Trigger>
            <Popover.Portal><Popover.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={12} className="gd-model-tier-positioner"><Popover.Popup className="gd-model-tier-menu" aria-label={`${model.displayName} 加速权限`}>
              <div className="gd-model-tier-title">允许加速<small>{model.displayName}</small></div>
              {tierRows.map(tier => <CheckLabel key={tier.id} label={`允许 ${tier.name}`} checked={allowedTiers.includes(tier.id as 'fast' | 'ultrafast')} disabled={readonly} onChange={() => edit({type: 'tier', id: model.id, tier: tier.id as 'fast' | 'ultrafast'})}><span className="gd-model-menu-copy"><span>{tier.name}</span>{removedTiers.includes(tier.id as 'fast' | 'ultrafast') && <small>已不可用</small>}</span></CheckLabel>)}
              <p>新话题默认使用普通速度，群内可通过 /model 开启已允许的加速。</p>
            </Popover.Popup></Popover.Positioner></Popover.Portal>
          </Popover.Root>}{defaultId === model.id ? <DefaultBadge/> : <button type="button" className="gd-model-icon-button gd-model-default-action" aria-label={`将 ${model.displayName} 设为新话题默认`} title="设为新话题默认" disabled={readonly} onClick={() => edit({type: 'defaultModel', id: model.id})}><Star size={15} aria-hidden="true"/></button>}</div>}
        </div>;
      })}{!rows.some(m => `${m.displayName} ${m.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && <p className="gd-model-menu-empty">{query ? '没有匹配的模型。' : '当前没有可选模型。'}</p>}</div>
      {ready && models.some(m => m.serviceTiers?.some(t => t.id === 'fast' || t.id === 'ultrafast')) && <p className="gd-model-menu-legend"><Zap size={11} aria-hidden="true"/>允许加速 · 默认关闭</p>}
    </>)}
    {menu('efforts', '可用思考强度', groups.length ? `${limited ? '已自定义' : '全部允许'}${groups.length > 1 ? ` · ${groups.length} 组` : ''}` : '暂无可配置项', <>
      <div className="gd-model-menu-heading"><strong>可用思考强度</strong>{refresh('efforts')}</div>
      <div className="gd-model-effort-list">{groups.map(group => {
        const defaultGroup = group.models.some(m => m.id === defaultId);
        return <section className="gd-model-effort-group" key={group.key} aria-label={`${group.models.map(m => m.displayName).join('、')} 可用思考强度`}>
          <div className="gd-model-effort-heading"><span title={group.models.map(m => m.displayName).join('、')}>{group.models.map(m => m.displayName).join('、')}</span>{defaultGroup && <small>含默认模型</small>}</div>
          {group.efforts.map(effort => {
            const checked = group.models.every(m => allowedEfforts(value, m.id).includes(effort));
            const any = group.models.some(m => allowedEfforts(value, m.id).includes(effort));
            const supported = group.models.every(m => m.supportedEfforts.includes(effort));
            return <div className="gd-model-menu-item gd-model-effort-option" key={effort}>
              <CheckLabel label={`允许 ${effort}`} checked={checked} mixed={!checked && any} disabled={readonly} onChange={() => edit({type: 'effort', ids: group.models.map(m => m.id), effort})}><span className="gd-model-menu-copy"><span>{effort}</span>{!supported && <small>{ready ? '已不可用' : '已保存，当前无法核对'}</small>}</span></CheckLabel>
              {defaultGroup && supported && (defaultEffort === effort ? <DefaultBadge/> : <button type="button" className="gd-model-icon-button gd-model-default-action" aria-label={`将 ${effort} 设为新话题默认强度`} title="设为默认，并允许使用" disabled={readonly} onClick={() => edit({type: 'defaultEffort', ids: group.models.map(m => m.id), effort})}><Star size={15} aria-hidden="true"/></button>)}
            </div>;
          })}{!group.efforts.length && <p className="gd-model-menu-empty">此模型没有可配置的思考强度。</p>}
        </section>;
      })}{!groups.length && <p className="gd-model-menu-empty">{ready ? '请先选择模型。' : `已保存：${value.efforts.join('、') || '暂无思考强度'}`}</p>}</div>
      {groups.length > 1 && <p className="gd-model-menu-help">支持范围相同的模型共用设置。</p>}
    </>)}
  </>;
}
