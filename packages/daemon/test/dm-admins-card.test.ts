import { rm } from 'node:fs/promises';
import type { CardActionEvent } from '@larksuiteoapi/node-sdk';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { loadConfig, saveConfig } from '../src/config/store';
import { createOrchestrator } from '../src/bot/handle-message';
import { DM } from '../src/card/dm-cards';
import { seedBots } from './helpers/bot-fixture';
import { fakeLark } from './helpers/fake-lark-http';

/** product.md section 6: the private chat's 设置 → 管理员 card only reads, an old card's buttons included. */
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'dm-admins-card-')));
  return {
    paths: { appDir, configFile: join(appDir, 'config.json'), sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'),
      botsFile: join(appDir, 'bots.json'), projectsRootDir: join(appDir, 'projects') },
    botPaths: (id: string) => ({ dir: join(appDir, 'bots', id), projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json') }),
  };
});
const fixture = vi.hoisted(() => ({
  send: vi.fn(async (..._args: unknown[]) => ({ messageId: 'om_result', cardId: 'card' })),
  update: vi.fn(async (..._args: unknown[]) => true),
}));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: (id: string) => ({ id, loginStatus: async () => ({ state: 'signedIn', message: '' }), listModels: async () => [] }),
  effectiveDefaultBackend: async () => 'claude-agent' }));
vi.mock('../src/config/keystore', async original => ({ ...await original<object>(), getSecret: async () => undefined }));
vi.mock('../src/card/managed', () => ({ sendManagedCard: fixture.send, updateManagedCard: fixture.update }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} }, withTrace: (_context: unknown, callback: () => unknown) => callback() }));

const CREATOR = 'ou_creator', ADMIN = 'ou_admin', OTHER_ADMIN = 'ou_other_admin', NEWCOMER = 'ou_newcomer';
const bot = { appId: 'cli_fixture', tenant: 'feishu' as const, createdAt: 1, registrationId: 'fixture' };
let cfg: AppConfig;
beforeEach(async () => {
  await seedBots({ version: 1, bots: [{ ...bot, name: 'fixture' }] });
  cfg = { accounts: { app: { id: bot.appId, secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: CREATOR, admins: [CREATOR, ADMIN, OTHER_ADMIN] } } };
  await saveConfig(cfg);
  fixture.send.mockClear(); fixture.update.mockClear();
});
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

function app() {
  const fake = fakeLark();
  return createOrchestrator({ send: fixture.send, rawClient: fake.client } as never, cfg, paths.appDir, undefined, { bot });
}
const click = (operator: string, value: Record<string, unknown>, formValue?: Record<string, unknown>): CardActionEvent =>
  ({ messageId: 'om_admins', chatId: 'oc_dm', operator: { openId: operator }, action: { tag: 'button', value, ...(formValue ? { form_value: formValue } : {}) },
    raw: { action: { ...(formValue ? { form_value: formValue } : {}) } } }) as unknown as CardActionEvent;
const saved = async () => (await loadConfig()).preferences?.access?.admins;
/** The card a click patched in place (the list's own message). */
async function patched(): Promise<string> {
  await vi.waitFor(() => expect(fixture.update).toHaveBeenCalled(), { timeout: 10_000 });
  return JSON.stringify(fixture.update.mock.calls.at(-1)?.[2]);
}

describe('the private chat\'s administrators card', () => {
  // main 必败: the owner got the buttons, and an old card's still wrote
  it('shows everyone the list read-only', async () => {
    const orchestrator = app();
    try {
      for (const who of [CREATOR, ADMIN]) {
        fixture.update.mockClear();
        await orchestrator.dispatcher.handle(click(who, { a: DM.admins }));
        const card = await patched();
        expect(card).not.toContain(DM.rmAdmin);
        expect(card).not.toContain(DM.addAdminForm);
      }
    } finally { await orchestrator.shutdown(); }
  });

  it.each([
    ['remove', () => click(CREATOR, { a: DM.rmAdmin, u: OTHER_ADMIN })],
    ['open the add form', () => click(CREATOR, { a: DM.addAdminForm })],
    ['add', () => click(CREATOR, { a: DM.addAdminSubmit }, { open_id: NEWCOMER })],
  ])('redraws an old card\'s %s button as the read-only card and writes nothing', async (_name, event) => {
    const orchestrator = app();
    try {
      await orchestrator.dispatcher.handle(event());
      const card = await patched();
      expect(card).toContain('名单在 Vonvon Bot 客户端或终端里改。');
      expect(card).not.toContain(DM.addAdminSubmit);
      expect(await saved()).toEqual([CREATOR, ADMIN, OTHER_ADMIN]);
      expect(fixture.send).not.toHaveBeenCalled();
    } finally { await orchestrator.shutdown(); }
  });

  it('shows someone off the list nothing', async () => {
    const orchestrator = app();
    try {
      await orchestrator.dispatcher.handle(click(NEWCOMER, { a: DM.rmAdmin, u: ADMIN }));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(fixture.update).not.toHaveBeenCalled();
      expect(await saved()).toEqual([CREATOR, ADMIN, OTHER_ADMIN]);
    } finally { await orchestrator.shutdown(); }
  });
});
