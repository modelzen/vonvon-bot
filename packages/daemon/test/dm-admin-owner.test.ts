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

/** audit 252-1: only the owner changes this machine's administrators, from the private chat's 设置 → 管理员 cards too. */
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'dm-admin-owner-')));
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

const OWNER = 'ou_owner', ADMIN = 'ou_admin', OTHER_ADMIN = 'ou_other_admin', NEWCOMER = 'ou_newcomer';
const bot = { appId: 'cli_fixture', tenant: 'feishu' as const, createdAt: 1, registrationId: 'fixture' };
let cfg: AppConfig;
beforeEach(async () => {
  await seedBots({ version: 1, bots: [{ ...bot, name: 'fixture' }] });
  // No Feishu roles: the scanner is the owner, the other two this machine's own administrators.
  cfg = { accounts: { app: { id: bot.appId, secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: OWNER, admins: [ADMIN, OTHER_ADMIN] } } };
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
/** The card a form's submit sent back as a new message. */
async function sent(): Promise<string> {
  await vi.waitFor(() => expect(fixture.send).toHaveBeenCalled(), { timeout: 10_000 });
  return JSON.stringify(fixture.send.mock.calls.at(-1)?.[2]);
}

describe('the private chat\'s administrators card', () => {
  it('shows an admin who is not the owner the list read-only, and the owner the buttons', async () => {
    const orchestrator = app();
    try {
      await orchestrator.dispatcher.handle(click(ADMIN, { a: DM.admins }));
      const readOnly = await patched();
      expect(readOnly).toContain('本机管理员名单只有主人能改。');
      expect(readOnly).not.toContain(DM.rmAdmin);
      expect(readOnly).not.toContain(DM.addAdminForm);
      fixture.update.mockClear();
      await orchestrator.dispatcher.handle(click(OWNER, { a: DM.admins }));
      const editable = await patched();
      expect(editable).toContain(DM.rmAdmin);
      expect(editable).toContain(DM.addAdminForm);
    } finally { await orchestrator.shutdown(); }
  });

  it('refuses an admin who is not the owner removing another admin, and lets the owner', async () => {
    const orchestrator = app();
    try {
      await orchestrator.dispatcher.handle(click(ADMIN, { a: DM.rmAdmin, u: OTHER_ADMIN }));
      expect(await patched()).toContain('本机管理员名单只有主人能改。');
      expect(await saved()).toEqual([ADMIN, OTHER_ADMIN]);
      expect(cfg.preferences?.access?.admins).toEqual([ADMIN, OTHER_ADMIN]);
      fixture.update.mockClear();
      await orchestrator.dispatcher.handle(click(OWNER, { a: DM.rmAdmin, u: OTHER_ADMIN }));
      await patched();
      expect(await saved()).toEqual([ADMIN]);
    } finally { await orchestrator.shutdown(); }
  });

  it('refuses an admin who is not the owner adding one, from the form or an old card, and lets the owner', async () => {
    const orchestrator = app();
    try {
      await orchestrator.dispatcher.handle(click(ADMIN, { a: DM.addAdminForm }));
      expect(await patched()).not.toContain(DM.addAdminSubmit);
      await orchestrator.dispatcher.handle(click(ADMIN, { a: DM.addAdminSubmit }, { open_id: NEWCOMER }));
      expect(await sent()).toContain('本机管理员名单只有主人能改。');
      expect(await saved()).toEqual([ADMIN, OTHER_ADMIN]);
      fixture.send.mockClear();
      await orchestrator.dispatcher.handle(click(OWNER, { a: DM.addAdminSubmit }, { open_id: NEWCOMER }));
      expect(await sent()).toContain(DM.rmAdmin);
      expect(await saved()).toEqual([ADMIN, OTHER_ADMIN, NEWCOMER]);
    } finally { await orchestrator.shutdown(); }
  });
});
