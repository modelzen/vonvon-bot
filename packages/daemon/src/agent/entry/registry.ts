import type { AgentEntry, AgentThread, AgentToolReply } from '../types';
import { log } from '../../core/logger';
import type { MemoryTurn } from '../../bot/memory-authority';
import { scheduleRefusalMessages, type ScheduleActor } from '../../admin/schedule-commands';
import { sessionInfoTool, ToolRefusal, type AgentTool, type ToolContext } from './tools';

export interface AgentPlace { kind: 'group' | 'p2p' | 'doc'; chatId?: string; docId?: string }
export interface TurnFacts {
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
export interface TurnScope { readonly id: number; readonly presence: TurnPresence; readonly scheduled?: { taskId: string; runId: string }; close(): void }
export interface AgentEntries {
  issue(place: AgentPlace): AgentEntry;
  openTurn(thread: AgentThread, facts: TurnFacts): TurnScope;
  /** 这一轮对记忆的事实（`memoryTurn()` 一调就绑定当前这一轮）；线程不是这个 daemon 发过入口的返回 undefined */
  memoryTurn(thread: AgentThread): TurnMemory | undefined;
  noteSteer(thread: AgentThread, sender: { openId?: string; kind: 'user' | 'bot' | 'unknown' }): void;
  closeAll(reason: 'shutdown'): void;
}
type Failure = Extract<AgentToolReply, { ok: false }>;
type Reason = NonNullable<Failure['reason']>;
const messages = {
  'not-ready': 'vonvon 还没准备好这条会话的工具，稍后再试。',
  revoked: '这条会话的 vonvon 工具已经失效（会话结束了，或者 daemon 重启过）。不要重试，接着做别的。',
  'unknown-tool': '没有这个工具。',
  'not-dm': '设置只能在私聊里改。请对方去私聊里跟我说。',
  'not-human-turn': '这一轮不是主人或管理员发消息直接触发的，不能改设置。',
  'turn-ended': '发起这次改动的那一轮已经结束了，不能改设置。请对方重新说一遍。',
  'unknown-origin': 'vonvon 认不出这次改动是哪一轮发起的，不能改设置。请对方重新说一遍。',
  'not-admin': '只有主人和管理员发消息触发的那一轮能改设置。',
  'switch-off': '主人关了私聊里的“聊天改设置”，要改请去桌面端或网页。',
  'not-group': scheduleRefusalMessages['not-group'],
  'no-human-create': scheduleRefusalMessages['no-human-create'],
  'scheduled-run-scope': scheduleRefusalMessages['scheduled-run-scope'],
  busy: 'vonvon 手上的事太多，稍后再试。',
  timeout: 'vonvon 这一步超时了。',
  failed: 'vonvon 这一步出错了。',
};
function failure(code: Exclude<Failure['code'], 'refused' | 'bad-args'>): Failure {
  return { ok: false, code, message: messages[code] };
}
function refused(reason: Reason): Failure {
  return { ok: false, code: 'refused', reason, message: messages[reason] };
}
interface TurnAuth {
  id: number;
  facts: TurnFacts;
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
  thread?: AgentThread;
  turn?: TurnAuth;
  firstTurn?: TurnAuth;
  origins: Map<string, TurnAuth | undefined>;
  controller: AbortController;
  active: number;
  settingRunning: boolean;
  queue: Array<() => void>;
}
export function createAgentEntries(opts: {
  appId: string;
  isAdmin(openId: string): boolean;
  isOwner(openId: string): boolean;
  chatSettingsOn?(): boolean;
  tools?: readonly AgentTool[];
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
  function revoke(grant: Grant) {
    grant.phase = 'revoked';
    end(grant.turn);
    grant.controller.abort();
    grant.origins.clear();
    grants.delete(grant);
  }
  function authorizeNow(grant: Grant, auth: TurnAuth | undefined): Failure | undefined {
    if (grant.thread && !grant.thread.isAlive()) revoke(grant);
    if (grant.phase === 'revoked') return failure('revoked');
    if (grant.place.kind !== 'p2p') return refused('not-dm');
    if (!auth) return refused('unknown-origin');
    if (!auth.active || grant.turn !== auth) return refused('turn-ended');
    if (!auth.human) return refused('not-human-turn');
    if (!opts.isAdmin(auth.facts.requesterOpenId ?? '')) return refused('not-admin');
    if (!(opts.chatSettingsOn?.() ?? true)) return refused('switch-off');
  }
  /** 记忆类工具的授权：不要求人、角色，只要求入口还活着、这一轮还在进行；人不人、什么角色只影响落点（§3.2） */
  function authorizeMemory(grant: Grant, auth: TurnAuth | undefined): Failure | undefined {
    if (grant.thread && !grant.thread.isAlive()) revoke(grant);
    if (grant.phase === 'revoked') return failure('revoked');
    if (grant.place.kind === 'doc') return failure('unknown-tool');
    if (!auth) return refused('unknown-origin');
    if (!auth.active || grant.turn !== auth) return refused('turn-ended');
  }
  /**
   * schedule 类的授权（3.13 的表、总设计第 8 节"在场"）：这一层先查，拒绝不进命令核；命令核按 actor 再查一遍，
   * 成员能不能碰别人的任务、跨群的 id 只有命令核看得到。
   */
  function authorizeSchedule(grant: Grant, auth: TurnAuth | undefined, action: AgentTool['action'], taskId: unknown): Failure | undefined {
    if (grant.thread && !grant.thread.isAlive()) revoke(grant);
    if (grant.phase === 'revoked') return failure('revoked');
    if (grant.place.kind !== 'group') return refused('not-group');
    if (!auth) return refused('unknown-origin');
    if (!auth.active || grant.turn !== auth) return refused('turn-ended');
    if (action === 'list') return undefined;
    if (auth.steered || auth.presence === 'none') return { ...refused('not-human-turn'), message: scheduleRefusalMessages['not-human-turn'] };
    if (auth.presence !== 'scheduled') return undefined;
    if (action === 'create') return refused('no-human-create');
    if ((action !== 'edit' && action !== 'delete') || taskId !== auth.facts.scheduled?.taskId) return refused('scheduled-run-scope');
  }
  const roleOf = (auth: TurnAuth): MemoryTurn['role'] => {
    const openId = auth.facts.requesterOpenId ?? '';
    if (auth.facts.requesterKind !== 'user' || !openId) return 'bot';
    return opts.isOwner(openId) ? 'owner' : opts.isAdmin(openId) ? 'admin' : 'member';
  };
  /** Who the command core sees: the task's own run, or the person of this turn with where they are now. */
  function scheduleActor(grant: Grant, auth: TurnAuth): Exclude<ScheduleActor, { kind: 'local' }> {
    const chatId = grant.place.chatId ?? '';
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
      place: { ...place }, origins: new Map(), controller: new AbortController(),
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
      if (!tool) return finishLog(failure('unknown-tool'));
      const runTool = tool.run.bind(tool);
      const settings = tool.class === 'settings';
      const memory = tool.class === 'memory';
      const schedule = tool.class === 'schedule';
      const gated = settings || memory || schedule;
      const taskId = schedule && args && typeof args === 'object' && 'taskId' in args ? args.taskId : undefined;
      // Only Codex declares releaseAfterRun (false before its first accepted turn).
      const auth = grant.thread?.releaseAfterRun !== undefined ? grant.firstTurn
        : origin?.toolUseId ? grant.origins.get(origin.toolUseId) : undefined;
      const authNow = (): Failure | undefined => memory ? authorizeMemory(grant, auth)
        : schedule ? authorizeSchedule(grant, auth, tool.action, taskId) : authorizeNow(grant, auth);
      if (gated) {
        const refusal = authNow();
        if (refusal?.reason === 'unknown-origin' && origin?.toolUseId && grant.origins.has(origin.toolUseId)) return finishLog(refused('turn-ended'));
        if (refusal) return finishLog(refusal);
        if (settings && grant.settingRunning && grant.queue.length >= 8) return finishLog(failure('busy'));
      }
      const parsed = tool.input.safeParse(args);
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
          if (memory || schedule) { const refusal = authNow(); if (refusal) stop(refusal); }
          else stop(authNow() ?? refused('turn-ended'));
        };
        const timer = setTimeout(() => stop(failure('timeout')), Math.max(0, deadline - Date.now()));
        grant.controller.signal.addEventListener('abort', onGrantAbort, { once: true });
        if (gated) auth?.controller.signal.addEventListener('abort', onTurnAbort, { once: true });
        const check = (reserveMs: number) => {
          if (interruption) throw new ToolRefusal(interruption);
          if (!running || settled || committed) throw new Error('Tool call is not running');
          const refusal = authNow();
          if (refusal) throw new ToolRefusal(refusal);
          if (Date.now() > deadline - reserveMs) throw new ToolRefusal(failure('timeout'));
        };
        async function execute() {
          const ctx: ToolContext = { signal: controller.signal, place: grant.place, notAfter: deadline, get admin() { return !!grant.turn?.active && grant.turn.human && opts.isAdmin(grant.turn.facts.requesterOpenId ?? ''); }, get writeRefusal() { return authorizeNow(grant, auth); } };
          if (memory && auth) {
            ctx.turn = { id: auth.id, requesterOpenId: auth.facts.requesterOpenId ?? '', triggerMessageId: auth.facts.triggerMessageId ?? '', role: roleOf(auth) };
            ctx.memoryTurn = () => memoryTurnOf(grant, auth);
            ctx.reserveBotWrite = () => { if (auth.botWrites >= 1) return false; auth.botWrites++; return true; };
            ctx.releaseBotWrite = () => { auth.botWrites = Math.max(0, auth.botWrites - 1); };
          }
          if (schedule && auth) ctx.schedule = () => ({ actor: scheduleActor(grant, auth), where: auth.facts.where?.() ?? { inTopic: false } });
          if (gated && auth) {
            if (settings) ctx.turn = { id: auth.id, requesterOpenId: auth.facts.requesterOpenId ?? '', triggerMessageId: auth.facts.triggerMessageId ?? '', role: opts.isOwner(auth.facts.requesterOpenId ?? '') ? 'owner' : 'admin' };
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
              const refusal = grant.turn ? authorizeNow(grant, grant.turn) : grant.place.kind === 'p2p' ? refused('not-human-turn') : refused('not-dm');
              result = { v: 1, place: place.kind, turn: !grant.turn?.active ? 'none' : grant.turn.human ? 'person' : 'other', settings: refusal ? { allowed: false, reason: refusal.reason ?? refusal.code } : { allowed: true } };
            } else result = await runTool(parsed.data, ctx);
            if (committed && Date.now() > deadline) log.warn('agent', 'late-commit', { tool: name });
            const json = JSON.stringify(result);
            settle(json !== undefined && Buffer.byteLength(json) <= 256 * 1024 ? { ok: true, result } : { ok: false, code: 'failed', message: '结果太大' });
          } catch (error) {
            if (error instanceof ToolRefusal) settle(error.reply);
            else {
              log.fail('agent.tool-failed', error, { tool: name });
              settle(!committed ? failure('failed') : { ok: false, code: 'failed', message: schedule
                ? '提交时出错，任务可能已经改了。先用 schedule_list 查一下，再决定要不要重试。' : '提交时出错，设置可能已经改了。先查一下现在的设置，再决定要不要重试。' });
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
      tools() {
        if (grant.thread && !grant.thread.isAlive()) revoke(grant);
        if (grant.phase === 'revoked') throw new ToolRefusal(failure('revoked'));
        if (grant.phase === 'capacity') return [];
        // 评论会话（doc）只给读类工具；写记忆的在群和私聊里给，任务的只在群里给
        return tools.filter(tool => tool.class === 'read' || (tool.class === 'memory' ? grant.place.kind !== 'doc'
          : grant.place.kind === (tool.class === 'schedule' ? 'group' : 'p2p')))
          .map(({ name, description, input }) => ({ name, description, input }));
      },
      call,
      noteToolUse(id) {
        if (grant.phase !== 'attached' || grant.origins.has(id) || grant.origins.size >= 256) return;
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
  return {
    issue,
    openTurn(thread, facts) {
      const grant = threads.get(thread);
      const scheduled = facts.scheduled ? { ...facts.scheduled } : undefined;
      // 合成的定时轮带齐了真人轮的字段也不算真人：它没有在场的发起人，记忆回合记成已有的 initiative
      const kind: MemoryTurn['kind'] = scheduled ? 'initiative' : facts.wake ? 'wake' : facts.initiative ? 'initiative' : facts.retry ? 'retry'
        : facts.requesterKind === 'user' && !!facts.requesterOpenId && !!facts.triggerMessageId ? 'human' : 'bot';
      const presence: TurnPresence = scheduled ? 'scheduled' : kind === 'human' ? 'human' : 'none';
      const auth: TurnAuth = { id: ++nextTurn, facts: { ...facts, ...(scheduled ? { scheduled } : {}) }, active: true, controller: new AbortController(), human: kind === 'human',
        steered: false, botWrites: 0, kind, presence };
      if (grant && grant.phase === 'attached') {
        if (grant.turn?.active) log.warn('agent', 'turn-overlap', {});
        end(grant.turn);
        grant.turn = auth;
        grant.firstTurn ??= auth;
      } else end(auth);
      return { id: auth.id, presence, ...(scheduled ? { scheduled: { ...scheduled } } : {}), close() { end(auth); } };
    },
    memoryTurn(thread) {
      const grant = threads.get(thread);
      const auth = grant?.turn;
      if (!grant || !auth) return undefined;
      return { turn: () => memoryTurnOf(grant, auth), place: { ...grant.place }, ...(auth.facts.triggerMessageId ? { triggerMessageId: auth.facts.triggerMessageId } : {}) };
    },
    noteSteer(thread, sender) {
      const auth = threads.get(thread)?.turn;
      if (auth && !(sender.kind === 'user' && sender.openId && sender.openId === auth.facts.requesterOpenId)) {
        auth.human = false;
        auth.steered = true;
        auth.controller.abort();
      }
    },
    closeAll() { shuttingDown = true; for (const grant of grants) revoke(grant); },
  };
}
