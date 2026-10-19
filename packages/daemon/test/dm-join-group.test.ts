import { rm } from 'node:fs/promises';
import type { CardActionEvent } from '@larksuiteoapi/node-sdk';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { getProjectByName } from '../src/project/registry';
import { createOrchestrator } from '../src/bot/handle-message';
import { DM } from '../src/card/dm-cards';
import { seedBots } from './helpers/bot-fixture';
import { fakeLark, httpError, type Answer } from './helpers/fake-lark-http';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'dm-join-group-')));
  return { paths: { appDir, sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), botsFile: join(appDir, 'bots.json'), projectsRootDir: join(appDir, 'projects') },
    botPaths: () => ({ projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json') }) };
});
const fixture = vi.hoisted(() => ({ send: vi.fn(async (..._args: unknown[]) => ({ messageId: 'om_result', cardId: 'card' })) }));
// Keep both selectable backends available so error cards can preserve the selection.
vi.mock('../src/agent', async original => ({ ...await original<object>(), isBackendEntryInstalled: () => true, createBackend: () => ({ id: 'codex-appserver', listModels: async () => [] }), effectiveDefaultBackend: async () => 'codex-appserver' }));
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

function app(answer?: Answer) {
  const fake = fakeLark(answer);
  return { fake, orchestrator: createOrchestrator({ send: fixture.send, rawClient: fake.client } as never, cfg, paths.appDir, undefined, { bot }) };
}

function submit(name: string, kind = 'topic', t: unknown = 'topic'): CardActionEvent {
  return { messageId: 'om_form', chatId: 'oc_dm', operator: { openId: 'ou_owner' }, action: { tag: 'button', value: { a: DM.joinGroupSubmit, chatId: 'oc_join', kind, t } },
    raw: { action: { form_value: { name, cwd: '', backend: 'claude-agent' } } } } as unknown as CardActionEvent;
}
async function reply(): Promise<string> {
  await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  return JSON.stringify(fixture.send.mock.calls[0]?.[2]);
}

it('binds 按话题聊 as multi with default 免@ on and a topic result label', async () => {
  const { orchestrator } = app();
  try {
    await orchestrator.dispatcher.handle(submit('Topic'));
    expect(await reply()).toContain('按话题聊');
    expect(await getProjectByName('Topic')).toMatchObject({ kind: 'multi', noMention: true, origin: 'joined', mode: 'qa', network: false });
  } finally { await orchestrator.shutdown(); }
});
it('binds the topic smart button as 智能', async () => {
  const { orchestrator } = app();
  try {
    await orchestrator.dispatcher.handle(submit('Smart', 'smart'));
    await reply();
    expect(await getProjectByName('Smart')).toMatchObject({ kind: 'single', smart: true, noMention: false });
  } finally { await orchestrator.shutdown(); }
});
it('refuses only an explicit not-in-chat result and preserves the topic form', async () => {
  const { orchestrator } = app(request => request.path.endsWith('/members/is_in_chat') ? { code: 0, data: { is_in_chat: false } } : undefined);
  try {
    await orchestrator.dispatcher.handle(submit('Gone'));
    const json = await reply();
    expect(json).toContain('我已经不在这个群里了');
    expect(json).toContain('submit_topic');
    expect(json).not.toContain('submit_single');
    expect(await getProjectByName('Gone')).toBeUndefined();
  } finally { await orchestrator.shutdown(); }
});
it('keeps binding when the membership lookup fails', async () => {
  const { orchestrator } = app(request => request.path.endsWith('/members/is_in_chat') ? (() => { throw httpError(403, 'no permission'); })() : undefined);
  try {
    await orchestrator.dispatcher.handle(submit('Unknown'));
    expect(await reply()).toContain('已绑定群');
    expect(await getProjectByName('Unknown')).toBeDefined();
  } finally { await orchestrator.shutdown(); }
});
it('keeps topic choices on a missing-name error', async () => {
  const { orchestrator } = app();
  try {
    await orchestrator.dispatcher.handle(submit(''));
    const json = await reply();
    expect(json).toContain('项目名不能为空');
    expect(json).toContain('\"initial_option\":\"claude-agent\"');
    expect(json).toContain('submit_topic');
    expect(json).not.toContain('submit_single');
  } finally { await orchestrator.shutdown(); }
});
it('keeps ordinary multi binding working', async () => {
  const { orchestrator } = app();
  try {
    await orchestrator.dispatcher.handle(submit('Ordinary', 'multi', ''));
    expect(await reply()).toContain('多会话');
    expect(await getProjectByName('Ordinary')).toMatchObject({ kind: 'multi', noMention: true });
  } finally { await orchestrator.shutdown(); }
});
for (const t of [undefined, 1, 'other']) it(`does not treat marker ${String(t)} as a topic`, async () => {
  const { orchestrator } = app();
  try {
    const event = submit('', 'multi', t);
    if (t === undefined) event.action.value = { a: DM.joinGroupSubmit, chatId: 'oc_join', kind: 'multi' };
    await orchestrator.dispatcher.handle(event);
    const json = await reply();
    expect(json).toContain('submit_multi');
    expect(json).toContain('submit_single');
    expect(json).not.toContain('submit_topic');
  } finally { await orchestrator.shutdown(); }
});

it('keeps binding after a membership lookup times out at three seconds', async () => {
  const { orchestrator } = app(request => request.path.endsWith('/members/is_in_chat') ? new Promise<never>(() => {}) : undefined);
  try {
    await orchestrator.dispatcher.handle(submit('Timeout'));
    expect(await reply()).toContain('已绑定群');
    expect(await getProjectByName('Timeout')).toBeDefined();
  } finally { await orchestrator.shutdown(); }
}, 15_000);
