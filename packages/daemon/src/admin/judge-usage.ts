import { backendLabel, type AdminReply, type JudgeUsageDay } from '@vonvon/protocol';
import { loadBots } from '../config/bots';
import { botPaths } from '../config/paths';
import { log } from '../core/logger';
import { decisionProvider } from '../judge/decision';
import { JudgeUsageUnreadable, localDayBefore, readJudgeUsage } from '../judge/usage';

export const JUDGE_USAGE_SHOWN_DAYS = 14;
export async function judgeUsageView(opts: { now?: number; read?: typeof readJudgeUsage } = {}): Promise<Extract<AdminReply, { kind: 'judgeUsage' }>> {
  const now = opts.now ?? Date.now();
  const days: JudgeUsageDay[] = Array.from({ length: JUDGE_USAGE_SHOWN_DAYS }, (_, n) => ({ date: localDayBefore(now, n), total: 0, sources: [], bots: [] }));
  let registry;
  try { registry = await loadBots(); }
  catch (error) {
    log.warn('judge', 'usage-bots-unreadable', { reason: (error instanceof Error ? error.message : String(error)).split('\n')[0] });
    return { kind: 'judgeUsage', days, unreadBots: 0, botsUnreadable: true };
  }
  let unreadBots = 0;
  for (const bot of registry.bots) {
    let usage;
    try { usage = await (opts.read ?? readJudgeUsage)(botPaths(bot.appId).judgeUsageFile); }
    catch (error) {
      unreadBots++;
      log.warn('judge', 'usage-unreadable', { agentId: bot.appId, ...(error instanceof JudgeUsageUnreadable ? { code: error.code, newer: error.newer } : {}) });
      continue;
    }
    for (const day of days) {
      let count = 0;
      for (const [key, value] of Object.entries(usage[day.date] ?? {})) {
        if (!value) continue;
        const kind = key.startsWith('llm:') ? 'llm' : 'decision';
        const id = key.slice(key.indexOf(':') + 1);
        const source = day.sources.find(s => s.kind === kind && s.id === id);
        if (source) source.count += value;
        else day.sources.push({ kind, id, label: kind === 'llm' ? backendLabel(id) : decisionProvider(id)?.displayName ?? id, count: value });
        count += value;
      }
      if (count) day.bots.push({ agentId: bot.appId, agentName: bot.botName || bot.name, count });
      day.total += count;
    }
  }
  for (const day of days) {
    day.sources.sort((a, b) => a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'llm' ? -1 : 1);
    day.bots.sort((a, b) => b.count - a.count);
  }
  return { kind: 'judgeUsage', days, unreadBots };
}
