import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { mcpRequestSchema, type McpConfig, type McpReply, type McpRequest } from '@vonvon/protocol';
import { AppServerClient } from '../agent/codex-appserver/app-server-client';
import type { ConfigReadResponse, ConfigWriteResponse } from '../agent/codex-appserver/protocol';

type Provider = McpRequest['provider'];
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const stable = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const LIMIT = 4 * 1024 * 1024;
export interface McpServiceOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  resolveTool(provider: Provider): Promise<string | null>;
  command(executable: string, args: string[]): Promise<{ exitCode: number | null }>;
  writeCodex?: typeof writeCodexMcp;
}

/** Only the provider's user configuration is managed here. Project and plugin layers remain native. */
export function nativeMcpPath(provider: Provider, home: string, env: NodeJS.ProcessEnv): string {
  return provider === 'codex' ? join(env.CODEX_HOME ? resolve(home, env.CODEX_HOME) : join(home, '.codex'), 'config.toml')
    : env.CLAUDE_CONFIG_DIR ? join(resolve(home, env.CLAUDE_CONFIG_DIR), '.claude.json') : join(home, '.claude.json');
}
async function snapshot(provider: Provider, file: string): Promise<{ revision: string; entries: ObjectValue }> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: digest(''), entries: {} }; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMIT) throw new Error('Invalid provider config');
    const raw = await handle.readFile('utf8');
    if (Buffer.byteLength(raw) > LIMIT) throw new Error('Invalid provider config');
    const parsed = provider === 'codex' ? parse(raw) : JSON.parse(raw);
    const top = object(parsed);
    const entries = top[provider === 'codex' ? 'mcp_servers' : 'mcpServers'];
    if (entries !== undefined && (!entries || typeof entries !== 'object' || Array.isArray(entries))) throw new Error('Invalid MCP config');
    return { revision: digest(raw), entries: object(entries) };
  } finally { await handle.close(); }
}
function summary(name: string, value: unknown, provider: Provider, executable: string | null): McpReply['entries'][number] {
  const config = object(value);
  const transport = typeof config.command === 'string' ? 'stdio' : typeof config.url === 'string' ? config.type === 'sse' ? 'sse' : 'http' : 'unknown';
  let urlOrigin: string | undefined;
  if (typeof config.url === 'string') { try { const url = new URL(config.url); urlOrigin = url.origin; } catch { /* do not echo malformed or interpolated credential URLs */ } }
  return { name, transport, source: 'user', enabled: config.enabled !== false, authorization: 'not-checked',
    ...(transport === 'stdio' ? { command: basename(String(config.command)), argumentCount: Array.isArray(config.args) ? config.args.length : 0 } : {}),
    ...(urlOrigin ? { urlOrigin } : {}),
    envNames: [...new Set([...Object.keys(object(config.env)), ...(Array.isArray(config.env_vars) ? config.env_vars.filter((v): v is string => typeof v === 'string') : []), ...(typeof config.bearer_token_env_var === 'string' ? [config.bearer_token_env_var] : [])])],
    headerNames: [...new Set([...Object.keys(object(config.http_headers)), ...Object.keys(object(config.env_http_headers)), ...Object.keys(object(config.headers))])],
    ...((transport === 'http' || transport === 'sse') && executable ? { loginArgv: [executable, 'mcp', 'login', '--', name] } : {}),
  };
}
function nativeConfig(provider: Provider, config: McpConfig): ObjectValue {
  if (config.transport === 'stdio') {
    if (/[\0\r\n]/.test(config.command) || config.args.some(arg => arg.includes('\0'))) throw new Error('Invalid command');
    return { ...(provider === 'claude' ? { type: 'stdio' } : {}), command: config.command, args: config.args, ...(config.env ? { env: config.env } : {}) };
  }
  const url = new URL(config.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid MCP URL');
  if (provider === 'codex') return { url: config.url, ...(config.bearerTokenEnvVar ? { bearer_token_env_var: config.bearerTokenEnvVar } : {}) };
  return { type: 'http', url: config.url, ...(config.bearerTokenEnvVar ? { headers: { Authorization: `Bearer \${${config.bearerTokenEnvVar}}` } } : {}) };
}

/** Native versioned config editor, without thread/start or mcp login. Unlike `mcp add --url`,
 * this does not start OAuth or launch a browser while merely saving a server. */
export async function writeCodexMcp(executable: string, file: string, before: ObjectValue, after: ObjectValue, home: string, env: NodeJS.ProcessEnv): Promise<void> {
  const client = new AppServerClient({ bin: executable, cwd: home, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)), clientName: 'vonvon-mcp-settings', replaceEnv: true, quietOutput: true, initializeTimeoutMs: 10_000 });
  try {
    await client.connect();
    const read = await client.request<ConfigReadResponse>('config/read', { includeLayers: true }, 10_000);
    const user = read.layers?.find(layer => layer.name.type === 'user' && layer.name.profile == null);
    if (!user || user.name.type !== 'user' || join(await realpath(dirname(file)), basename(file)) !== join(await realpath(dirname(user.name.file)), basename(user.name.file)) || stable(object(user.config).mcp_servers ?? {}) !== stable(before)) throw new Error('MCP configuration changed');
    const reply = await client.request<ConfigWriteResponse>('config/batchWrite', { filePath: user.name.type === 'user' ? user.name.file : file, expectedVersion: user.version, reloadUserConfig: false, edits: [{ keyPath: 'mcp_servers', value: after, mergeStrategy: 'replace' }] }, 10_000);
    if (reply.status !== 'ok' && reply.status !== 'okOverridden') throw new Error('Native config write failed');
  } finally { await client.close(); }
}

export class McpService {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: McpServiceOptions) {}
  run(input: McpRequest): Promise<McpReply> {
    const request = mcpRequestSchema.parse(input);
    const operation = this.chain.catch(() => undefined).then(() => this.execute(request));
    this.chain = operation;
    return operation;
  }
  private async execute(request: McpRequest): Promise<McpReply> {
    const env = this.options.env ?? process.env;
    const file = nativeMcpPath(request.provider, this.options.home, env);
    const executable = await this.options.resolveTool(request.provider).catch(() => null);
    const base = { type: 'mcp' as const, provider: request.provider, configPath: file, cliAvailable: executable !== null };
    const read = async (): Promise<McpReply> => {
      const current = await snapshot(request.provider, file);
      return { ...base, revision: current.revision, status: 'ready', entries: Object.entries(current.entries).map(([name, value]) => summary(name, value, request.provider, executable)), message: '本机用户配置。项目与插件连接仍由 Provider 加载；未检查授权或连接状态。' };
    };
    try {
      const before = await snapshot(request.provider, file);
      if (request.action === 'list') return read();
      if (before.revision !== request.revision) return { ...await read(), status: 'conflict', message: '配置已更新，请重新读取后再保存。' };
      if (!executable) return { ...await read(), status: 'unavailable', message: '请先安装这个 Provider 的 CLI。' };
      if (request.action === 'add') {
        if (Object.hasOwn(before.entries, request.name)) return { ...await read(), status: 'conflict', message: '已有同名连接，请使用其他名称。' };
        const config = nativeConfig(request.provider, request.config);
        if (request.provider === 'codex') await (this.options.writeCodex ?? writeCodexMcp)(executable, file, before.entries, { ...before.entries, [request.name]: config }, this.options.home, env);
        else {
          const result = await this.options.command(executable, ['mcp', 'add-json', request.name, JSON.stringify(config), '--scope', 'user']);
          if (result.exitCode !== 0) throw new Error('Native add failed');
        }
        const after = await snapshot(request.provider, file);
        if (stable(after.entries[request.name]) !== stable(config)) throw new Error('Native add not confirmed');
      } else {
        if (!Object.hasOwn(before.entries, request.name)) return { ...await read(), status: 'conflict', message: '连接已经移除，请重新读取。' };
        const args = request.provider === 'codex' ? ['mcp', 'remove', '--', request.name] : ['mcp', 'remove', '--scope', 'user', '--', request.name];
        const result = await this.options.command(executable, args);
        if (result.exitCode !== 0 || Object.hasOwn((await snapshot(request.provider, file)).entries, request.name)) throw new Error('Native remove not confirmed');
      }
      return { ...await read(), changed: true, message: '配置已保存，Provider 下次建立会话时读取。若需要授权，请在终端完成。' };
    } catch {
      // CLI output and parse errors can contain env values, headers or URL tokens. Never return them.
      const current = await read().catch((): McpReply => ({ ...base, status: 'unavailable', revision: '', entries: [] }));
      return { ...current, status: 'unavailable', changed: false, message: request.action === 'list' ? '无法读取 Provider 配置，请检查本机配置文件。' : '操作未完整完成，请重新读取配置确认结果。' };
    }
  }
}
