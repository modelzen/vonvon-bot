/** How the web UI and the CLI write backends, times and percentages (docs/v1-plan.md section 5, 叫法表). */

const BACKEND_LABELS: Readonly<Record<string, string>> = { "codex-appserver": "Codex", "claude-agent": "Claude" };

/** A backend id as the UI names it; an id this build does not know is shown as it is. */
export const backendLabel = (backend: string): string => BACKEND_LABELS[backend] ?? backend;

type Parts = Record<"year" | "month" | "day" | "hour" | "minute", string>;
function partsOf(date: Date, timeZone: string | undefined): Parts {
  const format = new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return Object.fromEntries(format.formatToParts(date).map(part => [part.type, part.value])) as Parts;
}

/**
 * A moment in local time, without seconds: 14:05 today, 10月18日 14:05 this year, 2025年10月18日 14:05 before.
 * Takes milliseconds, an ISO string or a Date; a string that is not a time comes back unchanged.
 * `now` and `timeZone` are for tests.
 */
export function formatTime(value: number | string | Date, options: { now?: number; timeZone?: string } = {}): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "时间未知";
  const at = partsOf(date, options.timeZone);
  const today = partsOf(new Date(options.now ?? Date.now()), options.timeZone);
  const time = `${at.hour}:${at.minute}`;
  if (at.year !== today.year) return `${at.year}年${at.month}月${at.day}日 ${time}`;
  return at.month === today.month && at.day === today.day ? time : `${at.month}月${at.day}日 ${time}`;
}

/** A share in whole percent. Rounding never says 0% for a little or 100% for not quite full. */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  if (rounded === 0 && value > 0) return "<1%";
  if (rounded === 100 && value < 100) return ">99%";
  return `${rounded}%`;
}
