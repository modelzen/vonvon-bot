const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export type DecisionReasoningEffort = typeof effortOrder[number];

const codexDecisionModel = 'gpt-6-luna';

/** Prefer a visible small model from the discovered catalog; never substitute for an explicit choice. */
export function defaultCodexDecisionModel(
  models?: readonly { id: string; hidden?: boolean; isDefault?: boolean }[],
): string {
  const visible = models?.filter(model => !model.hidden);
  if (!visible?.length) return codexDecisionModel;
  return (visible.find(model => model.id === codexDecisionModel)
    ?? visible.find(model => model.id.endsWith('-luna'))
    ?? visible.find(model => model.isDefault)
    ?? visible[0]!).id;
}

/** A decision is small and latency-sensitive: turn thinking off when supported, otherwise use low. */
export function recommendedDecisionEffort(supported: readonly string[]): DecisionReasoningEffort | undefined {
  return supported.includes('none') ? 'none' : supported.includes('low') ? 'low' : undefined;
}

/**
 * Resolve an omitted Codex decision effort in both the settings UI and the runtime.
 * A confirmed catalog is authoritative, including an empty supported-effort list. Unusual models
 * without none/low use their lowest supported level; hand-typed or unknown models keep the key
 * absent. Luna's known low fallback only applies while its catalog is unavailable.
 */
export function defaultCodexDecisionEffort(
  model: string,
  supported: readonly string[] | undefined,
  custom = false,
): DecisionReasoningEffort | undefined {
  if (custom) return undefined;
  if (supported === undefined) return model === codexDecisionModel ? 'low' : undefined;
  return recommendedDecisionEffort(supported) ?? effortOrder.find(effort => supported.includes(effort));
}
