import { z } from "zod";

/** How a daemon or bot process ended without being asked to (product.md 3.10). The daemon keeps the records in
 * `crash/` with its own zod 4 schema; these are the kinds, the texts and the snapshot's view of them. */
export const CRASH_KINDS = ["exception", "rejection", "fatal", "forced"] as const;
export type CrashKind = (typeof CRASH_KINDS)[number];
export const CRASH_KIND_TEXT: Record<CrashKind, string> = {
  exception: "程序出错", rejection: "程序出错（未处理的异步错误）", fatal: "出错退出", forced: "被系统强制结束",
};
export const FORCED_DETAIL = "（kill -9、内存不够，或者关机、注销时没来得及退出）";
/** 3 crashes in 10 minutes: the whole daemon (`application.crashes.paused`) or one bot (`agents[].paused`). */
export const crashPauseSchema = z.object({ since: z.number(), crashes: z.number().int().positive() });
export type CrashPause = z.infer<typeof crashPauseSchema>;
/** One record of the last 24 hours, newest first; a bot's carries its `appId`. Not strict, and the daemon trims the list
 * to 20, so a newer daemon's extra field or entry never fails a client's whole snapshot. */
export const crashEntrySchema = z.object({
  at: z.number(), kind: z.enum(CRASH_KINDS), appId: z.string().optional(),
  uptimeMs: z.number().int().nonnegative().optional(), paused: z.boolean().optional(), reason: z.string(),
});
export type CrashEntry = z.infer<typeof crashEntrySchema>;
export const applicationCrashesSchema = z.object({ paused: crashPauseSchema.optional(), records: z.array(crashEntrySchema) });
export type ApplicationCrashes = z.infer<typeof applicationCrashesSchema>;

export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/** `程序出错：TypeError: x，运行了 3 分 12 秒`. A forced end found at the next start has the last heartbeat (every 60 s) as
 * its uptime, a lower bound and none in the first minute; one the supervisor saw names the signal and its exact uptime. */
export function crashText(entry: { kind: CrashKind; reason: string; uptimeMs?: number | undefined; paused?: boolean | undefined }): string {
  const signal = entry.kind === "forced" && /^SIG[A-Z0-9]+$/.test(entry.reason);
  const what = entry.kind !== "forced" ? `${CRASH_KIND_TEXT[entry.kind]}：${entry.reason}`
    : `${CRASH_KIND_TEXT.forced}${signal ? `（${entry.reason}）` : FORCED_DETAIL}`;
  const lowerBound = entry.kind === "forced" && !signal;
  const shown = entry.uptimeMs !== undefined && (!lowerBound || entry.uptimeMs >= 1000);
  const ran = shown ? `，运行了${lowerBound ? "至少" : ""} ${formatUptime(entry.uptimeMs ?? 0)}` : "";
  return `${what}${ran}${entry.paused ? "（暂停期间）" : ""}`;
}
