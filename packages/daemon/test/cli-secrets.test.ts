import { basename } from 'node:path';
import { KEYSTORE_READ_FILES } from '../src/config/keystore';
import { paths } from '../src/config/paths';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { RpcError, type VonvonClient } from '@vonvon/client';
import type { AdminReply, AdminRequest, SecretService } from '@vonvon/protocol';
import { withDaemon } from '../src/cli/daemon-client';
import { runSecretsList, runSecretsRemove, runSecretsSet, parseExecRequest, secretValues, secretsGet, type SecretsContext } from '../src/cli/commands/secrets';
import { InputCancelled, readHidden } from '../src/core/terminal-input';

const KEY = 'ts_TESTKEY0000';
const service = (extra: Partial<SecretService> = {}): SecretService => ({
  provider: 'typesafe', displayName: 'TypeSafe', keyId: 'typesafe-api-key', models: [{ id: 'jev-latest', displayName: 'Jev' }], status: 'missing', inUse: [], ...extra,
});
const USES = [
  { agentId: 'cli_a', agentName: '值班助手' },
  { agentId: 'cli_a', agentName: '值班助手', groupId: 'oc_1', groupName: '发布群', inherited: true },
  { agentId: 'cli_a', agentName: '值班助手', groupId: 'oc_2', groupName: '', notSmart: true },
];

/** A context whose requests go to `answer`, through the real withDaemon when `daemon` is on. */
function context(answer: (request: AdminRequest) => AdminReply | Promise<AdminReply>, o: { daemon?: boolean; key?: string | Error; env?: NodeJS.ProcessEnv; json?: boolean } = {}) {
  let out = ''; let err = '';
  const sent: AdminRequest[] = [];
  const admin = vi.fn(async (request: AdminRequest) => { sent.push(request); return answer(request); });
  const direct = vi.fn(async (request: AdminRequest) => { sent.push(request); return answer(request); });
  const readKey = vi.fn(async () => { if (o.key instanceof Error) throw o.key; return o.key ?? ''; });
  const connect = vi.fn(async () => ({ admin, close: async () => {} }) as unknown as VonvonClient);
  const ctx: SecretsContext = {
    io: { json: o.json ?? false, write: text => { out += text; } }, warn: text => { err += text; },
    env: o.env ?? {}, readKey, daemonRunning: async () => o.daemon ?? false,
    daemon: fn => withDaemon(fn, connect, { local: 50, feishu: 50 }), direct: direct as SecretsContext['direct'],
  };
  return { ctx, sent, admin, direct, readKey, connect, out: () => out, err: () => err };
}
/** devices 8.1: the entry point prints the message and exits with the kind's code (`commandFailure`). */
const failure = (kind: string, message?: string, extra: object = {}) => expect.objectContaining({ kind, ...(message === undefined ? {} : { message }), ...extra });
const view = (s: SecretService, extra: object = {}): AdminReply => ({ kind: 'secrets', services: [s], unreadBots: 0, ...extra });

describe('vonvon secrets (s23g)', () => {
  it('list: state, last four and who chose it; an unreadable keystore exits 1', async () => {
    const h = context(() => view(service({ status: 'set', last4: 'A1B2', inUse: USES }), { unreadBots: 2 }), { daemon: true });
    await runSecretsList(h.ctx);
    expect(h.out()).toBe('TypeSafe（typesafe-api-key）  已填 ••••A1B2\n  在用：值班助手（Bot 默认）、发布群（值班助手，跟着 Bot 默认）、未命名飞书群（值班助手，现在不是智能群）\n'
      + '有 2 个 Bot 的设置读不了，没算进来；vonvon daemon logs 里的 secrets.bot-unreadable 有原因。\n');
    expect(h.admin).toHaveBeenCalledTimes(1);
    const unreadable = () => view(service({ status: 'unreadable', problem: 'secrets.enc 的格式不对', code: 'KEYSTORE_STORE_FORMAT' }));
    const u = context(unreadable);
    await expect(runSecretsList(u.ctx)).rejects.toEqual(failure('failed', '读不了 TypeSafe 的 key，原因见上面。', { reason: 'KEYSTORE_STORE_FORMAT' }));
    expect(u.out()).toContain('读不了：secrets.enc 的格式不对（KEYSTORE_STORE_FORMAT）');
    expect(u.out()).toContain('现在没有 Bot 或飞书群选它');
    expect(u.direct).toHaveBeenCalledTimes(1);
    // main 必败: --json printed a success line, then exited 1; the list now rides on the failure
    const j = context(unreadable, { json: true });
    await expect(runSecretsList(j.ctx)).rejects.toEqual(failure('failed', undefined, { partial: expect.objectContaining({ source: 'files', services: [expect.objectContaining({ status: 'unreadable' })] }) }));
    expect(j.out()).toBe('');
    const b = context(() => view(service(), { botsUnreadable: true }));
    await runSecretsList(b.ctx);
    expect(b.out()).toContain('Bot 清单（bots.json）读不了，谁选了它没算进来；vonvon daemon logs 里的 secrets.bots-unreadable 有原因。');
  });

  it('set with a keystore that cannot be read says so and exits 1 before asking for the key', async () => {
    for (const daemon of [false, true]) {
      const h = context(() => view(service({ status: 'unreadable', problem: 'secrets.enc 的格式不对', code: 'KEYSTORE_STORE_FORMAT' })), { daemon, key: KEY });
      await expect(runSecretsSet('typesafe-api-key', [], {}, h.ctx)).rejects.toEqual(failure('failed', '没有存：TypeSafe 的 key 读不了：secrets.enc 的格式不对（KEYSTORE_STORE_FORMAT）。vonvon daemon logs 里的 secrets.unreadable 有原话'));
      expect(h.readKey).not.toHaveBeenCalled();
      expect(h.sent).toEqual([{ type: 'secrets' }]);
    }
  });

  it('set: connects first, asks for the key, trims it, saves and tries it once', async () => {
    const h = context(request => request.type === 'testSecret'
      ? { kind: 'secretTested', keyId: 'typesafe-api-key', outcome: 'auth', message: 'key 不对：TypeSafe 不认这个 key', status: 401 }
      : view(service(request.type === 'setSecret' ? { status: 'set', last4: '0000' } : {})), { daemon: true, key: ` ${KEY}\n` });
    await runSecretsSet('typesafe-api-key', [], {}, h.ctx);
    expect(h.connect.mock.invocationCallOrder[0]).toBeLessThan(h.readKey.mock.invocationCallOrder[0]!);
    expect(h.sent).toEqual([{ type: 'secrets' }, { type: 'setSecret', keyId: 'typesafe-api-key', value: KEY }, { type: 'testSecret', keyId: 'typesafe-api-key' }]);
    expect(h.out()).toBe('✓ 已存 TypeSafe 的 key（末四位 0000）\n试了一次：key 不对：TypeSafe 不认这个 key。换一个 key：重新运行 vonvon secrets set typesafe-api-key\n');
    expect(h.err() + h.out()).not.toContain(KEY);
    // main 必败: --json printed the two human lines
    const j = context(request => request.type === 'testSecret'
      ? { kind: 'secretTested', keyId: 'typesafe-api-key', outcome: 'ok', message: '可以用' }
      : view(service(request.type === 'setSecret' ? { status: 'set', last4: '0000' } : {})), { daemon: true, key: KEY, json: true });
    await runSecretsSet('typesafe-api-key', [], {}, j.ctx);
    expect(JSON.parse(j.out())).toEqual({ ok: true, source: 'daemon', keyId: 'typesafe-api-key', last4: '0000', test: { outcome: 'ok', message: '可以用' } });
    expect(j.out()).not.toContain(KEY);
  });

  it('set refuses a key in the arguments, an unknown name and a bad shape with exit 2, echoing none of them', async () => {
    const h = context(() => view(service()), { key: 'ts_TEST KEY' });
    await expect(runSecretsSet('typesafe-api-key', [KEY], {}, h.ctx)).rejects.toEqual(failure('bad-args', expect.stringContaining('key 不写在命令参数里')));
    const named = context(() => view(service()));
    await expect(runSecretsSet(KEY, [], {}, named.ctx)).rejects.toEqual(failure('bad-args', '不认识这个名字。能用的名字：typesafe-api-key（TypeSafe）、openrouter-api-key（OpenRouter）、vercel-api-key（Vercel）、custom-decision-api-key（自定义 Jev）'));
    const shape = runSecretsSet('typesafe-api-key', [], {}, h.ctx);
    await expect(shape).rejects.toEqual(failure('bad-args', expect.stringContaining('没有存：key 只能是一串可见的英文字符')));
    await expect(shape).rejects.not.toEqual(expect.objectContaining({ message: expect.stringContaining('ts_TEST') }));
    for (const c of [h, named]) expect(c.sent.filter(r => r.type === 'setSecret')).toEqual([]);
    const cancelled = context(() => view(service()), { key: new InputCancelled() });
    await expect(runSecretsSet('typesafe-api-key', [], {}, cancelled.ctx)).rejects.toEqual(failure('interrupted'));
  });

  it('a daemon from before s23g: the files are written here, after saying so', async () => {
    const h = context(() => view(service({ status: 'set' })), { daemon: true });
    h.admin.mockImplementation(async () => { throw new RpcError('invalid_request', '请求参数无效。'); });
    await runSecretsRemove('typesafe-api-key', [], {}, h.ctx);
    expect(h.err()).toContain('daemon 比命令行旧');
    expect(h.direct.mock.calls.map(([r]) => r.type)).toEqual(['secrets', 'removeSecret']);
  });

  it('a daemon that holds the lock but cannot be reached: an error, and nothing written behind its back', async () => {
    const h = context(() => view(service()), { daemon: true, key: KEY });
    h.connect.mockRejectedValue(new Error('daemon 正在启动，稍后再试。'));
    await expect(runSecretsSet('typesafe-api-key', [], {}, h.ctx)).rejects.toThrow('daemon 正在启动');
    expect(h.readKey).not.toHaveBeenCalled();
    expect(h.direct).not.toHaveBeenCalled();
  });

  it('remove refuses anything after the name, echoing none of it', async () => {
    const h = context(() => view(service(), { removed: true }));
    await expect(runSecretsRemove('typesafe-api-key', [KEY], {}, h.ctx)).rejects.toEqual(failure('bad-args', '只写一个名字，后面多写了东西，没有删。'));
    await expect(runSecretsRemove('x', [KEY], { raw: true }, h.ctx)).rejects.toEqual(failure('bad-args', '只写一个名字，后面多写了东西，没有删。'));
    expect(h.sent).toEqual([]);
  });

  it('remove names who still chose it', async () => {
    const h = context(() => view(service({ inUse: USES.slice(0, 1) }), { removed: true }));
    await runSecretsRemove('typesafe-api-key', [], {}, h.ctx);
    expect(h.out()).toBe('✓ 已删 TypeSafe 的 key。\n还选着它的：值班助手（Bot 默认）；它们要判断的消息按出错处理（没 @ Bot 的不回，@ 的回在主区），重新填就恢复。\n');
    const j = context(() => view(service({ inUse: USES.slice(0, 1) }), { removed: true }), { json: true });
    await runSecretsRemove('typesafe-api-key', [], {}, j.ctx);
    expect(JSON.parse(j.out())).toEqual({ ok: true, source: 'files', keyId: 'typesafe-api-key', removed: true, inUse: USES.slice(0, 1) });
  });

  it('refuses list, set and remove inside a bot session; get never hands out a decision model key', async () => {
    for (const env of [{ VONVON_SESSION: 'x' }, { FEISHU_CODEX_BRIDGE: '1' }]) {
      const h = context(() => view(service()), { env, key: KEY });
      // main 必败: exit 2, as if the arguments were wrong; a session refusal is 4 with its reason (devices 8.1)
      const refused = failure('refused', '这组命令不能在 Bot 的会话里用。在网页的密钥页填或删，或者在自己的终端里运行。', { reason: 'not_in_session' });
      await expect(runSecretsList(h.ctx)).rejects.toEqual(refused);
      await expect(runSecretsSet('typesafe-api-key', [], {}, h.ctx)).rejects.toEqual(refused);
      await expect(runSecretsRemove('typesafe-api-key', [], { raw: true }, h.ctx)).rejects.toEqual(refused);
      expect(h.sent).toEqual([]);
    }
    const read = vi.fn(async (id: string) => (id === 'app-cli_a' ? 'app-secret' : KEY));
    expect(await secretValues(['app-cli_a', 'typesafe-api-key'], read)).toEqual({
      protocolVersion: 1, values: { 'app-cli_a': 'app-secret' }, errors: { 'typesafe-api-key': { message: 'not handed out: only the daemon reads this key' } },
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('exec provider protocol (s31b0)', () => {
  it.each([
    ['nope', { ids: [], problem: 'invalid request JSON' }],
    ['null', { ids: [], problem: 'invalid request JSON' }],
    ['[]', { ids: [], problem: 'invalid request JSON' }],
    ['"x"', { ids: [], problem: 'invalid request JSON' }],
    ['{"ids":"a"}', { ids: [], problem: 'invalid request: ids must be an array of strings' }],
    ['{"ids":["a",1]}', { ids: [], problem: 'invalid request: ids must be an array of strings' }],
    ['{"protocolVersion":2,"ids":["a","a"]}', { ids: ['a'], problem: 'unsupported protocolVersion: only 1' }],
    ['{}', { ids: [] }],
    ['{"protocolVersion":2}', { ids: [], problem: 'unsupported protocolVersion: only 1' }],
    ['{"protocolVersion":2,"ids":false}', { ids: [], problem: 'invalid request: ids must be an array of strings' }],
    ['{"protocolVersion":1,"ids":["a"]}', { ids: ['a'] }],
    ['{"ids":["a","b","a"]}', { ids: ['a', 'b'] }],
  ])('parses %s', (input, expected) => {
    expect(parseExecRequest(input)).toEqual(expected);
  });

  it.each(['__proto__', 'constructor', 'toString'])('keeps %s as an own property without changing prototypes', async id => {
    const reply = await secretValues([id], async () => undefined);
    expect(Object.hasOwn(reply.errors, id)).toBe(true);
    expect(JSON.stringify(reply)).toContain(`${JSON.stringify(id)}:{"message":"not found"}`);
    expect(Object.getPrototypeOf(reply)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(reply.errors)).toBe(Object.prototype);
    const found = await secretValues([id], async () => 'fake');
    expect(Object.hasOwn(found.values, id)).toBe(true);
    expect(Object.getPrototypeOf(found.values)).toBe(Object.prototype);
  });

  it.each([
    [async () => { throw new Error('/private/path'); }, 'secrets get 出错了（UNKNOWN）'],
    [async () => 'nope', 'invalid request JSON'],
  ])('writes exactly one v1 error line', async (input, message) => {
    const write = vi.fn();
    await expect(secretsGet({ input, write })).resolves.toBeUndefined();
    expect(write.mock.calls).toEqual([[`${JSON.stringify({ protocolVersion: 1, values: {}, errors: { _: { message } } })}\n`]]);
  });

  it('describes keystore failures without disclosing their original message', async () => {
    expect(await secretValues(['a'], async () => { throw Object.assign(new Error('/private/path'), { code: 'EACCES' }); })).toEqual({
      protocolVersion: 1, values: {}, errors: { a: { message: '没有权限读写密钥库的文件（EACCES）' } },
    });
  });

  it('exports the read files in the same order as the configured paths', () => {
    expect(KEYSTORE_READ_FILES).toEqual([basename(paths.secretsFile), basename(paths.masterKeyFile)]);
  });
});

describe('readHidden', () => {
  function terminal() {
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
    let shown = '';
    return { input, output: { write: (text: string) => { shown += text; } }, shown: () => shown };
  }
  it('echoes nothing, takes a paste whole, deletes on backspace and skips escape sequences', async () => {
    const t = terminal();
    const read = readHidden('key：', t.input, t.output);
    t.input.write('ab');
    t.input.write('\x7f\x1b[Dc\x1b[200~d');
    t.input.write('\r');
    expect(await read).toBe('acd');
    expect(t.shown()).toBe('key：\n');
    expect(t.input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });
  it('Ctrl-C rejects and gives the terminal back', async () => {
    const t = terminal();
    const read = readHidden('key：', t.input, t.output);
    t.input.write('ab\x03');
    await expect(read).rejects.toBeInstanceOf(InputCancelled);
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
  });
});
