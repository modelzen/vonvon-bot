import { rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const onboarding = vi.hoisted(() => ({
  wizard: vi.fn<typeof import('../src/bot/wizard').runRegistrationWizard>(),
  validate: vi.fn<typeof import('../src/utils/feishu-auth').validateAppCredentials>(),
  diagnose: vi.fn<typeof import('../src/utils/event-diagnosis').diagnoseEventSubscription>(),
  captureSelection: (): (() => void) => () => {},
}));
vi.mock('../src/bot/wizard', async original => ({ ...await original<typeof import('../src/bot/wizard')>(), runRegistrationWizard: onboarding.wizard }));
vi.mock('../src/utils/feishu-auth', async original => ({ ...await original<typeof import('../src/utils/feishu-auth')>(), validateAppCredentials: onboarding.validate }));
vi.mock('../src/utils/event-diagnosis', async original => ({ ...await original<typeof import('../src/utils/event-diagnosis')>(), diagnoseEventSubscription: onboarding.diagnose }));

// 把整个 ~/.feishu-codex-bridge 指到临时目录——keystore(secrets.enc/.salt) +
// bots.json + 每 bot config.json 全落临时区，绝不碰真实用户数据。secretsGetterScript
// 也指到临时区（buildEncryptedAccountConfig 会写它）。
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'register-bot-test-'));
  const botDir = (appId: string): string => join(appDir, 'bots', appId);
  const botPaths = (appId: string) => {
    const dir = botDir(appId);
    return {
      dir,
      configFile: join(dir, 'config.json'),
      sessionsFile: join(dir, 'sessions.json'),
      projectsFile: join(dir, 'projects.json'),
      processesFile: join(dir, 'processes.json'),
    };
  };
  let currentBotDir = appDir;
  onboarding.captureSelection = () => {
    const prior = currentBotDir;
    return () => { currentBotDir = prior; };
  };
  return {
    botDir,
    botPaths,
    useBotDir: (appId: string): void => {
      currentBotDir = botDir(appId);
    },
    paths: {
      appDir,
      projectsRootDir: join(appDir, 'projects'),
      cacheDir: appDir,
      botsFile: join(appDir, 'bots.json'),
      secretsFile: join(appDir, 'secrets.enc'),
      masterKeyFile: join(appDir, 'master.key'),
      keystoreSaltFile: join(appDir, '.keystore.salt'),
      secretsGetterScript: join(appDir, 'secrets-getter'),
      get configFile(): string {
        return join(currentBotDir, 'config.json');
      },
    },
  };
});

import { refreshBotCredentials } from '../src/bot/refresh-bot';
import { registerBotFromCredentials } from '../src/bot/register-bot';
import { ensureOnboarded, registerNewBot } from '../src/bot/onboarding';
import { getSecret } from '../src/config/keystore';
import { botIdentity, commitBotCredentialRefresh, loadBots, withBotGroupBinding, registerBotEntry, removeBot, setBotActivation } from '../src/config/bots';
import { removeSecret } from '../src/config/keystore';
import { rm } from 'node:fs/promises';
import { seedBots } from './helpers/bot-fixture';
import { botPaths, paths } from '../src/config/paths';
import { secretKeyForApp } from '../src/config/schema';
import { resolveAppSecret } from '../src/config/secret-resolver';
import { loadConfig } from '../src/config/store';

const okValidate = vi.fn(async () => ({
  ok: true as const,
  botName: '阿尔法机器人',
  missingScopes: ['im:resource'],
}));

afterAll(() => {
  rmSync(paths.appDir, { recursive: true, force: true });
});

beforeEach(() => {
  okValidate.mockClear();
});

describe('registerBotFromCredentials · 校验', () => {
  it('空 appId / 空 secret → invalid_input（绝不打真 API）', async () => {
    const r1 = await registerBotFromCredentials(
      { appId: '', appSecret: 's', tenant: 'feishu', ownerOpenId: 'ou_scanner' },
      okValidate,
    );
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe('invalid_input');
    const r2 = await registerBotFromCredentials(
      { appId: 'cli_abc123', appSecret: '', tenant: 'feishu', ownerOpenId: 'ou_scanner' },
      okValidate,
    );
    expect(r2.ok).toBe(false);
    expect(okValidate).not.toHaveBeenCalled();
  });

  it('appId 格式不对 → invalid_input（不以 cli_ 开头）', async () => {
    const r = await registerBotFromCredentials(
      { appId: 'not_an_app', appSecret: 'sec', tenant: 'feishu', ownerOpenId: 'ou_scanner' },
      okValidate,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_input');
    expect(okValidate).not.toHaveBeenCalled();
  });

  it('探活失败 → credential_rejected，且坏密钥绝不落 keystore', async () => {
    const badValidate = vi.fn(async () => ({ ok: false as const, reason: 'code=10003 msg=invalid' }));
    const r = await registerBotFromCredentials(
      { appId: 'cli_badbad99', appSecret: 'wrong', tenant: 'feishu', ownerOpenId: 'ou_scanner' },
      badValidate,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('credential_rejected');
      expect(r.reason).toContain('10003');
    }
    expect(await getSecret(secretKeyForApp('cli_badbad99'))).toBeUndefined();
    const reg = await loadBots();
    expect(reg.bots.find((b) => b.appId === 'cli_badbad99')).toBeUndefined();
  });

  it('连不上飞书时说网络问题，不让人去核对密钥', async () => {
    const offline = vi.fn(async () => ({ ok: false as const, reason: '飞书接口 10 秒没有响应', unreachable: true }));
    const r = await registerBotFromCredentials(
      { appId: 'cli_offline99', appSecret: 'fine', tenant: 'feishu', ownerOpenId: 'ou_scanner' },
      offline,
    );
    expect(r).toMatchObject({ ok: false, code: 'credential_rejected', reason: '连不上飞书，凭据还没校验：飞书接口 10 秒没有响应。请检查网络后重试。' });
    expect(await getSecret(secretKeyForApp('cli_offline99'))).toBeUndefined();
  });
});

describe('registerBotFromCredentials · 注册落盘', () => {
  it('成功：secret 进 keystore（明文绝不进 config.json）+ bots.json 注册 + 返回基本信息', async () => {
    const r = await registerBotFromCredentials(
      { appId: 'cli_alpha12345', appSecret: 'super-secret-value', tenant: 'feishu', ownerOpenId: 'ou_scanner' },
      okValidate,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.appId).toBe('cli_alpha12345');
    expect(r.botName).toBe('阿尔法机器人');
    expect(r.missingScopes).toEqual(['im:resource']);
    expect(okValidate).toHaveBeenCalledWith('cli_alpha12345', 'super-secret-value', 'feishu');

    // 密钥进 keystore，可解密回原值
    expect(await getSecret(secretKeyForApp('cli_alpha12345'))).toBe('super-secret-value');

    // config.json 里绝不出现明文密钥（只存指向 keystore 的 exec SecretRef）
    const cfgRaw = readFileSync(botPaths('cli_alpha12345').configFile, 'utf8');
    expect(cfgRaw).not.toContain('super-secret-value');
    expect(cfgRaw).toContain('exec');
    expect(await resolveAppSecret(await loadConfig(botPaths('cli_alpha12345').configFile) as Parameters<typeof resolveAppSecret>[0])).toBe('super-secret-value');

    // 注册表 + 唯一短名
    const reg = await loadBots();
    const entry = reg.bots.find((b) => b.appId === 'cli_alpha12345');
    expect(entry).toBeTruthy();
    expect(entry!.tenant).toBe('feishu');
    expect(entry!.botName).toBe('阿尔法机器人');
    expect(reg.current).toBe('cli_alpha12345'); // 首个注册成为 current
  });

  it('重复添加拒绝覆盖密钥与已有 Agent', async () => {
    await registerBotFromCredentials(
      { appId: 'cli_dup1234567', appSecret: 'secret-1', tenant: 'feishu', ownerOpenId: 'ou_dup' },
      okValidate,
    );
    const before = await loadBots();
    const original = before.bots.find(b => b.appId === 'cli_dup1234567')!;
    original.active = true;
    await seedBots(before);
    const duplicate = await registerBotFromCredentials(
      { appId: 'cli_dup1234567', appSecret: 'secret-2', tenant: 'feishu', ownerOpenId: 'ou_dup' },
      okValidate,
    );
    expect(duplicate).toMatchObject({ ok: false, code: 'already_registered' });
    expect(await getSecret(secretKeyForApp('cli_dup1234567'))).toBe('secret-1');
    const reg = await loadBots();
    expect(reg.bots.filter((b) => b.appId === 'cli_dup1234567')).toEqual([original]);
  });

  it('lark 租户透传给探活与注册', async () => {
    const r = await registerBotFromCredentials(
      { appId: 'cli_lark1234567', appSecret: 'sec', tenant: 'lark', ownerOpenId: 'ou_lark' },
      okValidate,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tenant).toBe('lark');
    expect(okValidate).toHaveBeenCalledWith('cli_lark1234567', 'sec', 'lark');
  });

  it('secretsGetterScript / config 都落在临时目录里（没污染真实 appDir）', () => {
    expect(existsSync(paths.appDir)).toBe(true);
    expect(paths.appDir).toContain('register-bot-test-');
  });
});

describe('registerBotFromCredentials · ownerOpenId（扫码人 = owner+admin）', () => {
  it('传 ownerOpenId → config.preferences.access 落 ownerOpenId + admins 含它', async () => {
    const r = await registerBotFromCredentials(
      { appId: 'cli_owner123456', appSecret: 'sec', tenant: 'feishu', ownerOpenId: 'ou_scanner' },
      okValidate,
    );
    expect(r.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(botPaths('cli_owner123456').configFile, 'utf8'));
    expect(cfg.preferences.access.ownerOpenId).toBe('ou_scanner');
    expect(cfg.preferences.access.admins).toContain('ou_scanner');
  });

  it('ownerOpenId 为空 → 拒绝保存无人可管理的配置', async () => {
    const r = await registerBotFromCredentials(
      { appId: 'cli_noowner1234', appSecret: 'sec', tenant: 'feishu', ownerOpenId: '   ' },
      okValidate,
    );
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' });
    if (!r.ok) expect(r.reason).toContain('未获取到扫码人的飞书身份');
    expect(okValidate).not.toHaveBeenCalled();
    expect(await getSecret(secretKeyForApp('cli_noowner1234'))).toBeUndefined();
    expect(() => readFileSync(botPaths('cli_noowner1234').configFile, 'utf8')).toThrow();
    expect((await loadBots()).bots.find((b) => b.appId === 'cli_noowner1234')).toBeUndefined();
  });

  it('幂等：同 appId 重扫 owner，admins 去重不重复堆叠', async () => {
    await registerBotFromCredentials(
      { appId: 'cli_dupowner99', appSecret: 's1', tenant: 'feishu', ownerOpenId: 'ou_o' },
      okValidate,
    );
    await registerBotFromCredentials(
      { appId: 'cli_dupowner99', appSecret: 's2', tenant: 'feishu', ownerOpenId: 'ou_o' },
      okValidate,
    );
    const cfg = JSON.parse(readFileSync(botPaths('cli_dupowner99').configFile, 'utf8'));
    expect(cfg.preferences.access.admins.filter((a: string) => a === 'ou_o')).toHaveLength(1);
  });
});


describe('targeted credential refresh', () => {
  let serial = 0;
  async function fixture() {
    const appId = `cli_refresh${++serial}`;
    await registerBotFromCredentials({ appId, appSecret: 'original', tenant: 'feishu', ownerOpenId: 'ou_owner' }, okValidate);
    const files = botPaths(appId);
    const config = JSON.parse(readFileSync(files.configFile, 'utf8'));
    config.preferences.access.admins.push('ou_admin');
    config.preferences.tools = { display: false };
    writeFileSync(files.configFile, JSON.stringify(config));
    writeFileSync(files.projectsFile, '{"project":"unchanged"}');
    writeFileSync(files.sessionsFile, '{"session":"unchanged"}');
    const preserved = [files.configFile, files.projectsFile, files.sessionsFile, paths.botsFile];
    const before = preserved.map(file => readFileSync(file, 'utf8'));
    const abort = new AbortController();
    const creds = { clientId: appId, clientSecret: 'replacement', tenant: 'feishu' as const, operatorOpenId: 'ou_admin' };
    return { appId, files, preserved, before, abort, creds, options: { signal: abort.signal, onQr: vi.fn() } };
  }

  it('rotates only target encrypted secret, preserving owner and all data bytes', async () => {
    const f = await fixture();
    const register = vi.fn(async () => f.creds);
    const other = await fixture();
    const registryBefore = readFileSync(paths.botsFile, 'utf8');
    const result = await refreshBotCredentials(f.appId, f.options, register, okValidate);
    expect(result).toMatchObject({ ok: true, appId: f.appId, adminOpenId: 'ou_owner' });
    expect(register).toHaveBeenCalledWith({ ...f.options, appId: f.appId });
    expect(await getSecret(secretKeyForApp(f.appId))).toBe('replacement');
    expect(await getSecret(secretKeyForApp(other.appId))).toBe('original');
    expect(readFileSync(paths.botsFile, 'utf8')).toBe(registryBefore);
    expect(f.preserved.slice(0, 3).map(file => readFileSync(file, 'utf8'))).toEqual(f.before.slice(0, 3));
    expect(readFileSync(paths.secretsFile, 'utf8')).not.toContain('replacement');
    expect(JSON.stringify(result)).not.toContain('replacement');
  });

  it.each(['wrong-app', 'wrong-tenant', 'abort', 'stale', 'rejected'] as const)('refuses %s without writing any encrypted data', async failure => {
    const f = await fixture();
    const beforeSecret = readFileSync(paths.secretsFile, 'utf8');
    const register = vi.fn(async () => {
      if (failure === 'wrong-app') f.creds.clientId = 'cli_unrelated';
      if (failure === 'abort') f.abort.abort();
      if (failure === 'stale') writeFileSync(f.files.configFile, `${f.before[0]} `);
      return failure === 'wrong-tenant' ? { ...f.creds, tenant: 'lark' as const } : f.creds;
    });
    const validate = failure === 'rejected' ? vi.fn(async () => ({ ok: false as const, reason: 'replacement' })) : okValidate;
    const result = await refreshBotCredentials(f.appId, f.options, register, validate);
    expect(result.ok).toBe(false);
    expect(readFileSync(paths.secretsFile, 'utf8')).toBe(beforeSecret);
    expect(JSON.stringify(result)).not.toContain('replacement');
    expect(await getSecret(secretKeyForApp(f.appId))).toBe('original');
  });

  // product.md section 6: only the app is checked, so a creator taken off the list can still change the credentials. main 必败
  it.each([
    ['someone off the list', { operatorOpenId: 'ou_stranger' }],
    ['a scan that names nobody', { operatorOpenId: undefined }],
  ])('takes the scan of %s for the same app', async (_name, scan) => {
    const f = await fixture();
    expect(await refreshBotCredentials(f.appId, f.options, async () => ({ ...f.creds, ...scan }), okValidate)).toMatchObject({ ok: true, appId: f.appId });
    expect(await getSecret(secretKeyForApp(f.appId))).toBe('replacement');
    expect(readFileSync(f.files.configFile, 'utf8')).toBe(f.before[0]);
  });

  it('takes a scan for a bot with no creator on record', async () => {
    const f = await fixture();
    const config = JSON.parse(f.before[0]!);
    delete config.preferences.access.ownerOpenId;
    writeFileSync(f.files.configFile, JSON.stringify(config));
    expect(await refreshBotCredentials(f.appId, f.options, async () => f.creds, okValidate)).toMatchObject({ ok: true, adminOpenId: 'ou_admin' });
  });

  it('honors cancellation during validation before encrypted commit', async () => {
    const f = await fixture();
    const before = readFileSync(paths.secretsFile, 'utf8');
    const result = await refreshBotCredentials(f.appId, f.options, async () => f.creds, async () => {
      f.abort.abort();
      return { ok: true };
    });
    expect(result).toMatchObject({ ok: false, code: 'abort' });
    expect(readFileSync(paths.secretsFile, 'utf8')).toBe(before);
  });
});

function barrier() {
  let open = () => {};
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { wait, open };
}

function snapshotAccountFiles() {
  const snapshots = [paths.botsFile, paths.secretsFile].map(file => ({ file, contents: existsSync(file) ? readFileSync(file) : undefined }));
  return () => {
    for (const { file, contents } of snapshots) {
      if (contents === undefined) rmSync(file, { force: true });
      else writeFileSync(file, contents);
    }
  };
}

describe('interactive shared registration adapter', () => {
  it('keeps the selected incarnation across validation and fences it after re-registration', async () => {
    const restoreFiles = snapshotAccountFiles(), restoreSelection = onboarding.captureSelection();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const entered = barrier(), release = barrier();
    try {
      const result = await registerBotFromCredentials({ appId: 'cli_selection123', appSecret: 'fixture', tenant: 'feishu', ownerOpenId: 'ou_owner' }, okValidate);
      if (!result.ok) throw new Error(result.reason);
      onboarding.validate.mockImplementationOnce(async () => { entered.open(); await release.wait; return { ok: true }; });
      onboarding.diagnose.mockResolvedValue({ state: 'unchecked', reason: 'fixture' });
      const starting = ensureOnboarded({ bot: result.appId });
      await entered.wait;
      await setBotActivation(result.appId, false);
      await removeBot(result.identity, { isRunning: async () => false, cleanup: async () => {} });
      await registerBotEntry({ appId: result.appId, tenant: 'feishu', desiredName: result.name }, async () => {});
      release.open();
      const ready = await starting;
      expect(ready?.identity).toEqual(result.identity);
      const prepare = vi.fn(async () => {});
      await expect(withBotGroupBinding(result.identity, { chatId: 'oc_selection', name: 'Selected', projectsRootDir: paths.projectsRootDir }, prepare)).rejects.toThrow('重新注册');
      expect(prepare).not.toHaveBeenCalled();
    } finally { release.open(); errors.mockRestore(); restoreFiles(); restoreSelection(); }
  });

  it('validates once, preserves wizard preferences/defaults and selects paths only after success', async () => {
    const restoreFiles = snapshotAccountFiles();
    const restoreSelection = onboarding.captureSelection();
    const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      onboarding.validate.mockResolvedValue({ ok: true });
      onboarding.diagnose.mockResolvedValue({ state: 'unchecked', reason: 'fixture' });
      onboarding.wizard.mockResolvedValue({ accounts: { app: { id: 'cli_wizard0001', secret: 'wizard-secret', tenant: 'feishu' } },
        preferences: { access: { ownerOpenId: 'ou_wizard', admins: ['ou_friend', 'ou_wizard'] }, pendingPolicy: 'queue' } });
      onboarding.validate.mockClear();
      const result = await registerNewBot();
      expect(result?.secret).toBe('wizard-secret');
      const selected = (await loadBots()).bots.find(bot => bot.appId === 'cli_wizard0001');
      expect(result?.identity).toEqual(selected && botIdentity(selected));
      expect(onboarding.validate).toHaveBeenCalledExactlyOnceWith('cli_wizard0001', 'wizard-secret', 'feishu');
      expect(onboarding.diagnose).toHaveBeenCalledExactlyOnceWith('cli_wizard0001', 'wizard-secret', 'feishu');
      expect(result?.cfg.preferences).toMatchObject({ pendingPolicy: 'queue', defaults: { permission: 'write', network: true },
        access: { ownerOpenId: 'ou_wizard', admins: ['ou_friend', 'ou_wizard'] } });
      expect((await loadBots()).bots.find(bot => bot.appId === 'cli_wizard0001')?.name).toMatch(/^default(?:-\d+)?$/);
      expect(paths.configFile).toBe(botPaths('cli_wizard0001').configFile);
      const priorPath = paths.configFile;
      onboarding.wizard.mockResolvedValue({ accounts: { app: { id: 'cli_wizard0002', secret: 'bad', tenant: 'feishu' } },
        preferences: { access: { ownerOpenId: 'ou_wizard', admins: ['ou_wizard'] } } });
      onboarding.validate.mockResolvedValue({ ok: false, reason: 'fixture rejection' });
      expect(await registerNewBot('named')).toBeNull();
      expect(paths.configFile).toBe(priorPath);
      expect((await loadBots()).bots.some(bot => bot.appId === 'cli_wizard0002')).toBe(false);
    } finally {
      restoreFiles(); restoreSelection();
      for (const id of ['cli_wizard0001', 'cli_wizard0002']) rmSync(botPaths(id).dir, { recursive: true, force: true });
      log.mockRestore(); errors.mockRestore();
      if (tty) Object.defineProperty(process.stdout, 'isTTY', tty); else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });
});

describe('bot removal and refresh ownership', () => {
  let serial = 0;
  let restoreFiles = () => {};
  const created: string[] = [];
  beforeEach(() => { restoreFiles = snapshotAccountFiles(); });
  afterEach(() => {
    restoreFiles();
    for (const id of created.splice(0)) rmSync(botPaths(id).dir, { recursive: true, force: true });
  });
  async function fixture() {
    const appId = `cli_lifecycle${++serial}`;
    created.push(appId);
    const result = await registerBotFromCredentials({ appId, appSecret: 'original', tenant: 'feishu', ownerOpenId: 'ou_owner' }, okValidate);
    if (!result.ok) throw new Error(result.reason);
    await setBotActivation(appId, false);
    const entry = (await loadBots()).bots.find(bot => bot.appId === appId);
    if (!entry) throw new Error('fixture missing');
    return { appId, expected: botIdentity(entry) };
  }
  const noCleanup = () => ({ isRunning: async () => false, cleanup: vi.fn(async () => {}) });

  it('refuses active/running/missing targets without cleanup and preserves legacy fallback', async () => {
    const f = await fixture();
    const callbacks = noCleanup();
    await setBotActivation(f.appId, true);
    expect(await removeBot(f.expected, callbacks)).toEqual({ kind: 'active' });
    await setBotActivation(f.appId, false);
    expect(await removeBot(f.expected, { ...callbacks, isRunning: async () => true })).toEqual({ kind: 'running' });
    expect(await removeBot({ ...f.expected, appId: 'missing' }, callbacks)).toEqual({ kind: 'missing' });
    expect(callbacks.cleanup).not.toHaveBeenCalled();
    const prior = await loadBots();
    const legacy = { appId: 'legacy', name: 'legacy', tenant: 'feishu' as const, createdAt: 1 };
    await seedBots({ version: 1, current: legacy.appId, bots: [legacy] });
    expect(await removeBot(botIdentity(legacy), callbacks)).toEqual({ kind: 'active' });
    expect((await loadBots()).bots[0]).not.toHaveProperty('registrationId');
    await seedBots(prior);
  });

  it('rejects stale legacy and new incarnations even when createdAt is the same millisecond', async () => {
    const prior = await loadBots();
    const legacy = { appId: 'same', name: 'same', tenant: 'feishu' as const, createdAt: 1, active: false };
    await seedBots({ version: 1, bots: [legacy] });
    const old = botIdentity(legacy);
    const callbacks = noCleanup();
    expect((await removeBot(old, callbacks)).kind).toBe('removed');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1);
    try {
      const registered = await registerBotEntry({ appId: 'same', tenant: 'feishu', desiredName: 'same' }, async () => {});
      if (registered.kind !== 'registered') throw new Error('fixture duplicate');
      await setBotActivation('same', false);
      expect(registered.entry.createdAt).toBe(1);
      expect(registered.entry.registrationId).toBeTypeOf('string');
      callbacks.cleanup.mockClear();
      expect(await removeBot(old, callbacks)).toEqual({ kind: 'stale' });
      const refresh = vi.fn(async () => {});
      expect(await commitBotCredentialRefresh(old, refresh)).toBe('stale');
      expect(refresh).not.toHaveBeenCalled();
      const expected = botIdentity(registered.entry);
      await removeBot(expected, noCleanup());
      await registerBotEntry({ appId: 'same', tenant: 'feishu', desiredName: 'same' }, async () => {});
      await setBotActivation('same', false);
      expect(await removeBot(expected, callbacks)).toEqual({ kind: 'stale' });
      expect(callbacks.cleanup).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); await seedBots(prior); }
  });

  it('keeps a deletion failure observable and releases ownership for later writers', async () => {
    const f = await fixture();
    await expect(removeBot(f.expected, { isRunning: async () => false, cleanup: async () => { throw new Error('partial cleanup'); } })).rejects.toThrow('partial cleanup');
    expect((await loadBots()).bots.some(bot => bot.appId === f.appId)).toBe(true);
    await setBotActivation(f.appId, true);
    expect((await loadBots()).bots.find(bot => bot.appId === f.appId)?.active).toBe(true);
  });

  it('does not let validated refresh resurrect a secret while deletion owns account cleanup', async () => {
    const f = await fixture();
    const entered = barrier(), release = barrier(), validated = barrier();
    const deletion = removeBot(f.expected, {
      isRunning: async () => { entered.open(); await release.wait; return false; },
      cleanup: async () => { await removeSecret(secretKeyForApp(f.appId)); await rm(botPaths(f.appId).dir, { recursive: true }); },
    });
    await entered.wait;
    const refreshing = refreshBotCredentials(f.appId, { signal: new AbortController().signal, onQr: () => {} },
      async () => ({ clientId: f.appId, clientSecret: 'must-not-resurrect', tenant: 'feishu', operatorOpenId: 'ou_owner' }),
      async () => { validated.open(); return { ok: true }; });
    try { await validated.wait; }
    finally { release.open(); }
    expect((await deletion).kind).toBe('removed');
    expect(await refreshing).toMatchObject({ ok: false, code: 'stale_target' });
    expect(await getSecret(secretKeyForApp(f.appId))).toBeUndefined();
  });

  it('holds deletion behind a credential commit, preserving the bots-before-keystore order', async () => {
    const f = await fixture();
    const entered = barrier(), release = barrier();
    const order: string[] = [];
    const refresh = commitBotCredentialRefresh(f.expected, async () => { entered.open(); await release.wait; order.push('refresh'); });
    await entered.wait;
    const deletion = removeBot(f.expected, { isRunning: async () => { order.push('check'); return false; }, cleanup: async () => { order.push('cleanup'); } });
    release.open();
    expect(await refresh).toBe('committed');
    expect((await deletion).kind).toBe('removed');
    expect(order).toEqual(['refresh', 'check', 'cleanup']);
  });
});
