import {RefreshCw} from 'lucide-react';
import {useEffect, useMemo, useState} from 'react';
import type {AdminReply, AdminRequest, JudgeUsageDay} from '@vonvon/protocol';
import {useActiveDevice, useClient} from '../client-context';
import {whereName} from '../device-copy';
import {IconButton} from '../reference/components/ui';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {settingAnchor} from '../search';
import {errorText} from './secretsModel';
import './judge-usage.css';

export type JudgeUsageView = Extract<AdminReply, {kind: 'judgeUsage'}>;
export type JudgeUsageRead = {kind: 'loading'} | {kind: 'ready'; view: JudgeUsageView; problem?: string} | {kind: 'failed'; problem: string};
export function dayLabel(date: string, today: string): string {
  const [year, month, day] = date.split('-');
  return `${year === today.slice(0, 4) ? '' : `${year}年`}${Number(month)}月${Number(day)}日${date === today ? '（今天）' : ''}`;
}
const sourceLabel = (source: JudgeUsageDay['sources'][number]) => source.kind === 'decision' && source.id === 'typesafe' ? 'Jev' : source.label;
export function sourcesText(day: JudgeUsageDay): string {
  return day.sources.map(source => `${source.kind === 'llm' ? '语言模型' : '决策模型'} ${sourceLabel(source)} ${source.count} 次`).join(' · ');
}
export function judgeSourceTotals(days: readonly JudgeUsageDay[]) {
  const totals = new Map<string, {key: string; label: string; today: number; total: number}>();
  days.forEach((day, index) => day.sources.forEach(source => {
    const key = `${source.kind}:${source.id}`;
    const total = totals.get(key) ?? {key, label: sourceLabel(source), today: 0, total: 0};
    total.total += source.count;
    if (index === 0) total.today += source.count;
    totals.set(key, total);
  }));
  return [...totals.values()].filter(source => source.total > 0).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
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
export function JudgeUsageRows({read, onRead, compact = false, disabled = false}: {read: JudgeUsageRead; onRead: () => void; compact?: boolean; disabled?: boolean}) {
  const where = useActiveDevice();
  const view = read.kind === 'ready' ? read.view : undefined;
  const bots = botTotals(view?.days ?? []);
  const sources = judgeSourceTotals(view?.days ?? []);
  const empty = view && !view.unreadBots && !view.botsUnreadable && view.days.every(day => day.total === 0);
  const logNote = '原因在诊断页底部的 daemon 日志（judge usage-unreadable）。';
  const dailyRows = view?.days.filter((day, index) => index === 0 || day.total > 0).map(day => <SettingsRow key={day.date}
    title={dayLabel(day.date, view.days[0]?.date ?? day.date)} value={`${day.total} 次`}
    description={empty ? '只有智能群会判断。' : sourcesText(day)}/>);
  return <SettingsGroup id={settingAnchor('智能模式的判断次数')} label="智能模式的判断次数"
    action={!compact && <IconButton size="sm" variant="ghost" label="重新读取" title="重新读取判断次数" disabled={disabled} onClick={onRead}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>}
    footer={<details className="usage-counting-note"><summary>最近 14 天 · 按{where.isRemote ? `${whereName(where)}的` : '本机'}日期统计</summary><p>计入已发起的调用，包括连接失败。不计入缺少密钥、冷却期或达到小时上限而跳过的判断；数据可能延迟几秒。</p></details>}>
    {disabled && <SettingsRow title="连接恢复后更新判断次数" description={view ? '当前为上次读取的数据。' : undefined}/>}
    {!disabled && read.kind === 'loading' && <SettingsRow title="正在读取判断次数"/>}
    {read.kind === 'failed' && <SettingsRow title="判断次数读取失败" description={read.problem}/>}
    {read.kind === 'ready' && read.problem && <SettingsRow title="判断次数读取失败" description={read.problem}/>}
    {compact && sources.length ? <>
      {sources.map(source => <SettingsRow key={source.key} title={source.label} value={<span className="judge-source-counts">
        <span><small>今天</small><strong>{source.today.toLocaleString('zh-CN')}</strong><small>次</small></span>
        <span><small>14 天</small><strong>{source.total.toLocaleString('zh-CN')}</strong><small>次</small></span>
      </span>}/>)}
      <details className="usage-details judge-daily-details"><summary>每日记录</summary>{dailyRows}</details>
    </> : dailyRows}
    {view && view.unreadBots > 0 && <SettingsRow title={`有 ${view.unreadBots} 个 Bot 的判断次数读不了`} description={logNote}/>}
    {view?.botsUnreadable && <SettingsRow title="Bot 列表读不了，判断次数都没算进来" description="原因在诊断页底部的 daemon 日志（judge usage-bots-unreadable）。"/>}
    {bots.length > 0 && <details className={`usage-details${compact ? ' judge-daily-details' : ''}`}><summary>按 Bot 看</summary>
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
/** Reads now and every `refreshInterval` ms while the page is visible; `readAt` is when the last good read landed. */
export function useJudgeUsage({disabled = false, refreshInterval = 0}: {disabled?: boolean; refreshInterval?: number} = {}) {
  const client = useClient();
  const [read, setRead] = useState<JudgeUsageRead>({kind: 'loading'});
  const [readAt, setReadAt] = useState<number>();
  const reader = useMemo(() => judgeUsageReader(request => client.admin(request), next => {
    setRead(next);
    if (next.kind === 'ready' && !next.problem) setReadAt(Date.now());
  }), [client]);
  useEffect(() => {
    if (disabled) return;
    let active = true, running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (!active || running || (refreshInterval > 0 && document.hidden)) return;
      running = true;
      await reader.read();
      running = false;
      if (active && refreshInterval > 0) timer = setTimeout(() => void refresh(), refreshInterval);
    };
    const visible = () => {if (!document.hidden) {clearTimeout(timer); void refresh();}};
    if (refreshInterval > 0) document.addEventListener('visibilitychange', visible);
    void refresh();
    return () => {active = false; clearTimeout(timer); reader.stop(); document.removeEventListener('visibilitychange', visible);};
  }, [reader, disabled, refreshInterval]);
  return {read, readAt, reread: () => void reader.read()};
}
export function JudgeUsageGroup({compact = false, disabled = false, refreshInterval = 0}: {compact?: boolean; disabled?: boolean; refreshInterval?: number}) {
  const {read, reread} = useJudgeUsage({disabled, refreshInterval});
  return <JudgeUsageRows read={read} onRead={reread} compact={compact} disabled={disabled}/>;
}
