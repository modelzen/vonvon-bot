import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { RpcError, type VonvonClient } from '@vonvon/client';
import type { AdminReply, AdminRequest, SecretService } from '@vonvon/protocol';
import { withDaemon } from '../src/cli/daemon-client';
import { runSecretsList, runSecretsRemove, runSecretsSet, secretValues, type SecretsContext } from '../src/cli/commands/secrets';
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
function context(answer: (request: AdminRequest) => AdminReply | Promise<AdminReply>, o: { daemon?: boolean; key?: string | Error; env?: NodeJS.ProcessEnv } = {}) {
  let out = ''; let err = ''; let code: number | undefined;
  const sent: AdminRequest[] = [];
  const admin = vi.fn(async (request: AdminRequest) => { sent.push(request); return answer(request); });
  const direct = vi.fn(async (request: AdminRequest) => { sent.push(request); return answer(request); });
  const readKey = vi.fn(async () => { if (o.key instanceof Error) throw o.key; return o.key ?? ''; });
  const connect = vi.fn(async () => ({ admin, close: async () => {} }) as unknown as VonvonClient);
  const ctx: SecretsContext = {
    io: { json: false, write: text => { out += text; } }, warn: text => { err += text; }, exit: c => { code = c; },
    env: o.env ?? {}, readKey, daemonRunning: async () => o.daemon ?? false,
    daemon: fn => withDaemon(fn, connect, { local: 50, feishu: 50 }), direct: direct as SecretsContext['direct'],
  };
  return { ctx, sent, admin, direct, readKey, connect, out: () => out, err: () => err, code: () => code };
}
const view = (s: SecretService, extra: object = {}): AdminReply => ({ kind: 'secrets', services: [s], unreadBots: 0, ...extra });

describe('vonvon secrets (s23g)', () => {
  it('list: state, last four and who chose it; an unreadable keystore exits 1', async () => {
    const h = context(() => view(service({ status: 'set', last4: 'A1B2', inUse: USES }), { unreadBots: 2 }), { daemon: true });
    await runSecretsList(h.ctx);
    expect(h.out()).toBe('TypeSafe（typesafe-api-key）  已填 ••••A1B2\n  在用：值班助手（Bot 默认）、发布群（值班助手，跟着 Bot 默认）、未命名飞书群（值班助手，现在不是智能群）\n'
      + '有 2 个 Bot 的设置读不了，没算进来；vonvon daemon logs 里的 secrets.bot-unreadable 有原因。\n');
    expect(h.admin).toHaveBeenCalledTimes(1);
    expect(h.code()).toBeUndefined();
    const u = context(() => view(service({ status: 'unreadable', problem: 'secrets.enc 的格式不对', code: 'KEYSTORE_STORE_FORMAT' })));
    await runSecretsList(u.ctx);
    expect(u.out()).toContain('读不了：secrets.enc 的格式不对（KEYSTORE_STORE_FORMAT）');
    expect(u.out()).toContain('现在没有 Bot 或飞书群选它');
    expect(u.code()).toBe(1);
    expect(u.direct).toHaveBeenCalledTimes(1);
    const b = context(() => view(service(), { botsUnreadable: true }));
    await runSecretsList(b.ctx);
    expect(b.out()).toContain('Bot 清单（bots.json）读不了，谁选了它没算进来；vonvon daemon logs 里的 secrets.bots-unreadable 有原因。');
  });

  it('set with a keystore that cannot be read says so and exits 1 before asking for the key', async () => {
    for (const daemon of [false, true]) {
      const h = context(() => view(service({ status: 'unreadable', problem: 'secrets.enc 的格式不对', code: 'KEYSTORE_STORE_FORMAT' })), { daemon, key: KEY });
      await runSecretsSet('typesafe-api-key', [], {}, h.ctx);
      expect(h.readKey).not.toHaveBeenCalled();
      expect(h.sent).toEqual([{ type: 'secrets' }]);
      expect(h.err()).toBe('没有存：TypeSafe 的 key 读不了：secrets.enc 的格式不对（KEYSTORE_STORE_FORMAT）。vonvon daemon logs 里的 secrets.unreadable 有原话\n');
      expect(h.code()).toBe(1);
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
  });

  it('set refuses a key in the arguments, an unknown name and a bad shape with exit 2, echoing none of them', async () => {
    const h = context(() => view(service()), { key: 'ts_TEST KEY' });
    await runSecretsSet('typesafe-api-key', [KEY], {}, h.ctx);
    expect(h.err()).toContain('key 不写在命令参数里');
    expect(h.code()).toBe(2);
    const named = context(() => view(service()));
    await runSecretsSet(KEY, [], {}, named.ctx);
    expect(named.err()).toBe('不认识这个名字。能用的名字：typesafe-api-key（TypeSafe）\n');
    expect(named.code()).toBe(2);
    await runSecretsSet('typesafe-api-key', [], {}, h.ctx);
    expect(h.err()).toContain('没有存：key 只能是一串可见的英文字符');
    expect(h.err()).not.toContain('ts_TEST');
    for (const c of [h, named]) expect(c.sent.filter(r => r.type === 'setSecret')).toEqual([]);
    const cancelled = context(() => view(service()), { key: new InputCancelled() });
    await runSecretsSet('typesafe-api-key', [], {}, cancelled.ctx);
    expect(cancelled.code()).toBe(130);
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
    await runSecretsRemove('typesafe-api-key', [KEY], {}, h.ctx);
    await runSecretsRemove('x', [KEY], { raw: true }, h.ctx);
    expect(h.err()).toBe('只写一个名字，后面多写了东西，没有删。\n'.repeat(2));
    expect(h.code()).toBe(2);
    expect(h.sent).toEqual([]);
  });

  it('remove names who still chose it', async () => {
    const h = context(() => view(service({ inUse: USES.slice(0, 1) }), { removed: true }));
    await runSecretsRemove('typesafe-api-key', [], {}, h.ctx);
    expect(h.out()).toBe('✓ 已删 TypeSafe 的 key。\n还选着它的：值班助手（Bot 默认）；它们要判断的消息按出错处理（没 @ Bot 的不回，@ 的回在主区），重新填就恢复。\n');
  });

  it('refuses list, set and remove inside a bot session; get never hands out a decision model key', async () => {
    for (const env of [{ VONVON_SESSION: 'x' }, { FEISHU_CODEX_BRIDGE: '1' }]) {
      const h = context(() => view(service()), { env, key: KEY });
      await runSecretsList(h.ctx);
      await runSecretsSet('typesafe-api-key', [], {}, h.ctx);
      await runSecretsRemove('typesafe-api-key', [], { raw: true }, h.ctx);
      expect(h.err()).toBe('这组命令不能在 Bot 的会话里用，在自己的终端里运行。\n'.repeat(3));
      expect(h.code()).toBe(2);
      expect(h.sent).toEqual([]);
    }
    const read = vi.fn(async (id: string) => (id === 'app-cli_a' ? 'app-secret' : KEY));
    expect(await secretValues(['app-cli_a', 'typesafe-api-key'], read)).toEqual({
      values: { 'app-cli_a': 'app-secret' }, errors: { 'typesafe-api-key': { message: 'not handed out: only the daemon reads this key' } },
    });
    expect(read).toHaveBeenCalledTimes(1);
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
