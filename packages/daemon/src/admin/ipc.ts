import type { AdminCollaborationOp } from './collaboration';
import type { BotSettingsScope, ModelQuery } from './settings-types';
import { GroupUpstreamError, InvalidGroupInput, type AdminGroupOp } from './groups';
import { AdminWriteError, type AdminWriteOp } from './ops';
import type { AdminLibraryOp } from './library';
import type { ScheduleActor } from './schedule-commands';
import type { MemoryDowngrade, MemoryItem, MemoryItemScope, MemorySource, ScheduleRequest } from '@vonvon/protocol';
import { groupIdSchema } from '@vonvon/protocol';
import { z } from 'zod';
import { SESSION_ID_RE, type SessionInput } from '../host/session-tokens';
import { SESSION_TURN_ENDED } from '../agent/entry/registry';
import type { FeishuReadReply, FeishuReadRequest } from '../feishu-read/reader';
import type { ApiRequest } from '../feishu-read/api';
import { apiRequestSchema, feishuReadReplySchema, type RoutedApi, type RoutedRead } from './feishu-route';

/**
 * supervisor ↔ bot 子进程的管理面 IPC（node 'ipc' stdio / process.send）。
 *
 * 为什么是 IPC 而不是 supervisor 文件级直写（设计取舍，第二棒调查结论）：
 *   1. registry 的 withLock 是**进程内**锁——bot 子进程自己也在读-改-写
 *      projects.json，supervisor 直写会与之交错丢更新（O_EXCL 文件锁只能保
 *      互斥，挡不住子进程模块内已排队的旧快照写回）。
 *   2. 写操作的既有语义包含「驱逐活跃会话」（🔐 权限），LIVE
 *      线程只存在于 bot 进程内存里——文件锁方案根本做不到，必须进程内执行。
 *   把写请求转发给对应子进程，在子进程内走既有 withLock + 校验 + 驱逐，与
 *   DM 卡片回调完全同一条代码路径（admin/ops.ts）。
 *
 * 消息用 `fcb` 标签隔离（node 内部消息/其他用途互不干扰）；请求按自增 id 关联
 * 响应；caller 端带超时与「子进程退场全拒」兜底，绝不悬挂 HTTP 请求。
 */

export const ADMIN_IPC_REQ = 'fcb.admin.req' as const;
export const ADMIN_IPC_RES = 'fcb.admin.res' as const;

export type AdminSettingsReadOp = { kind: 'settingsRead'; scope: BotSettingsScope } | { kind: 'settingsModels'; query: ModelQuery };
/**
 * Scheduled-task requests over the wire; the bot process runs them through schedule-commands as `actor`: the local owner
 * (`local`, the desktop or the terminal) or a Bot session's turn (`session`, D4b), as the host decided.
 */
export type AdminScheduleOp = { kind: 'schedule'; actor: ScheduleActor; request: ScheduleRequest };

/** A memory a Bot session's request names (the bot's own: the host has checked that). */
export type SessionMemoryTarget = { kind: 'bot' } | { kind: 'project'; projectId: string } | { kind: 'dm'; openId: string };
/**
 * devices-4b 4.1: what a Bot session's ★ request asks of its Bot process, which answers with the tools' own checks for the
 * session's current turn. `settingsWrite`: authorizeNow; `adminRead`: the private
 * chat's read-only queries (the tools' `ctx.admin`); `memory`: authorizeMemory, then memory-authority's decideAdd (where it
 * lands) or decideEdit (the item as the host read it); `schedule`: authorizeSchedule.
 */
export type SessionAction =
  | { kind: 'settingsWrite' }
  | { kind: 'adminRead' }
  | { kind: 'memory'; op: 'read'; target: SessionMemoryTarget }
  /** `otherBot`: a private chat writing another Bot's memory (dm-agent 6.4): its person's open_id is not written there. */
  | { kind: 'memory'; op: 'add'; target: SessionMemoryTarget; text: string; otherBot?: boolean }
  | { kind: 'memory'; op: 'edit'; item: Pick<MemoryItem, 'scope' | 'source'>; text?: string; otherBot?: boolean }
  /** The page's other buttons (restore, move, merge a branch…), a private chat's only (dm-agent 6.2). */
  | { kind: 'memory'; op: 'manage'; target: SessionMemoryTarget; otherBot?: boolean }
  | { kind: 'schedule'; action: ScheduleRequest['action']; taskId?: string }
  /** A Feishu read from the command line (dm-agent 7.3): a group's turn or a private chat's administrator. */
  | { kind: 'feishuRead' };
/** Where a session's memory write lands and as whom (memory-authority's decision), with the source fields the tools write. */
export interface MemoryLanding {
  scope: MemoryItemScope;
  trust: 'trusted' | 'untrusted';
  actor: { role: 'owner' | 'admin' | 'member' | 'bot'; openId?: string };
  source: { botId: string; turn?: NonNullable<MemorySource['turn']>; chatId?: string; messageId?: string; downgraded?: MemoryDowngrade; actorName?: string };
  /** dm-agent 6.4: the write touches another Bot's memory, so a transferred item leaves its open_id behind. */
  otherBot?: boolean;
}
/** The Bot process's answer: who started the turn (and for a task its actor, for a memory write where it lands), or the refusal with the tools' sentence. */
export type SessionAuthz =
  | { ok: true; role: 'owner' | 'admin' | 'member' | 'bot'; openId?: string; /** the person's union_id (dm-agent 6.4): what another Bot of the same developer can use */ unionId?: string; name?: string; actor?: Extract<ScheduleActor, { kind: 'session' | 'scheduled' | 'dm' }>; memory?: MemoryLanding }
  | { ok: false; reason: string; message: string };
export type AdminSessionOp = { kind: 'authorizeSessionCall'; sessionId: string; action: SessionAction };
/**
 * dm-agent 7.3: a read this Bot runs as itself, for the host. This channel is the parent's alone, a bot child's IPC, so the
 * request comes from the host; who may ask was settled there (feishu-route.ts), and `run.ts` answers it only when supervised.
 * `feishuApi`: the same for `feishu_api`, which only a private chat's tool ever asks the host for (7.6).
 */
export type AdminFeishuOp = { kind: 'feishuRead'; request: FeishuReadRequest } | { kind: 'feishuApi'; request: ApiRequest };
export type AdminIpcOp = AdminCollaborationOp | AdminWriteOp | AdminGroupOp | AdminSettingsReadOp | AdminLibraryOp | AdminScheduleOp | AdminSessionOp | AdminFeishuOp | { kind: 'status' } | { kind: 'firstHello' };

export interface AdminIpcRequest {
  fcb: typeof ADMIN_IPC_REQ;
  id: number;
  op: AdminIpcOp;
}

export interface IpcResponse {
  fcb: string;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
  groupId?: string;
}
export interface AdminIpcResponse extends IpcResponse {
  fcb: typeof ADMIN_IPC_RES;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** AdminWriteError 的拒绝码——caller 端按它还原类型（HTTP 层好映射 409）。 */
  code?: string;
}

/** 普通状态和不涉及 Provider 的写请求保持短期限。 */
export const ADMIN_IPC_TIMEOUT_MS = 15_000;

/** Provider operations include bounded native startup and cleanup. Ordinary status
 * and unrelated writes keep their short deadline; cold metadata must reach the UI. */
export function adminIpcTimeout(op: AdminIpcOp): number {
  // Native model discovery may take 30 s after startup on every platform;
  // Codex session catalogs can additionally validate cwd-specific settings.
  return ['settingsRead', 'settingsModels', 'settingsPatch', 'settingsAction', 'switchBackend', 'setPermissionMode'].includes(op.kind)
    ? 120_000 : ADMIN_IPC_TIMEOUT_MS;
}

export interface AdminIpcCaller {
  /** 发请求并等响应；超时/子进程退场 reject。op 必须可结构化克隆（纯 JSON）。 */
  call(op: AdminIpcOp, timeoutMs?: number): Promise<unknown>;
  /** 子进程来的消息直喂这里（proc.on('message', caller.onMessage)）；非本协议忽略。 */
  onMessage(raw: unknown): void;
  /** 子进程退出/重启时调用：在途请求全部拒绝（绝不悬挂）。 */
  rejectAll(reason: string): void;
}

/** One request/response channel pair over a child's IPC: the admin one (host → bot) and the host one (bot → host). */
export interface IpcChannels { req: string; res: string }
export interface IpcRequest<Op> { fcb: string; id: number; op: Op }
export interface IpcCaller<Op> {
  call(op: Op, timeoutMs?: number): Promise<unknown>;
  onMessage(raw: unknown): void;
  rejectAll(reason: string): void;
}

/**
 * The caller of either channel: requests numbered, each settled once by its response, its timeout or `rejectAll`.
 * `revive` turns a failed response back into the error the other side threw.
 */
export function createIpcCaller<Op>(channels: IpcChannels, send: (msg: IpcRequest<Op>) => void, opts: { timeoutMs: number | ((op: Op) => number); timeoutMessage?: (ms: number) => string; revive?: (msg: Partial<IpcResponse>) => Error }): IpcCaller<Op> {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  function settle(id: number): { resolve: (v: unknown) => void; reject: (e: Error) => void } | undefined {
    const entry = pending.get(id);
    if (!entry) return undefined;
    pending.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }

  return {
    call(op, timeoutMs = typeof opts.timeoutMs === 'function' ? opts.timeoutMs(op) : opts.timeoutMs): Promise<unknown> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(opts.timeoutMessage?.(timeoutMs) ?? `Bot 进程 ${timeoutMs}ms 未响应（可能正忙或已假死）`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        try {
          send({ fcb: channels.req, id, op });
        } catch (err) {
          settle(id)?.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },

    onMessage(raw): void {
      const msg = raw as Partial<IpcResponse> | null;
      if (!msg || msg.fcb !== channels.res || typeof msg.id !== 'number') return;
      const entry = settle(msg.id);
      if (!entry) return; // 已超时/已拒绝的迟到响应
      if (msg.ok) {
        entry.resolve(msg.result);
        return;
      }
      entry.reject(opts.revive?.(msg) ?? new Error(msg.error ?? '子进程执行失败'));
    },

    rejectAll(reason): void {
      for (const id of [...pending.keys()]) {
        settle(id)?.reject(new Error(reason));
      }
    },
  };
}

/** The other side of {@link createIpcCaller}: a thrown error is an `ok: false` response with its code; a send that fails (the peer is leaving) is dropped. */
export function createIpcResponder<Op>(channels: IpcChannels, execute: (op: Op) => Promise<unknown>, send: (msg: IpcResponse) => void): (raw: unknown) => void {
  return (raw) => {
    const msg = raw as Partial<IpcRequest<Op>> | null;
    if (!msg || msg.fcb !== channels.req || typeof msg.id !== 'number' || !msg.op) return;
    const id = msg.id;
    const reply = (response: Omit<IpcResponse, 'fcb' | 'id'>): void => {
      try {
        send({ fcb: channels.res, id, ...response });
      } catch {
        /* 对端退场中 */
      }
    };
    void execute(msg.op as Op).then(
      (result) => reply({ ok: true, result }),
      (err: unknown) => {
        const failure = err as {code?: string; chatId?: unknown} | null;
        const id = failure?.code === 'CREATED_UNSAVED' && groupIdSchema.safeParse(failure.chatId);
        reply({ok:false, error:err instanceof Error ? err.message : String(err), code:failure?.code,
          ...(id && id.success && {groupId:id.data})});
      },
    );
  };
}

const ADMIN_CHANNELS: IpcChannels = { req: ADMIN_IPC_REQ, res: ADMIN_IPC_RES };

/** supervisor 侧：每个子进程一个 caller（子进程重启后换新的——旧在途请求由
 * rejectAll 收尾）。`send` 注入 proc.send（测试里可直连 responder）。 */
export function createAdminIpcCaller(send: (msg: AdminIpcRequest) => void): AdminIpcCaller {
  return createIpcCaller<AdminIpcOp>(ADMIN_CHANNELS, msg => send(msg as AdminIpcRequest), {
    timeoutMs: adminIpcTimeout,
    revive: (msg) => {
      const reason = msg.error ?? '子进程执行失败';
      // 校验拒绝跨进程还原成 AdminWriteError —— HTTP 层与进程内路径同样映射 409。
      return msg.code === 'ADMIN_WRITE_REJECTED' ? new AdminWriteError(reason) : msg.code === 'GROUP_UPSTREAM' ? new GroupUpstreamError(reason) : msg.code === 'INVALID_GROUP_INPUT' ? new InvalidGroupInput(reason)
        : msg.code === 'CREATED_UNSAVED' ? Object.assign(new Error(reason), { code: msg.code, chatId: msg.groupId }) : new Error(reason);
    },
  });
}

/**
 * bot 子进程侧：把 supervisor 的请求接到执行器上（run.ts 把它挂到
 * process.on('message')）。`execute` 抛错 → ok:false 响应（带 code 供还原）；
 * 响应发送失败（supervisor 正退场）静默忽略。
 */
export function createAdminIpcResponder(
  execute: (op: AdminIpcOp) => Promise<unknown>,
  send: (msg: AdminIpcResponse) => void,
): (raw: unknown) => void {
  return createIpcResponder<AdminIpcOp>(ADMIN_CHANNELS, execute, msg => send(msg as AdminIpcResponse));
}

/** devices-4b 4.3: a Bot process slower than this is refused, not waited for (not ADMIN_IPC_TIMEOUT_MS). */
export const SESSION_IPC_TIMEOUT_MS = 5_000;
/** No turn to answer for: the grant is gone, the process is gone, or it did not answer (devices 15, 这一轮已结束). */
export const sessionTurnEnded = (): SessionAuthz => ({ ok: false, reason: 'turn-ended', message: SESSION_TURN_ENDED });
const short = z.string().min(1).max(200);
/** The answer as the host takes it: anything else, a local actor above all, is refused. */
export const sessionAuthzSchema: z.ZodType<SessionAuthz> = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true), role: z.enum(['owner', 'admin', 'member', 'bot']), openId: short.optional(), unionId: short.optional(), name: z.string().max(200).optional(),
    actor: z.discriminatedUnion('kind', [
      // A bot's turn may list its group's tasks: no openId then (and as a member it may create none).
      z.object({ kind: z.literal('session'), openId: z.string().max(200), role: z.enum(['owner', 'admin', 'member']), chatId: short, name: z.string().max(200).optional(), messageId: short.optional() }).strict(),
      z.object({ kind: z.literal('scheduled'), taskId: short, runId: short, chatId: short }).strict(),
      z.object({ kind: z.literal('dm'), via: z.literal('cli'), openId: short.optional(), name: z.string().max(200).optional(), chatId: short, messageId: short.optional() }).strict(),
    ]).optional(),
    memory: z.object({
      scope: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('project'), projectId: short }).strict(), z.object({ kind: z.literal('bot') }).strict(), z.object({ kind: z.literal('dm'), openId: short }).strict(),
      ]),
      trust: z.enum(['trusted', 'untrusted']),
      actor: z.object({ role: z.enum(['owner', 'admin', 'member', 'bot']), openId: short.optional() }).strict(),
      source: z.object({
        botId: short, turn: z.object({ kind: z.enum(['human', 'wake', 'initiative', 'retry', 'bot']), steered: z.boolean() }).strict().optional(),
        chatId: short.optional(), messageId: short.optional(), downgraded: z.enum(['member', 'not-human-turn', 'steered', 'not-typed', 'not-in-message', 'quota']).optional(),
        actorName: z.string().max(200).optional(),
      }).strict(),
      otherBot: z.boolean().optional(),
    }).strict().optional(),
  }).strict(),
  z.object({ ok: z.literal(false), reason: short, message: z.string().min(1).max(500) }).strict(),
]);

/**
 * The host asks a Bot process to authorize a session's ★ request. No process, no answer in time, a failure or an
 * answer of the wrong shape are all refusals: never a way through (devices 5.2).
 */
export async function askBotOver(ipc: Pick<AdminIpcCaller, 'call'> | undefined, sessionId: string, action: SessionAction): Promise<SessionAuthz> {
  if (!ipc) return sessionTurnEnded();
  try {
    const parsed = sessionAuthzSchema.safeParse(await ipc.call({ kind: 'authorizeSessionCall', sessionId, action }, SESSION_IPC_TIMEOUT_MS));
    return parsed.success ? parsed.data : sessionTurnEnded();
  } catch { return sessionTurnEnded(); }
}

/** devices-4a 4.2: bot → host. A bot process asks the host for its sessions' tokens (devices 5.3), the reverse of the admin channel. */
export const HOST_IPC_REQ = 'fcb.host.req' as const;
export const HOST_IPC_RES = 'fcb.host.res' as const;
/** A session does not start without its token, so a host that does not answer is given up on soon. */
export const HOST_IPC_TIMEOUT_MS = 5_000;
/**
 * A Feishu read may look a message up and then download for 60 s. The tool gives up at 70 s and the command line at 75 s,
 * so what they read is the Bot process's answer, or this limit's.
 */
export const FEISHU_READ_IPC_MS = 68_000;
export type HostIpcOp =
  | ({ kind: 'issueSessionToken' } & SessionInput)
  | { kind: 'revokeSessionToken'; sessionId: string }
  | ({ kind: 'feishuRead'; bot?: string } & RoutedRead)
  | ({ kind: 'feishuApi'; bot: string } & RoutedApi);
/** The result of a host op; a failure is the response's `error`, as on the admin channel. */
export type HostIpcReply = { kind: 'token'; token: string } | { kind: 'ok' } | { kind: 'feishuRead' | 'feishuApi'; reply: FeishuReadReply };
export interface HostApi {
  issueSessionToken(input: SessionInput): Promise<string>;
  revokeSessionToken(sessionId: string): Promise<void>;
  /** dm-agent 7.3: a private chat's read, on the Bot the host picks unless `bot` names one (feishu-route.ts). */
  feishuRead(bot: string | undefined, request: RoutedRead): Promise<FeishuReadReply>;
  /** `feishu_api` on the Bot named, for a private chat's session of this process (7.6). */
  feishuApi(bot: string, request: RoutedApi): Promise<FeishuReadReply>;
}
const HOST_CHANNELS: IpcChannels = { req: HOST_IPC_REQ, res: HOST_IPC_RES };
const hostOpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('issueSessionToken'), appId: z.string().min(1).max(200), chatId: z.string().min(1).max(200).optional(),
    place: z.enum(['dm', 'group', 'comment']), threadId: z.string().min(1).max(1000).optional(), sessionId: z.string().regex(SESSION_ID_RE),
  }).strict(),
  z.object({ kind: z.literal('revokeSessionToken'), sessionId: z.string().regex(SESSION_ID_RE) }).strict(),
  z.object({ kind: z.literal('feishuRead'), bot: z.string().min(1).max(200).optional(), sessionId: z.string().regex(SESSION_ID_RE), tool: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal('feishuApi'), bot: z.string().min(1).max(200), sessionId: z.string().regex(SESSION_ID_RE), request: apiRequestSchema }).strict(),
]);
const hostReplySchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('token'), token: z.string() }).strict(), z.object({ kind: z.literal('ok') }).strict(),
  z.object({ kind: z.enum(['feishuRead', 'feishuApi']), reply: feishuReadReplySchema }).strict()]);

/** The bot process's side: `send` is process.send; feed the host's messages to `onMessage`. */
export function createHostIpcCaller(send: (msg: IpcRequest<HostIpcOp>) => void): HostApi & { onMessage(raw: unknown): void; rejectAll(reason: string): void } {
  const caller = createIpcCaller<HostIpcOp>(HOST_CHANNELS, send, { timeoutMs: HOST_IPC_TIMEOUT_MS, timeoutMessage: ms => `vonvon 主进程 ${ms}ms 未响应` });
  const ask = async (op: HostIpcOp, ms?: number): Promise<HostIpcReply> => hostReplySchema.parse(await caller.call(op, ms));
  return {
    async issueSessionToken(input) {
      const reply = await ask({ kind: 'issueSessionToken', ...input });
      if (reply.kind !== 'token') throw new Error('The host did not answer with a token');
      return reply.token;
    },
    async revokeSessionToken(sessionId) { await ask({ kind: 'revokeSessionToken', sessionId }); },
    async feishuRead(bot, request) {
      // Past the host's own wait for the Bot process, so its answer gets here first.
      const reply = await ask({ kind: 'feishuRead', ...(bot !== undefined ? { bot } : {}), ...request }, FEISHU_READ_IPC_MS + 1_000);
      if (reply.kind !== 'feishuRead') throw new Error('The host did not answer with a read');
      return reply.reply;
    },
    async feishuApi(bot, request) {
      const reply = await ask({ kind: 'feishuApi', bot, ...request }, FEISHU_READ_IPC_MS + 1_000);
      if (reply.kind !== 'feishuApi') throw new Error('The host did not answer with a call');
      return reply.reply;
    },
    onMessage: caller.onMessage,
    rejectAll: caller.rejectAll,
  };
}

/** The host's side, one per bot child: a request that is not one of these ops is refused, not passed on. */
export function createHostIpcResponder(api: HostApi, send: (msg: IpcResponse) => void): { onMessage(raw: unknown): void } {
  return {
    onMessage: createIpcResponder<unknown>(HOST_CHANNELS, async (raw): Promise<HostIpcReply> => {
      const op = hostOpSchema.parse(raw);
      if (op.kind === 'revokeSessionToken') { await api.revokeSessionToken(op.sessionId); return { kind: 'ok' }; }
      if (op.kind === 'feishuRead') {
        const { kind: _read, bot, ...request } = op;
        return { kind: 'feishuRead', reply: await api.feishuRead(bot, request) };
      }
      if (op.kind === 'feishuApi') return { kind: 'feishuApi', reply: await api.feishuApi(op.bot, { sessionId: op.sessionId, request: op.request }) };
      const { kind: _kind, ...input } = op;
      return { kind: 'token', token: await api.issueSessionToken(input) };
    }, send),
  };
}
