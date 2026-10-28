import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 隔离 registerBotByQr 的**编排**：mock SDK registerApp（推 onQr/onStatus + resolve/
// reject）与共享写盘 registerBotFromCredentials（spy 验入参），不碰真网络/keystore。
// startRegistration 的 reject-code 解析（registrationErrorCode）走真实实现。
// 注册成功后会写 bots.json 的启用状态，所以整个数据目录指到临时目录。

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'qr-register-test-'));
  const botDir = (appId: string): string => join(appDir, 'bots', appId);
  const botPaths = (appId: string) => {
    const dir = botDir(appId);
    return {
      dir,
      configFile: join(dir, 'config.json'),
      sessionsFile: join(dir, 'sessions.json'),
      projectsFile: join(dir, 'projects.json'),
      processesFile: join(dir, 'processes.json'),
      setupFile: join(dir, 'setup.json'),
    };
  };
  return {
    botDir,
    botPaths,
    useBotDir: (): void => {},
    paths: {
      appDir,
      cacheDir: appDir,
      projectsRootDir: join(appDir, 'projects'),
      botsFile: join(appDir, 'bots.json'),
      secretsFile: join(appDir, 'secrets.enc'),
      masterKeyFile: join(appDir, 'master.key'),
      keystoreSaltFile: join(appDir, '.keystore.salt'),
      secretsGetterScript: join(appDir, 'secrets-getter'),
      configFile: join(appDir, 'config.json'),
    },
  };
});

// 真实落盘的用例（s02e）里探活一律通过，不打真飞书。
const validateMock = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, botName: '新机器人', missingScopes: [] as string[] })));
vi.mock('../src/utils/feishu-auth', async (original) => ({
  ...(await original<typeof import('../src/utils/feishu-auth')>()),
  validateAppCredentials: validateMock,
}));

const registerAppMock = vi.fn();
vi.mock('@larksuiteoapi/node-sdk', () => ({
  registerApp: (opts: unknown) => registerAppMock(opts),
}));

const registerBotFromCredentialsMock = vi.fn();
vi.mock('../src/bot/register-bot', () => ({
  registerBotFromCredentials: (input: unknown) => registerBotFromCredentialsMock(input),
}));

import { rmSync } from 'node:fs';
import { createAdminService } from '../src/admin/service';
import { runRegistrationWizard, startRegistration } from '../src/bot/wizard';
import { loadBots, type BotEntry } from '../src/config/bots';
import { getSecret } from '../src/config/keystore';
import { secretKeyForApp } from '../src/config/schema';
import { loadConfig } from '../src/config/store';
import { seedBots } from './helpers/bot-fixture';
import { botPaths, paths } from '../src/config/paths';

afterEach(() => {
  registerAppMock.mockReset();
  registerBotFromCredentialsMock.mockReset();
});

afterAll(() => {
  rmSync(paths.appDir, { recursive: true, force: true });
});

interface RegisterAppOpts {
  createOnly?: boolean;
  appId?: string;
  signal?: AbortSignal;
  onQRCodeReady: (info: { url: string; expireIn: number }) => void;
  onStatusChange?: (info: { status: string; interval?: number }) => void;
}

describe('registerBotByQr · 扫码编排', () => {
  it('成功：透传 onQr/onStatus，拿明文密钥后委托 registerBotFromCredentials（含 ownerOpenId），done 不含 secret', async () => {
    registerAppMock.mockImplementation((opts: RegisterAppOpts) => {
      expect(opts.createOnly).toBe(false);
      expect(opts.appId).toBeUndefined();
      opts.onQRCodeReady({ url: 'https://accounts.feishu.cn/scan?c=1', expireIn: 600 });
      opts.onStatusChange?.({ status: 'polling' });
      return Promise.resolve({
        client_id: 'cli_qr12345678',
        client_secret: 'TOP-SECRET-PLAINTEXT',
        user_info: { open_id: 'ou_scanner', tenant_brand: 'feishu' },
      });
    });
    registerBotFromCredentialsMock.mockResolvedValue({
      ok: true,
      name: 'qrbot',
      appId: 'cli_qr12345678',
      tenant: 'feishu',
      botName: '扫码机器人',
      missingScopes: ['im:resource'],
    });

    const svc = createAdminService();
    const qrFrames: unknown[] = [];
    const statusFrames: unknown[] = [];
    const r = await svc.registerBotByQr({
      signal: new AbortController().signal,
      onQr: (i) => qrFrames.push(i),
      onStatus: (i) => statusFrames.push(i),
    });

    // 回调透传
    expect(qrFrames).toEqual([{ url: 'https://accounts.feishu.cn/scan?c=1', expireIn: 600 }]);
    expect(statusFrames).toEqual([{ status: 'polling', interval: undefined }]);

    // 委托写盘：明文密钥 + 扫码人 open_id 当 ownerOpenId
    expect(registerBotFromCredentialsMock).toHaveBeenCalledWith({
      appId: 'cli_qr12345678',
      appSecret: 'TOP-SECRET-PLAINTEXT',
      tenant: 'feishu',
      ownerOpenId: 'ou_scanner',
    });

    // 结果白名单字段，绝不回 secret
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.appId).toBe('cli_qr12345678');
      expect(r.adminOpenId).toBe('ou_scanner');
      expect(r.botName).toBe('扫码机器人');
      expect(r.missingScopes).toEqual(['im:resource']);
      expect(JSON.stringify(r)).not.toContain('SECRET');
    }
  });

  it('SDK reject {code:"expired_token"} → {ok:false, code:"expired_token"}（不委托写盘）', async () => {
    registerAppMock.mockRejectedValue({ code: 'expired_token', description: 'Polling timed out' });
    const svc = createAdminService();
    const r = await svc.registerBotByQr({ signal: new AbortController().signal, onQr: () => {} });
    expect(r).toEqual({ ok: false, code: 'expired_token', reason: '二维码已过期，请重新生成。' });
    expect(registerBotFromCredentialsMock).not.toHaveBeenCalled();
  });

  it('网络/TLS 抖动（无结构化 code，只有 socket 断连 message）→ code:"network" + 可操作中文（不甩英文原文）', async () => {
    // 复刻真实现场：切 VPN / 网络抖动让到开放平台的 HTTPS 握手中断，SDK 抛裸 Error。
    registerAppMock.mockRejectedValue(
      new Error('Client network socket disconnected before secure TLS connection was established'),
    );
    const svc = createAdminService();
    const r = await svc.registerBotByQr({ signal: new AbortController().signal, onQr: () => {} });
    expect(r).toMatchObject({ ok: false, code: 'network' });
    if (!r.ok) {
      expect(r.reason).toContain('飞书开放平台');
      expect(r.reason).not.toContain('socket'); // 绝不把英文原文甩给用户
    }
    expect(registerBotFromCredentialsMock).not.toHaveBeenCalled();
  });

  it('SDK reject {code:"access_denied"} → 映射拒绝文案', async () => {
    registerAppMock.mockRejectedValue({ code: 'access_denied', description: 'denied' });
    const svc = createAdminService();
    const r = await svc.registerBotByQr({ signal: new AbortController().signal, onQr: () => {} });
    expect(r).toMatchObject({ ok: false, code: 'access_denied' });
  });

  it('abort：signal.abort → SDK reject {code:"abort"} → {ok:false, code:"abort"}', async () => {
    const ac = new AbortController();
    registerAppMock.mockImplementation(
      (opts: RegisterAppOpts) =>
        new Promise((_resolve, reject) => {
          opts.onQRCodeReady({ url: 'https://x', expireIn: 600 });
          opts.signal?.addEventListener('abort', () => reject({ code: 'abort', description: 'aborted' }), { once: true });
        }),
    );
    const svc = createAdminService();
    const p = svc.registerBotByQr({ signal: ac.signal, onQr: () => {} });
    ac.abort();
    const r = await p;
    expect(r).toMatchObject({ ok: false, code: 'abort' });
    expect(registerBotFromCredentialsMock).not.toHaveBeenCalled();
  });

  it('入库失败（registerBotFromCredentials persist_failed）→ {ok:false, code:"persist_failed"}', async () => {
    registerAppMock.mockResolvedValue({
      client_id: 'cli_qr99999999',
      client_secret: 'sec',
      user_info: { open_id: 'ou_x', tenant_brand: 'feishu' },
    });
    registerBotFromCredentialsMock.mockResolvedValue({ ok: false, code: 'persist_failed', reason: '保存失败：磁盘满' });
    const svc = createAdminService();
    const r = await svc.registerBotByQr({ signal: new AbortController().signal, onQr: () => {} });
    expect(r).toMatchObject({ ok: false, code: 'persist_failed' });
    if (!r.ok) expect(r.reason).toContain('磁盘满');
  });

  it('SDK 未返回 open_id：拒绝落盘，避免产生无人可管理的机器人', async () => {
    registerAppMock.mockResolvedValue({ client_id: 'cli_qrnoopen11', client_secret: 'sec', user_info: {} });
    const svc = createAdminService();
    const r = await svc.registerBotByQr({ signal: new AbortController().signal, onQr: () => {} });
    expect(r).toMatchObject({ ok: false, code: 'identity_missing' });
    if (!r.ok) expect(r.reason).toContain('未获取到扫码人的飞书身份');
    expect(registerBotFromCredentialsMock).not.toHaveBeenCalled();
  });
});

describe('registerBotByQr · 注册完默认启用（s02e）', () => {
  const ON = 'cli_enabledold1';
  const OFF = 'cli_disabledold';
  const bot = (appId: string, active?: boolean): BotEntry => ({ name: appId, appId, tenant: 'feishu', createdAt: 1, ...(active === undefined ? {} : { active }) });
  const scanned = (appId: string): void => {
    registerAppMock.mockResolvedValue({ client_id: appId, client_secret: 'scan-secret', user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' } });
  };
  const scan = { signal: new AbortController().signal, onQr: () => {} };
  const activeFlags = async (): Promise<Record<string, boolean | undefined>> =>
    Object.fromEntries((await loadBots()).bots.map((entry) => [entry.appId, entry.active]));

  beforeEach(() => {
    // 这一组走真实的落盘（keystore + config + bots.json），只有探活是假的。
    registerBotFromCredentialsMock.mockImplementation(async (input) =>
      (await vi.importActual<typeof import('../src/bot/register-bot')>('../src/bot/register-bot')).registerBotFromCredentials(input as never));
  });

  it('扫码选择飞书已有应用后，注册其凭据并设置扫码人为管理员', async () => {
    await seedBots({ version: 1, bots: [] });
    const appId = 'cli_existingbot1';
    scanned(appId);
    const result = await createAdminService().registerBotByQr(scan);

    expect(registerAppMock).toHaveBeenCalledWith(expect.objectContaining({ createOnly: false }));
    expect(result).toMatchObject({ ok: true, appId, adminOpenId: 'ou_owner' });
    expect((await loadBots()).bots).toContainEqual(expect.objectContaining({ appId, active: true }));
    expect(await getSecret(secretKeyForApp(appId))).toBe('scan-secret');
    const config = await loadConfig(botPaths(appId).configFile);
    expect(config.preferences?.access).toMatchObject({ ownerOpenId: 'ou_owner', admins: ['ou_owner'] });
    expect(JSON.stringify(config)).not.toContain('scan-secret');
  });

  it('新 Bot 写成启用并马上启动；主人停用的 Bot 仍是停用', async () => {
    await seedBots({ version: 1, current: ON, bots: [bot(ON, true), bot(OFF, false)] });
    const apply = vi.fn(async () => {});
    scanned('cli_newbot00001');
    const r = await createAdminService({ applyBotActivation: apply }).registerBotByQr(scan);
    expect(r).toMatchObject({ ok: true, appId: 'cli_newbot00001' });
    expect(await activeFlags()).toEqual({ [ON]: true, [OFF]: false, cli_newbot00001: true });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith('cli_newbot00001', true));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('旧安装没有启用标记：原来的 current 仍启用，其余照旧不启用', async () => {
    await seedBots({ version: 1, current: ON, bots: [bot(ON), bot(OFF)] });
    scanned('cli_newbot00002');
    expect(await createAdminService().registerBotByQr(scan)).toMatchObject({ ok: true });
    expect(await activeFlags()).toEqual({ [ON]: true, [OFF]: false, cli_newbot00002: true });
    expect((await loadBots()).current).toBe(ON);
  });

  it('启动失败不让注册失败：Bot 仍算启用，之后的开关照常', async () => {
    await seedBots({ version: 1, bots: [] });
    const apply = vi.fn(async (_appId: string, enabled: boolean) => {
      if (enabled) throw new Error('Bot 启动后未能及时响应');
    });
    const service = createAdminService({ applyBotActivation: apply });
    scanned('cli_newbot00003');
    expect(await service.registerBotByQr(scan)).toMatchObject({ ok: true, appId: 'cli_newbot00003' });
    expect(await activeFlags()).toEqual({ cli_newbot00003: true });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith('cli_newbot00003', true));
    expect(await service.setBotEnabled('cli_newbot00003', false)).toMatchObject({ ok: true, activation: 'applied' });
    expect(await activeFlags()).toEqual({ cli_newbot00003: false });
  });

  it('重新扫码只换凭据，不动启用状态；同一个应用再注册也不会被打开', async () => {
    await seedBots({ version: 1, bots: [] });
    const apply = vi.fn(async () => {});
    const service = createAdminService({ applyBotActivation: apply });
    scanned('cli_newbot00004');
    expect(await service.registerBotByQr(scan)).toMatchObject({ ok: true });
    expect(await service.setBotEnabled('cli_newbot00004', false)).toMatchObject({ ok: true });
    apply.mockClear();

    scanned('cli_newbot00004');
    expect(await service.refreshBotByQr('cli_newbot00004', scan)).toMatchObject({ ok: true, appId: 'cli_newbot00004' });
    expect(await activeFlags()).toEqual({ cli_newbot00004: false });

    registerAppMock.mockResolvedValue({ client_id: 'cli_newbot00004', client_secret: 'replacement-secret', user_info: { open_id: 'ou_other', tenant_brand: 'feishu' } });
    expect(await service.registerBotByQr(scan)).toMatchObject({ ok: false, code: 'already_registered' });
    expect(await activeFlags()).toEqual({ cli_newbot00004: false });
    expect(await getSecret(secretKeyForApp('cli_newbot00004'))).toBe('scan-secret');
    expect((await loadConfig(botPaths('cli_newbot00004').configFile)).preferences?.access?.ownerOpenId).toBe('ou_owner');
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('runRegistrationWizard · owner 不变量', () => {
  it('CLI 扫码返回空白 open_id：拒绝返回无人可管理的配置', async () => {
    registerAppMock.mockResolvedValue({ client_id: 'cli_qrcli11111', client_secret: 'sec', user_info: { open_id: '   ' } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(runRegistrationWizard()).rejects.toThrow('未获取到你的飞书身份');
    } finally {
      log.mockRestore();
    }
  });
});


it('refresh passes the selected app to the SDK with creation disabled', async () => {
  registerAppMock.mockResolvedValue({ client_id: 'cli_existing123', client_secret: 'ephemeral', user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' } });
  await startRegistration({ appId: 'cli_existing123', onQr: vi.fn() });
  expect(registerAppMock).toHaveBeenCalledWith(expect.objectContaining({ appId: 'cli_existing123', createOnly: false }));
});

it('prefills the Feishu create page with the Vonvon Bot name, not the old bridge name', async () => {
  registerAppMock.mockResolvedValue({ client_id: 'cli_preset12345', client_secret: 'ephemeral', user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' } });
  await startRegistration({ onQr: vi.fn() });
  const opts = registerAppMock.mock.calls[0]?.[0] as { appPreset?: { name?: string; desc?: string } };
  expect(opts.appPreset?.name).toBe('Vonvon Bot');
  expect(opts.appPreset?.desc).toContain('{user}');
  expect(JSON.stringify(opts.appPreset)).not.toMatch(/Codex Bridge|feishu-codex-bridge/);
});
