import type {ModelCatalog, ProjectSettingsView} from '@vonvon/protocol';

export type ModelAccess = NonNullable<ProjectSettingsView['sections']['modelAccess']>['stored'];
export type CatalogModel = ModelCatalog['models'][number];
export type EffortGroup = {key: string; models: CatalogModel[]; efforts: string[]};
export const allowedEfforts = (value: Pick<ModelAccess, 'modelEfforts' | 'efforts'>, id: string) => value.modelEfforts?.[id] ?? value.efforts;
const unique = (values: string[]) => [...new Set(values)];

export function modelAccessDefaultId(value: Pick<ModelAccess, 'defaultModel' | 'models'>) {
  return value.defaultModel ?? value.models[0];
}
export function modelAccessDefault(value: ModelAccess, models: CatalogModel[]) {
  const id = modelAccessDefaultId(value);
  const model = models.find(m => m.id === id && !m.hidden);
  const supported = model?.supportedEfforts.filter(e => allowedEfforts(value, model.id).includes(e)) ?? [];
  const effort = value.defaultEffort ?? supported.find(e => e === model?.defaultEffort) ?? supported[0];
  return {id, model, effort};
}

/** Group by capabilities, never by provider/model name or the order of native options. */
export function effortGroups(value: ModelAccess, models: CatalogModel[]): EffortGroup[] {
  const groups = new Map<string, EffortGroup>();
  for (const model of models.filter(model => value.models.includes(model.id) && !model.hidden)) {
    const key = JSON.stringify(unique(model.supportedEfforts).sort());
    const group = groups.get(key) ?? {key, models: [], efforts: [...model.supportedEfforts]};
    group.models.push(model);
    group.efforts = unique([...group.efforts, ...allowedEfforts(value, model.id).filter(e => value.modelEfforts?.[model.id] || !models.some(m => m.supportedEfforts.includes(e)))]);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export type ModelAccessAction =
  | {type: 'model' | 'defaultModel'; id: string}
  | {type: 'effort' | 'defaultEffort'; ids: string[]; effort: string}
  | {type: 'tier'; id: string; tier: 'fast' | 'ultrafast'};

/** Every edit keeps the default inside the permitted subset; saving remains atomic. */
export function editModelAccess(value: ModelAccess, catalog: CatalogModel[], action: ModelAccessAction): {value?: ModelAccess; notice?: string} {
  const models = catalog.filter(m => !m.hidden);
  const next: ModelAccess = {...value, models: [...value.models],
    modelEfforts: Object.fromEntries(value.models.map(id => [id, [...(value.modelEfforts?.[id] ?? value.efforts.filter(e => models.find(m => m.id === id)?.supportedEfforts.includes(e) || !models.some(m => m.supportedEfforts.includes(e))))]])),
    modelServiceTiers: Object.fromEntries(Object.entries(value.modelServiceTiers ?? {}).filter(([id]) => value.models.includes(id)).map(([id, tiers]) => [id, [...tiers]])),
  };
  const usable = (m: CatalogModel) => m.supportedEfforts.filter(e => allowedEfforts(next, m.id).includes(e));
  let notice: string | undefined;
  if (action.type === 'model') {
    if (next.models.includes(action.id)) {
      if (next.models.length === 1) return {notice: '至少保留一个模型，可以先勾选其他模型。'};
      next.models = next.models.filter(id => id !== action.id);
      delete next.modelEfforts![action.id]; delete next.modelServiceTiers![action.id];
    } else {
      const model = models.find(m => m.id === action.id);
      if (!model) return {};
      next.models.push(action.id); next.modelEfforts![action.id] = [...model.supportedEfforts];
      next.modelServiceTiers![action.id] = [];
    }
  } else if (action.type === 'defaultModel') {
    if (!next.models.includes(action.id)) return {};
    next.defaultModel = action.id;
  } else if (action.type === 'tier') {
    const tiers = next.modelServiceTiers![action.id] ?? [];
    if (!next.models.includes(action.id) || !tiers.includes(action.tier) && !models.find(m => m.id === action.id)?.serviceTiers?.some(t => t.id === action.tier)) return {};
    next.modelServiceTiers![action.id] = tiers.includes(action.tier) ? tiers.filter(t => t !== action.tier) : [...tiers, action.tier];
  } else if (action.type === 'effort' || action.type === 'defaultEffort') {
    const group = models.filter(m => action.ids.includes(m.id) && next.models.includes(m.id));
    if (!group.length) return {};
    const unsupported = group.some(m => !m.supportedEfforts.includes(action.effort));
    const remove = action.type === 'effort' && (unsupported || group.every(m => allowedEfforts(next, m.id).includes(action.effort)));
    if (!remove && group.some(m => !m.supportedEfforts.includes(action.effort))) return {};
    for (const m of group) next.modelEfforts![m.id] = remove ? allowedEfforts(next, m.id).filter(e => e !== action.effort) : unique([...allowedEfforts(next, m.id), action.effort]);
    if (group.some(m => m.supportedEfforts.length && !usable(m).length)) return {notice: '每个模型至少保留一种思考强度。'};
    if (action.type === 'defaultEffort') {
      if (!group.some(m => m.id === (value.defaultModel ?? value.models[0]))) return {};
      next.defaultEffort = action.effort;
      if (group.some(m => !allowedEfforts(value, m.id).includes(action.effort))) notice = `已允许 ${action.effort}，并设为新话题默认。`;
    }
  }
  const candidates = models.filter(m => next.models.includes(m.id) && (!m.supportedEfforts.length || usable(m).length));
  const previousDefault = value.defaultModel ?? value.models[0];
  const preferred = next.defaultModel ?? previousDefault;
  const selected = candidates.find(m => m.id === preferred) ?? candidates.find(m => next.defaultEffort && usable(m).includes(next.defaultEffort)) ?? candidates[0];
  if (!selected) return {notice: '请先勾选一个可用的模型和思考强度。'};
  next.defaultModel = selected.id;
  const efforts = usable(selected);
  next.defaultEffort = selected.supportedEfforts.length ? efforts.find(e => e === next.defaultEffort) ?? efforts.find(e => e === selected.defaultEffort) ?? efforts[0] : undefined;
  next.efforts = unique(next.models.flatMap(id => allowedEfforts(next, id)));
  if (previousDefault !== next.defaultModel && action.type !== 'defaultModel') notice = `已将 ${selected.displayName} 设为新话题默认。`;
  else if (value.defaultEffort && next.defaultEffort !== value.defaultEffort && action.type !== 'defaultEffort') notice = next.defaultEffort ? `默认思考强度已调整为 ${next.defaultEffort}。` : '此模型无需设置思考强度。';
  return {value: next, notice};
}
