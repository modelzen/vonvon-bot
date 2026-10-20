import type { AgentEntry, AgentThread, AgentToolReply } from '../types';
import { log } from '../../core/logger';
import { sessionInfoTool, ToolRefusal, type AgentTool, type ToolContext } from './tools';

export interface AgentPlace { kind: 'group' | 'p2p' | 'doc'; chatId?: string; docId?: string }
export interface TurnFacts {
  requesterOpenId?: string;
  requesterKind?: 'user' | 'bot' | 'unknown';
  triggerMessageId?: string;
  retry: boolean;
  initiative: boolean;
  wake: boolean;
}
export interface TurnScope { readonly id: number; close(): void }
export interface AgentEntries {
  issue(place: AgentPlace): AgentEntry;
  openTurn(thread: AgentThread, facts: TurnFacts): TurnScope;
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
      // Only Codex declares releaseAfterRun (false before its first accepted turn).
      const auth = grant.thread?.releaseAfterRun !== undefined ? grant.firstTurn
        : origin?.toolUseId ? grant.origins.get(origin.toolUseId) : undefined;
      if (settings) {
        const refusal = authorizeNow(grant, auth);
        if (refusal?.reason === 'unknown-origin' && origin?.toolUseId && grant.origins.has(origin.toolUseId)) return finishLog(refused('turn-ended'));
        if (refusal) return finishLog(refusal);
        if (grant.settingRunning && grant.queue.length >= 8) return finishLog(failure('busy'));
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
          if (!committed) stop(authorizeNow(grant, auth) ?? refused('turn-ended'));
        };
        const timer = setTimeout(() => stop(failure('timeout')), Math.max(0, deadline - Date.now()));
        grant.controller.signal.addEventListener('abort', onGrantAbort, { once: true });
        if (settings) auth?.controller.signal.addEventListener('abort', onTurnAbort, { once: true });
        const check = (reserveMs: number) => {
          if (interruption) throw new ToolRefusal(interruption);
          if (!running || settled || committed) throw new Error('Tool call is not running');
          const refusal = authorizeNow(grant, auth);
          if (refusal) throw new ToolRefusal(refusal);
          if (Date.now() > deadline - reserveMs) throw new ToolRefusal(failure('timeout'));
        };
        async function execute() {
          const ctx: ToolContext = { signal: controller.signal, place: grant.place };
          if (settings && auth) {
            ctx.turn = { id: auth.id, requesterOpenId: auth.facts.requesterOpenId ?? '', triggerMessageId: auth.facts.triggerMessageId ?? '', role: opts.isOwner(auth.facts.requesterOpenId ?? '') ? 'owner' : 'admin' };
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
              if (!guarded) {
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
              settle(committed ? { ok: false, code: 'failed', message: '提交时出错，设置可能已经改了。先查一下现在的设置，再决定要不要重试。' } : failure('failed'));
            }
          }
        }
        function run() {
          if (settled) return;
          if (settings) {
            const refusal = authorizeNow(grant, auth);
            if (refusal) { settle(refusal); grant.queue.shift()?.(); return; }
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
        return tools.map(({ name, description, input }) => ({ name, description, input }));
      },
      call,
      noteToolUse(id) {
        if (grant.phase !== 'attached' || grant.origins.has(id)) return;
        grant.origins.set(id, grant.turn);
        if (grant.origins.size > 256) {
          const oldest = grant.origins.keys().next().value;
          if (oldest !== undefined) grant.origins.delete(oldest);
        }
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
      const auth: TurnAuth = { id: ++nextTurn, facts: { ...facts }, active: true, controller: new AbortController(), human: facts.requesterKind === 'user' && !!facts.requesterOpenId && !!facts.triggerMessageId && !facts.retry && !facts.initiative && !facts.wake };
      if (grant && grant.phase === 'attached') {
        if (grant.turn?.active) log.warn('agent', 'turn-overlap', {});
        end(grant.turn);
        grant.turn = auth;
        grant.firstTurn ??= auth;
      } else end(auth);
      return { id: auth.id, close() { end(auth); } };
    },
    noteSteer(thread, sender) {
      const auth = threads.get(thread)?.turn;
      if (auth && !(sender.kind === 'user' && sender.openId && sender.openId === auth.facts.requesterOpenId)) {
        auth.human = false;
        auth.controller.abort();
      }
    },
    closeAll() { shuttingDown = true; for (const grant of grants) revoke(grant); },
  };
}
