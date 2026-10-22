import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'smol-toml';
import { McpService, nativeMcpPath, writeCodexMcp } from '../src/environment/mcp';
import { mcpReplySchema } from '@vonvon/protocol';
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'vonvon-mcp-settings-')); await mkdir(join(home, '.codex')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const env = () => ({ HOME: home, PATH: process.env.PATH, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude') });
const file = (provider: 'codex' | 'claude') => nativeMcpPath(provider, home, env());
const config = { transport: 'stdio' as const, command: '/usr/bin/true', args: ['do-not-return-this-secret'], env: { API_TOKEN: 'secret-env-value' } };

it('reads native user config passively and returns only safe summary metadata', async () => {
  await writeFile(file('codex'), stringify({ mcp_servers: { fixture: { url: 'https://user:password@example.test/private/token?key=secret', http_headers: { Authorization: 'secret-header' }, env_http_headers: { 'X-Token': 'TOKEN_ENV' }, bearer_token_env_var: 'ACCESS_TOKEN' }, command: { command: '/private/bin/tool', args: ['secret-arg'], env: { TOKEN: 'secret' } } } }));
  const command = vi.fn(); const writer = vi.fn();
  const service = new McpService({ home, env: env(), resolveTool: async () => '/bin/codex', command, writeCodex: writer });
  const reply = await service.run({ provider: 'codex', action: 'list' });
  mcpReplySchema.parse(reply);
  expect(reply).toMatchObject({ status: 'ready', entries: [{ name: 'fixture', urlOrigin: 'https://example.test', authorization: 'not-checked', envNames: ['ACCESS_TOKEN'], headerNames: ['Authorization', 'X-Token'], loginArgv: ['/bin/codex', 'mcp', 'login', '--', 'fixture'] }, { command: 'tool', argumentCount: 1, envNames: ['TOKEN'] }] });
  for (const secret of ['password', 'secret-header', 'private/token', 'secret-arg']) expect(JSON.stringify(reply)).not.toContain(secret);
  expect(command).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled();
});

it('saves through the versioned native editor, preserves other keys, and rejects stale writes', async () => {
  const writer = vi.fn(async (_exe, path, before, after) => {
    expect(before).toEqual({ existing: { command: 'keep' } });
    await writeFile(path, stringify({ model: 'keep-model', mcp_servers: after }));
  });
  const command = vi.fn();
  const service = new McpService({ home, env: env(), resolveTool: async () => '/bin/codex', command, writeCodex: writer });
  await writeFile(file('codex'), stringify({ model: 'keep-model', mcp_servers: { existing: { command: 'keep' } } }));
  const initial = await service.run({ provider: 'codex', action: 'list' });
  const added = await service.run({ provider: 'codex', action: 'add', name: 'fixture', revision: initial.revision, config });
  expect(added).toMatchObject({ status: 'ready', changed: true });
  expect(JSON.stringify(added)).not.toContain('secret-env-value');
  expect((await service.run({ provider: 'codex', action: 'remove', name: 'fixture', revision: initial.revision })).status).toBe('conflict');
  expect(command).not.toHaveBeenCalled();
  expect(writer).toHaveBeenCalledTimes(1);
});

it('uses Claude user scope and confirms writes/removal before reporting changed', async () => {
  await mkdir(join(home, '.claude'));
  const command = vi.fn(async (_exe: string, args: string[]) => {
    const old = JSON.parse(await readFile(file('claude'), 'utf8').catch(() => '{"other":"keep","mcpServers":{}}'));
    if (args[1] === 'add-json') { expect(args.slice(-2)).toEqual(['--scope', 'user']); old.mcpServers[args[2]!] = JSON.parse(args[3]!); }
    else { expect(args.slice(0, 5)).toEqual(['mcp', 'remove', '--scope', 'user', '--']); delete old.mcpServers[args[5]!]; }
    await writeFile(file('claude'), JSON.stringify(old)); return { exitCode: 0 };
  });
  const service = new McpService({ home, env: env(), resolveTool: async () => '/bin/claude', command });
  const initial = await service.run({ provider: 'claude', action: 'list' });
  const added = await service.run({ provider: 'claude', action: 'add', name: 'fixture', revision: initial.revision, config });
  expect(added.changed).toBe(true);
  const removed = await service.run({ provider: 'claude', action: 'remove', name: 'fixture', revision: added.revision });
  expect(removed).toMatchObject({ changed: true, entries: [] });
  expect(JSON.parse(await readFile(file('claude'), 'utf8')).other).toBe('keep');
});

it('does not expose command failures or accept unconfirmed native changes', async () => {
  const command = vi.fn(async () => { throw new Error('raw-secret-token'); });
  const service = new McpService({ home, env: env(), resolveTool: async () => '/bin/claude', command });
  const initial = await service.run({ provider: 'claude', action: 'list' });
  const failed = await service.run({ provider: 'claude', action: 'add', name: 'fixture', revision: initial.revision, config });
  expect(failed).toMatchObject({ status: 'unavailable', changed: false });
  expect(JSON.stringify(failed)).not.toContain('raw-secret');
  command.mockImplementation(async () => ({ exitCode: 0 }) as never);
  expect((await service.run({ provider: 'claude', action: 'add', name: 'fixture', revision: initial.revision, config })).changed).toBe(false);
});

it('refuses malformed config without overwriting it and validates names before native commands', async () => {
  await writeFile(file('codex'), 'invalid = [');
  const command = vi.fn(); const writer = vi.fn();
  const service = new McpService({ home, env: env(), resolveTool: async () => '/bin/codex', command, writeCodex: writer });
  expect((await service.run({ provider: 'codex', action: 'list' })).status).toBe('unavailable');
  expect(await readFile(file('codex'), 'utf8')).toBe('invalid = [');
  expect(() => service.run({ provider: 'codex', action: 'remove', name: '--danger', revision: 'x' })).toThrow();
  expect(command).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled();
});

it.skipIf(!process.env.VONVON_NATIVE_CODEX_MCP_BIN)('writes an isolated fresh native Codex user config without a session or OAuth', async () => {
  await writeCodexMcp(process.env.VONVON_NATIVE_CODEX_MCP_BIN!, file('codex'), {}, { fixture: { command: '/usr/bin/true', args: [] } }, home, env());
  expect(await readFile(file('codex'), 'utf8')).toContain('[mcp_servers.fixture]');
  await writeCodexMcp(process.env.VONVON_NATIVE_CODEX_MCP_BIN!, file('codex'), { fixture: { command: '/usr/bin/true', args: [] } }, { fixture: { command: '/usr/bin/true', args: [] }, http_fixture: { url: 'https://example.invalid/mcp' } }, home, env());
  expect(await readFile(file('codex'), 'utf8')).toContain('[mcp_servers.http_fixture]');
}, 30_000);


it.skipIf(!process.env.VONVON_NATIVE_CODEX_MCP_BIN || !process.env.VONVON_NATIVE_CLAUDE_MCP_BIN)('round trips isolated native user configs through the same add/list/remove service used by RPC', async () => {
  await mkdir(join(home, '.claude'));
  const service = new McpService({ home, env: env(), resolveTool: async provider => provider === 'codex' ? process.env.VONVON_NATIVE_CODEX_MCP_BIN! : process.env.VONVON_NATIVE_CLAUDE_MCP_BIN!, command: async (exe, args) => {
    await promisify(execFile)(exe, args, { env: env(), cwd: home, timeout: 20_000, maxBuffer: 64 * 1024 }); return { exitCode: 0 };
  } });
  for (const provider of ['codex', 'claude'] as const) {
    const initial = await service.run({ provider, action: 'list' });
    const added = await service.run({ provider, action: 'add', name: 'fixture', revision: initial.revision, config: { transport: 'stdio', command: '/usr/bin/true', args: [] } });
    expect(added, provider).toMatchObject({ status: 'ready', changed: true, entries: [expect.objectContaining({ name: 'fixture', command: 'true' })] });
    const removed = await service.run({ provider, action: 'remove', name: 'fixture', revision: added.revision });
    expect(removed, provider).toMatchObject({ status: 'ready', changed: true, entries: [] });
  }
}, 60_000);

it('routes machine MCP requests through the environment owner and refuses absent capabilities', async () => {
  const { machineRpc } = await import('../src/server/rpc/machine');
  const mcp = vi.fn(async () => ({ type: 'mcp' as const, provider: 'codex' as const, revision: 'one', entries: [], status: 'ready' as const, cliAvailable: true, configPath: '/fixture/config.toml' }));
  const owner = { environment: { mcp } } as unknown as NonNullable<Parameters<typeof machineRpc>[4]>;
  const unused = {} as Parameters<typeof machineRpc>[0];
  expect(await machineRpc(unused, undefined, 1, { type: 'mcp', request: { action: 'list', provider: 'codex' } }, owner)).toMatchObject({ kind: 'read', value: { type: 'mcp' } });
  expect(await machineRpc(unused, undefined, 1, { type: 'mcp', request: { action: 'remove', provider: 'codex', name: 'fixture', revision: 'one' } }, owner)).toMatchObject({ kind: 'mutation' });
  await expect(machineRpc(unused, undefined, 1, { type: 'mcp', request: { action: 'list', provider: 'codex' } })).rejects.toThrow();
  expect(mcp).toHaveBeenCalledTimes(2);
});
