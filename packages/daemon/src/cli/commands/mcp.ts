import { mcpRequestSchema, type McpConfig, type McpReply, type McpRequest } from '@vonvon/protocol';
import { badArgs, CommandError } from '../command-error';
import { print, printable, withDaemon, type Call, type Daemon, type Io } from '../daemon-client';

type Provider = McpRequest['provider'];
export type McpOptions = { provider: string; command?: string | undefined; arg?: string[] | undefined; env?: string[] | undefined; url?: string | undefined; bearerEnv?: string | undefined };
const LABEL: Record<Provider, string> = { codex: 'Codex', claude: 'Claude' };
const UNKNOWN = (provider: Provider) => `可能已经改了，运行 vonvon mcp list --provider ${provider} 查看。`;

function providerOf(raw: string): Provider {
  if (raw === 'codex' || raw === 'claude') return raw;
  throw badArgs('--provider 写 codex 或 claude。');
}

/** `--env NAME=VALUE`, or `NAME` alone for this shell's value: a key then never appears in the arguments. */
function stdioConfig(options: McpOptions, env: NodeJS.ProcessEnv): McpConfig {
  const vars: Record<string, string> = {};
  for (const item of options.env ?? []) {
    const at = item.indexOf('=');
    const name = at < 0 ? item : item.slice(0, at);
    const value = at < 0 ? env[name] : item.slice(at + 1);
    // the name only: the value may be a key
    if (value === undefined) throw badArgs(`--env ${printable(name)}：这个终端里没有这个环境变量。写成 --env ${printable(name)}=…，或者先设好它。`);
    vars[name] = value;
  }
  return { transport: 'stdio', command: options.command ?? '', args: options.arg ?? [], ...(options.env?.length ? { env: vars } : {}) };
}

/** The add request, checked against the protocol before anything is sent; issues name fields, never values. */
function addRequest(name: string, provider: Provider, options: McpOptions, env: NodeJS.ProcessEnv): Extract<McpRequest, { action: 'add' }> {
  const local = options.command !== undefined;
  if (local === (options.url !== undefined)) throw badArgs('写 --command（本机命令）或 --url（远程地址）其中一个。');
  if (local && options.bearerEnv !== undefined) throw badArgs('--bearer-env 只配 --url。');
  if (!local && (options.arg?.length || options.env?.length)) throw badArgs('--arg 和 --env 只配 --command。');
  const config: McpConfig = local ? stdioConfig(options, env) : { transport: 'http', url: options.url ?? '', ...(options.bearerEnv === undefined ? {} : { bearerTokenEnvVar: options.bearerEnv }) };
  return checked({ action: 'add', provider, name, revision: '-', config }) as Extract<McpRequest, { action: 'add' }>;
}
function checked(request: McpRequest): McpRequest {
  const parsed = mcpRequestSchema.safeParse(request);
  if (parsed.success) return parsed.data;
  throw badArgs(parsed.error.issues.map(issue => `${issue.path.join('.') || 'name'}：${issue.message}`).join('；'));
}

async function send(call: Call, what: string, request: McpRequest, unknown?: string): Promise<McpReply> {
  const reply = await call(what, c => c.machine({ type: 'mcp', request }), unknown ? { unknown } : {});
  if (reply.type !== 'mcp') throw new CommandError('failed', `${what}没有完成：daemon 回了意外的结果（${reply.type}）。`);
  // unavailable: no readable config, or no CLI to write it with (4); conflict: changed elsewhere since the read (5)
  if (reply.status === 'unavailable') throw new CommandError('refused', `${what}没有完成：${reply.message ?? '读不了配置。'}`, { reason: 'mcp_unavailable' });
  if (reply.status === 'conflict') throw new CommandError('conflict', `${what}没有完成：${reply.message ?? '配置刚被别处改过。'}重新运行一次。`, { reason: 'conflict', current: { revision: reply.revision, entries: reply.entries } });
  return reply;
}

function entryLine(entry: McpReply['entries'][number]): string {
  const parts = [entry.name, entry.transport];
  if (entry.transport === 'stdio') parts.push(`${entry.command ?? ''}（${entry.argumentCount ?? 0} 个参数）`);
  else if (entry.urlOrigin) parts.push(entry.urlOrigin);
  if (entry.envNames.length) parts.push(`环境变量：${entry.envNames.join('、')}`);
  if (entry.headerNames.length) parts.push(`请求头：${entry.headerNames.join('、')}`);
  if (!entry.enabled) parts.push('（已停用）');
  return parts.join('  ');
}
const entryLines = (reply: McpReply): string[] => reply.entries.length ? reply.entries.map(entryLine) : ['（没有 MCP 服务）'];

/**
 * `vonvon mcp list / add / remove` (cli-8-machine): the provider's own user configuration, as the web page's 本机 → MCP.
 * add and remove read the revision first, so a change made elsewhere since is a conflict (5), not overwritten. The
 * daemon answers names only, never a value.
 */
export async function runMcp(action: 'list' | 'add' | 'remove', name: string | undefined, options: McpOptions, io: Io, daemon: Daemon = withDaemon, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const provider = providerOf(options.provider);
  const add = action === 'add' ? addRequest(name ?? '', provider, options, env) : undefined;
  if (action === 'remove') checked({ action: 'remove', provider, name: name ?? '', revision: '-' });
  const reply = await daemon(async call => {
    const listed = await send(call, `读 ${LABEL[provider]} 的 MCP 配置`, { action: 'list', provider });
    if (action === 'list') return listed;
    const exists = listed.entries.some(entry => entry.name === name);
    const names = listed.entries.map(entry => entry.name).join('、') || '没有';
    if (add && exists) throw badArgs(`${LABEL[provider]} 的配置里已经有「${name}」，换个名字，或者先 vonvon mcp remove ${name} --provider ${provider}。`);
    if (!add && !exists) throw badArgs(`${LABEL[provider]} 的配置里没有「${printable(name ?? '')}」。现有的：${names}`);
    const request: McpRequest = add ? { ...add, revision: listed.revision } : { action: 'remove', provider, name: name ?? '', revision: listed.revision };
    return send(call, add ? '加 MCP 服务' : '删 MCP 服务', request, UNKNOWN(provider));
  });
  const where = `${LABEL[provider]} 的配置（${reply.configPath}）`;
  if (action === 'list') {
    const human = [`${where}：`, ...entryLines(reply)];
    if (!reply.cliAvailable) human.push(`没找到 ${LABEL[provider]} 的命令行：配置能看，加和删要先装好它。`);
    print(io, human, { provider, configPath: reply.configPath, revision: reply.revision, status: reply.status, entries: reply.entries });
    return;
  }
  const done = action === 'add' ? `已加到 ${where}。` : `已从 ${where}删掉「${name ?? ''}」。`;
  print(io, [done, ...reply.message ? [reply.message] : [], ...entryLines(reply)], { provider, configPath: reply.configPath, changed: Boolean(reply.changed), entries: reply.entries });
}
