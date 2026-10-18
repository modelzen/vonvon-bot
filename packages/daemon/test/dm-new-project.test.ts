import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CardActionEvent } from '@larksuiteoapi/node-sdk';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { getProjectByName } from '../src/project/registry';
import { createOrchestrator, dmCreationId } from '../src/bot/handle-message';
import { DM } from '../src/card/dm-cards';
import { seedBots } from './helpers/bot-fixture';
import { fakeLark, httpError, type Answer } from './helpers/fake-lark-http';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'dm-new-project-')));
  return { paths: { appDir, sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), botsFile: join(appDir, 'bots.json'), projectsRootDir: join(appDir, 'projects') },
    botPaths: () => ({ projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json') }) };
});
const fixture = vi.hoisted(() => ({ send: vi.fn(async (..._args: unknown[]) => ({ messageId: 'om_result', cardId: 'card' })) }));
// One backend: the form shows no picker, so the group gets the effective default written in.
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: () => ({ id: 'codex-appserver', listModels: async () => [] }), effectiveDefaultBackend: async () => 'claude-agent' }));
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
/** One click of 创建 on the DM new-project form, as Feishu delivers it. */
function submit(name: string, card = 'om_form', token = '1'): CardActionEvent {
  return { messageId: card, chatId: 'oc_dm', operator: { openId: 'ou_owner' }, action: { tag: 'button', value: { a: DM.newProjectSubmit, kind: 'multi', __r: token } },
    raw: { action: { form_value: { name, cwd: '' } } } } as unknown as CardActionEvent;
}
/** The card the DM got back for the n-th result. */
async function reply(n: number): Promise<string> {
  await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(n), { timeout: 10_000 });
  return JSON.stringify(fixture.send.mock.calls[n - 1]?.[2]);
}
const isCreate = (request: { method: string; path: string }) => request.method === 'POST' && request.path === '/open-apis/im/v1/chats';

it('creates from the DM in the bot\'s stable directory with a uuid of the card, the clicker and the render', async () => {
  const { fake, orchestrator } = app();
  try {
    await orchestrator.dispatcher.handle(submit('From DM'));
    expect(await reply(1)).toContain('已创建项目');
    const requestId = dmCreationId('om_form', 'ou_owner', '1');
    expect(requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(fake.creates()).toMatchObject([{ params: { uuid: requestId }, data: { name: 'From DM', user_id_list: ['ou_owner'] } }]);
    expect(await getProjectByName('From DM')).toMatchObject({ cwd: join(paths.projectsRootDir, 'fixture', 'groups', 'From DM'), origin: 'created', mode: 'full',
      backend: 'claude-agent', creationRequestId: requestId });
    await orchestrator.dispatcher.handle(submit('Second', 'om_form', '2'));
    await reply(2);
    expect(new Set(fake.creates().map(r => r.params?.uuid)).size).toBe(2);
  } finally { await orchestrator.shutdown(); }
});

it('warns without a form when the result is not known, and sends the same uuid for the same click again', async () => {
  let fail = true;
  const { fake, orchestrator } = app(request => isCreate(request) && fail ? (() => { throw httpError(500, 'busy'); })() : undefined);
  try {
    await orchestrator.dispatcher.handle(submit('Unknown'));
    const card = await reply(1);
    expect(card).toContain('不确定建好没有');
    expect(card).toContain('可能已经建好了，先去飞书看一眼再重试');
    expect(card).toContain('Unknown');
    expect(card).not.toContain('"tag":"form"');
    // Feishu delivering the same click again is the same creation to it.
    fail = false;
    await orchestrator.dispatcher.handle(submit('Unknown'));
    expect(await reply(2)).toContain('已创建项目');
    const [first, second] = fake.creates();
    expect(second?.params?.uuid).toBe(first?.params?.uuid);
  } finally { await orchestrator.shutdown(); }
});

it('keeps the form for a refusal Feishu answered', async () => {
  const { orchestrator } = app(request => isCreate(request) ? (() => { throw httpError(400, { code: 232001, msg: 'invalid name' }); })() : undefined);
  try {
    await orchestrator.dispatcher.handle(submit('Refused'));
    const card = await reply(1);
    expect(card).toContain('创建失败**：飞书拒绝建群 code=232001：invalid name');
    expect(card).toContain('"tag":"form"');
  } finally { await orchestrator.shutdown(); }
});

it('runs DM and web creations one at a time', async () => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { fake, orchestrator } = app(request => isCreate(request) && request.data && (request.data as { name?: string }).name === 'Web first' ? gate.then(() => undefined) : undefined);
  try {
    const web = orchestrator.collaboration({ action: 'createProject', requestId: 'c1b2c3d4-0000-4000-8000-000000000001', name: 'Web first', kind: 'multi', backend: 'codex-appserver' });
    await vi.waitFor(() => expect(fake.creates()).toHaveLength(1), { timeout: 10_000 });
    await orchestrator.dispatcher.handle(submit('DM second'));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(fake.creates()).toHaveLength(1);
    release();
    await web;
    expect(await reply(1)).toContain('已创建项目');
    expect(fake.creates().map(r => (r.data as { name: string }).name)).toEqual(['Web first', 'DM second']);
  } finally { await orchestrator.shutdown(); }
});

it('refuses a DM creation that reaches its turn after shutdown began, without calling Feishu', async () => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { fake, orchestrator } = app(request => isCreate(request) ? gate.then(() => undefined) : undefined);
  const web = orchestrator.collaboration({ action: 'createProject', requestId: 'd1b2c3d4-0000-4000-8000-000000000001', name: 'Web first', kind: 'multi', backend: 'codex-appserver' }).catch(() => undefined);
  await vi.waitFor(() => expect(fake.creates()).toHaveLength(1), { timeout: 10_000 });
  await orchestrator.dispatcher.handle(submit('Queued in DM'));
  const closing = orchestrator.shutdown();
  release();
  await closing; await web;
  expect(await reply(1)).toContain('后台服务正在关闭，没有建群');
  expect(fake.creates()).toHaveLength(1);
});
