/** Compact local date for recent conversations; invalid timestamps never break the page. */
export function conversationTime(value: number, now = Date.now()): {label: string; dateTime: string; title: string} | null {
  const date = new Date(value);
  if (!Number.isFinite(value) || !Number.isFinite(date.getTime())) return null;
  const current = new Date(now);
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const label = day === today.getTime()
    ? date.toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit', hour12: false})
    : day === yesterday.getTime() ? '昨天'
    : `${date.getFullYear() === current.getFullYear() ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`;
  return {label, dateTime: date.toISOString(), title: date.toLocaleString('zh-CN')};
}
