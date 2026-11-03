import type { Agent, CollaborationReply, Membership } from '@vonvon/protocol';
import { badArgs, CommandError } from '../command-error';
import { localTime, pickGroup, print, printable, runningBot, toolLabel, withDaemon, type Call, type Daemon, type Io } from '../daemon-client';

/**
 * `vonvon session …` (cli-4-sessions): the web page's 会话管理 of one group. Every request goes to the bot's process,
 * so the bot must be running (`runningBot`, exit 4 `bot_not_running`, not the daemon's 5 "conflict").
 */
type Reply<K extends CollaborationReply['kind']> = Extract<CollaborationReply, { kind: K }>;
type History = Reply<'history'>;
type Session = History['sessions'][number];
type Context = Reply<'context'>;
type Run = NonNullable<Context['run']>;
type Target = { agentId: Agent['id']; projectName: string; groupId: Membership['groupId'] };
export type GroupOptions = { group: string; bot?: string };
export type SessionOptions = GroupOptions & { session?: string };

/** The bot and group a command acts in; `again(…)` is a command line for the same group, with --bot when it is needed. */
export type GroupAt = { agent: Agent; membership: Membership; target: Target; again: (command: string) => string };

export async function groupAt(call: Call, options: GroupOptions): Promise<GroupAt> {
  const snapshot = await call('读取快照', c => c.snapshot());
  const agent = runningBot(snapshot.agents, options.bot);
  const membership = pickGroup(snapshot.memberships, agent, options.group);
  const bot = snapshot.agents.length > 1 ? ` --bot ${agent.id}` : '';
  return {
    agent, membership, target: { agentId: agent.id, projectName: membership.name, groupId: membership.groupId },
    again: command => `vonvon ${command}${bot} --group ${membership.groupId}`,
  };
}

/** The reply asked for; the daemon's own refusal is exit 4 with its code, as `bot` does (cli-2-bot notDone). */
export function answer<K extends CollaborationReply['kind']>(what: string, reply: CollaborationReply, kind: K): Reply<K> {
  if (reply.kind === kind) return reply as Reply<K>;
  if (reply.kind === 'refused') throw new CommandError('refused', reply.message, { reason: reply.code });
  throw new CommandError('failed', `${what}没有完成：daemon 回了意外的结果（${reply.kind}）。`);
}

/** The provider lists the resumable sessions, which can be slow: the Feishu tier, and a read's timeout is exit 3. */
const readHistory = async (call: Call, at: GroupAt): Promise<History> =>
  answer('读取会话', await call('读取会话', c => c.collaboration({ action: 'history', ...at.target }), { feishu: true }), 'history');
const readContext = async (call: Call, at: GroupAt, session: Session): Promise<Context> =>
  answer('读取会话状态', await call('读取会话状态', c => c.collaboration({ action: 'context', ...at.target, threadId: session.threadId })), 'context');
const title = (session: Session): string => printable(session.summary) || '未命名会话';

/**
 * The session a command acts on (4.2 第 1 条): the one --session names, or else the group's only live session, the
 * web page's 当前会话. Several (a 多会话 group's topics) are listed for --session, never guessed.
 */
async function sessionOf(call: Call, at: GroupAt, wanted?: string): Promise<Session> {
  const live = (await readHistory(call, at)).sessions.filter(session => session.chatId === at.membership.groupId && !session.detached);
  if (wanted !== undefined) {
    const found = live.find(session => session.threadId === wanted);
    if (!found) throw badArgs(`这个群没有会话 ${wanted}。${at.again('session list')} 列出全部。`);
    return found;
  }
  const [only] = live;
  if (!only) throw new CommandError('bad-args', '这个群还没有会话。', { reason: 'no_session' });
  if (live.length > 1) throw badArgs([`这个群有 ${live.length} 条会话，用 --session 指定一条：`, ...live.map(session => `${session.threadId}  ${title(session)}`)].join('\n'));
  return only;
}

/** `session context` for the same session, to look after a write whose outcome is unknown. */
const lookAt = (at: GroupAt, session: Session, options: SessionOptions): string =>
  at.again(options.session === undefined ? 'session context' : `session context --session ${session.threadId}`);

type Applied = Reply<'applied'>;
/** What a write said: the daemon's own words first (the web page shows them too), then its warning on a Feishu receipt. */
function appliedLines(reply: Applied, done: string): string[] {
  return [reply.message || done, ...reply.warning ? [`飞书回执未确认：${reply.warning}`] : []];
}
const appliedJson = (reply: Applied) => ({ ...reply.message ? { message: reply.message } : {}, ...reply.warning ? { warning: reply.warning } : {} });

export async function runSessionList(options: GroupOptions & { resumable?: boolean }, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const { at, history } = await daemon(async call => {
    const at = await groupAt(call, options);
    return { at, history: await readHistory(call, at) };
  });
  const human = ['群里的会话：'];
  for (const session of history.sessions) human.push(`  ${session.threadId}  ${title(session)}  ${toolLabel(session.backend)}  更新于 ${localTime(session.updatedAt)}${session.detached ? '（已归档）' : ''}`);
  if (!history.sessions.length) human.push('  还没有会话。');
  if (options.resumable) {
    // As the web page's 可恢复: a provider session already bound here (and not archived) is not offered again.
    const resumable = history.threads.filter(thread => !history.sessions.some(bound => !bound.detached && bound.sessionId === thread.sessionId));
    human.push('可以接上的会话：');
    // The provider's times are in seconds.
    for (const thread of resumable) human.push(`  ${thread.sessionId}  ${printable(thread.name || thread.preview) || '旧会话'}  更新于 ${localTime(thread.updatedAt * 1000)}`);
    if (history.threadsError) human.push(`  读不到可以接上的会话：${history.threadsError}`);
    else if (!resumable.length) human.push('  没有。');
    if (resumable.length) human.push(`接上：${at.again('session resume <sessionId>')}`);
  }
  print(io, human, { backend: history.backend, sessions: history.sessions, threads: history.threads, ...history.threadsError ? { threadsError: history.threadsError } : {} });
}

const SUBAGENT_STATUS: Record<NonNullable<Run['subagents']>[number]['status'], string> = { running: '运行中', completed: '已完成', failed: '失败', stopped: '已停止' };
const amount = (value: number): string => value.toLocaleString('en-US');

/** 上下文 used / window (percent), as the web page's 当前会话, then what runs and the commands that act on it. */
function contextLines(context: Context, at: GroupAt, session: Session, picked: boolean): string[] {
  const { usage, run } = context;
  const lines = [`会话 ${session.threadId}  ${title(session)}`];
  if (!usage) lines.push('上下文：暂无可用统计');
  else if (typeof usage.window === 'number' && Number.isFinite(usage.window) && usage.window > 0) lines.push(`上下文 ${amount(usage.used)} / ${amount(usage.window)}（${Math.round(usage.used / usage.window * 100)}%）`);
  else lines.push(`上下文 ${amount(usage.used)} · 窗口未知`);
  if (!run) { lines.push('现在没有在跑的任务。'); return lines; }
  const again = (command: string) => at.again(picked ? `${command} --session ${session.threadId}` : command);
  lines.push(`正在运行：${run.goal ? '自主目标' : '当前任务'}`);
  for (const subagent of run.subagents ?? []) {
    lines.push(`  子 agent ${subagent.id}  ${printable(subagent.name)}  ${SUBAGENT_STATUS[subagent.status]}`);
    if (subagent.status === 'running' && subagent.stoppable) lines.push(`    停止它：${again(`session stop-subagent ${subagent.id}`)}`);
  }
  lines.push(`完成时提醒：${run.reminderRequested ? '已开启' : '未开启'}`);
  if (run.canStop) lines.push(`停止任务：${again('session stop')}`);
  if (run.canEndGoal) lines.push(`结束目标：${again('session end-goal')}`);
  if (run.canRemind) lines.push(`${run.reminderRequested ? '关闭' : '开启'}提醒：${again(`session reminder ${run.reminderRequested ? '--off' : '--on'}`)}`);
  return lines;
}

export async function runSessionContext(options: SessionOptions, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const { at, session, context } = await daemon(async call => {
    const at = await groupAt(call, options);
    const session = await sessionOf(call, at, options.session);
    return { at, session, context: await readContext(call, at, session) };
  });
  print(io, contextLines(context, at, session, options.session !== undefined), { threadId: context.threadId, usage: context.usage, run: context.run });
}

/** 清空 and 压缩 (4.2 第 4、5 条): both start or talk to a provider session and post a receipt in Feishu, so the Feishu tier. */
export async function runSessionReset(action: 'clear' | 'compact', options: SessionOptions, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const what = action === 'clear' ? '清空会话' : '压缩上下文';
  const { session, reply } = await daemon(async call => {
    const at = await groupAt(call, options);
    // The web page's button is off for 多会话 (its topics have no main-area session to start over): no request.
    if (action === 'clear' && at.membership.conversation === 'threads') throw new CommandError('refused', '多会话支持压缩上下文；清空仅适用于主区会话。', { reason: 'not_for_threads' });
    const session = await sessionOf(call, at, options.session);
    const unknown = `${action === 'clear' ? '可能已经清空' : '可能已经在压缩'}，运行 ${lookAt(at, session, options)} 看。`;
    const reply = await call(what, c => c.collaboration({ action, ...at.target, threadId: session.threadId }), { feishu: true, unknown });
    return { session, reply: answer(what, reply, 'applied') };
  });
  print(io, appliedLines(reply, action === 'clear' ? '已开始新会话。' : '上下文已压缩。'), { threadId: reply.threadId ?? session.threadId, ...appliedJson(reply) });
}

/** 接上 (4.2 第 6 条): a provider session from `session list --resumable`, with the backend the history named, as the web page sends it. */
export async function runSessionResume(sessionId: string, options: GroupOptions, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const reply = await daemon(async call => {
    const at = await groupAt(call, options);
    const history = await readHistory(call, at);
    if (history.sessions.some(bound => !bound.detached && bound.sessionId === sessionId)) throw badArgs('这条会话已经接在群里了。');
    if (!history.threads.some(thread => thread.sessionId === sessionId)) {
      if (history.threadsError) throw new CommandError('failed', `读不到可以接上的会话：${history.threadsError}`);
      throw badArgs(`这个群没有可以接上的会话 ${sessionId}。${at.again('session list --resumable')} 列出。`);
    }
    const unknown = `可能已经接上，运行 ${at.again('session list')} 看。`;
    return answer('接上会话', await call('接上会话', c => c.collaboration({ action: 'resume', ...at.target, sessionId, backend: history.backend }), { feishu: true, unknown }), 'applied');
  });
  print(io, appliedLines(reply, '已恢复会话。'), { ...reply.threadId ? { threadId: reply.threadId } : {}, ...appliedJson(reply) });
}

type RunAction = 'stop' | 'endGoal';
/**
 * 停止 and 结束目标 (4.2 第 7 条): read the run first, for its id and whether the web page's button is on. Nothing running is
 * exit 0 (`stopped: false`): what the user wanted is so. A run that ends between the read and the write is the daemon's say.
 */
export async function runSessionStop(action: RunAction, options: SessionOptions, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const what = action === 'stop' ? '停止任务' : '结束目标';
  const result = await daemon(async call => {
    const at = await groupAt(call, options);
    const session = await sessionOf(call, at, options.session);
    const { run } = await readContext(call, at, session);
    if (!run) return undefined;
    if (action === 'stop' && !run.canStop) throw new CommandError('refused', '任务还在准备，现在停不了，稍后再试。', { reason: 'cannot_stop' });
    if (action === 'endGoal' && !run.canEndGoal) throw new CommandError('refused', `在跑的不是自主目标，没有目标可以结束。要停下它，运行 ${at.again('session stop')}。`, { reason: 'cannot_end_goal' });
    const unknown = `${action === 'stop' ? '可能已经停了' : '目标可能已经结束'}，运行 ${lookAt(at, session, options)} 看。`;
    const reply = answer(what, await call(what, c => c.collaboration({ action, ...at.target, threadId: session.threadId, runId: run.id }), { unknown }), 'applied');
    return { runId: run.id, reply };
  });
  const flag = action === 'stop' ? 'stopped' : 'ended';
  if (!result) return print(io, ['现在没有在跑的任务。'], { [flag]: false });
  print(io, appliedLines(result.reply, action === 'stop' ? '已请求停止任务。' : '已结束目标。'), { [flag]: true, runId: result.runId, ...appliedJson(result.reply) });
}

/** 停止子 agent (4.2 第 8 条): only one the web page offers a button for, running and stoppable. */
export async function runSessionStopSubagent(subagentId: string, options: SessionOptions, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const result = await daemon(async call => {
    const at = await groupAt(call, options);
    const session = await sessionOf(call, at, options.session);
    const { run } = await readContext(call, at, session);
    const cannot = (message: string) => new CommandError('refused', message, { reason: 'cannot_stop_subagent' });
    if (!run) throw cannot('现在没有在跑的任务。');
    const subagent = run.subagents?.find(each => each.id === subagentId);
    if (!subagent) throw cannot(`在跑的任务里没有子 agent ${subagentId}。运行 ${lookAt(at, session, options)} 看有哪些。`);
    if (subagent.status !== 'running') throw cannot(`子 agent ${subagentId} ${SUBAGENT_STATUS[subagent.status]}。`);
    if (!subagent.stoppable) throw cannot(`子 agent ${subagentId} 不能单独停止。`);
    const unknown = `可能已经停了，运行 ${lookAt(at, session, options)} 看。`;
    const reply = answer('停止子 agent', await call('停止子 agent', c => c.collaboration({ action: 'stopSubagent', ...at.target, threadId: session.threadId, runId: run.id, subagentId }), { unknown }), 'applied');
    return { runId: run.id, reply };
  });
  print(io, appliedLines(result.reply, '已请求停止子 agent。'), { runId: result.runId, subagentId, ...appliedJson(result.reply) });
}

/**
 * 完成时提醒 (4.2 第 9 条): nothing running is exit 4, unlike stop: the user asked for a reminder and got none. Sent even
 * when it is so already; the daemon sets it, which is idempotent.
 */
export async function runSessionReminder(switches: { on?: boolean; off?: boolean }, options: SessionOptions, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  if (Boolean(switches.on) === Boolean(switches.off)) throw badArgs('--on 和 --off 选一个：--on 开启完成时提醒，--off 关闭。');
  const requested = Boolean(switches.on);
  const result = await daemon(async call => {
    const at = await groupAt(call, options);
    const session = await sessionOf(call, at, options.session);
    const { run } = await readContext(call, at, session);
    if (!run) throw new CommandError('refused', '现在没有在跑的任务，完成时提醒只对在跑的任务有用。', { reason: 'cannot_remind' });
    if (!run.canRemind) throw new CommandError('refused', '这个任务不能设完成时提醒：只有你自己发起、开着手动提醒的任务可以设，自主目标不行。', { reason: 'cannot_remind' });
    const unknown = `可能已经改了，运行 ${lookAt(at, session, options)} 看。`;
    const reply = await call('设置完成时提醒', c => c.collaboration({ action: 'reminder', ...at.target, threadId: session.threadId, runId: run.id, requested }), { unknown });
    return { runId: run.id, reply: answer('设置完成时提醒', reply, 'applied') };
  });
  print(io, appliedLines(result.reply, requested ? '已开启提醒。' : '已关闭提醒。'), { runId: result.runId, requested, ...appliedJson(result.reply) });
}
