import {isKnownJudgeSelection, type DecisionModelsView, type JudgeSelection, type JudgeSelectionView, type ModelCatalog} from '@vonvon/protocol';
import {MEANWHILE} from '../management/secretsModel';

export type JudgeChoiceOption = {value: string; label: string; selection?: JudgeSelection; disabled?: boolean};
export function judgeChoiceOptions(input: {
  value: JudgeSelectionView; catalog: ModelCatalog | undefined; decisionModels: DecisionModelsView | undefined;
  followLabel: string; allowCustom: boolean;
}): {follow: JudgeChoiceOption; language: JudgeChoiceOption[]; decision: JudgeChoiceOption[]; unknown?: JudgeChoiceOption; selected: string} {
  const {value, catalog, decisionModels, followLabel, allowCustom} = input;
  const known = isKnownJudgeSelection(value) ? value : undefined;
  const follow: JudgeChoiceOption = {value: 'follow', label: followLabel, selection: {kind: 'default'}};
  const language: JudgeChoiceOption[] = (catalog?.models ?? []).filter(model => !model.hidden).map((model, index) => ({
    value: `lm:${index}`, label: `${model.displayName} · ${model.id}`,
    selection: known?.kind === 'llm' && known.model === model.id ? known : {kind: 'llm', model: model.id},
  }));
  let selected = 'follow';
  if (known?.kind === 'llm' && !known.custom) {
    const listed = language.find(option => option.selection?.kind === 'llm' && option.selection.model === known.model);
    if (listed) selected = listed.value;
    else {
      selected = `lm:${language.length}`;
      const hidden = catalog?.models.some(model => model.id === known.model && model.hidden);
      const suffix = hidden ? '（已保存，目录里已隐藏）' : catalog && catalog.state !== 'unavailable' && language.length ? '（已保存，当前目录里没有）' : '';
      language.push({value: selected, label: `${known.model}${suffix}`, selection: known});
    }
  }
  if (allowCustom) language.push({value: 'custom', label: '手填模型 id…'});
  if (known?.kind === 'llm' && known.custom && allowCustom) selected = 'custom';
  const decision: JudgeChoiceOption[] = [];
  for (const service of decisionModels ?? []) {
    for (const model of service.models) {
      const selection: JudgeSelection = known?.kind === 'decision' && known.provider === service.provider && known.model === model.id
        ? known : {kind: 'decision', provider: service.provider, model: model.id};
      decision.push({value: `dm:${decision.length}`, label: `${service.displayName} 的 ${model.displayName}${service.keyUnreadable ? '（读不了密钥库）' : !service.keySet ? '（还没填 key）' : ''}`, selection});
    }
  }
  if (known?.kind === 'decision') {
    const listed = decision.find(option => option.selection?.kind === 'decision' && option.selection.provider === known.provider && option.selection.model === known.model);
    if (listed) selected = listed.value;
    else {
      selected = `dm:${decision.length}`;
      decision.push({value: selected, label: `${decisionModels?.find(service => service.provider === known.provider)?.displayName ?? known.provider} 的 ${known.model}`, selection: known});
    }
  }
  const unknown: JudgeChoiceOption | undefined = known ? undefined : {value: 'unknown', label: '这个版本不认识的设置，判断时当没设', disabled: true};
  if (unknown) selected = 'unknown';
  return {follow, language, decision, unknown, selected};
}
export function judgeEffortChoices(value: Extract<JudgeSelection, {kind: 'llm'}>, catalog: ModelCatalog | undefined, backend: string): {value: string; label: string}[] {
  const efforts = value.custom ? catalog?.titleEfforts : catalog?.models.find(model => model.id === value.model)?.supportedEfforts;
  const available = [...(efforts ?? [])];
  if (value.effort && !available.includes(value.effort)) available.push(value.effort);
  return [{value: '', label: backend === 'claude-agent' ? '默认（关思考）' : '默认（最低一档）'}, ...available.map(effort => ({value: effort, label: effort}))];
}
export function judgeLabel(selection: JudgeSelectionView, decisionModels?: DecisionModelsView): string {
  if (!isKnownJudgeSelection(selection)) return '这个版本的网页不认识的设置';
  switch (selection.kind) {
    case 'default': return '各后端的默认小模型';
    case 'llm': return `${selection.model}${selection.effort ? `（推理强度 ${selection.effort}）` : ''}`;
    case 'decision': {
      const service = decisionModels?.find(service => service.provider === selection.provider);
      return `${service?.displayName ?? selection.provider} 的 ${service?.models.find(model => model.id === selection.model)?.displayName ?? selection.model}`;
    }
  }
}
export function judgeKeyNotice(selection: JudgeSelectionView | undefined, decisionModels?: DecisionModelsView): {title: string; text: string} | undefined {
  if (!selection || !isKnownJudgeSelection(selection) || selection.kind !== 'decision') return;
  const service = decisionModels?.find(service => service.provider === selection.provider);
  if (!service) return;
  if (service.keyUnreadable) return {title: '读不了密钥库', text: `看不出填没填 ${service.displayName} 的 key，读得了之前${MEANWHILE}。`};
  if (!service.keySet) return {title: '还没填 key', text: `还没填 ${service.displayName} 的 key，填之前${MEANWHILE}。在密钥页填，或者在终端运行 vonvon secrets set ${service.keyId}，按提示粘贴。`};
}
