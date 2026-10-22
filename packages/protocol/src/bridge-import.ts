import {z} from 'zod';

const checkState = z.enum(['present', 'missing', 'invalid', 'unknown']);
const runningState = z.enum(['running', 'stopped', 'unknown']);
const hookState = z.enum(['installed', 'absent', 'needs-repair', 'unknown']);
export const bridgeDetectionSchema = z.object({
  kind: z.enum(['unsupported-platform', 'not-found', 'found', 'upgrade-required', 'invalid', 'imported']),
  message: z.string(),
});
export type BridgeDetection = z.infer<typeof bridgeDetectionSchema>;
export const bridgeImportNoteSchema = z.object({kind: z.string(), message: z.string(), appId: z.string().optional(), chatId: z.string().optional()});
export const bridgePreflightSchema = z.object({
  canImport: z.boolean(),
  bots: z.array(z.object({appId: z.string(), name: z.string(), groups: z.number().int().nonnegative().nullable(),
    directories: z.array(z.object({index: z.number().int().nonnegative(), state: checkState})),
    secret: z.enum(['decryptable', 'plaintext', 'missing', 'invalid', 'cannot-decrypt', 'external-reference', 'unknown']),
    hooks: z.object({claude: hookState, codex: hookState}), running: runningState,
    problems: z.array(z.object({file: z.string(), code: z.string()})),
  })),
  service: runningState, bundledCodex: checkState,
  problems: z.array(z.object({code: z.string(), message: z.string(), appId: z.string().optional()})),
  notes: z.array(bridgeImportNoteSchema),
});
export type BridgePreflight = z.infer<typeof bridgePreflightSchema>;
export const bridgeImportStepSchema = z.enum(['checking', 'stopping', 'locking', 'staging', 'codex', 'hooks', 'moving', 'starting', 'finishing', 'done', 'rolling-back', 'rolled-back', 'rollback-failed', 'refused']);
export const bridgeImportViewSchema = z.object({
  txId: z.string(), step: bridgeImportStepSchema,
  bots: z.array(z.object({appId: z.string(), name: z.string()})),
  notes: z.array(bridgeImportNoteSchema),
  error: z.object({code: z.string(), message: z.string()}).optional(),
  cleanupPending: z.boolean(), canRollback: z.boolean(),
});
export type BridgeImportView = z.infer<typeof bridgeImportViewSchema>;
export type BridgeImportStep = z.infer<typeof bridgeImportStepSchema>;
export const bridgeImportReplySchema = z.object({type: z.literal('bridgeImport'),
  detection: bridgeDetectionSchema.nullable(), preflight: bridgePreflightSchema.nullable(), view: bridgeImportViewSchema.nullable()});
export type BridgeImportReply = z.infer<typeof bridgeImportReplySchema>;
