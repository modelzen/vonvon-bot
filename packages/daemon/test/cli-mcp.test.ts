import { expect, it, vi } from 'vitest';
import type { VonvonClient } from '@vonvon/client';
import type { McpReply, McpRequest } from '@vonvon/protocol';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import { runMcp, type McpOptions } from '../src/cli/commands/mcp';

/** cli-8-machine: mcp list / add / remove through a fake client behind the real withDaemon. */
const entry = (name: string, extra: Partial<McpReply['entries'][number]> = {}): McpReply['entries'][number] => ({
  name, transport: 'stdio', source: 'user', command: 'npx', argumentCount: 2, envNames: ['TOKEN'], headerNames: [], enabled: true, authorization: 'not-checked', ...extra,
});
const reply = (extra: Partial<McpReply> = {}): McpReply => ({
  type: 'mcp', provider: 'codex', configPath: '/home/u/.codex/config.toml', revision: 'r1', status: 'ready', cliAvailable: true, entries: [entry('old')], ...extra,
});
function harness(answer: (request: McpRequest) => McpReply) {
  const machine = vi.fn(async ({ request }: { request: McpRequest }) => answer(request));
  const close = vi.fn(async () => {});
  const daemon: Daemon = fn => withDaemon(fn, async () => ({ machine, close }) as unknown as VonvonClient, { local: 50, feishu: 50 });
  let out = '';
  return { machine, close, daemon, io: (json = false) => ({ json, write: (text: string) => { out += text; } }), out: () => out };
}
const caught = (promise: Promise<unknown>) => promise.then(() => { throw new Error('resolved'); }, (error: unknown) => error as { kind: string; message: string; reason?: string; current?: unknown });
const add = (extra: Partial<McpOptions> = {}): McpOptions => ({ provider: 'codex', command: 'npx', arg: ['-y', 'gh-mcp'], env: ['TOKEN'], ...extra });

// main 必败: there was no mcp add
it('mcp add reads the revision first and takes a --env NAME value from the shell, never printing it', async () => {
  const h = harness(request => request.action === 'list' ? reply() : reply({ revision: 'r2', changed: true, entries: [entry('old'), entry('gh')], message: '配置已保存。' }));
  await runMcp('add', 'gh', add(), h.io(true), h.daemon, { TOKEN: 'x-secret-value' });
  expect(h.machine.mock.calls.map(([call]) => call)).toEqual([
    { type: 'mcp', request: { action: 'list', provider: 'codex' } },
    { type: 'mcp', request: { action: 'add', provider: 'codex', name: 'gh', revision: 'r1', config: { transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: { TOKEN: 'x-secret-value' } } } },
  ]);
  expect(JSON.parse(h.out())).toEqual({ ok: true, provider: 'codex', configPath: '/home/u/.codex/config.toml', changed: true, entries: [entry('old'), entry('gh')] });
  expect(h.out()).not.toContain('x-secret-value');
  expect(h.close).toHaveBeenCalled();
  // NAME=VALUE is taken as given; the human output lists names only
  const human = harness(request => request.action === 'list' ? reply({ entries: [] }) : reply({ changed: true, entries: [entry('gh')] }));
  await runMcp('add', 'gh', add({ env: ['TOKEN=inline-secret'] }), human.io(), human.daemon, {});
  expect(human.machine.mock.calls[1]?.[0]).toMatchObject({ request: { config: { env: { TOKEN: 'inline-secret' } } } });
  expect(human.out()).toBe('已加到 Codex 的配置（/home/u/.codex/config.toml）。\ngh  stdio  npx（2 个参数）  环境变量：TOKEN\n');
});

// main 必败: there was no mcp add
it('mcp add refuses bad arguments before it connects', async () => {
  const h = harness(() => reply());
  for (const [options, message] of [
    [add({ env: ['TOKEN'] }), '--env TOKEN：这个终端里没有这个环境变量。写成 --env TOKEN=…，或者先设好它。'],
    [add({ url: 'https://example.com/mcp' }), '写 --command（本机命令）或 --url（远程地址）其中一个。'],
    [{ provider: 'codex' }, '写 --command（本机命令）或 --url（远程地址）其中一个。'],
    [{ provider: 'codex', url: 'https://example.com/mcp', env: ['A=1'] }, '--arg 和 --env 只配 --command。'],
    [add({ bearerEnv: 'T' }), '--bearer-env 只配 --url。'],
    [add({ provider: 'cursor' }), '--provider 写 codex 或 claude。'],
  ] as Array<[McpOptions, string]>) expect(await caught(runMcp('add', 'gh', options, h.io(), h.daemon, {})), message).toMatchObject({ kind: 'bad-args', message });
  // the protocol's own checks: the name, a variable name
  expect(await caught(runMcp('add', '-bad', add({ env: [] }), h.io(), h.daemon, {}))).toMatchObject({ kind: 'bad-args', message: expect.stringContaining('name') });
  expect(await caught(runMcp('add', 'gh', add({ env: ['1X=y'] }), h.io(), h.daemon, {}))).toMatchObject({ kind: 'bad-args' });
  expect(h.machine).not.toHaveBeenCalled();
});

// main 必败: there was no mcp add or remove
it('mcp add and remove pass on a conflict (5) and an unavailable provider (4), and check the name in the list first', async () => {
  const conflict = harness(request => request.action === 'list' ? reply() : reply({ status: 'conflict', revision: 'r9', message: '配置已更新，请重新读取后再保存。' }));
  expect(await caught(runMcp('remove', 'old', { provider: 'codex' }, conflict.io(), conflict.daemon))).toMatchObject({ kind: 'conflict', reason: 'conflict', current: { revision: 'r9' } });
  expect(conflict.machine.mock.calls[1]?.[0]).toEqual({ type: 'mcp', request: { action: 'remove', provider: 'codex', name: 'old', revision: 'r1' } });
  const missing = harness(request => request.action === 'list' ? reply() : reply({ status: 'unavailable', message: '请先安装这个 Provider 的 CLI。' }));
  expect(await caught(runMcp('add', 'gh', add({ env: [] }), missing.io(), missing.daemon, {}))).toMatchObject({ kind: 'refused', reason: 'mcp_unavailable', message: expect.stringContaining('请先安装这个 Provider 的 CLI。') });
  const listed = harness(() => reply());
  expect(await caught(runMcp('remove', 'nope', { provider: 'codex' }, listed.io(), listed.daemon))).toMatchObject({ kind: 'bad-args', message: 'Codex 的配置里没有「nope」。现有的：old' });
  expect(await caught(runMcp('add', 'old', add({ env: [] }), listed.io(), listed.daemon, {}))).toMatchObject({ kind: 'bad-args' });
  expect(listed.machine).toHaveBeenCalledTimes(2);
});

// main 必败: there was no mcp list
it('mcp list prints names, commands and variable names, and says when the CLI is missing', async () => {
  const h = harness(() => reply({ provider: 'claude', configPath: '/home/u/.claude.json', cliAvailable: false, entries: [entry('gh'), { name: 'docs', transport: 'http', source: 'user', urlOrigin: 'https://example.com', envNames: [], headerNames: ['Authorization'], enabled: false, authorization: 'not-checked' }] }));
  await runMcp('list', undefined, { provider: 'claude' }, h.io(), h.daemon);
  expect(h.out()).toBe('Claude 的配置（/home/u/.claude.json）：\ngh  stdio  npx（2 个参数）  环境变量：TOKEN\ndocs  http  https://example.com  请求头：Authorization  （已停用）\n'
    + '没找到 Claude 的命令行：配置能看，加和删要先装好它。\n');
  const json = harness(() => reply());
  await runMcp('list', undefined, { provider: 'codex' }, json.io(true), json.daemon);
  expect(JSON.parse(json.out())).toEqual({ ok: true, provider: 'codex', configPath: '/home/u/.codex/config.toml', revision: 'r1', status: 'ready', entries: [entry('old')] });
});
