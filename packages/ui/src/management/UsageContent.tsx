import {useId, useState, type ReactNode} from 'react';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import type {Usage} from './usage-data';
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
  return <section className="usage-account" aria-label={`${provider} 当前用量`}>
      <header className="usage-account-heading">
        <div className="usage-account-identity"><strong>{provider}</strong><span>{profile?.displayName || '当前账号'}</span>{data?.usage.planType && <small>{data.usage.planType}</small>}</div>
        {data && <span className="usage-read-time" title={new Date(data.usage.fetchedAt).toLocaleString()}>读取于 {new Date(data.usage.fetchedAt).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit', hour12: false})}</span>}
      </header>
      <p className="usage-account-note">所有 Bot 共用本机 {provider} 账号的用量</p>
      {data ? <>
        <div className="usage-quota-grid">
          {data.usage.main.primary && <UsageQuota label={primaryLabel} window={data.usage.main.primary}/>}
          {data.usage.main.secondary && <UsageQuota label={secondaryLabel} window={data.usage.main.secondary}/>}
        </div>
        {(!data.usage.main.primary || !data.usage.main.secondary) && <p className="usage-quota-unavailable">{[!data.usage.main.primary && primaryLabel, !data.usage.main.secondary && secondaryLabel].filter(Boolean).join('、')}暂不可用</p>}
        {data.usage.extras.map((item, index) => <SettingsRow key={`${item.name ?? '额外限额'}-${index}`} title={item.name || '额外限额'} value={`${windowValue(item.primary)}；${windowValue(item.secondary)}`}/>)}
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
export function usageDays(buckets: Usage['profile']['dailyBuckets'], today = new Date()) {
  const day = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const start = day - ((new Date(day).getUTCDay() + 6) % 7 + 12 * 7) * DAY;
  const daily = new Map(buckets.filter(item => Number.isFinite(item.tokens) && item.tokens >= 0).map(item => [item.date, item.tokens]));
  const cells = Array.from({length: 91}, (_, index) => {
    const at = start + index * DAY, date = new Date(at).toISOString().slice(0, 10);
    return {date, tokens: daily.get(date), future: at > day};
  });
  const max = Math.max(0, ...cells.filter(cell => !cell.future).map(cell => cell.tokens ?? 0));
  return cells.map(cell => ({...cell, level: cell.tokens === undefined ? -1 : cell.tokens === 0 || max === 0 ? 0 : Math.min(4, Math.ceil(cell.tokens / max * 4))}));
}

/** The settings heatmap, with missing history and keyboard inspection preserved. */
export function UsageHeatmap({profile, provider = 'Codex'}: {profile: Profile; provider?: string}) {
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const captionId = useId();
  const cells = usageDays(profile.dailyBuckets);
  const last = cells.reduce((index, cell, current) => cell.future ? index : current, 0);
  const active = hover ?? focus;
  const selected = active === null ? undefined : cells[active];
  if (!profile.dailyBuckets.length) return <SettingsRow title="每日用量" description={`${provider} 暂未提供每日活动记录。`}/>;
  return <div className="usage-heatmap" aria-label="最近十三周每日 Token 用量">
    <div className="usage-heatmap__grid" tabIndex={0} role="group" aria-label={`${provider} 每日 Token 用量，方向键查看日期`} aria-describedby={captionId}
      onMouseLeave={() => setHover(null)} onFocus={() => setFocus(last)} onBlur={() => setFocus(null)} onKeyDown={event => {
        const delta: Record<string, number> = {ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1};
        if (delta[event.key] !== undefined) {event.preventDefault(); setHover(null); setFocus(index => Math.max(0, Math.min(last, (index ?? last) + delta[event.key]!)));}
      }}>
      {cells.map((cell, index) => <span key={cell.date} className={`usage-cell usage-cell--${cell.level < 0 ? 'unknown' : cell.level}`} data-future={cell.future} data-selected={index === active} aria-hidden="true"
        title={cell.future ? undefined : `${cell.date} · ${cell.tokens === undefined ? '暂无数据' : `${amount(cell.tokens)} Token`}`} onMouseEnter={() => {if (!cell.future) setHover(index);}}/>)}
    </div>
    <span className="usage-heatmap__hint" id={captionId} aria-live="polite">{selected ? `${selected.date} · ${selected.tokens === undefined ? '暂无数据' : `${amount(selected.tokens)} Token`}` : '最近十三周 · 悬停查看每日用量'}</span>
  </div>;
}
