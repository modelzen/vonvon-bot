import {useEffect, useMemo, useState} from 'react';
import type {AdminReply, AdminRequest, JudgeUsageDay} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {Button} from '../reference/components/ui';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {settingAnchor} from '../search';
import {errorText} from './secretsModel';

export type JudgeUsageView = Extract<AdminReply, {kind: 'judgeUsage'}>;
export type JudgeUsageRead = {kind: 'loading'} | {kind: 'ready'; view: JudgeUsageView; problem?: string} | {kind: 'failed'; problem: string};
export function dayLabel(date: string, today: string): string {
  const [year, month, day] = date.split('-');
  return `${year === today.slice(0, 4) ? '' : `${year}年`}${Number(month)}月${Number(day)}日${date === today ? '（今天）' : ''}`;
}
export function sourcesText(day: JudgeUsageDay): string {
  return day.sources.map(source => `${source.kind === 'llm' ? '语言模型' : '决策模型'} ${source.label} ${source.count} 次`).join(' · ');
}
export function botTotals(days: readonly JudgeUsageDay[]) {
  const totals = new Map<string, {agentId: string; agentName: string; today: number; total: number}>();
  days.forEach((day, index) => day.bots.forEach(bot => {
    const total = totals.get(bot.agentId) ?? {agentId: bot.agentId, agentName: bot.agentName, today: 0, total: 0};
    total.total += bot.count;
    if (index === 0) total.today += bot.count;
    totals.set(bot.agentId, total);
  }));
  return [...totals.values()].filter(bot => bot.total > 0).sort((a, b) => b.total - a.total || a.agentName.localeCompare(b.agentName));
}
export function JudgeUsageRows({read, onRead}: {read: JudgeUsageRead; onRead: () => void}) {
  const view = read.kind === 'ready' ? read.view : undefined;
  const bots = botTotals(view?.days ?? []);
  const empty = view && !view.unreadBots && !view.botsUnreadable && view.days.every(day => day.total === 0);
  const logNote = '原因在状态与诊断页底部的 daemon 日志（judge usage-unreadable）。';
  return <SettingsGroup id={settingAnchor('智能模式的判断次数')} label="智能模式的判断次数"
    action={<Button size="sm" onClick={onRead}>重新读取</Button>}
    footer="按这台电脑的日期算，最近 14 天。发起了调用的才算一次（连不上也算）；没填 key、冷却中、到了每小时上限没判断的不算。最多晚几秒。">
    {read.kind === 'loading' && <SettingsRow title="正在读取判断次数"/>}
    {read.kind === 'failed' && <SettingsRow title="判断次数读取失败" description={read.problem}/>}
    {read.kind === 'ready' && read.problem && <SettingsRow title="判断次数读取失败" description={read.problem}/>}
    {view?.days.filter((day, index) => index === 0 || day.total > 0).map(day => <SettingsRow key={day.date}
      title={dayLabel(day.date, view.days[0]?.date ?? day.date)} value={`${day.total} 次`}
      description={empty ? '只有智能群会判断。' : sourcesText(day)}/>)}
    {view && view.unreadBots > 0 && <SettingsRow title={`有 ${view.unreadBots} 个 Bot 的判断次数读不了`} description={logNote}/>}
    {view?.botsUnreadable && <SettingsRow title="Bot 列表读不了，判断次数都没算进来" description="原因在状态与诊断页底部的 daemon 日志（judge usage-bots-unreadable）。"/>}
    {bots.length > 0 && <details className="usage-details"><summary>按 Bot 看</summary>
      {bots.map(bot => <SettingsRow key={bot.agentId} title={bot.agentName} value={`今天 ${bot.today} 次 · 14 天 ${bot.total} 次`}/>)}
    </details>}
  </SettingsGroup>;
}
export function judgeUsageReader(admin: (request: AdminRequest) => Promise<AdminReply>, publish: (read: JudgeUsageRead) => void) {
  let latest = 0;
  let stopped = false;
  let current: JudgeUsageRead = {kind: 'loading'};
  return {
    async read() {
      stopped = false;
      const asked = ++latest;
      let next: JudgeUsageRead;
      try {
        const reply = await admin({type: 'judgeUsage'});
        next = reply.kind === 'judgeUsage' ? {kind: 'ready', view: reply} : {kind: 'failed', problem: 'daemon 回的不是判断次数'};
      } catch (error) { next = {kind: 'failed', problem: errorText(error)}; }
      if (asked !== latest || stopped) return;
      current = next.kind === 'failed' && current.kind === 'ready' ? {...current, problem: next.problem} : next;
      publish(current);
    },
    stop() { stopped = true; ++latest; },
  };
}
export function JudgeUsageGroup() {
  const client = useClient();
  const [read, setRead] = useState<JudgeUsageRead>({kind: 'loading'});
  const reader = useMemo(() => judgeUsageReader(request => client.admin(request), setRead), [client]);
  useEffect(() => { void reader.read(); return () => reader.stop(); }, [reader]);
  return <JudgeUsageRows read={read} onRead={() => void reader.read()}/>;
}
