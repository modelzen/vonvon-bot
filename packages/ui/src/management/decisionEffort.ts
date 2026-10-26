import {defaultCodexDecisionEffort, recommendedDecisionEffort} from '@vonvon/protocol';
type Choice = {value: string; label: string; recommended?: boolean; disabled?: boolean};

/** Recommendations follow explicit capabilities; the legacy implicit value is displayed truthfully. */
export function effortChoices({provider, model, stored, efforts, custom = false, catalogReady}: {
  provider: string; model: string; stored?: string; efforts: readonly string[]; custom?: boolean; catalogReady: boolean;
}): {value: string; options: Choice[]; recommended: string | undefined} {
  const claude = provider === 'claude-agent';
  const known = !custom && catalogReady;
  const recommended = claude ? '' : known ? recommendedDecisionEffort(efforts) : undefined;
  const label = (effort: string) => effort === 'none' ? '关闭思考' : effort;
  // Showing a pre-existing automatic value does not rewrite the stored setting on page load.
  const effective = stored ?? (claude ? '' : defaultCodexDecisionEffort(model, known ? efforts : undefined, custom));
  const options: Choice[] = [
    ...(claude ? [{value: '', label: '关闭思考', recommended: true}] : custom ? [{value: '', label: '未指定'}] : []),
    ...efforts.map(effort => ({value: effort, label: label(effort), recommended: effort === recommended})),
  ];
  if (effective !== undefined && !options.some(option => option.value === effective)) {
    options.push({value: effective, label: label(effective), disabled: true});
  } else if (effective === undefined && !options.some(option => option.value === '')) {
    // Unknown/custom catalog: no claim that disabling thinking or low is supported.
    options.unshift({value: '', label: known ? '无需设置' : '未指定', disabled: true});
  }
  return {value: effective ?? '', options, recommended};
}
