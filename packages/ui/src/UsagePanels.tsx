import type {ReactNode} from 'react';
import type {Agent, JudgeUsageDay} from '@vonvon/protocol';
import {AgentAvatar} from './AgentAvatar';
import {useActiveDevice} from './client-context';
import {placeOf, whereName} from './device-copy';
import {extraWindows, UsageHeatmap, usageDays, usageHiddenFrom, usageWindowLabel} from './management/UsageContent';
import {dayLabel, type JudgeUsageView} from './management/JudgeUsage';
import type {Usage} from './management/usage-data';
import './usage-panels.css';

/** What the share card may leave out; the page shows all of it. */
export type UsagePanelSections = {habits?: boolean; quota?: boolean};
/** `progress` (0..1) shows only the oldest share of the days, for the share card's day-by-day build; the page leaves it
 * at 1. Totals with daily figures add up the shown days, counts without them rise in step, peaks and records stay.
 * `weeks`: the heatmap's, 13 unless the share card has the room of a hidden quota column. */
type PanelProps = {progress?: number; sections?: UsagePanelSections; weeks?: number};
type Profile = Usage['profile'];
type Amount = [value: string, unit: string];

const clamp = (progress: number) => Math.min(1, Math.max(0, progress));
const count = (value: number, digits = 0) => value.toLocaleString('zh-CN', {maximumFractionDigits: digits});
const rise = (value: number, progress: number) => Math.round(value * clamp(progress));
const clock = (at: number) => new Date(at).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit', hour12: false});

/** 亿 and 万 the way people say them, about three significant figures. */
export function tokenAmount(tokens: number): Amount {
  if (tokens >= 1e8) {const value = tokens / 1e8; return [count(value, value < 10 ? 2 : value < 100 ? 1 : 0), '亿'];}
  if (tokens >= 1e4) {const value = tokens / 1e4; return [count(value, value < 10 ? 1 : 0), '万'];}
  return [count(tokens), ''];
}
const withToken = ([value, unit]: Amount): Amount => [value, `${unit} Token`.trim()];
export function durationAmount(seconds: number): Amount {
  const minutes = seconds / 60;
  if (minutes < 60) return [seconds > 0 && minutes < 0.5 ? '<1' : count(Math.round(minutes)), '分钟'];
  const hours = minutes / 60;
  return [count(hours, hours < 10 ? 1 : 0), '小时'];
}
const capital = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
/** claude-opus-4-5-20251101 → Opus 4.5, claude-3-5-sonnet-20241022 → Sonnet 3.5; anything else as it came. */
export function claudeModelName(id: string): string {
  const current = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (current) return `${capital(current[1]!)} ${current[2]}${current[3] ? `.${current[3]}` : ''}`;
  const legacy = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(id);
  return legacy ? `${capital(legacy[3]!)} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ''}` : id;
}
/** The sum of a daily figure over the days a progress still hides. */
function hiddenSum(buckets: Profile['dailyBuckets'], from: string | undefined, pick: (bucket: Profile['dailyBuckets'][number]) => number) {
  return from ? buckets.reduce((sum, bucket) => bucket.date >= from ? sum + pick(bucket) : sum, 0) : 0;
}

type Stat = {label: string; value?: Amount; note?: string | false};
function Stats({items}: {items: Stat[]}) {
  return <dl className="usage-board-stats">{items.map(item => <div key={item.label}>
    <dt>{item.label}</dt>
    <dd data-missing={!item.value || undefined}>{item.value ? <>{item.value[0]}{item.value[1] && <small>{item.value[1]}</small>}</> : '未提供'}</dd>
    {item.note && <dd className="usage-board-note">{item.note}</dd>}
  </div>)}</dl>;
}

const planNames: Record<string, string> = {go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', max: 'Max', claude_ultra: 'Ultra', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
  self_serve_business_usage_based: '按用量计费', enterprise_cbp_usage_based: '按用量计费'};
type Window = NonNullable<Usage['usage']['main']['primary']>;
function QuotaWindow({label, window}: {label: string; window: Window}) {
  const used = Math.round(window.usedPercent);
  const width = Math.max(0, Math.min(100, window.usedPercent));
  const reset = window.resetAt ? new Date(window.resetAt * 1000) : undefined;
  return <div className="usage-board-window" data-high={used >= 90 || undefined}>
    <div className="usage-board-window-line"><span>{label}</span><strong>{used}<small>%</small></strong></div>
    <div className="usage-progress" role="progressbar" aria-label={`${label}已用`} aria-valuenow={width} aria-valuemin={0} aria-valuemax={100}>{width > 0 && <span style={{width: `${width}%`}}/>}</div>
    <small title={reset?.toLocaleString()}>{reset ? `${reset.toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false})} 重置` : '暂未提供重置时间'}</small>
  </div>;
}
/** Plan, read time and every window the account reports; at 90% a window turns to the warning colour. Without quota
 * (API access, no subscription login, a failed read) the daemon's `unavailable` line says why (now-share N2b). */
export function QuotaColumn({usage, brand}: {usage: Usage['usage']; brand: string}) {
  const where = useActiveDevice();
  const gap = usage.unavailable;
  const main = ([[usage.main.primary, '主要限额'], [usage.main.secondary, '额外限额']] as const).map(([window, fallback]) => ({window, label: usageWindowLabel(window?.windowSeconds, fallback)}));
  const windows = [...main.flatMap(({window, label}) => window ? [{label, window}] : []), ...usage.extras.flatMap(extraWindows)];
  const missing = main.filter(item => !item.window).map(item => item.label);
  return <section className="usage-board-side usage-board-quota" aria-label={`${brand} 额度`}>
    <header title={`所有 Bot 共用${placeOf(where)} ${brand} 账号的额度`}>
      <strong>{usage.planType ? `${brand} ${planNames[usage.planType] ?? usage.planType}` : brand}</strong>
      {!gap && <span title={new Date(usage.fetchedAt).toLocaleString()}>读取于 {clock(usage.fetchedAt)}</span>}
    </header>
    {gap ? <p className="usage-board-unavailable" role="status" data-reason={gap.reason}>{gap.message}</p> : <>
      {windows.map(({label, window}, index) => <QuotaWindow key={`${index}-${label}`} label={label} window={window}/>)}
      {missing.length > 0 && <p className="usage-board-unavailable">{`${missing.join('、')}暂不可用`}</p>}
    </>}
  </section>;
}

function Heat({profile, provider, metric = 'tokens', progress, weeks}: {profile: Profile; provider: string; metric?: 'tokens' | 'messages'; progress: number; weeks?: number}) {
  return <div className="usage-board-heat">{profile.dailyBuckets.length || metric === 'messages'
    ? <UsageHeatmap profile={profile} provider={provider} metric={metric} progress={progress} weeks={weeks}/>
    : <p className="usage-board-empty">{`${provider} 暂未提供每日活动记录。`}</p>}</div>;
}
function Board({provider, quota, habits, children}: {provider: string; quota?: ReactNode; habits?: ReactNode; children: ReactNode}) {
  return <div className="usage-board" data-provider={provider}>
    <div className="usage-board-top">{children}{quota}</div>
    {habits}
  </div>;
}

export function CodexUsagePanel({data, progress = 1, sections = {}, weeks}: PanelProps & {data: Usage}) {
  const {profile} = data;
  const hiddenFrom = usageHiddenFrom(usageDays(profile.dailyBuckets, new Date(), 'tokens', weeks), progress);
  const skills = profile.topInvocations.filter(item => item.kind === 'skill').sort((a, b) => b.count - a.count).slice(0, 3);
  const effort = profile.mostUsedEffort, fast = profile.fastModePct;
  const habits = sections.habits !== false && (skills.length > 0 || effort || fast !== undefined) && <div className="usage-board-habits">
    {skills.length > 0 && <span className="usage-board-skills">常用技能{skills.map(skill => <span key={skill.name} title={skill.name}><span>{skill.name}</span><small>{count(skill.count)} 次</small></span>)}</span>}
    <span className="usage-board-facts">
      {effort && <span>推理强度 <b>{effort}</b>{profile.mostUsedEffortPct !== undefined && ` ${Math.round(profile.mostUsedEffortPct)}%`}</span>}
      {fast !== undefined && <span>Fast 模式 <b>{`${Math.round(fast)}%`}</b></span>}
    </span>
  </div>;
  return <Board provider="codex" quota={sections.quota !== false && <QuotaColumn usage={data.usage} brand="Codex"/>} habits={habits}>
    <Stats items={[
      {label: '累计 Token', value: profile.lifetimeTokens === undefined ? undefined : tokenAmount(Math.max(0, profile.lifetimeTokens - hiddenSum(profile.dailyBuckets, hiddenFrom, bucket => bucket.tokens))),
        note: profile.totalThreads !== undefined && `${count(rise(profile.totalThreads, progress))} 个会话`},
      {label: '连续活跃', value: profile.currentStreakDays === undefined ? undefined : [count(profile.currentStreakDays), '天'], note: profile.longestStreakDays !== undefined && `最长 ${count(profile.longestStreakDays)} 天`},
      {label: '峰值单日', value: profile.peakDailyTokens === undefined ? undefined : withToken(tokenAmount(profile.peakDailyTokens))},
      {label: '最长单任务', value: profile.longestTurnSec === undefined ? undefined : durationAmount(profile.longestTurnSec)},
    ]}/>
    <Heat profile={profile} provider="Codex" progress={progress} weeks={weeks}/>
  </Board>;
}
/** Claude Code's own /usage → Stats, which the daemon counts from this device's transcripts (now-share N2). The quota
 * comes from the account and stands on its own while the count is scanning, missing, or from a daemon without it. */
export function ClaudeUsagePanel({data, progress = 1, sections = {}, weeks}: PanelProps & {data: Usage}) {
  const where = useActiveDevice();
  const {profile} = data, stats = profile.localStats;
  const quota = sections.quota !== false && <QuotaColumn usage={data.usage} brand="Claude"/>;
  if (stats?.state !== 'ready') return <Board provider="claude" quota={quota}>
    <p className="usage-board-empty" role="status">{!stats ? '暂无 Claude Code 的使用统计。' : stats.state === 'scanning' ? `正在统计${placeOf(where)}的 Claude Code 记录…` : `${placeOf(where)}没有 Claude Code 的使用记录。`}</p>
  </Board>;
  const buckets = profile.dailyBuckets;
  const hiddenFrom = usageHiddenFrom(usageDays(buckets, new Date(), 'messages', weeks), progress);
  const tokens = (profile.lifetimeTokens ?? stats.models.reduce((sum, model) => sum + model.tokens, 0)) - hiddenSum(buckets, hiddenFrom, bucket => bucket.tokens);
  const messages = stats.messages - hiddenSum(buckets, hiddenFrom, bucket => bucket.messages ?? 0);
  const activeDays = stats.activeDays - hiddenSum(buckets, hiddenFrom, bucket => (bucket.messages ?? 0) > 0 ? 1 : 0);
  const top = stats.models[0];
  return <Board provider="claude" quota={quota} habits={sections.habits !== false && <ClaudeHabits models={stats.models} hours={stats.hourCounts}/>}>
    <Stats items={[
      {label: '累计 Token', value: tokenAmount(Math.max(0, tokens)), note: top && `最常用 ${claudeModelName(top.id)}`},
      {label: '连续活跃', value: profile.currentStreakDays === undefined ? undefined : [count(profile.currentStreakDays), '天'],
        note: [profile.longestStreakDays !== undefined && `最长 ${count(profile.longestStreakDays)} 天`, `共活跃 ${count(Math.max(0, activeDays))} 天`].filter(Boolean).join(' · ')},
      {label: '会话', value: [count(rise(stats.sessions, progress)), '个'], note: `${count(Math.max(0, messages))} 条消息`},
      {label: '最长会话', value: stats.longestSessionSec === undefined ? undefined : durationAmount(stats.longestSessionSec),
        note: stats.longestSessionMessages !== undefined && `${count(stats.longestSessionMessages)} 条消息`},
    ]}/>
    <Heat profile={profile} provider="Claude Code" metric="messages" progress={progress} weeks={weeks}/>
  </Board>;
}
function ClaudeHabits({models, hours}: {models: {id: string; tokens: number}[]; hours?: number[]}) {
  const used = models.filter(model => model.tokens > 0);
  const shown = used.length > 4 ? [...used.slice(0, 3), {id: '其他', tokens: used.slice(3).reduce((sum, model) => sum + model.tokens, 0)}] : used;
  const total = shown.reduce((sum, model) => sum + model.tokens, 0);
  const share = (tokens: number) => tokens / total < .005 ? '<1%' : `${Math.round(tokens / total * 100)}%`;
  const busiest = Math.max(0, ...hours ?? []);
  const peak = hours?.indexOf(busiest) ?? -1;
  if (!total && !busiest) return null;
  return <div className="usage-board-habits">
    {total > 0 && <div className="usage-board-models">
      <div className="usage-board-modelbar" role="img" aria-label={`各模型 Token 占比：${shown.map(model => `${claudeModelName(model.id)} ${share(model.tokens)}`).join('，')}`}>
        {shown.map((model, index) => <i key={model.id} data-shade={index} style={{flexGrow: model.tokens}}/>)}
      </div>
      <ul aria-hidden="true">{shown.map((model, index) => <li key={model.id}><i data-shade={index}/>{claudeModelName(model.id)}<b>{share(model.tokens)}</b></li>)}</ul>
    </div>}
    {busiest > 0 && <div className="usage-board-hours">
      <div className="usage-board-hourbars" role="img" aria-label={`按会话开始时间的 24 小时分布，最常在 ${peak} 点开工`}>
        {hours!.map((sessions, hour) => <i key={hour} data-peak={hour === peak || undefined} data-zero={!sessions || undefined} style={sessions ? {height: `${Math.max(8, sessions / busiest * 100)}%`} : undefined} title={`${hour} 点 · ${count(sessions)} 个会话`}/>)}
      </div>
      <span>最常在 <b>{`${peak} 点`}</b>开工</span>
    </div>}
  </div>;
}

/** Jev is every decision service: native language-model judging is the Provider's own usage, never Jev's. */
const jevCount = (sources: readonly {kind: string; count: number}[] | undefined) => (sources ?? []).reduce((sum, source) => sum + (source.kind === 'decision' ? source.count : 0), 0);
type JevBot = {agentId: string; agentName: string; count: number};
function jevBots(days: readonly JudgeUsageDay[]): JevBot[] {
  const bots = new Map<string, JevBot>();
  for (const day of days) for (const bot of day.bots) {
    const calls = jevCount(bot.sources);
    if (calls) bots.set(bot.agentId, {agentId: bot.agentId, agentName: bot.agentName, count: (bots.get(bot.agentId)?.count ?? 0) + calls});
  }
  return [...bots.values()].sort((a, b) => b.count - a.count || a.agentName.localeCompare(b.agentName));
}
/** Oldest day first. The per-Bot split needs each Bot's sources: an older daemon sends only its sum of every judge, which
 * must not pass for Jev's, and one Bot alone has nothing to compare. Whether it shows does not depend on `progress`. */
export function jevUsage(view: JudgeUsageView, progress = 1) {
  const days = [...view.days].reverse();
  const shown = Math.floor(clamp(progress) * days.length);
  const visible = days.slice(0, shown);
  const daily = days.map((day, index) => ({date: day.date, count: jevCount(day.sources), shown: index < shown}));
  const total = daily.reduce((sum, day) => day.shown ? sum + day.count : sum, 0);
  const busiest = daily.reduce<typeof daily[number] | undefined>((top, day) => day.shown && day.count > (top?.count ?? 0) ? day : top, undefined);
  const split = days.some(day => day.bots.length > 0) && days.every(day => day.bots.every(bot => bot.sources));
  const at = (back: number) => daily[daily.length - 1 - back];
  return {daily, total, busiest, average: days.length ? Math.round(total / days.length) : 0, today: at(0), yesterday: at(1),
    bots: split && jevBots(days).length > 1 ? jevBots(visible) : undefined};
}

export function JevUsagePanel({view, agents = [], asOf, progress = 1, sections = {}}: PanelProps & {view: JudgeUsageView; agents?: readonly Pick<Agent, 'id' | 'avatarDataUrl'>[]; asOf?: number}) {
  const where = useActiveDevice();
  const jev = jevUsage(view, progress);
  const max = Math.max(1, ...jev.daily.map(day => day.count));
  const today = view.days[0]?.date ?? '';
  const visible = (day: {count: number; shown: boolean} | undefined) => day?.shown ? day.count : 0;
  const bots = sections.habits !== false ? jev.bots : undefined;
  const top = Math.max(1, ...bots?.map(bot => bot.count) ?? []);
  return <div className="usage-board" data-provider="jev">
    <div className="usage-board-top">
      <Stats items={[
        {label: '今天判断', value: [count(visible(jev.today)), '次'], note: asOf !== undefined && `截至 ${clock(asOf)}`},
        {label: `${jev.daily.length} 天合计`, value: [count(jev.total), '次'], note: `日均 ${count(jev.average)} 次`},
        {label: '最忙一天', value: [count(jev.busiest?.count ?? 0), '次'], note: jev.busiest && dayLabel(jev.busiest.date, today)},
        {label: '昨天', value: [count(visible(jev.yesterday)), '次'], note: jev.yesterday && dayLabel(jev.yesterday.date, today)},
      ]}/>
      <figure className="usage-board-jev-chart">
        <div role="img" aria-label={`最近 ${jev.daily.length} 天每天的判断次数`}>{jev.daily.map((day, index) => <i key={day.date} data-today={index === jev.daily.length - 1 || undefined}
          data-zero={!day.shown || !day.count || undefined} data-count={day.shown ? count(day.count) : undefined}
          style={{height: day.shown && day.count ? `${day.count / max * 100}%` : undefined}} title={`${dayLabel(day.date, today)} · ${count(day.count)} 次`}/>)}</div>
        <figcaption><span>{jev.daily[0] && dayLabel(jev.daily[0].date, today)}</span><span>今天</span></figcaption>
      </figure>
      {bots && <section className="usage-board-side usage-board-bots" aria-label={`按 Bot，最近 ${jev.daily.length} 天`}>
        <header><strong>{`按 Bot · ${jev.daily.length} 天`}</strong></header>
        {bots.slice(0, 5).map(bot => <div key={bot.agentId} className="usage-board-bot">
          <AgentAvatar agent={agents.find(agent => agent.id === bot.agentId) ?? {}}/><span className="usage-board-bot-name">{bot.agentName}</span><b>{count(bot.count)}</b>
          <span className="usage-progress" aria-hidden="true"><span style={{width: `${bot.count / top * 100}%`}}/></span>
        </div>)}
        {bots.length > 5 && <p className="usage-board-unavailable">{`另有 ${bots.length - 5} 个 Bot，共 ${count(bots.slice(5).reduce((sum, bot) => sum + bot.count, 0))} 次`}</p>}
      </section>}
    </div>
    <p className="usage-board-foot"><span>Jev 在智能群里替 Bot 判断要不要接话，每判断一次记一次</span><span>{`最近 ${jev.daily.length} 天 · 按${where.isRemote ? `${whereName(where)}的` : '本机'}日期`}</span></p>
    {(view.unreadBots > 0 || view.botsUnreadable) && <p className="usage-board-unavailable" role="status">部分 Bot 的判断记录暂时无法读取，没有算进来。</p>}
  </div>;
}
