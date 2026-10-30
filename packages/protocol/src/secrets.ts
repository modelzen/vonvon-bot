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
  /** Only custom: the shared System One endpoint is configured and valid. */
  endpointConfigured: z.boolean().optional(),
  status: z.enum(["set", "missing", "invalid", "unreadable"]),
  /** its last four characters: only when set and 12 characters or longer */
  last4: z.string().optional(),
  /** unreadable: a fixed sentence and the error's code, never the keystore's own words */
  problem: z.string().optional(), code: z.string().optional(),
  inUse: z.array(secretUseSchema),
});
export type SecretService = z.infer<typeof secretServiceSchema>;

/** Why a key cannot be saved, or nothing; the words never quote it. The daemon checks it on each save; the key page
 * checks it before sending, so its words are the same (s23g2). */
export function keyProblem(value: string): string | undefined {
  if (!value) return "没有读到 key";
  if (value.length > API_KEY_MAX) return `key 太长了，最多 ${API_KEY_MAX} 个字符`;
  if (!API_KEY_SHAPE.test(value)) return "key 只能是一串可见的英文字符，不能有空格、换行或中文";
  return undefined;
}

/** The judge's words when a decision model's key stops a judgement (judge.ts readKey, typesafe.ts): they land in a
 * not-replied record's `detail`, and the 状态与诊断 page reads them back to point at the key page (s23g2). */
export const KEY_FAILURE = {
  unreadable: "密钥库读不了",
  missing: (service: string) => `没填 ${service} 的 key`,
  invalid: (service: string) => `${service} 的 key 不是一串可见字符，重新填一次`,
  rejected: (service: string) => `${service} 不认这个 key`,
} as const;
/** Which of {@link KEY_FAILURE} a detail is: the keystore, or the key itself (missing, unusable, refused). */
export function keyFailureOf(detail: string | undefined): "keystore" | "key" | undefined {
  if (!detail) return undefined;
  if (detail === KEY_FAILURE.unreadable) return "keystore";
  return /^没填 .+ 的 key$|^.+ 的 key 不是一串可见字符，重新填一次$|^.+ 不认这个 key$/.test(detail) ? "key" : undefined;
}

/** What one 试一次 found; `message` is always the daemon's own words. */
export const secretTestOutcomeSchema = z.enum(["ok", "auth", "busy", "network", "timeout", "failed"]);
export type SecretTestOutcome = z.infer<typeof secretTestOutcomeSchema>;
