import { randomBytes } from 'node:crypto';
import type { AgentEntry, AgentThread, AgentToolReply } from '../types';
import { log } from '../../core/logger';
import { actorOf, decideAdd, decideEdit, decisionMessages, ownDm, type MemoryPlace, type MemoryTurn, type RequestedScope } from '../../bot/memory-authority';
import { scheduleRefusalMessages, type ScheduleActor } from '../../admin/schedule-commands';
import type { MemoryLanding, SessionAction, SessionAuthz } from '../../admin/ipc';
import { sessionInfoTool, TOOL_RESULT_BYTES, ToolRefusal, type AgentTool, type ToolContext } from './tools';

export interface AgentPlace { kind: 'group' | 'p2p' | 'doc'; chatId?: string; docId?: string }
export interface TurnFacts {
  feedback?: import('./feedback-tool').FeedbackSource;
  requesterOpenId?: string;
  requesterKind?: 'user' | 'bot' | 'unknown';
  triggerMessageId?: string;
  retry: boolean;
  initiative: boolean;
  wake: boolean;
  /** 触发消息是本人手打的 text/post，不是合并转发、卡片、附件（记忆的出处核对用，§3.2 第 3 条） */
  typed?: boolean;
  /** 触发消息正文，没经过引用、转发、记录块的编织（记忆的出处核对用，§3.2 第 4 条） */
  triggerText?: string;
  /** 定时任务的无人回合（T2 的 `runScheduled` 填）：在场算 `scheduled`，记忆回合按 `initiative` 算 */
  scheduled?: { taskId: string; runId: string };
  /** 发起人的名字，建任务时记成创建人（总设计 7.2 的 `{creator}`） */
  requesterName?: string;
  /** 私聊发起人的 union_id：open_id 按应用分，要让别的 Bot 拉这个人进群时用它（dm-agent 6.4） */
  requesterUnionId?: string;
  /** 这一轮在群里的位置，任务工具调用时才读（`launchRun` 的闭包；bot 开的话题认领后才有 id） */
  where?(): TurnWhere;
}
/** 主区 `{ inTopic: false }`；话题里 `inTopic`，话题 id 认领前没有（总设计第 3 节钥匙 2） */
export interface TurnWhere { inTopic: boolean; topicId?: string }
/** 这一轮有没有人在场：真人发起的 `human`；定时任务自己的运行 `scheduled`；bot、唤醒、主动、重试 `none`（总设计第 8 节） */
export type TurnPresence = 'human' | 'scheduled' | 'none';
/** 隐藏块在 `done` 前要用的这一轮的事实：现取，不是开轮时的快照 */
export interface TurnMemory { turn(): MemoryTurn | undefined; place: AgentPlace; triggerMessageId?: string }
/** 开轮时定下的这一轮：`presence`、`scheduled` 不随插话变（插话看 `steered`） */
export interface TurnScope { readonly sessionId?:string; readonly id: number; readonly presence: TurnPresence; readonly scheduled?: { taskId: string; runId: string }; close(): void }
export interface AgentEntries {
  issue(place: AgentPlace): AgentEntry;
  openTurn(thread: AgentThread, facts: TurnFacts): TurnScope;
  /** 这一轮对记忆的事实（`memoryTurn()` 一调就绑定当前这一轮）；线程不是这个 daemon 发过入口的返回 undefined */
  memoryTurn(thread: AgentThread): TurnMemory | undefined;
  noteSteer(thread: AgentThread, sender: { openId?: string; kind: 'user' | 'bot' | 'unknown' }): void;
  /** Every session of this private chat ends now, its token with it (dm-agent 3.3): an admin was removed. A session still starting goes too. */
  revokeChat(chatId: string): void;
  /**
   * devices-4b 4.2: a Bot session's ★ request from its command line, judged for the session's current turn by the same
   * checks as the tools' (authorizeNow, authorizeMemory, authorizeSchedule, `ctx.admin`). Changes nothing but a dead
   * session's grant (revoked) and a bot-memory write's quota of the turn.
   */
  authorizeSessionCall(sessionId: string, action: SessionAction): Promise<SessionAuthz>;
  closeAll(reason: 'shutdown'): void;
}
type Failure = Extract<AgentToolReply, { ok: false }>;
type Reason = NonNullable<Failure['reason']>;
/**
 * A settings write outside a private chat: the tools' refusal, and the daemon's to a Bot session's command line (devices
 * 5.2). The owner's words (2026-11-02, settings-dm-only).
 */
export const NOT_DM_MESSAGE = '群里不能改设置。私聊我可以改，也可以在 Vonvon Bot 客户端或命令行里改。';
/** The same refusal in a document comment's session (s1b): it is not a group. */
export const NOT_DM_COMMENT_MESSAGE = '评论里不能改设置。私聊我可以改，也可以在 Vonvon Bot 客户端或命令行里改。';
/** The not-dm sentence of a place: a comment's own, every other place's the group's. */
export const notDmMessage = (place: 'group' | 'dm' | 'comment' | AgentPlace['kind']): string => place === 'comment' || place === 'doc' ? NOT_DM_COMMENT_MESSAGE : NOT_DM_MESSAGE;
/** devices 15, 这一轮已结束: a Bot session's command line called when no turn of its session is going (or its Bot process is gone). */
export const SESSION_TURN_ENDED = '这次调用对应的那一轮对话已经结束，不能再改设置。';
/** A session's call is not tied to a tool use: a turn not known, ended or a session gone all read as the turn having ended. */
const ENDED = new Set(['revoked', 'unknown-origin', 'turn-ended']);
const messages = {
  'not-ready': 'vonvon 还没准备好这条会话的工具，稍后再试。',
  revoked: '这条会话的 vonvon 工具已经失效（会话结束了，或者 daemon 重启过）。不要重试，接着做别的。',
  'unknown-tool': '没有这个工具。',
  'not-dm': NOT_DM_MESSAGE,
  'not-human-turn': '这一轮不是管理员发消息直接触发的，也不是管理员建的私聊定时任务，不能改设置。',
  'turn-ended': '发起这次改动的那一轮已经结束了，不能改设置。请对方重新说一遍。',
  'unknown-origin': 'vonvon 认不出这次改动是哪一轮发起的，不能改设置。请对方重新说一遍。',
  'not-admin': '只有管理员发消息触发的那一轮，或者管理员建的私聊定时任务，能改设置。',
  'not-group': scheduleRefusalMessages['not-group'],
  'no-human-create': scheduleRefusalMessages['no-human-create'],
  'scheduled-run-scope': scheduleRefusalMessages['scheduled-run-scope'],
  busy: 'vonvon 手上的事太多，稍后再试。',
  timeout: 'vonvon 这一步超时了。',
  failed: 'vonvon 这一步出错了。',
};
/** The schedule tools' own sentences for the two above that talk about settings. */
const scheduleTurnMessages = {
  'unknown-origin': 'vonvon 认不出这次操作是哪一轮发起的，任务没有动。请对方重新说一遍。',
  'turn-ended': '发起这次操作的那一轮已经结束了，任务没有动。请对方重新说一遍。',
};
function failure(code: Exclude<Failure['code'], 'refused' | 'bad-args'>): Failure {
  return { ok: false, code, message: messages[code] };
}
function refused(reason: Reason): Failure {
  return { ok: false, code: 'refused', reason, message: messages[reason] };
}
/** A settings write outside a private chat, in its place's words. */
function notDm(place: AgentPlace): Failure {
  return { ...refused('not-dm'), message: notDmMessage(place.kind) };
}
function scheduleRefused(reason: keyof typeof scheduleTurnMessages): Failure {
  return { ok: false, code: 'refused', reason, message: scheduleTurnMessages[reason] };
}
/** The document tools' own sentences for the same two. */
const feishuTurnMessages = {
  'unknown-origin': 'vonvon 认不出这次操作是哪一轮发起的，文档没有动。请对方重新说一遍。',
  'turn-ended': '发起这次操作的那一轮已经结束了，文档没有动。请对方重新说一遍。',
};
function feishuRefused(reason: keyof typeof feishuTurnMessages): Failure {
  return { ok: false, code: 'refused', reason, message: feishuTurnMessages[reason] };
}
/** feishu_api's own sentences: nothing here is about settings or a document. */
const feishuApiMessages = {
  'unknown-origin': 'vonvon 认不出这次调用是哪一轮发起的，没有调飞书。请对方重新说一遍。',
  'turn-ended': '发起这次调用的那一轮已经结束了，没有调飞书。请对方重新说一遍。',
  'not-human-turn': '这一轮不是管理员发消息或管理员的定时任务触发的，不能调飞书接口。',
  'not-admin': '只有管理员的私聊能调飞书接口。',
};
function feishuApiRefused(reason: keyof typeof feishuApiMessages): Failure {
  return { ok: false, code: 'refused', reason, message: feishuApiMessages[reason] };
}
interface TurnAuth {
  id: number;
  facts: TurnFacts;
  feedbackSteer: AbortController;
  human: boolean;
  /** 开轮时的事实：这一轮是谁触发的（记忆的 `turn.kind`），不随插话变 */
  kind: MemoryTurn['kind'];
  /** 开轮时推导，不随插话变：先看 `facts.scheduled`，再看 `kind === 'human'` */
  presence: TurnPresence;
  /** 被不是触发人的人插过话（`noteSteer`），记忆写入据此降级 */
  steered: boolean;
  /** 这一轮写进 Bot 记忆的条数，含正在写的（一轮一条） */
  botWrites: number;
  active: boolean;
  controller: AbortController;
}
interface Grant {
  phase: 'pending' | 'attached' | 'revoked' | 'capacity';
  place: AgentPlace;
  /** devices 5.3: the session's id, which its token in the host names (`ses_` + 16 hex). */
  sessionId: string;
  /** The host was told this session ended: once, whichever way it ends. */
  sessionEnded: boolean;
  thread?: AgentThread;
  turn?: TurnAuth;
  /** The turn before `turn`; its origins outlive `pruneOrigins`. */
  previous?: TurnAuth;
  origins: Map<string, TurnAuth | undefined>;
  /**
   * Ids no longer noted, oldest first, the last {@link PRUNED_IDS}: those `pruneOrigins` dropped and those refused while
   * the map was full. A late copy is not noted under a later turn, and its call reads turn-ended.
   */
  pruned: Set<string>;
  controller: AbortController;
  active: number;
  settingRunning: boolean;
  queue: Array<() => void>;
}
const PRUNED_IDS = 1024;
/** A tool kept to some places (the settings reads, a private chat's) is neither listed nor called elsewhere. */
const placed = (tool: AgentTool, place: AgentPlace): boolean => !tool.places || tool.places.includes(place.kind);
/** What a tool takes in this place: a private chat's may be wider (dm-agent 7.3). */
const inputAt = (tool: AgentTool, place: AgentPlace): AgentTool['input'] => place.kind === 'p2p' ? tool.dmInput ?? tool.input : tool.input;
export function createAgentEntries(opts: {
  appId: string;
  isAdmin(openId: string): boolean;
  tools?: readonly AgentTool[];
  feedbackEnabled?(chatId: string): boolean;
  /** devices-4a 4.3: told once when a session ends, so the host drops its token (best effort: it never throws). */
  sessions?: { revoke(sessionId: string): void };
  /** devices-4b 4.5: a turn's place for memory (the memory writer's own), where a session's command-line write lands. */
  memoryPlace?(turn: Pick<MemoryTurn, 'chatId' | 'place'>): Promise<MemoryPlace>;
}): AgentEntries {
  const tools = opts.tools ?? [sessionInfoTool];
  const table = new Map(tools.map(tool => [tool.name, tool]));
  if (table.size !== tools.length || tools.some(tool => !/^[a-z][a-z0-9_]{0,40}$/.test(tool.name))) {
    throw new Error('Invalid agent tool registry');
  }
  const grants = new Set<Grant>();
  const threads = new WeakMap<AgentThread, Grant>();
  let nextTurn = 0;
  let shuttingDown = false;
  function end(auth: TurnAuth | undefined) {
    if (!auth) return;
    auth.active = false;
    auth.controller.abort();
  }
  /**
   * At capacity, origins of ended turns go: they cannot authorize anything, and a long-lived session (a recurring task
   * keeps a single-session group's main session open) would otherwise refuse every later turn's calls as unknown-origin. The turn
   * before this one keeps its own; if that turn alone filled the map, the turn after this one gets room. A dropped id
   * goes to `pruned` (see {@link forget}).
   */
  function pruneOrigins(grant: Grant) {
    for (const [id, auth] of grant.origins) {
      if (auth && (auth === grant.turn || auth === grant.previous)) continue;
      grant.origins.delete(id);
      forget(grant, id);
    }
  }
  /**
   * An id that will not be noted again: a late copy of it (streamed, then in the full message) is not noted under the
   * turn of the moment, and its call reads turn-ended, while it is among the last {@link PRUNED_IDS} forgotten.
   */
  function forget(grant: Grant, id: string) {
    grant.pruned.add(id);
    if (grant.pruned.size > PRUNED_IDS) grant.pruned.delete(grant.pruned.values().next().value!);
  }
  function revoke(grant: Grant) {
    grant.phase = 'revoked';
    end(grant.turn);
    grant.controller.abort();
    grant.origins.clear();
    grant.pruned.clear();
    grants.delete(grant);
    if (grant.sessionEnded) return;
    grant.sessionEnded = true;
    try { opts.sessions?.revoke(grant.sessionId); }
    catch (error) { log.fail('agent', error, { phase: 'session-revoke', sessionId: grant.sessionId }); }
  }
  /**
   * dm-agent 6.3: whether a private chat's turn, going, may do what the permission table lets it. An admin's own message,
   * or a task of this private chat as its creator: the same rights (owner 2026-11-05). The creator is on the turn's facts;
   * one no longer an admin has had the task paused (3.3), so this only catches a run already on its way.
   */
  function dmTurn(auth: TurnAuth): Failure | undefined {
    if (!auth.human && auth.presence !== 'scheduled') return refused('not-human-turn');
    if (!opts.isAdmin(auth.facts.requesterOpenId ?? '')) return refused('not-admin');
  }
  function authorizeNow(grant: Grant, auth: TurnAuth | undefined): Failure | undefined {
    if (grant.thread && !grant.thread.isAlive()) revoke(grant);
    if (grant.phase === 'revoked') return failure('revoked');
    if (grant.place.kind !== 'p2p') return notDm(grant.place);
    if (!auth) return refused('unknown-origin');
    if (!auth.active || grant.turn !== auth) return refused('turn-ended');
    return dmTurn(auth);
  }
  /** 记忆类工具的授权：不要求人、角色，只要求入口还活着、这一轮还在进行；人不人、什么角色只影响落点（§3.2） */
  function authorizeMemory(grant: Grant, auth: TurnAuth | undefined): Failure | undefined {
    if (grant.thread && !grant.thread.isAlive()) revoke(grant);
    if (grant.phase === 'revoked') return failure('revoked');
    if (grant.place.kind === 'doc') return failure('unknown-tool');
    if (!auth) return refused('unknown-origin');
    if (!auth.active || grant.turn !== auth) return refused('turn-ended');
  }
  function authorizeFeedback(grant: Grant, auth: TurnAuth | undefined): Failure | undefined {
    const refusal = authorizeMemory(grant, auth);
    const source = auth?.facts.feedback;
    if (refusal || !auth?.human || auth.feedbackSteer.signal.aborted || !source || grant.place.kind !== 'group'
      || !opts.feedbackEnabled?.(source.chatId) || source.chatId !== grant.place.chatId || source.openId !== auth.facts.requesterOpenId || source.messageId !== auth.facts.triggerMessageId) {
      return { ...(refusal ?? refused('not-human-turn')), message: '这次调用没有对应的本人群消息。请在原群重新发起反馈。' };
    }
  }
  /**
   * schedule 类的授权（3.13 的表、总设计第 8 节"在场"）：这一层先查，拒绝不进命令核；命令核按 actor 再查一遍，
   * 成员能不能碰别人的任务、跨群的 id 只有命令核看得到。
   */
  function authorizeSchedule(grant: Grant, auth: TurnAuth | undefined, action: AgentTool['action'], taskId: unknown): Failure | undefined {
    if (grant.thread && !grant.thread.isAlive()) revoke(grant);
    if (grant.phase === 'revoked') return failure('revoked');
    if (grant.place.kind === 'doc') return refused('not-group');
    if (!auth) return scheduleRefused('unknown-origin');
    if (!auth.active || grant.turn !== auth) return scheduleRefused('turn-ended');
    if (grant.place.kind === 'p2p') return dmTurn(auth);
    if (action === 'list') return undefined;
    if (auth.steered || auth.presence === 'none') return { ...refused('not-human-turn'), message: scheduleRefusalMessages['not-human-turn'] };
    if (auth.presence !== 'scheduled') return undefined;
    if (action === 'create') return refused('no-human-create');
    if ((action !== 'edit' && action !== 'delete') || taskId !== auth.facts.scheduled?.taskId) return refused('scheduled-run-scope');
  }
  /**
   * 文档这一列的工具（dm-agent 7.2、7.4）：入口活着、这一轮还在。谁能做看位置：评论 @bot 进来之前已经查过管理员，群和私聊的
   * 范围在工具里守（`mayRead`、`mayEdit`）。群和私聊的读不走这里（`turnBound`），改文档和评论会话走。
   */
  function authorizeFeishu(grant: Grant, auth: TurnAuth | undefined): Failure | undefined {
    if (grant.thread && !grant.thread.isAlive()) revoke(grant);
    if (grant.phase === 'revoked') return failure('revoked');
    if (!auth) return feishuRefused('unknown-origin');
    if (!auth.active || grant.turn !== auth) return feishuRefused('turn-ended');
  }
  /** feishu_api: the entry alive and this turn going, then {@link dmTurn} in its own words. The place is `places: ['p2p']`, looked at before this. */
  function authorizeFeishuApi(grant: Grant, auth: TurnAuth | undefined): Failure | undefined {
    if (grant.thread && !grant.thread.isAlive()) revoke(grant);
    if (grant.phase === 'revoked') return failure('revoked');
    if (!auth) return feishuApiRefused('unknown-origin');
    if (!auth.active || grant.turn !== auth) return feishuApiRefused('turn-ended');
    const refusal = dmTurn(auth);
    return refusal && feishuApiRefused(refusal.reason === 'not-human-turn' ? 'not-human-turn' : 'not-admin');
  }
  /** The tools' `ctx.admin` (a private chat's queries of its Bot's groups) and a private chat's requests through the command line. */
  function adminTurn(grant: Grant): Failure | undefined {
    const turn = grant.turn;
    return turn?.active ? dmTurn(turn) : refused('turn-ended');
  }
  const roleOf = (auth: TurnAuth): Exclude<MemoryTurn['role'], 'owner'> => {
    const openId = auth.facts.requesterOpenId ?? '';
    if (auth.facts.requesterKind !== 'user' || !openId) return 'bot';
    return opts.isAdmin(openId) ? 'admin' : 'member';
  };
  /**
   * Who the command core sees: the task's own run, or the person of this turn with where they are now. A private chat's
   * turn is its person's or their task's, the same rights (dm-agent 6.3); only a person's message is a task's origin.
   */
  function scheduleActor(grant: Grant, auth: TurnAuth): Exclude<ScheduleActor, { kind: 'local' }> {
    const chatId = grant.place.chatId ?? '';
    if (grant.place.kind === 'p2p') {
      const { requesterOpenId: openId, requesterName: name, triggerMessageId: messageId, typed, triggerText, scheduled } = auth.facts;
      return {
        kind: 'dm', via: 'chat', chatId, ...(openId ? { openId } : {}), ...(name ? { name } : {}),
        ...(!scheduled && messageId ? { messageId } : {}), ...(!scheduled && typed && triggerText ? { text: triggerText } : {}),
      };
    }
    if (auth.facts.scheduled) return { kind: 'scheduled', ...auth.facts.scheduled, chatId };
    const { facts } = auth, role = roleOf(auth), topicId = facts.where?.().topicId;
    return {
      // A bot's or a wake's turn only gets to list (authorizeSchedule), where the role is not looked at.
      kind: 'chat', openId: facts.requesterOpenId ?? '', role: role === 'bot' ? 'member' : role, chatId,
      ...(facts.requesterName ? { name: facts.requesterName } : {}),
      ...(topicId ? { topicId } : {}),
      ...(facts.triggerMessageId ? { messageId: facts.triggerMessageId } : {}),
      ...(facts.typed && facts.triggerText ? { text: facts.triggerText } : {}),
    };
  }
  function memoryTurnOf(grant: Grant, auth: TurnAuth): MemoryTurn | undefined {
    if (grant.phase !== 'attached' || (grant.thread && !grant.thread.isAlive())) return undefined;
    const kind = grant.place.kind;
    return {
      kind: auth.kind, steered: auth.steered, role: roleOf(auth),
      ...(auth.facts.requesterOpenId ? { openId: auth.facts.requesterOpenId } : {}),
      place: kind === 'group' ? 'group' : kind === 'p2p' ? 'dm' : 'comment',
      ...(grant.place.chatId ? { chatId: grant.place.chatId } : {}),
      active: auth.active && grant.turn === auth,
      typed: auth.facts.typed === true,
      ...(auth.facts.triggerText !== undefined ? { triggerText: auth.facts.triggerText } : {}),
      botWrites: auth.botWrites,
    };
  }
  function issue(place: AgentPlace): AgentEntry {
    for (const old of grants) if (old.thread && !old.thread.isAlive()) revoke(old);
    const capped = grants.size >= 1024;
    const grant: Grant = {
      phase: shuttingDown ? 'revoked' : capped ? 'capacity' : 'pending',
      place: { ...place }, sessionId: `ses_${randomBytes(8).toString('hex')}`, sessionEnded: false,
      origins: new Map(), pruned: new Set(), controller: new AbortController(),
      active: 0, settingRunning: false, queue: [],
    };
    if (!capped && !shuttingDown) grants.add(grant);
    if (capped) log.warn('agent', 'entry-cap', {});
    async function call(name: string, args: unknown, origin?: { toolUseId?: string }): Promise<AgentToolReply> {
      const started = Date.now();
      const deadline = started + 70_000;
      const finishLog = (reply: AgentToolReply) => {
        log.info('agent', 'call', { tool: name, code: reply.ok ? 'ok' : reply.code, kind: place.kind, ms: Date.now() - started });
        return reply;
      };
      if (grant.thread && !grant.thread.isAlive()) revoke(grant);
      if (grant.phase === 'revoked') return finishLog(failure('revoked'));
      if (grant.phase !== 'attached') return finishLog(failure('not-ready'));
      const tool = table.get(name);
      if (!tool || !placed(tool, grant.place)) return finishLog(failure('unknown-tool'));
      const runTool = tool.run.bind(tool);
      const settings = tool.class === 'settings';
      const memory = tool.class === 'memory';
      const schedule = tool.class === 'schedule';
      const document = tool.class === 'document' && (tool.writes === true || grant.place.kind === 'doc');
      const feishuApi = tool.class === 'feishu-api';
      const feedback = tool.class === 'feedback';
      const resource=tool.class==='resource';
      const gated = resource || feedback || settings || memory || schedule || document || feishuApi;
      const taskId = schedule && args && typeof args === 'object' && 'taskId' in args ? args.taskId : undefined;
      // Claude's tool-use id, or the Codex turn id its turn/start answered with (定时任务 T3b): both noted by noteToolUse.
      const auth = origin?.toolUseId ? grant.origins.get(origin.toolUseId) : undefined;
      const authNow = (): Failure | undefined => resource ? (authorizeNow(grant,auth)??(auth?.presence!=='human'||auth.steered?refused('not-human-turn'):undefined)) : feedback ? authorizeFeedback(grant, auth) : memory ? authorizeMemory(grant, auth)
        : schedule ? authorizeSchedule(grant, auth, tool.action, taskId)
          : document ? authorizeFeishu(grant, auth) : feishuApi ? authorizeFeishuApi(grant, auth) : authorizeNow(grant, auth);
      if (gated) {
        const refusal = authNow();
        const known = origin?.toolUseId && (grant.origins.has(origin.toolUseId) || grant.pruned.has(origin.toolUseId));
        if (refusal?.reason === 'unknown-origin' && known) return finishLog(schedule ? scheduleRefused('turn-ended') : document ? feishuRefused('turn-ended') : feishuApi ? feishuApiRefused('turn-ended') : refused('turn-ended'));
        if (refusal) return finishLog(refusal);
        if (settings && grant.settingRunning && grant.queue.length >= 8) return finishLog(failure('busy'));
      }
      const parsed = inputAt(tool, grant.place).safeParse(args);
      if (!parsed.success) return finishLog({ ok: false, code: 'bad-args', message: `参数不对：${parsed.error.issues.map(i => `${i.path.join('.') || '<root>'}：${i.code}`).join('；')}。` });
      if ((!settings || !grant.settingRunning) && grant.active >= 4) return finishLog(failure('busy'));
      return new Promise<AgentToolReply>(resolve => {
        const controller = new AbortController();
        let settled = false;
        let running = false;
        let committed = false;
        let interruption: Failure | undefined;
        const settle = (reply: AgentToolReply) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          grant.controller.signal.removeEventListener('abort', onGrantAbort);
          if (feedback) auth?.feedbackSteer.signal.removeEventListener('abort', onTurnAbort);
          auth?.controller.signal.removeEventListener('abort', onTurnAbort);
          const index = grant.queue.indexOf(run);
          if (index >= 0) grant.queue.splice(index, 1);
          if (running) {
            grant.active--;
            if (settings) grant.settingRunning = false;
          }
          resolve(finishLog(reply));
          if (running && settings) grant.queue.shift()?.();
        };
        const stop = (reply: Failure) => {
          if (committed || settled) return;
          interruption = reply;
          controller.abort();
          settle(reply);
        };
        const onGrantAbort = () => stop(failure('revoked'));
        const onTurnAbort = () => {
          if (committed) return;
          // 记忆类：插话也会触发这个信号，但那一轮没结束，只影响落点，不打断调用；任务类插话后只剩 list
          if (memory || schedule || document || feishuApi) { const refusal = authNow(); if (refusal) stop(refusal); }
          else stop(authNow() ?? refused('turn-ended'));
        };
        const timer = setTimeout(() => stop(failure('timeout')), Math.max(0, deadline - Date.now()));
        grant.controller.signal.addEventListener('abort', onGrantAbort, { once: true });
        if (feedback) auth?.feedbackSteer.signal.addEventListener('abort', onTurnAbort, { once: true });
        if (gated) auth?.controller.signal.addEventListener('abort', onTurnAbort, { once: true });
        const check = (reserveMs: number) => {
          if (interruption) throw new ToolRefusal(interruption);
          if (!running || settled || committed) throw new Error('Tool call is not running');
          const refusal = authNow();
          if (refusal) throw new ToolRefusal(refusal);
          if (Date.now() > deadline - reserveMs) throw new ToolRefusal(failure('timeout'));
        };
        async function execute() {
          const ctx: ToolContext = { signal: controller.signal, place: grant.place, sessionId: grant.sessionId, notAfter: deadline, get admin() { return !adminTurn(grant); }, get writeRefusal() { return authorizeNow(grant, auth); } };
          if(resource&&auth)ctx.resourceCaller=()=>{
            const {requesterOpenId:openId,triggerMessageId:messageId}=auth.facts,chatId=grant.place.chatId;
            if(authNow()||grant.place.kind!=='p2p'||!openId||!messageId||!chatId||controller.signal.aborted)return;
            return {sessionId:grant.sessionId,openId,messageId,chatId};
          };
          if (memory && auth) {
            ctx.turn = { id: auth.id, requesterOpenId: auth.facts.requesterOpenId ?? '', triggerMessageId: auth.facts.triggerMessageId ?? '', role: roleOf(auth) };
            ctx.memoryTurn = () => memoryTurnOf(grant, auth);
            ctx.reserveBotWrite = () => { if (auth.botWrites >= 1) return false; auth.botWrites++; return true; };
            ctx.releaseBotWrite = () => { auth.botWrites = Math.max(0, auth.botWrites - 1); };
          }
          if (schedule && auth) ctx.schedule = () => ({ actor: scheduleActor(grant, auth), where: auth.facts.where?.() ?? { inTopic: false }, steered: auth.steered });
          if (feedback && auth?.facts.feedback) {
            const source = auth.facts.feedback;
            ctx.feedback = input => source.prepare(input, controller.signal, () => check(0));
          }
          if (gated && !feedback && auth) {
            if (settings) ctx.turn = { id: auth.id, requesterOpenId: auth.facts.requesterOpenId ?? '', triggerMessageId: auth.facts.triggerMessageId ?? '', role: 'admin' };
            ctx.commit = async write => {
              check(0);
              let guarded = false;
              const guard = () => {
                if (guarded) throw new Error('Commit guard called twice');
                check(3_000);
                guarded = true;
                committed = true;
              };
              const result = await write(guard);
              // 记忆写入在被拒（满了、重复、像密钥）时根本走不到提交点，这是正常的；设置写入走不到才是 bug
              if (!guarded && !memory) {
                const error = new Error('Settings write did not call its commit guard');
                log.fail('agent.commit-unguarded', error, { tool: name });
                throw error;
              }
              return result;
            };
          }
          try {
            let result: unknown;
            if (name === 'session_info') {
              const turn = !grant.turn?.active ? 'none' : grant.turn.human ? 'person' : 'other';
              // Only a private chat changes settings, with the command line, so only there it says whether this turn's
              // `vonvon` calls may: a person's own, or a task's (dm-agent 6.3).
              const refusal = grant.place.kind !== 'p2p' ? undefined : grant.turn ? authorizeNow(grant, grant.turn) : refused('not-human-turn');
              result = { v: 1, place: place.kind, turn, ...(grant.place.kind !== 'p2p' ? {} : { settings: refusal ? { allowed: false, reason: refusal.reason ?? refusal.code } : { allowed: true } }) };
            } else result = await runTool(parsed.data, ctx);
            if (committed && Date.now() > deadline) log.warn('agent', 'late-commit', { tool: name });
            const json = JSON.stringify(result);
            settle(json !== undefined && Buffer.byteLength(json) <= TOOL_RESULT_BYTES ? { ok: true, result } : { ok: false, code: 'failed', message: '结果太大' });
          } catch (error) {
            if (error instanceof ToolRefusal) settle(error.reply);
            else {
              log.fail('agent.tool-failed', error, { tool: name });
              settle(!committed ? failure('failed') : { ok: false, code: 'failed', message: schedule
                ? '提交时出错，任务可能已经改了。先用 schedule_list 查一下，再决定要不要重试。'
                : document ? '提交时出错，文档可能已经改了。先用 feishu_doc 读一下，再决定要不要重试。'
                  : feishuApi ? '调用时出错，这次调用可能已经生效了。先查一下，再决定要不要重试。' : '提交时出错，设置可能已经改了。先查一下现在的设置，再决定要不要重试。' });
            }
          }
        }
        function run() {
          if (settled) return;
          if (gated) {
            const refusal = authNow();
            if (refusal) { settle(refusal); if (settings) grant.queue.shift()?.(); return; }
          }
          if (Date.now() >= deadline) { stop(failure('timeout')); grant.queue.shift()?.(); return; }
          if (grant.active >= 4) { settle(failure('busy')); if (settings) grant.queue.shift()?.(); return; }
          running = true;
          grant.active++;
          if (settings) grant.settingRunning = true;
          void execute();
        }
        if (settings && grant.settingRunning) grant.queue.push(run);
        else run();
      });
    }
    return {
      sessionId: grant.sessionId,
      tools() {
        if (grant.thread && !grant.thread.isAlive()) revoke(grant);
        if (grant.phase === 'revoked') throw new ToolRefusal(failure('revoked'));
        if (grant.phase === 'capacity') return [];
        // 评论会话（doc）只给读类和文档这一列的工具；写记忆的和任务的在群和私聊里给；只为设置服务的读工具只在私聊里给
        return tools.filter(tool => {
          if (!placed(tool, grant.place)) return false;
          if (tool.class === 'feedback') return !!grant.place.chatId && opts.feedbackEnabled?.(grant.place.chatId);
          return tool.class === 'read' || tool.class === 'document'
            || (tool.class === 'memory' || tool.class === 'schedule' ? grant.place.kind !== 'doc' : grant.place.kind === 'p2p');
        })
          .map(tool => ({ name: tool.name, description: tool.description, input: inputAt(tool, grant.place) }));
      },
      call,
      noteToolUse(id) {
        if (grant.phase !== 'attached' || grant.origins.has(id) || grant.pruned.has(id)) return;
        if (grant.origins.size >= 256) pruneOrigins(grant);
        // Still full (this turn and the one before hold it all): a copy noted turns later would get the wrong turn.
        if (grant.origins.size >= 256) { forget(grant, id); return; }
        grant.origins.set(id, grant.turn);
      },
      attach(thread) {
        if (grant.phase !== 'pending') return;
        grant.thread = thread;
        grant.phase = 'attached';
        threads.set(thread, grant);
      },
      revoke() { revoke(grant); },
    };
  }
  /** A refusal as a session's command line reads it: the tools' reason and sentence, but an ended turn in the design's words. */
  const denial = (failure: Failure): SessionAuthz => {
    const reason = failure.reason ?? failure.code;
    return ENDED.has(reason) ? { ok: false, reason: 'turn-ended', message: SESSION_TURN_ENDED } : { ok: false, reason, message: failure.message };
  };
  const live = (sessionId: string): Grant | undefined => {
    for (const grant of grants) if (grant.sessionId === sessionId) return grant;
  };
  async function authorizeSessionCall(sessionId: string, action: SessionAction): Promise<SessionAuthz> {
    const ended = denial(refused('turn-ended'));
    const found = live(sessionId);
    if (!found) return ended;
    // The only wait, before the turn is read: everything after it runs in one go, so the turn cannot change under it.
    const place = action.kind === 'memory' && action.op !== 'read'
      ? await opts.memoryPlace?.({ place: found.place.kind === 'group' ? 'group' : found.place.kind === 'p2p' ? 'dm' : 'comment', ...(found.place.chatId ? { chatId: found.place.chatId } : {}) }) ?? {}
      : {};
    const grant = live(sessionId);
    if (!grant) return ended;
    if (grant.thread && !grant.thread.isAlive()) { revoke(grant); return ended; }
    const auth = grant.turn;
    const who = (turn: TurnAuth): Pick<Extract<SessionAuthz, { ok: true }>, 'role' | 'openId' | 'unionId' | 'name'> => {
      const { requesterOpenId: openId, requesterUnionId: unionId, requesterName: name } = turn.facts;
      return { role: roleOf(turn), ...(openId ? { openId } : {}), ...(unionId ? { unionId } : {}), ...(name ? { name } : {}) };
    };
    switch (action.kind) {
      case 'settingsWrite': {
        const failure = authorizeNow(grant, auth);
        if (failure || !auth) return denial(failure ?? refused('unknown-origin'));
        return { ok: true, ...who(auth) };
      }
      case 'adminRead': {
        const failure = grant.place.kind !== 'p2p' ? notDm(grant.place) : adminTurn(grant);
        return failure || !grant.turn ? denial(failure ?? refused('turn-ended')) : { ok: true, ...who(grant.turn) };
      }
      // dm-agent 7.3: a private chat's as anything else of it; a group's on a turn of its own, whoever's, as its tools are (7.2).
      case 'feishuRead': {
        const failure = grant.place.kind === 'p2p' ? adminTurn(grant) : grant.place.kind === 'doc' ? notDm(grant.place) : grant.turn?.active ? undefined : refused('turn-ended');
        return failure || !grant.turn ? denial(failure ?? refused('turn-ended')) : { ok: true, ...who(grant.turn) };
      }
      case 'schedule': {
        const failure = authorizeSchedule(grant, auth, action.action, action.taskId);
        if (failure || !auth) return denial(failure ?? refused('unknown-origin'));
        const actor = scheduleActor(grant, auth);
        // The command core checks a person's turn again by its role; a task's own run as itself (3.13).
        if (actor.kind === 'scheduled') return { ok: true, ...who(auth), actor };
        if (actor.kind === 'dm') {
          const { text: _text, ...person } = actor;
          return { ok: true, ...who(auth), actor: { ...person, via: 'cli' } };
        }
        const { openId, role, chatId, name, messageId } = actor;
        return { ok: true, ...who(auth), actor: { kind: 'session', openId, role, chatId, ...(name ? { name } : {}), ...(messageId ? { messageId } : {}) } };
      }
      case 'memory': {
        const dm = grant.place.kind === 'p2p';
        const failure = authorizeMemory(grant, auth) ?? (dm && auth ? dmTurn(auth) : undefined);
        const turn = !failure && auth ? memoryTurnOf(grant, auth) : undefined;
        if (!turn || !auth) return denial(failure ?? refused('unknown-origin'));
        const target = action.op === 'edit' ? action.item.scope : action.target;
        // A private chat's memory is its own person's: the tools' decideAdd and decideEdit give no other (4.5a).
        if (target.kind === 'dm' && !ownDm(turn, target.openId)) return { ok: false, reason: 'out-of-scope', message: decisionMessages['out-of-scope'] };
        if (action.op === 'read') return { ok: true, ...who(auth) };
        // dm-agent 6.4: what is written in another Bot's memory says who by name, its open_id being this Bot's.
        const otherBot = action.otherBot === true, name = auth.facts.requesterName;
        const source: MemoryLanding['source'] = {
          botId: opts.appId, turn: { kind: turn.kind, steered: turn.steered }, ...(turn.chatId ? { chatId: turn.chatId } : {}),
          ...(auth.facts.triggerMessageId ? { messageId: auth.facts.triggerMessageId } : {}), ...(otherBot && name ? { actorName: name } : {}),
        };
        const writer = (decided: { actorRole: string; actorOpenId?: string }): MemoryLanding['actor'] =>
          ({ role: decided.actorRole as MemoryLanding['actor']['role'], ...(decided.actorOpenId && !otherBot ? { openId: decided.actorOpenId } : {}) });
        if (action.op === 'manage') {
          if (!dm) return denial(notDm(grant.place));
          const by = actorOf(turn);
          return { ok: true, ...who(auth), memory: { scope: action.target, trust: by.trust, actor: writer(by), source, ...(otherBot ? { otherBot } : {}) } };
        }
        // A private chat reaches every project (dm-agent 6.1), not only those of its Bot's groups.
        const reached = dm && target.kind === 'project' ? { ...place, botProjectIds: [...place.botProjectIds ?? [], target.projectId] } : place;
        if (action.op === 'edit') {
          const decision = decideEdit({ turn, place: reached, item: action.item, ...(action.text !== undefined ? { text: action.text } : {}) });
          if (!decision.allow) return { ok: false, reason: decision.reason, message: decisionMessages[decision.reason] };
          // One Bot-memory write a turn, as the tools reserve it; not given back if the write then fails.
          if (action.item.scope.kind === 'bot') auth.botWrites++;
          return { ok: true, ...who(auth), memory: { scope: action.item.scope, trust: 'untrusted', actor: writer(decision.actor), source } };
        }
        const requested: RequestedScope = target.kind === 'project' ? { project: target.projectId } : target.kind;
        const decision = decideAdd({ turn, place: reached, via: 'tool', text: action.text.trim(), scope: requested });
        if (!decision.allow) return { ok: false, reason: decision.reason, message: decisionMessages[decision.reason] };
        // A downgrade lands in this Bot's project: not what a write aimed at another Bot asked for.
        if (otherBot && decision.scope.kind !== target.kind) return { ok: false, reason: 'not-allowed-here', message: decisionMessages['not-allowed-here'] };
        if (decision.scope.kind === 'bot') auth.botWrites++;
        return { ok: true, ...who(auth), memory: {
          scope: decision.scope, trust: decision.trust, actor: writer(decision),
          source: { ...source, ...(decision.downgraded ? { downgraded: decision.downgraded } : {}) },
        } };
      }
    }
  }
  return {
    issue,
    authorizeSessionCall,
    openTurn(thread, facts) {
      const grant = threads.get(thread);
      const scheduled = facts.scheduled ? { ...facts.scheduled } : undefined;
      // 合成的定时轮带齐了真人轮的字段也不算真人：它没有在场的发起人，记忆回合记成已有的 initiative
      const kind: MemoryTurn['kind'] = scheduled ? 'initiative' : facts.wake ? 'wake' : facts.initiative ? 'initiative' : facts.retry ? 'retry'
        : facts.requesterKind === 'user' && !!facts.requesterOpenId && !!facts.triggerMessageId ? 'human' : 'bot';
      const presence: TurnPresence = scheduled ? 'scheduled' : kind === 'human' ? 'human' : 'none';
      const auth: TurnAuth = { id: ++nextTurn, facts: { ...facts, ...(scheduled ? { scheduled } : {}) }, active: true, controller: new AbortController(), feedbackSteer: new AbortController(), human: kind === 'human',
        steered: false, botWrites: 0, kind, presence };
      if (grant && grant.phase === 'attached') {
        if (grant.turn?.active) log.warn('agent', 'turn-overlap', {});
        end(grant.turn);
        grant.previous = grant.turn;
        grant.turn = auth;
      } else end(auth);
      return { ...(grant?.phase==='attached'&&{sessionId:grant.sessionId}),id: auth.id, presence, ...(scheduled ? { scheduled: { ...scheduled } } : {}), close() { end(auth); } };
    },
    memoryTurn(thread) {
      const grant = threads.get(thread);
      const auth = grant?.turn;
      if (!grant || !auth) return undefined;
      return { turn: () => memoryTurnOf(grant, auth), place: { ...grant.place }, ...(auth.facts.triggerMessageId ? { triggerMessageId: auth.facts.triggerMessageId } : {}) };
    },
    noteSteer(thread, sender) {
      const auth = threads.get(thread)?.turn;
      auth?.feedbackSteer.abort();
      if (auth && !(sender.kind === 'user' && sender.openId && sender.openId === auth.facts.requesterOpenId)) {
        auth.human = false;
        auth.steered = true;
        auth.controller.abort();
      }
    },
    revokeChat(chatId) { for (const grant of [...grants]) if (grant.place.kind === 'p2p' && grant.place.chatId === chatId) revoke(grant); },
    closeAll() { shuttingDown = true; for (const grant of grants) revoke(grant); },
  };
}
