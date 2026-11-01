import { badArgs, CommandError, rpcErrorKind } from './command-error';
import { connectLocal, ConnectionError, RpcError, type VonvonClient } from '@vonvon/client';
import { backendLabel, conversationCopy, PROTOCOL_VERSION, requestSchema, type Agent, type Membership, type ServerInfo } from '@vonvon/protocol';
import { paths } from '../config/paths';
import { verifyPidLockOwner } from '../server/owner-verification';
import { PidLockError, readRunningPidLock } from '../server/pid-lock';

/** Where a command prints; `json` switches stdout to one JSON line, `{ ok: true, … }`. The entry point formats failures for --json. */
export type Io = { json: boolean; write(text: string): void };
export type Call = <T>(what: string, run: (c: VonvonClient) => Promise<T>, o?: { feishu?: boolean; unknown?: string; ms?: number }) => Promise<T>;
/** One connection for the whole command; s47 passes its own connector through `withDaemon`. `info`: the daemon's server info, when the connector has it. */
export type Daemon = <T>(fn: (call: Call, info?: ServerInfo) => Promise<T>) => Promise<T>;
export type DaemonConnection = { client: VonvonClient; serverInfo: ServerInfo };
/** Feishu calls get longer than the supervisor's 60 s IPC timeout, so the daemon's own error arrives first. */
export const TIMEOUTS = { local: 30_000, feishu: 75_000 };

const VERSION_MISMATCH = 'daemon 和命令行的版本不一致。先 vonvon daemon stop，再 vonvon daemon start。';
const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
const lines = (...parts: Array<string | undefined>): string => parts.filter(Boolean).join('\n');
const isZodError = (error: unknown): boolean => error instanceof Error && error.name === 'ZodError';
class CallTimeout extends Error {}
class BadRequest extends Error {}
/** C0, DEL and C1: a name from Feishu must not move the cursor or start an escape sequence. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
export const printable = (text: string): string => text.replace(CONTROL, '');

export async function connectLocalDaemon(home = paths.appDir, cliEntry = process.argv[1]): Promise<DaemonConnection> {
  let lock;
  try { lock = await readRunningPidLock(home); }
  catch (error) { throw new CommandError('connection', `连不上 daemon：${firstLine(error)}`); }
  if (!lock) throw new CommandError('connection', 'daemon 没有运行。先运行 vonvon daemon start。');
  if (!lock.listen) throw new CommandError('connection', 'daemon 正在启动，稍后再试。');
  // Covers a missing or wrong local-credential too: the check is an authenticated round trip.
  try { await verifyPidLockOwner(home, lock); }
  catch (error) {
    if (error instanceof PidLockError) throw new CommandError('connection', `连不上 daemon（PID ${lock.pid}）：本机凭据对不上，或者这个 PID 已经不是 daemon。运行 vonvon daemon status 查看。`);
    throw error;
  }
  if (!cliEntry) throw new CommandError('connection', 'Cannot locate the daemon CLI entry.');
  let connected: DaemonConnection;
  try { connected = await connectLocal({ home, cliEntry }); }
  catch (error) {
    // The child printed {"running":false}: the daemon stopped between the lock check and discovery.
    if (isZodError(error)) throw new CommandError('connection', 'daemon 刚刚停止了。先运行 vonvon daemon start。');
    const message = firstLine(error);
    if (message === 'Daemon closed during handshake') throw new CommandError('connection', 'daemon 在握手时断开了：本机凭据对不上，或者 daemon 刚好停止或重启了。稍后重试，或运行 vonvon daemon status 查看。');
    if (message === 'Daemon handshake timed out') throw new CommandError('connection', '和 daemon 握手超时。');
    throw new CommandError('connection', `连不上 daemon：${message}`);
  }
  // A daemon of another protocol answers only the maintenance kinds (devices 4.5); daemon stop and status do not come here.
  if (connected.serverInfo.protocolVersion !== PROTOCOL_VERSION) {
    await connected.client.close().catch(() => undefined);
    throw new CommandError('connection', VERSION_MISMATCH);
  }
  return connected;
}

function translate(what: string, error: unknown, ms: number, unknown?: string): Error {
  if (error instanceof BadRequest) return new CommandError('bad-args', `${what}没有发出：命令行给的参数不对（${error.message}）。`);
  if (error instanceof CallTimeout) return new CommandError(unknown ? 'outcome-unknown' : 'connection', lines(`daemon 在 ${ms / 1000} 秒内没有回应（${what}）。`, unknown, '运行 vonvon daemon logs 查看。'));
  // The bot process timed out or exited after the request reached it: the change may still land, so not "failed".
  if (error instanceof RpcError && unknown && error.code === 'operation_failed') return new CommandError('outcome-unknown', lines(`${what}没有确认：${error.message}`, unknown));
  if (error instanceof RpcError) return new CommandError(rpcErrorKind(error.code), lines(`${what}失败：${error.message}`, error.code === 'unsupported' ? 'daemon 可能比命令行旧。' : undefined), { reason: error.code });
  if (error instanceof ConnectionError || firstLine(error) === 'Daemon connection closed') return new CommandError(unknown ? 'outcome-unknown' : 'connection', lines('和 daemon 的连接断了，daemon 可能正在停止。', unknown));
  // checkRequests already parsed the request, so the client's own ZodError is a reply this CLI cannot read.
  if (isZodError(error)) return new CommandError(unknown ? 'outcome-unknown' : 'connection', lines(VERSION_MISMATCH, unknown));
  return new CommandError(unknown ? 'outcome-unknown' : 'failed', lines(`${what}失败：${firstLine(error)}`, unknown));
}

/** Client method → RPC method; snapshot() always sends the same payload. */
const METHODS = {
  run: 'command', settings: 'settings', collaboration: 'collaboration', environment: 'environment', machine: 'machine', admin: 'admin', directory: 'directory',
} as const;

/**
 * The client zod-parses a request before sending it and the reply after, and both throw a ZodError. Parsing the
 * request here first, with the same schema, tells a bad request (nothing sent) from a reply this CLI cannot read.
 */
function checkRequests(client: VonvonClient): VonvonClient {
  const checked: Record<string, unknown> = { ...client };
  for (const [name, method] of Object.entries(METHODS)) {
    const send = (client as unknown as Record<string, ((payload: unknown) => Promise<unknown>) | undefined>)[name];
    if (!send) continue;
    checked[name] = (payload: unknown) => {
      const parsed = requestSchema.safeParse({ type: 'request', id: 'cli', method, payload });
      if (parsed.success) return send.call(client, payload);
      const issue = parsed.error.issues[0];
      return Promise.reject(new BadRequest(issue ? `${issue.path.slice(1).join('.') || method}：${issue.message}` : parsed.error.message));
    };
  }
  return checked as unknown as VonvonClient;
}

/** Errors keep their line breaks; daemon or Feishu text inside them loses its control characters. */
function printableError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const message = error.message.split('\n').map(printable).join('\n');
  return message === error.message ? error : error instanceof CommandError ? new CommandError(error.kind, message, error) : new Error(message);
}

/** `connect` may give a bare client (the tests' fakes) or a connection with the server info. */
export async function withDaemon<T>(fn: (call: Call, info?: ServerInfo) => Promise<T>, connect: () => Promise<VonvonClient | DaemonConnection> = connectLocalDaemon, timeouts = TIMEOUTS): Promise<T> {
  const connected = await connect();
  const { client, serverInfo } = 'serverInfo' in connected ? connected : { client: connected, serverInfo: undefined };
  const checked = checkRequests(client);
  const call: Call = async (what, run, o = {}) => {
    const ms = o.ms ?? (o.feishu ? timeouts.feishu : timeouts.local);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CallTimeout()), ms); });
    // race keeps a handler on the losing call, so its late "connection closed" from close() is handled.
    try { return await Promise.race([run(checked), timeout]); }
    catch (error) { throw translate(what, error, ms, o.unknown); }
    finally { clearTimeout(timer); }
  };
  // Ordinary commands exit when the event loop drains, so an open socket would hang the CLI.
  try { return await fn(call, serverInfo); }
  catch (error) { throw printableError(error); }
  finally { await client.close().catch(() => undefined); }
}

/** `--fresh` (devices 8.1): the daemon probes the tools and rebuilds its snapshot, which it otherwise does every 5 s,
 * before the command reads. A write needs none: the daemon rebuilds before it answers one. */
export const freshDaemon: Daemon = fn => withDaemon(async (call, info) => {
  await call('刷新状态', c => c.run({ type: 'refresh', tools: true }));
  return fn(call, info);
});

/** Throws the reply's own message unless it is the expected kind. */
export function want<R extends { kind: string }, K extends R['kind']>(what: string, reply: R, kind: K, unknown?: string): Extract<R, { kind: K }> {
  if (reply.kind === kind) return reply as Extract<R, { kind: K }>;
  const message = 'message' in reply && typeof reply.message === 'string' ? reply.message : undefined;
  if (message !== undefined && (reply.kind === 'refused' || reply.kind === 'outcomeUnknown' || reply.kind === 'activationPending')) {
    throw new CommandError(reply.kind === 'outcomeUnknown' ? 'outcome-unknown' : 'refused', lines(`${what}没有完成：${message}`, reply.kind === 'outcomeUnknown' ? unknown : undefined));
  }
  throw new CommandError('failed', `${what}没有完成：daemon 回了意外的结果（${reply.kind}）。`);
}

export const NO_BOT = '还没有 Bot。运行 vonvon bot add 在终端里扫码注册，或者在网页里注册（vonvon open）。';

/** No "current bot": only a single bot is picked without --bot. */
export function pickBot(agents: readonly Agent[], wanted?: string): Agent {
  const [only] = agents;
  if (!only) throw badArgs(NO_BOT);
  // Error lines keep their own breaks (printableError), so a name loses a line break of its own here.
  const list = agents.map(agent => `${printable(agent.name)}（${agent.id}）`).join('、');
  if (wanted === undefined) {
    if (agents.length === 1) return only;
    throw badArgs(`有 ${agents.length} 个 Bot，用 --bot 指定：${list}`);
  }
  const byId = agents.find(agent => agent.id === wanted);
  if (byId) return byId;
  const named = agents.filter(agent => agent.name === wanted);
  if (named.length > 1) throw badArgs(`有 ${named.length} 个 Bot 都叫「${wanted}」，用 id 指定：${named.map(agent => agent.id).join('、')}`);
  if (named[0]) return named[0];
  throw badArgs(`没有找到 Bot「${wanted}」。现有的 Bot：${list}`);
}

/** Group id or project name; both are unique per bot because bind refuses a duplicate project name. */
export function pickGroup(memberships: readonly Membership[], bot: Agent, wanted: string): Membership {
  const own = memberships.filter(membership => membership.agentId === bot.id);
  const found = own.find(membership => membership.groupId === wanted) ?? own.find(membership => membership.name === wanted);
  if (!found) throw badArgs(`Bot「${printable(bot.name)}」没有绑定「${wanted}」。用 vonvon group list 查看。`);
  return found;
}

/** Each human line is printed without control characters; --json keeps the daemon's text as it is, after `ok: true`. */
export function print<T extends object>(io: Io, human: string[], json: T & { ok?: never }): void {
  if (io.json) io.write(`${JSON.stringify({ ok: true, ...json })}\n`);
  else if (human.length) io.write(`${human.map(printable).join('\n')}\n`);
}

export const withoutAvatar = <T extends { avatarDataUrl?: string }>({ avatarDataUrl: _avatar, ...rest }: T): Omit<T, 'avatarDataUrl'> => rest;
export const toolLabel = backendLabel;
export const conversationLabel = (conversation: string): string => conversation === 'threads' || conversation === 'shared' || conversation === 'smart' ? `${conversationCopy[conversation].name}（${conversationCopy[conversation].title}）` : conversation;
const pad = (value: number): string => String(value).padStart(2, '0');
export function localTime(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
