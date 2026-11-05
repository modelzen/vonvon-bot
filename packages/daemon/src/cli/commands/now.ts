import {
  BOT_ACTIVITY_STALE_MS, BOT_LATEST_ACTION_SHOWN_MS,
  type Agent, type BotActivity, type DesktopSnapshot, type GroupAttention,
} from '@vonvon/protocol';
import { NO_BOT, pickBot, print, withDaemon, withoutAvatar, type Daemon, type Io } from '../daemon-client';

/** The web page's words for 此刻 (NowBotList.tsx). */
const PHASE: Record<BotActivity['phase'], string> = {
  processing: '正在处理', thinking: '思考中', tool: '使用工具', responding: '组织回复', compacting: '压缩上下文', waiting: '等待确认', retrying: '正在重试',
};
const TOOL: Record<NonNullable<BotActivity['toolKind']>, string> = { command: '执行命令', file: '读写文件', search: '搜索中', tool: '使用工具' };
const since = (ms: number): string => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} 分钟` : `${Math.floor(ms / 3_600_000)} 小时`;

function groupName(snapshot: DesktopSnapshot, groupId: string): string {
  return snapshot.groups.find(group => group.id === groupId)?.name ?? snapshot.memberships.find(member => member.groupId === groupId)?.name ?? groupId;
}
function activityLine(activity: BotActivity, group: string, now: number): string {
  const label = activity.phase === 'tool' ? `${TOOL[activity.toolKind ?? 'tool']}${(activity.activeToolCount ?? 0) > 1 ? `（${activity.activeToolCount} 个）` : ''}` : PHASE[activity.phase];
  // the last heartbeat, as the web page; a daemon without heartbeats has only the last phase change
  const stuck = now - (activity.observedAt ?? activity.updatedAt) >= BOT_ACTIVITY_STALE_MS ? '（可能卡住了）' : '';
  return `  ${group}：${label}（${since(now - activity.startedAt)}）${stuck}`;
}
function attentionText(attention: GroupAttention, now: number): string | undefined {
  const parts: string[] = [];
  if (attention.group) parts.push(`群注意力 ${attention.group.score}/100（${attention.group.score === 100 ? '短批查看' : `间隔 ${since(attention.group.intervalMs)}`}）`);
  else parts.push('群注意力暂不可用');
  if (attention.budget && attention.budget.until > now) parts.push(attention.budget.kind === 'named-only' ? '判断额度满了，只看直接找它的' : '判断额度满了，暂缓查看');
  return parts.length ? parts.join('、') : undefined;
}

/** One bot's part of `now`, empty when it does nothing; an older daemon without diagnostics shows nothing. */
function botView(agent: Agent, snapshot: DesktopSnapshot, now: number) {
  const diagnostics = agent.running ? agent.diagnostics : undefined;
  const activities = [...diagnostics?.activities ?? []].sort((a, b) => b.updatedAt - a.updatedAt);
  const attention = diagnostics?.attention ?? [];
  const latest = diagnostics?.latestAction && now - diagnostics.latestAction.at < BOT_LATEST_ACTION_SHOWN_MS ? diagnostics.latestAction : undefined;
  const lines = activities.map(activity => activityLine(activity, groupName(snapshot, activity.groupId), now));
  const attending = attention.flatMap(each => { const text = attentionText(each, now); return text ? [`${groupName(snapshot, each.groupId)} ${text}`] : []; });
  if (attending.length) lines.push(`  注意力：${attending.join('；')}`);
  if (latest) lines.push(`  刚刚：在 ${groupName(snapshot, latest.groupId)} ${latest.kind === 'replied' ? '回复了' : '记了一条记忆'}`);
  return {
    lines: lines.length ? [`${agent.name}（${agent.id}）`, ...lines] : [],
    json: { id: agent.id, name: agent.name, activities, attention, ...(latest ? { latestAction: latest } : {}), decisions: diagnostics?.decisions ?? [] },
  };
}

/** `vonvon now` (cli-8-machine): what each bot does this moment and where its attention is, the web page's 此刻. */
export async function runNow(wanted: string | undefined, io: Io, daemon: Daemon = withDaemon, now: () => number = Date.now): Promise<void> {
  const snapshot = await daemon(call => call('读取快照', c => c.snapshot()));
  const agents = wanted === undefined ? snapshot.agents : [pickBot(snapshot.agents, wanted)];
  const views = agents.map(agent => botView(agent, snapshot, now()));
  const human = views.flatMap(view => view.lines);
  print(io, agents.length ? human.length ? human : ['都闲着。'] : [NO_BOT], { bots: views.map(view => view.json) });
}

/**
 * `vonvon snapshot` (cli-8-machine): the web page's whole state. --json prints it, without the avatars' data URLs;
 * a terminal gets a summary.
 */
export async function runSnapshot(io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const snapshot = await daemon(call => call('读取快照', c => c.snapshot()));
  const problems = [
    ...snapshot.stale ? ['状态可能过期了'] : [],
    ...snapshot.application.crashes?.paused ? ['daemon 已暂停'] : [],
    ...snapshot.agents.flatMap(agent => agent.readError ? [`${agent.name} 的配置读不了`] : agent.paused ? [`${agent.name} 已暂停`]
      : agent.enabled && agent.connection !== 'connected' ? [`${agent.name} 没连上飞书`] : []),
  ];
  const human = [
    `daemon ${snapshot.application.version} · ${snapshot.agents.length} 个 Bot · ${snapshot.memberships.length} 个群`,
    problems.length ? `问题：${problems.join('；')}` : '没有发现问题。',
    '完整内容加 --json。',
  ];
  print(io, human, { snapshot: { ...snapshot, agents: snapshot.agents.map(withoutAvatar), groups: snapshot.groups.map(withoutAvatar), memberships: snapshot.memberships.map(withoutAvatar) } });
}
