import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from '../config/paths';
import { writeFileAtomic } from '../server/atomic-file';
import { parseModelId } from '../agent/model-id';
import { REASONING_EFFORTS, type ReasoningEffort } from '../agent/types';
import { getSessionTitleEfforts } from '../config/schema';
import { defaultJudgeModel } from './model';
import { decisionProvider } from './decision';

export const JUDGE_PROVIDERS = ['codex-appserver', 'claude-agent', 'typesafe'] as const;
export type JudgeProvider = typeof JUDGE_PROVIDERS[number];
export type JudgeModelChoice = { model: string; effort?: ReasoningEffort; custom?: boolean };
export type JudgeModels = { defaultProvider?: JudgeProvider; byProvider: Record<string, JudgeModelChoice> };
export const DEFAULT_JUDGE_PROVIDER: JudgeProvider = 'codex-appserver';
/** Missing old configuration has a stable default; availability never silently switches providers. */
export function defaultJudgeProvider(stored: JudgeModels): JudgeProvider { return stored.defaultProvider ?? DEFAULT_JUDGE_PROVIDER; }
const choice = z.object({ model: z.string(), effort: z.enum(REASONING_EFFORTS).optional(), custom: z.boolean().optional() }).strict();
const fileSchema = z.object({ version: z.literal(1), defaultProvider: z.enum(JUDGE_PROVIDERS).optional(), byProvider: z.record(z.string(), choice) }).strict();

export class JudgeModelsError extends Error {}
export function judgeModelsFile(root = paths.appDir): string { return join(root, 'judge-models.json'); }
function parseSnapshot(text: string): JudgeModels {
  let parsed: z.infer<typeof fileSchema>;
  try { parsed = fileSchema.parse(JSON.parse(text)); }
  catch { throw new JudgeModelsError('整台电脑的决策模型设置已损坏'); }
  for (const [provider, value] of Object.entries(parsed.byProvider)) {
    if (!JUDGE_PROVIDERS.includes(provider as JudgeProvider)) continue;
    if (!parseModelId(value.model).ok || (provider === 'typesafe' && value.effort)
      || (value.effort && provider !== 'typesafe' && !getSessionTitleEfforts(provider).includes(value.effort)))
      throw new JudgeModelsError(`${provider} 的决策模型设置无效`);
  }
  return { ...(parsed.defaultProvider ? { defaultProvider: parsed.defaultProvider } : {}), byProvider: parsed.byProvider };
}

/** Read on every judgement. Missing means defaults; a corrupt explicit choice fails closed. */
export async function readJudgeModels(root = paths.appDir): Promise<JudgeModels> {
  let text: string;
  try { text = await readFile(judgeModelsFile(root), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { byProvider: {} };
    throw new JudgeModelsError('无法读取整台电脑的决策模型设置');
  }
  return parseSnapshot(text);
}
export function readJudgeModelsSync(root = paths.appDir): JudgeModels {
  try { return parseSnapshot(readFileSync(judgeModelsFile(root), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { byProvider: {} };
    if (error instanceof JudgeModelsError) throw error;
    throw new JudgeModelsError('无法读取整台电脑的决策模型设置');
  }
}

/** Caller holds the host mutex across CAS and this atomic write. */
export async function writeJudgeModels(value: JudgeModels, root = paths.appDir): Promise<void> {
  await writeFileAtomic(judgeModelsFile(root), JSON.stringify(fileSchema.parse({ version: 1, ...value })));
}

export function defaultProviderChoice(provider: JudgeProvider): JudgeModelChoice {
  if (provider === 'typesafe') return { model: decisionProvider('typesafe')!.models[0]!.id };
  return defaultJudgeModel(provider, undefined);
}

export function effectiveJudgeModels(stored: JudgeModels): JudgeModels {
  return { defaultProvider: defaultJudgeProvider(stored), byProvider: Object.fromEntries(JUDGE_PROVIDERS.map(provider => [provider, stored.byProvider[provider] ?? defaultProviderChoice(provider)])) };
}

export async function resolveProviderChoice(provider: JudgeProvider, root = paths.appDir): Promise<JudgeModelChoice> {
  const stored = await readJudgeModels(root);
  return stored.byProvider[provider] ?? defaultProviderChoice(provider);
}
export function resolveProviderChoiceSync(provider: JudgeProvider, root = paths.appDir): JudgeModelChoice {
  return readJudgeModelsSync(root).byProvider[provider] ?? defaultProviderChoice(provider);
}
