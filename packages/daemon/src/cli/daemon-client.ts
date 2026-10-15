import { connectLocal, ConnectionError, RpcError, type VonvonClient } from '@vonvon/client';
import type { Agent, Membership } from '@vonvon/protocol';
import { paths } from '../config/paths';
import { verifyPidLockOwner } from '../server/owner-verification';
import { PidLockError, readRunningPidLock } from '../server/pid-lock';

/** Where a command prints; `json` switches stdout to one JSON line. Errors stay plain text on stderr. */
export type Io = { json: boolean; write(text: string): void };
export type Call = <T>(what: string, run: (c: VonvonClient) => Promise<T>, o?: { feishu?: boolean; unknown?: string }) => Promise<T>;
/** One connection for the whole command; s47 passes its own connector through `withDaemon`. */
export type Daemon = <T>(fn: (call: Call) => Promise<T>) => Promise<T>;
/** Feishu calls get longer than the supervisor's 60 s IPC timeout, so the daemon's own error arrives first. */
export const TIMEOUTS = { local: 30_000, feishu: 75_000 };

const VERSION_MISMATCH = 'daemon 和命令行的版本不一致。先 vonvon daemon stop，再 vonvon daemon start。';
const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
const lines = (...parts: Array<string | undefined>): string => parts.filter(Boolean).join('\n');
const isZodError = (error: unknown): boolean => error instanceof Error && error.name === 'ZodError';
class CallTimeout extends Error {}

export async function connectLocalDaemon(home = paths.appDir, cliEntry = process.argv[1]): Promise<VonvonClient> {
  let lock;
  try { lock = await readRunningPidLock(home); }
  catch (error) { throw new Error(`连不上 daemon：${firstLine(error)}`); }
  if (!lock) throw new Error('daemon 没有运行。先运行 vonvon daemon start。');
  if (!lock.listen) throw new Error('daemon 正在启动，稍后再试。');
  // Covers a missing or wrong local-credential too: the check is an authenticated round trip.
  try { await verifyPidLockOwner(home, lock); }
  catch (error) {
    if (error instanceof PidLockError) throw new Error(`连不上 daemon（PID ${lock.pid}）：本机凭据对不上，或者这个 PID 已经不是 daemon。运行 vonvon daemon status 查看。`);
    throw error;
  }
  if (!cliEntry) throw new Error('Cannot locate the daemon CLI entry.');
  try { return await connectLocal({ home, cliEntry }); }
  catch (error) {
    // The child printed {"running":false}: the daemon stopped between the lock check and discovery.
    if (isZodError(error)) throw new Error('daemon 刚刚停止了。先运行 vonvon daemon start。');
    const message = firstLine(error);
    if (message === 'Daemon closed during handshake') throw new Error('daemon 没有接受本机凭据。');
    if (message === 'Daemon handshake timed out') throw new Error('和 daemon 握手超时。');
    if (message.includes('protocol version mismatch')) throw new Error(VERSION_MISMATCH);
    throw new Error(`连不上 daemon：${message}`);
  }
}

function translate(what: string, error: unknown, ms: number, unknown?: string): Error {
  if (error instanceof CallTimeout) return new Error(lines(`daemon 在 ${ms / 1000} 秒内没有回应（${what}）。`, unknown, '运行 vonvon daemon logs 查看。'));
  if (error instanceof RpcError) return new Error(lines(`${what}失败：${error.message}`, error.code === 'unsupported' ? 'daemon 可能比命令行旧。' : undefined));
  if (error instanceof ConnectionError || firstLine(error) === 'Daemon connection closed') return new Error(lines('和 daemon 的连接断了，daemon 可能正在停止。', unknown));
  if (isZodError(error)) return new Error(VERSION_MISMATCH);
  return new Error(`${what}失败：${firstLine(error)}`);
}

export async function withDaemon<T>(fn: (call: Call) => Promise<T>, connect = connectLocalDaemon, timeouts = TIMEOUTS): Promise<T> {
  const client = await connect();
  const call: Call = async (what, run, o = {}) => {
    const ms = o.feishu ? timeouts.feishu : timeouts.local;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CallTimeout()), ms); });
    // race keeps a handler on the losing call, so its late "connection closed" from close() is handled.
    try { return await Promise.race([run(client), timeout]); }
    catch (error) { throw translate(what, error, ms, o.unknown); }
    finally { clearTimeout(timer); }
  };
  // Ordinary commands exit when the event loop drains, so an open socket would hang the CLI.
  try { return await fn(call); }
  finally { await client.close().catch(() => undefined); }
}

/** Throws the reply's own message unless it is the expected kind. */
export function want<R extends { kind: string }, K extends R['kind']>(what: string, reply: R, kind: K, unknown?: string): Extract<R, { kind: K }> {
  if (reply.kind === kind) return reply as Extract<R, { kind: K }>;
  const message = 'message' in reply && typeof reply.message === 'string' ? reply.message : undefined;
  if (message !== undefined && (reply.kind === 'refused' || reply.kind === 'outcomeUnknown' || reply.kind === 'activationPending')) {
    throw new Error(lines(`${what}没有完成：${message}`, reply.kind === 'outcomeUnknown' ? unknown : undefined));
  }
  throw new Error(`${what}没有完成：daemon 回了意外的结果（${reply.kind}）。`);
}

/** No "current bot": only a single bot is picked without --bot. */
export function pickBot(agents: readonly Agent[], wanted?: string): Agent {
  const [only] = agents;
  if (!only) throw new Error('还没有 bot。在网页里扫码注册（vonvon open）。');
  const list = agents.map(agent => `${agent.name}（${agent.id}）`).join('、');
  if (wanted === undefined) {
    if (agents.length === 1) return only;
    throw new Error(`有 ${agents.length} 个 bot，用 --bot 指定：${list}`);
  }
  const byId = agents.find(agent => agent.id === wanted);
  if (byId) return byId;
  const named = agents.filter(agent => agent.name === wanted);
  if (named.length > 1) throw new Error(`有 ${named.length} 个 bot 都叫「${wanted}」，用 id 指定：${named.map(agent => agent.id).join('、')}`);
  if (named[0]) return named[0];
  throw new Error(`没有找到 bot「${wanted}」。现有的 bot：${list}`);
}

/** Group id or project name; both are unique per bot because bind refuses a duplicate project name. */
export function pickGroup(memberships: readonly Membership[], bot: Agent, wanted: string): Membership {
  const own = memberships.filter(membership => membership.agentId === bot.id);
  const found = own.find(membership => membership.groupId === wanted) ?? own.find(membership => membership.name === wanted);
  if (!found) throw new Error(`bot「${bot.name}」没有绑定「${wanted}」。用 vonvon group list 查看。`);
  return found;
}

export function print(io: Io, human: string[], json: unknown): void {
  if (io.json) io.write(`${JSON.stringify(json)}\n`);
  else if (human.length) io.write(`${human.join('\n')}\n`);
}

export const withoutAvatar = <T extends { avatarDataUrl?: string }>({ avatarDataUrl: _avatar, ...rest }: T): Omit<T, 'avatarDataUrl'> => rest;
export const toolLabel = (backend: string): string => backend === 'codex-appserver' ? 'Codex' : backend === 'claude-agent' ? 'Claude' : backend;
export const conversationLabel = (conversation: string): string => conversation === 'threads' ? '按话题独立会话' : conversation === 'shared' ? '整群连续会话' : conversation;
const pad = (value: number): string => String(value).padStart(2, '0');
export function localTime(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
