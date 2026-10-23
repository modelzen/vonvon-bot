import { rm } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBridge } from '../src/bot/bridge';
import { createOrchestrator } from '../src/bot/handle-message';
import { COFFEE_RETIRED, COFFEE_RETIRED_ACTIONS, buildSettingsCard } from '../src/card/dm-cards';
import { paths } from '../src/config/paths';
import type { AppConfig } from '../src/config/schema';
import { saveConfig } from '../src/config/store';

const fixtureStore = vi.hoisted(() => ({ config: {} as unknown }));
const createdCards = vi.hoisted(() => [] as unknown[]);
vi.mock('../src/config/store', () => ({
  saveConfig: vi.fn(async (config: unknown) => { fixtureStore.config = structuredClone(config); }),
  loadConfig: vi.fn(async () => structuredClone(fixtureStore.config)),
}));
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'coffee-retired-'));
  return { botDir: (appId: string) => join(appDir, 'bots', appId), botPaths: (appId: string) => { const dir = join(appDir, 'bots', appId); return { dir, configFile: join(dir, 'config.json'), sessionsFile: join(dir, 'sessions.json'), projectsFile: join(dir, 'projects.json'), processesFile: join(dir, 'processes.json'), setupFile: join(dir, 'setup.json'), topicsDir: join(dir, 'topics'), droppedFile: join(dir, 'dropped.json'), judgeUsageFile: join(dir, 'judge-usage.json') }; }, paths: { appDir, sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), commentInstructionsFile: join(appDir, 'comment-instructions.md'), commentsRootDir: join(appDir, 'comments'), projectsRootDir: join(appDir, 'projects') } };
});
vi.mock('@larksuiteoapi/node-sdk', async original => ({
  ...await original<object>(),
  createLarkChannel: () => ({ ...(channel() as object), on: vi.fn(), connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined) }),
}));
vi.mock('../src/core/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, fail: () => undefined },
  withTrace: async (_ctx: unknown, fn: () => Promise<void> | void) => fn(),
}));

afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

// config.json as s02b left it: a stored 咖啡一下 section, kept as is and read by
// nobody. AppConfig has had no cliBridge since s02c5, so the fixture is plain
// JSON, the way loadConfig hands it over.
const STORED = JSON.stringify({
  accounts: { app: { id: 'cli_fixture', secret: 'secret', tenant: 'feishu' } },
  preferences: { access: { ownerOpenId: 'ou_owner' }, cliBridge: { enabled: true, notifyScope: 'bound_projects' } },
});

function cfg(): AppConfig {
  fixtureStore.config = JSON.parse(STORED);
  return JSON.parse(STORED) as AppConfig;
}

function channel() {
  let nextCard = 0;
  let nextMessage = 0;
  return {
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: vi.fn(async (request: unknown) => {
              createdCards.push(request);
              nextCard += 1;
              return { data: { card_id: `card_${nextCard}` } };
            }),
            update: vi.fn(async () => ({})),
          },
        },
      },
      im: {
        v1: {
          message: {
            create: vi.fn(async () => {
              nextMessage += 1;
              return { data: { message_id: `message_${nextMessage}` } };
            }),
          },
        },
      },
    },
  } as never;
}

const tap = (actionId: string, openId = 'ou_owner') => ({
  chatId: openId,
  messageId: 'old-settings-card',
  operator: { openId },
  action: { tag: 'button', value: { a: actionId, v: 'on', agent: 'codex' } },
});

describe('s02b: 咖啡一下 is gone', () => {
  beforeEach(() => {
    createdCards.length = 0;
    vi.mocked(saveConfig).mockClear();
  });

  it('the settings card has no 咖啡一下 entry', () => {
    const card = JSON.stringify(buildSettingsCard(cfg()));
    expect(card).toContain('全局设置');
    expect(card).not.toContain('咖啡一下');
    expect(card).not.toContain('dm.coffee.settings');
  });

  it.each(COFFEE_RETIRED_ACTIONS)('a tap on %s from an old card re-renders the settings card with a notice and writes nothing', async actionId => {
    const appCfg = cfg();
    const orchestrator = createOrchestrator(channel(), appCfg, '/repo');
    await orchestrator.dispatcher.handle(tap(actionId) as never);
    await vi.waitFor(() => expect(createdCards).toHaveLength(1));
    const card = JSON.stringify(createdCards);
    expect(card).toContain(COFFEE_RETIRED);
    expect(card).toContain('全局设置');
    expect(card).not.toContain('dm.coffee.settings');
    expect(saveConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(appCfg)).toBe(STORED);
  });

  it('ignores a tap from someone who is not an admin', async () => {
    const orchestrator = createOrchestrator(channel(), cfg(), '/repo');
    await orchestrator.dispatcher.handle(tap('cli.toggle.enabled', 'ou_stranger') as never);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(createdCards).toHaveLength(0);
  });

  it('the bot starts and stops when the stored 咖啡一下 setting says enabled, and leaves it alone', async () => {
    const appCfg = cfg();
    const bridge = await startBridge({ identity: { appId: appCfg.accounts.app.id, tenant: appCfg.accounts.app.tenant, createdAt: 1 }, cfg: appCfg, appSecret: 'secret', fallbackCwd: '/repo' });
    await expect(bridge.shutdown()).resolves.toBeUndefined();
    expect(saveConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(appCfg)).toBe(STORED);
  });
});
