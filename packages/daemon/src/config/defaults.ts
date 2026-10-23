import { z } from 'zod';
import { REASONING_EFFORTS } from '../agent/types';
import { TIER_NETWORK } from '../agent/permission/types';

export const ModelSelectionSchema = z.strictObject({
  kind: z.enum(['catalog', 'custom']),
  id: z.string().min(1).refine((value) => value === value.trim(), 'Must not have surrounding whitespace'),
  effort: z.enum(REASONING_EFFORTS).optional(),
});

/** Only this new block is strict; legacy config and preference keys remain untouched. */
export const BotDefaultsSchema = z.strictObject({
  backend: z.string().min(1).refine((value) => value === value.trim(), 'Must not have surrounding whitespace').optional(),
  model: ModelSelectionSchema.optional(),
  permission: z.enum(['qa', 'write', 'full']).optional(),
  /** Legacy file compatibility only; since s31c, network is derived from permission. */
  network: z.boolean().optional(),
});

export type ModelSelection = z.infer<typeof ModelSelectionSchema>;
export type BotDefaults = z.infer<typeof BotDefaultsSchema>;
export type ResolvedBotDefaults = {
  backend: NonNullable<BotDefaults['backend']> | null;
  model: ModelSelection | null;
  permission: NonNullable<BotDefaults['permission']>;
  network: boolean;
};

export function parseBotDefaults(raw: unknown): BotDefaults | undefined {
  if (raw === undefined) return undefined;
  const result = BotDefaultsSchema.safeParse(raw);
  if (result.success) return result.data;
  // Never include rejected values, unknown keys, or Zod's input-bearing messages.
  const fields = new Set(['backend', 'model', 'kind', 'id', 'effort', 'permission', 'network']);
  const locations = [...new Set(result.error.issues.map((issue) =>
    ['preferences', 'defaults', ...issue.path.filter((part) => typeof part === 'string' && fields.has(part))].join('.'),
  ))];
  throw new Error(`Invalid execution defaults: ${locations.join(', ')}`);
}

export function resolveBotDefaults(defaults: BotDefaults | undefined): ResolvedBotDefaults {
  const permission = defaults?.permission ?? 'write';
  return {
    backend: defaults?.backend ?? null,
    model: defaults?.model ?? null,
    permission,
    network: TIER_NETWORK[permission],
  };
}

/** Validate the owned block without parsing or stripping the legacy envelope. */
export function validateConfigDefaults(config: unknown): void {
  if (typeof config !== 'object' || config === null || !('preferences' in config)) return;
  const preferences = config.preferences;
  if (typeof preferences !== 'object' || preferences === null || !('defaults' in preferences)) return;
  parseBotDefaults(preferences.defaults);
}
