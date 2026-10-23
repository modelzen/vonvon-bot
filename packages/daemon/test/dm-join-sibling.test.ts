import { rm } from 'node:fs/promises';
import type { CardActionEvent } from '@larksuiteoapi/node-sdk';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { createOrchestrator } from '../src/bot/handle-message';
import { DM } from '../src/card/dm-cards';
import { seedBots } from './helpers/bot-fixture';
import { fakeLark, httpError, type Answer } from './helpers/fake-lark-http';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'dm-join-sibling-')));
  return { paths: { appDir, sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), botsFile: join(appDir, 'bots.json'), projectsRootDir: join(appDir, 'projects') },
    botPaths: () => ({ projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json') }) };
});
const fixture = vi.hoisted(() => ({ send: vi.fn(async (..._args: unknown[]) => ({ messageId: 'om_result', cardId: 'card' })) }));
// Keep both selectable backends available so error cards can preserve the selection.
vi.mock('../src/agent', async original => ({ ...await original<object>(), isBackendEntryInstalled: () => true, createBackend: () => ({ id: 'codex-appserver', listModels: async () => [{ id: 'default', displayName: 'Default', supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true, hidden: false }] }), effectiveDefaultBackend: async () => 'codex-appserver' }));
vi.mock('../src/card/managed', () => ({ sendManagedCard: fixture.send, updateManagedCard: vi.fn(async () => true) }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} }, withTrace: (_context: unknown, callback: () => unknown) => callback() }));

const cfg: AppConfig = { accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' } } };
const bot = { appId: 'cli_fixture', tenant: 'feishu' as const, createdAt: 1, registrationId: 'fixture' };
beforeEach(async () => {
  await seedBots({ version: 1, bots: [{ ...bot, name: 'fixture' }] });
  await rm(paths.projectsFile, { force: true });
  fixture.send.mockClear();
});
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

const captured = vi.hoisted(() => ({ input: undefined as Record<string, unknown> | undefined }));
vi.mock('../src/admin/library', async original => ({ ...await original<object>(), siblingProjectOfChat: async () => ({ id: 'prj_0000000a', name: '支付组' }) }));
vi.mock('../src/project/lifecycle', async original => ({ ...await original<object>(), joinExistingGroup: async (_channel: unknown, input: Record<string, unknown>) => {
  captured.input = input;
  return { name: String(input.name), chatId: String(input.chatId), cwd: '/w', blank: true, kind: 'multi', mode: 'qa', backend: 'codex-appserver', network: false, createdAt: 1, origin: 'joined' };
} }));

function app() {
  const fake = fakeLark();
  return { orchestrator: createOrchestrator({ send: fixture.send, rawClient: fake.client } as never, cfg, paths.appDir, undefined, { bot }) };
}
function submit(form: Record<string, unknown>): CardActionEvent {
  return { messageId: 'om_form', chatId: 'oc_dm', operator: { openId: 'ou_owner' }, action: { tag: 'button', value: { a: DM.joinGroupSubmit, chatId: 'oc_join', kind: 'multi' } },
    raw: { action: { form_value: { name: '支付组群', cwd: '', backend: 'claude-agent', ...form } } } } as unknown as CardActionEvent;
}
for (const [label, form, expected] of [['joins by default', {}, 'prj_0000000a'], ['joins when picked', { project: 'join' }, 'prj_0000000a'], ['makes a new project when picked', { project: 'new' }, undefined],
  ['never joins with a typed folder', { project: 'join', cwd: '/w/x' }, undefined], ['ignores a posted project id', { project: 'prj_00000002' }, 'prj_0000000a']] as const) {
  it(`the sibling's project: ${label}`, async () => {
    captured.input = undefined; fixture.send.mockClear();
    const { orchestrator } = app();
    try {
      await orchestrator.dispatcher.handle(submit(form));
      await vi.waitFor(() => expect(captured.input).toBeDefined(), { timeout: 10_000 });
      expect((captured.input as Record<string, unknown> | undefined)?.project).toBe(expected);
    } finally { await orchestrator.shutdown(); }
  }, 15_000);
}
