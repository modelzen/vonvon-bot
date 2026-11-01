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
 * Nothing, an empty string and 0 are "no time" (the daemon writes 0 for never), never 1970.
 * `now` and `timeZone` are for tests.
 */
export function formatTime(value: number | string | Date | null | undefined, options: { now?: number; timeZone?: string } = {}): string {
  if (value === null || value === undefined || value === "") return "时间未知";
  const date = new Date(value);
  if (date.getTime() === 0) return "时间未知";
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

/** What 移除本地 Bot asks the owner to confirm, on the web page and in `vonvon bot remove`: what goes (counted) and what
 * stays with the projects (§5.2). `memories` is the Bot's own active entries; left out when they cannot be read. */
export function deleteAgentDescription(name: string, bindings: number, memories: number | undefined): string {
  const counted = [`${bindings} 个群绑定`, ...(memories === undefined ? [] : [`${memories} 条 Bot 记忆`])].join("、");
  return `将移除「${name}」的本地注册信息、凭据、${counted}、设置和会话记录。项目的记忆和工作区属于项目，不会删。飞书开发者平台中的应用不会删除。请确认这个 Bot 已停用并停止运行。`;
}

/** devices 第 15 节, word for word: said where a group gets 完全访问, such as `vonvon group create` (a group the Bot makes
 * is full access, devices 5.3). U2 replaces it with `TierInfo.warning`; this is the one place to change then. */
export const FULL_ACCESS_WARNING = "完全访问的群里，群成员能让 Bot 在这台设备上做任何事，包括改 vonvon 的设置，只给信任的群用。";
