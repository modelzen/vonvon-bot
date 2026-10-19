import { z } from "zod";

/** A key as an HTTP header carries it: printable ASCII, no space or line break (s23g). The daemon checks it on each
 * save and the judge on each read; the request schema takes only the length, so a client sees the daemon's refusal. */
export const API_KEY_SHAPE = /^[\x21-\x7e]+$/;
export const API_KEY_MAX = 4096;
/** A decision provider's name in the keystore, such as `typesafe-api-key`; the key page names no other entry. */
export const keyIdSchema = z.string().min(1).max(100);

/** Who chose a key's service: the bot's default judge model (no groupId), or a group that chose it itself or follows
 * that default (s23g). A group outside 智能 is listed only when it chose it itself, and is marked. */
export const secretUseSchema = z.object({
  agentId: z.string(), agentName: z.string(),
  groupId: z.string().optional(), groupName: z.string().optional(),
  /** the group follows the bot's default */
  inherited: z.boolean().optional(),
  /** the group is not in 智能 now, so it judges nothing until it is */
  notSmart: z.boolean().optional(),
});
export type SecretUse = z.infer<typeof secretUseSchema>;

/** One service on the key page. `invalid`: a stored key no header can carry (the judge takes it for a missing one). */
export const secretServiceSchema = z.object({
  provider: z.string(), displayName: z.string(), keyId: z.string(),
  models: z.array(z.object({ id: z.string(), displayName: z.string() })),
  status: z.enum(["set", "missing", "invalid", "unreadable"]),
  /** its last four characters: only when set and 12 characters or longer */
  last4: z.string().optional(),
  /** unreadable: a fixed sentence and the error's code, never the keystore's own words */
  problem: z.string().optional(), code: z.string().optional(),
  inUse: z.array(secretUseSchema),
});
export type SecretService = z.infer<typeof secretServiceSchema>;

/** What one 试一次 found; `message` is always the daemon's own words. */
export const secretTestOutcomeSchema = z.enum(["ok", "auth", "busy", "network", "timeout", "failed"]);
export type SecretTestOutcome = z.infer<typeof secretTestOutcomeSchema>;
