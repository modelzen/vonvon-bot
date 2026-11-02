import type { AdminCollaborationOp } from './collaboration';
import type { BotSettingsScope, ModelQuery } from './settings-types';
import { GroupUpstreamError, InvalidGroupInput, type AdminGroupOp } from './groups';
import { AdminWriteError, type AdminWriteOp } from './ops';
import type { AdminLibraryOp } from './library';
import type { ScheduleRequest } from '@vonvon/protocol';
import { z } from 'zod';
import { SESSION_ID_RE, type SessionInput } from '../host/session-tokens';

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
/** Scheduled-task requests from the desktop and the terminal; the bot process runs them through schedule-commands as the local owner. */
export type AdminScheduleOp = { kind: 'schedule'; via: 'desktop' | 'cli'; request: ScheduleRequest };
export type AdminIpcOp = AdminCollaborationOp | AdminWriteOp | AdminGroupOp | AdminSettingsReadOp | AdminLibraryOp | AdminScheduleOp | { kind: 'status' };

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

/** 写请求默认超时：后端切换要 doctor 探活（单后端 3s 兜底）+ 驱逐，留足余量。 */
export const ADMIN_IPC_TIMEOUT_MS = 15_000;

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
export function createIpcCaller<Op>(channels: IpcChannels, send: (msg: IpcRequest<Op>) => void, opts: { timeoutMs: number; timeoutMessage?: (ms: number) => string; revive?: (msg: Partial<IpcResponse>) => Error }): IpcCaller<Op> {
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
    call(op, timeoutMs = opts.timeoutMs): Promise<unknown> {
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
      (err: unknown) => reply({ ok: false, error: err instanceof Error ? err.message : String(err), code: (err as { code?: string } | null)?.code }),
    );
  };
}

const ADMIN_CHANNELS: IpcChannels = { req: ADMIN_IPC_REQ, res: ADMIN_IPC_RES };

/** supervisor 侧：每个子进程一个 caller（子进程重启后换新的——旧在途请求由
 * rejectAll 收尾）。`send` 注入 proc.send（测试里可直连 responder）。 */
export function createAdminIpcCaller(send: (msg: AdminIpcRequest) => void): AdminIpcCaller {
  return createIpcCaller<AdminIpcOp>(ADMIN_CHANNELS, msg => send(msg as AdminIpcRequest), {
    timeoutMs: ADMIN_IPC_TIMEOUT_MS,
    revive: (msg) => {
      const reason = msg.error ?? '子进程执行失败';
      // 校验拒绝跨进程还原成 AdminWriteError —— HTTP 层与进程内路径同样映射 409。
      // 「群建好了没存上」只带回它的 code（s36d1），RPC 层据此让网页锁住建群表单。
      return msg.code === 'ADMIN_WRITE_REJECTED' ? new AdminWriteError(reason) : msg.code === 'GROUP_UPSTREAM' ? new GroupUpstreamError(reason) : msg.code === 'INVALID_GROUP_INPUT' ? new InvalidGroupInput(reason)
        : msg.code === 'CREATED_UNSAVED' ? Object.assign(new Error(reason), { code: msg.code }) : new Error(reason);
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

/** devices-4a 4.2: bot → host. A bot process asks the host for its sessions' tokens (devices 5.3), the reverse of the admin channel. */
export const HOST_IPC_REQ = 'fcb.host.req' as const;
export const HOST_IPC_RES = 'fcb.host.res' as const;
/** A session does not start without its token, so a host that does not answer is given up on soon. */
export const HOST_IPC_TIMEOUT_MS = 5_000;
export type HostIpcOp =
  | ({ kind: 'issueSessionToken' } & SessionInput)
  | { kind: 'revokeSessionToken'; sessionId: string };
/** The result of a host op; a failure is the response's `error`, as on the admin channel. */
export type HostIpcReply = { kind: 'token'; token: string } | { kind: 'ok' };
export interface HostApi {
  issueSessionToken(input: SessionInput): Promise<string>;
  revokeSessionToken(sessionId: string): Promise<void>;
}
const HOST_CHANNELS: IpcChannels = { req: HOST_IPC_REQ, res: HOST_IPC_RES };
const hostOpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('issueSessionToken'), appId: z.string().min(1).max(200), chatId: z.string().min(1).max(200).optional(),
    place: z.enum(['dm', 'group', 'comment']), threadId: z.string().min(1).max(1000).optional(), sessionId: z.string().regex(SESSION_ID_RE),
  }).strict(),
  z.object({ kind: z.literal('revokeSessionToken'), sessionId: z.string().regex(SESSION_ID_RE) }).strict(),
]);
const hostReplySchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('token'), token: z.string() }).strict(), z.object({ kind: z.literal('ok') }).strict()]);

/** The bot process's side: `send` is process.send; feed the host's messages to `onMessage`. */
export function createHostIpcCaller(send: (msg: IpcRequest<HostIpcOp>) => void): HostApi & { onMessage(raw: unknown): void; rejectAll(reason: string): void } {
  const caller = createIpcCaller<HostIpcOp>(HOST_CHANNELS, send, { timeoutMs: HOST_IPC_TIMEOUT_MS, timeoutMessage: ms => `vonvon 主进程 ${ms}ms 未响应` });
  const ask = async (op: HostIpcOp): Promise<HostIpcReply> => hostReplySchema.parse(await caller.call(op));
  return {
    async issueSessionToken(input) {
      const reply = await ask({ kind: 'issueSessionToken', ...input });
      if (reply.kind !== 'token') throw new Error('The host did not answer with a token');
      return reply.token;
    },
    async revokeSessionToken(sessionId) { await ask({ kind: 'revokeSessionToken', sessionId }); },
    onMessage: caller.onMessage,
    rejectAll: caller.rejectAll,
  };
}

/** The host's side, one per bot child: a request that is not one of the two ops is refused, not passed on. */
export function createHostIpcResponder(api: HostApi, send: (msg: IpcResponse) => void): { onMessage(raw: unknown): void } {
  return {
    onMessage: createIpcResponder<unknown>(HOST_CHANNELS, async (raw): Promise<HostIpcReply> => {
      const op = hostOpSchema.parse(raw);
      if (op.kind === 'revokeSessionToken') { await api.revokeSessionToken(op.sessionId); return { kind: 'ok' }; }
      const { kind: _kind, ...input } = op;
      return { kind: 'token', token: await api.issueSessionToken(input) };
    }, send),
  };
}
