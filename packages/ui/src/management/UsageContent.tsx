import {useId, useState, type ReactNode} from 'react';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import type {Usage} from './usage-data';
import {useActiveDevice} from '../client-context';
import {whereName} from '../device-copy';
import './usage.css';

type Profile = Usage['profile'];

function amount(value: number | undefined) {
  return value === undefined ? "未提供" : value.toLocaleString("zh-CN");
}

export function usageWindowLabel(seconds: number | undefined, fallback: string) {
  if (!seconds) return fallback;
  if (seconds % 86400 === 0) return `${seconds / 86400} 天限额`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时限额`;
  return `${Math.round(seconds / 60)} 分钟限额`;
}

type UsageWindow = NonNullable<Usage['usage']['main']['primary']>;
/** An extra limit may report only one window (Claude's per-model weekly ones): each window is a "<name> 7 天限额" of its own. */
export function extraWindows(item: Usage['usage']['extras'][number]): {label: string; window: UsageWindow}[] {
  const name = item.name || '额外限额';
  return ([[item.primary, '主要限额'], [item.secondary, '额外限额']] as const)
    .flatMap(([window, fallback]) => window ? [{label: `${name} ${usageWindowLabel(window.windowSeconds, fallback)}`, window}] : []);
}

function windowValue(window: { usedPercent: number; resetAt?: number } | undefined) {
  if (!window) return "暂不可用";
  const reset = window.resetAt ? ` · ${new Date(window.resetAt * 1000).toLocaleString()} 重置` : "";
  return `已用 ${window.usedPercent}%${reset}`;
}

function profileStats(profile: Profile) {
  return [
    { label: "累计 Token", value: amount(profile.lifetimeTokens) },
    { label: "峰值单日 Token", value: amount(profile.peakDailyTokens) },
    { label: "当前连续天数", value: profile.currentStreakDays === undefined ? "未提供" : `${profile.currentStreakDays} 天` },
    { label: "最长连续天数", value: profile.longestStreakDays === undefined ? "未提供" : `${profile.longestStreakDays} 天` },
    { label: "最长单任务", value: profile.longestTurnSec === undefined ? "未提供" : `${Math.round(profile.longestTurnSec / 60)} 分钟` },
  ];
}


export function UsageAccount({data, provider = 'Codex', children}: {data?: Usage; provider?: string; children?: ReactNode}) {
  const profile = data?.profile;
  const primaryLabel = usageWindowLabel(data?.usage.main.primary?.windowSeconds, '主要限额');
  const secondaryLabel = usageWindowLabel(data?.usage.main.secondary?.windowSeconds, '额外限额');
  const where = useActiveDevice();
  return <section className="usage-account" aria-label={`${provider} 当前用量`}>
      <header className="usage-account-heading">
        <div className="usage-account-identity"><strong>{provider}</strong><span>{profile?.displayName || '当前账号'}</span>{data?.usage.planType && <small>{data.usage.planType}</small>}</div>
        {data && <span className="usage-read-time" title={new Date(data.usage.fetchedAt).toLocaleString()}>读取于 {new Date(data.usage.fetchedAt).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit', hour12: false})}</span>}
      </header>
      <p className="usage-account-note">所有 Bot 共用{where.isRemote ? `${whereName(where)}上` : '本机'} {provider} 账号的用量</p>
      {data ? <>
        <div className="usage-quota-grid">
          {data.usage.main.primary && <UsageQuota label={primaryLabel} window={data.usage.main.primary}/>}
          {data.usage.main.secondary && <UsageQuota label={secondaryLabel} window={data.usage.main.secondary}/>}
        </div>
        {(!data.usage.main.primary || !data.usage.main.secondary) && <p className="usage-quota-unavailable">{[!data.usage.main.primary && primaryLabel, !data.usage.main.secondary && secondaryLabel].filter(Boolean).join('、')}暂不可用</p>}
        {data.usage.extras.flatMap((item, index) => {
          const windows = extraWindows(item);
          return windows.length ? windows.map(({label, window}) => <SettingsRow key={`${index}-${label}`} title={label} value={windowValue(window)}/>)
            : [<SettingsRow key={index} title={item.name || '额外限额'} value={windowValue(undefined)}/>];
        })}
      </> : null}
      {children}
    </section>;
}

export function UsageProfile({profile, provider = 'Codex', showDetails = true}: {profile: Profile; provider?: string; showDetails?: boolean}) {
  return <>
      <SettingsGroup label="每日活动"><div className="usage-activity">
        <UsageHeatmap profile={profile} provider={provider}/>
        <dl className="usage-activity-stats">
          <div><dt>累计 Token</dt><dd>{amount(profile.lifetimeTokens)}</dd></div>
          <div><dt>连续活跃</dt><dd>{profile.currentStreakDays === undefined ? '未提供' : `${profile.currentStreakDays} 天`}</dd></div>
        </dl>
      </div></SettingsGroup>
      {showDetails && <details className="usage-details"><summary>详细统计</summary>
      <SettingsGroup label="活动统计" footer={profile.statsAsOf ? `统计截至 ${profile.statsAsOf}` : undefined}>
        {profileStats(profile).map(item => <SettingsRow key={item.label} title={item.label} value={item.value} />)}
        <SettingsRow title="会话总数" value={amount(profile.totalThreads)} />
        <SettingsRow title="技能调用总数" value={amount(profile.totalSkillsUsed)} />
        <SettingsRow title="不同技能数" value={amount(profile.uniqueSkillsUsed)} />
        <SettingsRow title="Fast Mode 占比" value={profile.fastModePct === undefined ? "未提供" : `${Math.round(profile.fastModePct)}%`} />
        <SettingsRow title="常用推理强度" value={profile.mostUsedEffort ? `${profile.mostUsedEffort}${profile.mostUsedEffortPct === undefined ? "" : ` · ${Math.round(profile.mostUsedEffortPct)}%`}` : "未提供"} />
        {profile.topInvocations.map(item => <SettingsRow key={`${item.kind}:${item.name}`} title={`${item.kind === "plugin" ? "插件" : "技能"} · ${item.name}`} value={`${amount(item.count)} 次`} />)}
      </SettingsGroup>
      </details>}
  </>;

}

export function UsageQuota({label, window}: {label: string; window: {usedPercent: number; resetAt?: number}}) {
  const used = Math.round(window.usedPercent);
  const progress = Math.max(0, Math.min(100, window.usedPercent));
  const reset = window.resetAt ? new Date(window.resetAt * 1000) : undefined;
  return <section className="usage-quota" aria-label={label}>
    <div className="usage-quota-line"><span>{label}</span><strong>{used}<small>% 已用</small></strong></div>
    <div className="usage-progress" role="progressbar" aria-label={`${label}已用`} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span style={{width: `${progress}%`}}/></div>
    <span className="usage-reset" title={reset?.toLocaleString()}>{reset ? `${reset.toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false})} 重置` : '暂未提供重置时间'}</span>
  </section>;
}


const DAY = 86_400_000;
export type UsageMetric = 'tokens' | 'messages';
type Buckets = Usage['profile']['dailyBuckets'];
/** Claude Code's /usage heatmap grades a day by the p25/p50/p75 of all its active days' messages. */
function messageLevel(buckets: Buckets) {
  const counts = buckets.map(item => item.messages ?? 0).filter(count => count > 0).sort((a, b) => a - b);
  const [p25 = 0, p50 = 0, p75 = 0] = [.25, .5, .75].map(share => counts[Math.floor(counts.length * share)]);
  return (count: number) => count <= 0 ? 0 : count >= p75 ? 4 : count >= p50 ? 3 : count >= p25 ? 2 : 1;
}
/** `weeks` whole weeks from a Monday, this week last; the share card asks for more where it has the room. */
export function usageDays(buckets: Buckets, today = new Date(), metric: UsageMetric = 'tokens', weeks = 13) {
  const day = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const start = day - ((new Date(day).getUTCDay() + 6) % 7 + (weeks - 1) * 7) * DAY;
  const daily = new Map(buckets.flatMap(item => {
    const value = metric === 'tokens' ? item.tokens : item.messages;
    return value !== undefined && Number.isFinite(value) && value >= 0 ? [[item.date, value] as const] : [];
  }));
  // Local transcripts are complete, so a day without messages had none; gaps in the account's history stay unknown.
  const cells = Array.from({length: weeks * 7}, (_, index) => {
    const at = start + index * DAY, date = new Date(at).toISOString().slice(0, 10);
    return {date, value: daily.get(date) ?? (metric === 'messages' ? 0 : undefined), future: at > day};
  });
  const max = Math.max(0, ...cells.filter(cell => !cell.future).map(cell => cell.value ?? 0));
  const grade = metric === 'messages' ? messageLevel(buckets) : (value: number) => value === 0 || max === 0 ? 0 : Math.min(4, Math.ceil(value / max * 4));
  return cells.map(cell => ({...cell, level: cell.value === undefined ? -1 : grade(cell.value)}));
}

/** The first past day a progress (0..1) still hides: the share card fills the oldest days first. None at 1. */
export function usageHiddenFrom(cells: readonly {date: string; future: boolean}[], progress = 1): string | undefined {
  const past = cells.filter(cell => !cell.future);
  return past[Math.floor(Math.min(1, Math.max(0, progress)) * past.length)]?.date;
}

const metricCopy = {tokens: {unit: 'Token', daily: '每日 Token', label: '每日 Token 用量'}, messages: {unit: '条消息', daily: '每日消息', label: '每日消息数'}};
/** The settings heatmap, with missing history and keyboard inspection preserved. Hidden days (progress) read as empty
 * while the grading keeps the whole range, so colours do not shift as days fill in. */
export function UsageHeatmap({profile, provider = 'Codex', metric = 'tokens', progress = 1, weeks = 13}: {profile: Profile; provider?: string; metric?: UsageMetric; progress?: number; weeks?: number}) {
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const captionId = useId();
  const all = usageDays(profile.dailyBuckets, new Date(), metric, weeks);
  const hiddenFrom = usageHiddenFrom(all, progress);
  const cells = hiddenFrom ? all.map(cell => cell.date >= hiddenFrom && !cell.future ? {...cell, level: Math.min(cell.level, 0)} : cell) : all;
  const last = cells.reduce((index, cell, current) => cell.future ? index : current, 0);
  const active = hover ?? focus;
  const selected = active === null ? undefined : cells[active];
  const copy = metricCopy[metric];
  const dayText = (cell: {date: string; value?: number}) => `${cell.date} · ${cell.value === undefined ? '暂无数据' : `${amount(cell.value)} ${copy.unit}`}`;
  if (!profile.dailyBuckets.length && metric === 'tokens') return <SettingsRow title="每日用量" description={`${provider} 暂未提供每日活动记录。`}/>;
  return <div className="usage-heatmap" aria-label={`最近 ${weeks} 周${copy.label}`}>
    <div className="usage-heatmap__grid" tabIndex={0} role="group" aria-label={`${provider} ${copy.label}，方向键查看日期`} aria-describedby={captionId}
      onMouseLeave={() => setHover(null)} onFocus={() => setFocus(last)} onBlur={() => setFocus(null)} onKeyDown={event => {
        const delta: Record<string, number> = {ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1};
        if (delta[event.key] !== undefined) {event.preventDefault(); setHover(null); setFocus(index => Math.max(0, Math.min(last, (index ?? last) + delta[event.key]!)));}
      }}>
      {cells.map((cell, index) => <span key={cell.date} className={`usage-cell usage-cell--${cell.level < 0 ? 'unknown' : cell.level}`} data-future={cell.future} data-selected={index === active} aria-hidden="true"
        title={cell.future ? undefined : dayText(cell)} onMouseEnter={() => {if (!cell.future) setHover(index);}}/>)}
    </div>
    <div className="usage-heatmap__caption">
      <span className="usage-heatmap__hint" id={captionId} aria-live="polite">{selected ? dayText(selected) : `${copy.daily} · 最近 ${weeks} 周`}</span>
      <span className="usage-heatmap__legend" aria-hidden="true">少{[0, 1, 2, 3, 4].map(level => <i key={level} className={`usage-cell usage-cell--${level}`}/>)}多</span>
    </div>
  </div>;
}
