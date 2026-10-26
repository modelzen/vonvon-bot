import { readFileSync, rmSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The app renamed in the Feishu developer console: the bot's display name in bots.json follows bot/v3/info when the bot
// starts, through the registry's own locked writer. Only `botName` changes, never the handle or the appId.
const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  info: vi.fn(),
  fail: vi.fn(),
}));
vi.mock('../src/utils/feishu-auth', () => ({ validateAppCredentials: mocks.validate }));
vi.mock('../src/utils/event-diagnosis', async original => ({
  ...await original<typeof import('../src/utils/event-diagnosis')>(),
  diagnoseEventSubscription: async () => ({ state: 'unchecked', reason: 'fixture' }),
}));
vi.mock('../src/agent', () => ({ detectAgents: async () => [{ backends: [{ available: true }] }] }));
vi.mock('../src/config/store', () => ({ loadConfig: async () => ({ accounts: { app: { id: 'cli_rename', secret: 'fixture', tenant: 'feishu' } } }) }));
vi.mock('../src/config/secret-resolver', () => ({ resolveAppSecret: async () => 'fixture' }));
vi.mock('../src/core/logger', () => ({ log: { info: mocks.info, fail: mocks.fail, warn: vi.fn() } }));
vi.mock('../src/config/bots', async original => {
  const real = await original<typeof import('../src/config/bots')>();
  return { ...real, updateBotName: vi.fn(real.updateBotName) };
});
// bots.json and the bot directories live in a temp directory, never the real data root.
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'bot-name-sync-test-'));
  const botDir = (appId: string): string => join(appDir, 'bots', appId);
  return {
    botDir,
    botPaths: (appId: string) => ({ dir: botDir(appId), configFile: join(botDir(appId), 'config.json') }),
    useBotDir: (): void => {},
    paths: { appDir, botsFile: join(appDir, 'bots.json'), configFile: join(appDir, 'config.json') },
  };
});

import { ensureOnboarded } from '../src/bot/onboarding';
import { loadBots, updateBotName, type BotEntry } from '../src/config/bots';
import { paths } from '../src/config/paths';
import { seedBots } from './helpers/bot-fixture';

const bot: BotEntry = { name: 'vonvon-bot-6', appId: 'cli_rename', tenant: 'feishu', botName: 'Vonvon Bot 6', createdAt: 1, registrationId: 'reg-1', active: true };
const raw = (): string => readFileSync(paths.botsFile, 'utf8');

afterAll(() => { rmSync(paths.appDir, { recursive: true, force: true }); });
beforeEach(async () => {
  vi.clearAllMocks();
  // Back to the real writer, so a one-off failure a test set up cannot leak into the next one.
  vi.mocked(updateBotName).mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await seedBots({ version: 1, current: bot.appId, bots: [{ ...bot }] });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the display name follows a rename in Feishu', () => {
  it('saves the new name at startup and leaves the handle and appId', async () => {
    mocks.validate.mockResolvedValue({ ok: true, botName: '小码', missingScopes: [] });
    const ready = await ensureOnboarded({ bot: bot.appId });
    expect(ready?.identity).toEqual({ appId: bot.appId, tenant: 'feishu', createdAt: 1, registrationId: 'reg-1' });
    const saved = (await loadBots()).bots;
    expect(saved).toEqual([{ ...bot, botName: '小码' }]);
    expect(mocks.info).toHaveBeenCalledWith('onboard', 'bot-name-synced', { appId: bot.appId, from: 'Vonvon Bot 6', to: '小码' });
  });

  it('a bot registered before names were saved gets one', async () => {
    const { botName: _unsaved, ...legacy } = bot;
    await seedBots({ version: 1, current: bot.appId, bots: [legacy] });
    mocks.validate.mockResolvedValue({ ok: true, botName: '小周' });
    expect(await ensureOnboarded({ bot: bot.appId })).not.toBeNull();
    expect((await loadBots()).bots[0]?.botName).toBe('小周');
  });

  it('the same name writes nothing', async () => {
    mocks.validate.mockResolvedValue({ ok: true, botName: 'Vonvon Bot 6' });
    const before = raw();
    expect(await ensureOnboarded({ bot: bot.appId })).not.toBeNull();
    expect(raw()).toBe(before);
    expect(updateBotName).not.toHaveBeenCalled();
  });

  it.each([
    ['bot/v3/info failed', { ok: true, missingScopes: undefined }],
    ['an empty name', { ok: true, botName: '' }],
    ['a blank name', { ok: true, botName: '   ' }],
  ])('%s writes nothing and the bot still starts', async (_case, validation) => {
    mocks.validate.mockResolvedValue(validation);
    const before = raw();
    expect(await ensureOnboarded({ bot: bot.appId })).not.toBeNull();
    expect(raw()).toBe(before);
    expect(updateBotName).not.toHaveBeenCalled();
  });

  it('Feishu out of reach writes nothing', async () => {
    mocks.validate.mockResolvedValue({ ok: false, reason: '网络错误：fixture', unreachable: true });
    const before = raw();
    expect(await ensureOnboarded({ bot: bot.appId })).toBeNull();
    expect(raw()).toBe(before);
    expect(updateBotName).not.toHaveBeenCalled();
  });

  it('a failed write is logged and the bot still starts', async () => {
    mocks.validate.mockResolvedValue({ ok: true, botName: '小查' });
    vi.mocked(updateBotName).mockRejectedValueOnce(new Error('disk full'));
    const before = raw();
    const ready = await ensureOnboarded({ bot: bot.appId });
    expect(ready?.secret).toBe('fixture');
    expect(raw()).toBe(before);
    expect(mocks.fail).toHaveBeenCalledWith('onboard', expect.objectContaining({ message: 'disk full' }), { phase: 'sync-bot-name', appId: bot.appId }, { console: false });
  });

  it('a bot registered again while Feishu answered keeps the new registration as it is', async () => {
    const again = { ...bot, registrationId: 'reg-2', botName: '新注册' };
    mocks.validate.mockImplementation(async () => {
      await seedBots({ version: 1, current: bot.appId, bots: [again] });
      return { ok: true, botName: '小码' };
    });
    await ensureOnboarded({ bot: bot.appId });
    expect((await loadBots()).bots).toEqual([again]);
    expect(await vi.mocked(updateBotName).mock.results[0]?.value).toBe('stale');
  });
});

describe('updateBotName', () => {
  it('changes only botName and keeps the rest of the registry', async () => {
    await seedBots({ version: 1, current: bot.appId, bots: [{ ...bot }, { ...bot, appId: 'cli_other', name: 'other', botName: '别的' }] });
    expect(await updateBotName({ appId: bot.appId, tenant: 'feishu', createdAt: 1, registrationId: 'reg-1' }, '小码')).toBe('updated');
    const saved = await loadBots();
    expect(saved.current).toBe(bot.appId);
    expect(saved.bots).toEqual([{ ...bot, botName: '小码' }, { ...bot, appId: 'cli_other', name: 'other', botName: '别的' }]);
    const before = raw();
    expect(await updateBotName({ appId: bot.appId, tenant: 'feishu', createdAt: 1, registrationId: 'reg-1' }, '小码')).toBe('unchanged');
    expect(raw()).toBe(before);
    expect(await updateBotName({ appId: 'cli_missing', tenant: 'feishu', createdAt: 1 }, '小码')).toBe('stale');
    expect(raw()).toBe(before);
  });
});
