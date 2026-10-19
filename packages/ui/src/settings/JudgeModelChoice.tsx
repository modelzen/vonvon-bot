import {useEffect, useState} from 'react';
import {isKnownJudgeSelection, type DecisionModelsView, type JudgeSelection, type JudgeSelectionView, type ModelCatalog} from '@vonvon/protocol';
import {SettingsRow} from '../reference/components/system-settings';
import {Button} from '../reference/components/ui';
import {Text} from './SettingsPanel';
import {judgeChoiceOptions, judgeEffortChoices, judgeKeyNotice, judgeLabel, type JudgeChoiceOption} from './judgeChoice';

export function JudgeModelChoice({value, onChange, backend, catalog, decisionModels, effective, showInheritedKey, disabled, followLabel, allowCustom = false, onOpenSecrets}: {
  value: JudgeSelectionView; onChange: (next: JudgeSelection) => void; backend: string;
  catalog: ModelCatalog | undefined; decisionModels: DecisionModelsView | undefined;
  effective?: JudgeSelectionView; showInheritedKey: boolean; disabled: boolean; followLabel: string;
  allowCustom?: boolean; onOpenSecrets?: () => void;
}) {
  const [typing, setTyping] = useState(false);
  const known = isKnownJudgeSelection(value) ? value : undefined;
  useEffect(() => {
    if (isKnownJudgeSelection(value) && (value.kind === 'decision' || value.kind === 'llm' && !value.custom)) setTyping(false);
  }, [value]);
  const custom = allowCustom && (known?.kind === 'llm' && known.custom || typing);
  const choices = judgeChoiceOptions({value, catalog, decisionModels, followLabel, allowCustom});
  const notice = judgeKeyNotice(showInheritedKey ? effective : value, decisionModels);
  const option = (item: JudgeChoiceOption) => <option key={item.value} value={item.value} disabled={item.disabled}>{item.label}</option>;
  const description = [effective ? `现在判断用：${judgeLabel(effective, decisionModels)}` : '', catalog?.state === 'unavailable' ? catalog.error : ''].filter(Boolean).join('。');
  return <>
    <SettingsRow title="判断模型" description={description || undefined} trailing={
      <select aria-label="判断模型" value={custom ? 'custom' : choices.selected} disabled={disabled} onChange={event => {
        if (event.target.value === 'custom') {
          setTyping(true);
          if (!(known?.kind === 'llm' && known.custom)) onChange({kind: 'default'});
          return;
        }
        setTyping(false);
        const next = [choices.follow, ...choices.language, ...choices.decision].find(item => item.value === event.target.value)?.selection;
        if (next) onChange(next);
      }}>
        {option(choices.follow)}
        <optgroup label="语言模型">{choices.language.map(option)}</optgroup>
        {choices.decision.length > 0 && <optgroup label="决策模型">{choices.decision.map(option)}</optgroup>}
        {choices.unknown && option(choices.unknown)}
      </select>
    } />
    {custom && <SettingsRow title="手填模型 id" description="列表里没有的模型，比如网关的。不核对，填错了判断会出错，5 分钟内不再试。" trailing={
      <Text label="手填模型 id" value={known?.kind === 'llm' ? known.model : ''} disabled={disabled} onChange={input => {
        const model = input.trim();
        setTyping(true);
        if (!model) { onChange({kind: 'default'}); return; }
        const effort = known?.kind === 'llm' && known.effort && catalog?.titleEfforts.includes(known.effort) ? known.effort : undefined;
        onChange({kind: 'llm', model, custom: true, ...(effort ? {effort} : {})});
      }} />
    } />}
    {known?.kind === 'llm' && <SettingsRow title="推理强度" trailing={
      <select aria-label="判断的推理强度" value={known.effort ?? ''} disabled={disabled} onChange={event => {
        const {effort: previous, ...rest} = known;
        const effort = [known.effort, ...(catalog?.titleEfforts ?? []), ...(catalog?.models.find(model => model.id === known.model)?.supportedEfforts ?? [])].find(item => item === event.target.value);
        onChange({...rest, ...(effort ? {effort} : {})});
      }}>{judgeEffortChoices(known, catalog, backend).map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
    } />}
    {notice && <SettingsRow title={notice.title} description={notice.text} trailing={onOpenSecrets ? <Button size="sm" onClick={onOpenSecrets}>去密钥页</Button> : undefined} />}
  </>;
}
