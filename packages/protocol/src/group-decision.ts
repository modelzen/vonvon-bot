import {z} from 'zod';
import {JUDGE_PROVIDER_IDS} from './decision-providers.js';

/** New groups copy the host default at creation; legacy default/provider requests resolve to explicit snapshots. */
export const groupDecisionSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('default')}).strict(),
  z.object({kind:z.literal('provider'), provider:z.enum(JUDGE_PROVIDER_IDS)}).strict(),
  z.object({kind:z.literal('llm'), backend:z.enum(['codex-appserver','claude-agent']), model:z.string().trim().min(1).max(1000), effort:z.string().trim().min(1).max(1000).optional(), custom:z.boolean().optional()}).strict(),
  z.object({kind:z.literal('decision'), provider:z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), model:z.string().trim().min(1).max(1000)}).strict(),
]);
export type GroupDecision = z.infer<typeof groupDecisionSchema>;
