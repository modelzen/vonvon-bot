import { RpcError } from '@vonvon/client';
import type { AdminReply, SecretService, SecretUse } from '@vonvon/protocol';
import { keyProblem, secretsAction, type SecretsRequest, type SecretsView } from '../../admin/secrets';
import { getSecret, removeSecret, setSecret } from '../../config/keystore';
import { paths } from '../../config/paths';
import { inBotSession } from '../../config/session-env';
import { readStdin } from '../../core/stdin';
import { InputCancelled, readHidden } from '../../core/terminal-input';
import { decisionProviders, type DecisionProvider } from '../../judge/decision';
import { readRunningPidLock } from '../../server/pid-lock';
import { print, printable, want, withDaemon, type Daemon, type Io } from '../daemon-client';

const SESSION_REFUSED = '这组命令不能在 Bot 的会话里用，在自己的终端里运行。';
const ARGS_REFUSED = 'key 不写在命令参数里（会进 shell 的历史）。直接运行 vonvon secrets set <名字>，按提示粘贴；脚本里从标准输入传进来。';
/** A save may wait out the keystore's 30 s lock across processes. */
const SAVE_MS = 45_000;

export interface SecretsContext {
  io: Io;
  /** stderr: the prompt and the refusals */
  warn(text: string): void;
  exit(code: number): void;
  env: NodeJS.ProcessEnv;
  /** the key: asked for without echo on a terminal, else all of stdin */
  readKey(prompt: string): Promise<string>;
  /** a daemon holds the data root: requests then go to it, so it logs them and is the one writer */
  daemonRunning(): Promise<boolean>;
  daemon: Daemon;
  /** without a daemon: this process, on the files */
  direct(request: SecretsRequest): Promise<AdminReply>;
}

export function terminalContext(io: Io): SecretsContext {
  return {
    io, env: process.env,
    warn: text => { process.stderr.write(text); },
    exit: code => { process.exitCode = code; },
    readKey: prompt => process.stdin.isTTY ? readHidden(prompt, process.stdin, process.stderr) : readStdin(),
    // a lock that cannot be read counts as a daemon: connecting says why, and nothing is written behind its back
    daemonRunning: () => readRunningPidLock(paths.appDir).then(Boolean, () => true),
    daemon: withDaemon,
    direct: request => secretsAction(request),
  };
}

type Send = (what: string, request: SecretsRequest, ms?: number) => Promise<AdminReply>;
/** Connects before asking for the key. A daemon from before s23g refuses these requests as invalid; the files are
 * then written here, which the keystore's lock across processes allows. */
async function route<T>(ctx: SecretsContext, run: (send: Send, view: SecretsView) => Promise<T>): Promise<T> {
  const direct: Send = (_what, request) => ctx.direct(request);
  const local = async (): Promise<T> => run(direct, want('读密钥库', await direct('读密钥库', { type: 'secrets' }), 'secrets'));
  if (!await ctx.daemonRunning()) return local();
  const done = await ctx.daemon(async call => {
    const first = await call('读密钥库', c => c.admin({ type: 'secrets' }).catch((error: unknown) => {
      if (error instanceof RpcError && error.code === 'invalid_request') return undefined;
      throw error;
    }));
    if (!first) return undefined;
    const send: Send = (what, request, ms) => call(what, c => c.admin(request), ms ? { ms } : {});
    return { value: await run(send, want('读密钥库', first, 'secrets')) };
  });
  if (done) return done.value;
  ctx.warn('daemon 比命令行旧，不认这组请求，这次直接改本机的文件。之后运行 vonvon daemon restart。\n');
  return local();
}

function refused(ctx: SecretsContext): boolean {
  if (!inBotSession(ctx.env)) return false;
  ctx.warn(`${SESSION_REFUSED}\n`);
  ctx.exit(2);
  return true;
}
/** Never echoes the name it was given: a key typed in its place would land on the screen. */
function service(ctx: SecretsContext, name: string): DecisionProvider | undefined {
  const found = decisionProviders().find(p => p.keyId === name);
  if (!found) {
    ctx.warn(`不认识这个名字。能用的名字：${decisionProviders().map(p => `${p.keyId}（${p.displayName}）`).join('、')}\n`);
    ctx.exit(2);
  }
  return found;
}

const useText = (u: SecretUse): string => u.groupId === undefined ? `${u.agentName}（Bot 默认）`
  : `${u.groupName || '未命名群聊'}（${[u.agentName, u.inherited && '跟着 Bot 默认', u.notSmart && '现在不是智能群'].filter(Boolean).join('，')}）`;
const statusText = (s: SecretService): string => s.status === 'set' ? `已填${s.last4 ? ` ••••${s.last4}` : ''}`
  : s.status === 'missing' ? '还没填'
  : s.status === 'invalid' ? '存着的 key 不能用（有空格或看不见的字符），重新填一次'
  : `读不了：${s.problem}（${s.code}）。vonvon daemon logs 里的 secrets.unreadable 有原话`;

export async function runSecretsList(ctx: SecretsContext): Promise<void> {
  if (refused(ctx)) return;
  const view = await route(ctx, async (_send, first) => first);
  const human = view.services.flatMap(s => [
    `${s.displayName}（${s.keyId}）  ${statusText(s)}`,
    `  ${s.inUse.length ? `在用：${s.inUse.map(useText).join('、')}` : '现在没有 Bot 或飞书群选它'}`,
  ]);
  if (view.unreadBots) human.push(`有 ${view.unreadBots} 个 Bot 的设置读不了，没算进来；vonvon daemon logs 里的 secrets.bot-unreadable 有原因。`);
  print(ctx.io, human, { services: view.services, unreadBots: view.unreadBots });
  if (view.services.some(s => s.status === 'unreadable')) ctx.exit(1);
}

function testText(reply: AdminReply, keyId: string): string {
  if (reply.kind !== 'secretTested') return `没试成：${reply.kind === 'refused' ? reply.message : reply.kind}`;
  if (reply.outcome === 'ok' || reply.outcome === 'busy') return `试了一次：${reply.message}`;
  const next = reply.outcome === 'auth' ? '换一个 key' : 'key 已经存下，要再试一次';
  return `试了一次：${reply.message}。${next}：重新运行 vonvon secrets set ${keyId}`;
}

/** `secrets set <名字>`: the key from a hidden prompt or stdin, never an argument; saved, then tried once. */
export async function runSecretsSet(name: string, extra: string[], options: { raw?: boolean }, ctx: SecretsContext): Promise<void> {
  if (refused(ctx)) return;
  if (extra.length) { ctx.warn(`${ARGS_REFUSED}\n`); ctx.exit(2); return; }
  try {
    if (options.raw) { await rawSet(name, ctx); return; }
    const provider = service(ctx, name);
    if (!provider) return;
    await route(ctx, async send => {
      const value = (await ctx.readKey(`粘贴 ${provider.displayName} 的 key（不回显），回车结束：`)).trim();
      const problem = keyProblem(value);
      if (problem) { ctx.warn(`没有存：${problem}。\n`); ctx.exit(2); return; }
      const view = want('存 key', await send('存 key', { type: 'setSecret', keyId: provider.keyId, value }, SAVE_MS), 'secrets');
      const last4 = view.services.find(s => s.keyId === provider.keyId)?.last4;
      ctx.io.write(`✓ 已存 ${provider.displayName} 的 key${last4 ? `（末四位 ${last4}）` : ''}\n`);
      ctx.io.write(`${testText(await send('试 key', { type: 'testSecret', keyId: provider.keyId }), provider.keyId)}\n`);
    });
  } catch (error) {
    if (!(error instanceof InputCancelled)) throw error;
    ctx.exit(130);
  }
}

/** `--raw <id>`: an entry by its id, for internal use and repairs; no shape check, no daemon. */
async function rawSet(id: string, ctx: SecretsContext): Promise<void> {
  const value = (await ctx.readKey(`粘贴 ${printable(id)} 的值（不回显），回车结束：`)).trim();
  if (!value) { ctx.warn('没有读到值：从标准输入传进来，或者在终端里按提示粘贴。\n'); ctx.exit(2); return; }
  await setSecret(id, value);
  ctx.io.write(`✓ 已存储密钥: ${printable(id)}\n`);
}

export async function runSecretsRemove(name: string, options: { raw?: boolean }, ctx: SecretsContext): Promise<void> {
  if (refused(ctx)) return;
  if (options.raw) {
    ctx.io.write(await removeSecret(name) ? `✓ 已删除: ${printable(name)}\n` : `未找到: ${printable(name)}\n`);
    return;
  }
  const provider = service(ctx, name);
  if (!provider) return;
  await route(ctx, async send => {
    const view = want('删 key', await send('删 key', { type: 'removeSecret', keyId: provider.keyId }, SAVE_MS), 'secrets');
    const uses = view.services.find(s => s.keyId === provider.keyId)?.inUse ?? [];
    print(ctx.io, !view.removed ? [`${provider.displayName} 的 key 本来就没填。`] : [
      `✓ 已删 ${provider.displayName} 的 key。`,
      ...uses.length ? [`还选着它的：${uses.map(useText).join('、')}；它们要判断的消息按出错处理（没 @ Bot 的不回，@ 的回在主区），重新填就恢复。`] : [],
    ], {});
  });
}

/** What `secrets get` answers for `ids`. A decision provider's key is never handed out: only the daemon reads it, and
 * this runs in bot sessions too, where lark-cli resolves the App Secret through it (s23g). */
export async function secretValues(ids: string[], read: typeof getSecret = getSecret): Promise<{ values: Record<string, string>; errors: Record<string, { message: string }> }> {
  const kept = new Set(decisionProviders().map(p => p.keyId));
  const values: Record<string, string> = {};
  const errors: Record<string, { message: string }> = {};
  for (const id of ids) {
    if (kept.has(id)) { errors[id] = { message: 'not handed out: only the daemon reads this key' }; continue; }
    try {
      const v = await read(id);
      if (v !== undefined) values[id] = v;
      else errors[id] = { message: 'not found' };
    } catch (err) {
      errors[id] = { message: err instanceof Error ? err.message : String(err) };
    }
  }
  return { values, errors };
}

/**
 * `secrets get` — exec-provider endpoint. Reads a JSON-RPC-ish request from
 * stdin (`{ protocolVersion, provider, ids: [...] }`) and writes
 * `{ values: { id: secret }, errors: { id: { message } } }` to stdout.
 * Invoked by the secrets-getter wrapper (and lark-cli) to resolve secrets.
 */
export async function secretsGet(): Promise<void> {
  const input = await readStdin();
  let ids: string[] = [];
  try {
    const req = JSON.parse(input) as { ids?: string[] };
    ids = Array.isArray(req.ids) ? req.ids : [];
  } catch {
    process.stdout.write(JSON.stringify({ values: {}, errors: { _: { message: 'invalid request JSON' } } }));
    return;
  }
  process.stdout.write(JSON.stringify(await secretValues(ids)));
}
