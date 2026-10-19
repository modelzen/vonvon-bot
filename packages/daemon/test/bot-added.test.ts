import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { createOrchestrator } from '../src/bot/handle-message';
import { pendingGroupsFile, readPendingGroups } from '../src/project/pending-groups';
import { addProject } from '../src/project/registry';
import { BACKEND_CATALOG } from '../src/agent/catalog';
import { bindModeFor } from '../src/project/lifecycle';
import { effectiveDefaultBackend } from '../src/agent';
import { topicConversationCopy } from '@vonvon/protocol';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'bot-added-'));
  return { paths: { appDir, sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), botsFile: join(appDir, 'bots.json'), commentInstructionsFile: join(appDir, 'instructions.md'), commentsRootDir: join(appDir, 'comments'), projectsRootDir: join(appDir, 'projects') }, botPaths: () => ({ projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json') }) };
});
const fixture = vi.hoisted(() => ({ send: vi.fn<(...args: unknown[]) => Promise<unknown>>(), info: vi.fn(), fail: vi.fn(), fullOnly: undefined as string | undefined }));
vi.mock('../src/card/managed', () => ({ sendManagedCard: fixture.send, updateManagedCard: vi.fn() }));
vi.mock('../src/core/logger', () => ({ log: { info: fixture.info, warn: vi.fn(), fail: fixture.fail }, withTrace: (_: unknown, run: () => unknown) => run() }));
vi.mock('../src/agent', async original => ({ ...await original<object>(), isBackendEntryInstalled: () => true, createBackend: () => ({ id: 'codex-appserver', displayName: 'Codex', listModels: async () => [], fullAccessOnly: () => fixture.fullOnly }) }));
const cfg: AppConfig = { accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner', admins: ['ou_admin'] } } };
const file = pendingGroupsFile(paths.projectsFile);
const pending = () => readPendingGroups(file);
const stall = () => new Promise<never>(() => {});
const event = (openId = 'ou_owner') => ({ chatId: 'oc_new', operator: { openId } });
const card = () => JSON.stringify(fixture.send.mock.calls.at(-1));
const logged = (name: string, data: object = {}) => expect(fixture.info).toHaveBeenCalledWith('intake', name, expect.objectContaining(data));
function harness(config = cfg) {
  const getChatInfo = vi.fn(async (chatId: string) => ({ chatId, name: 'Research', chatType: 'group', ownerId: 'ou_owner' }));
  const isInChat = vi.fn(async () => ({ code: 0, data: { is_in_chat: true } }));
  const batch = vi.fn(async () => ({ code: 0, data: { items: [] } }));
  const get = vi.fn(async () => ({ code: 0, data: { items: [{ member_id: 'ou_guest', name: '访客' }] } }));
  const chat = vi.fn(async () => ({ code: 0, data: { chat_mode: 'group', group_message_type: 'chat' } }));
  const channel = { send: vi.fn(async () => ({ messageId: 'om_reply' })), botIdentity: { openId: 'ou_bot' }, getChatInfo, rawClient: { contact: { v3: { user: { batch } } }, im: { v1: { chat: { get: chat }, chatMembers: { isInChat, get } } } } };
  const app = createOrchestrator(channel as never, config, paths.appDir); apps.push(app);
  return { app, channel, getChatInfo, isInChat, batch, get, chat };
}
const apps: ReturnType<typeof createOrchestrator>[] = [];
beforeEach(async () => {
  vi.useRealTimers(); fixture.send.mockReset().mockResolvedValue({ messageId: 'om_card' }); fixture.info.mockClear(); fixture.fail.mockClear(); fixture.fullOnly = undefined;
  await rm(file, { force: true }); await rm(paths.projectsFile, { force: true });
});
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.shutdown())); vi.useRealTimers(); });

it('s36b 1: sends the owner a named, read-only setup card', async () => {
  const { app, channel } = harness(); await app.onBotAddedToChat(event());
  expect(fixture.send).toHaveBeenCalledWith(channel, 'ou_owner', expect.any(Object), undefined, false, 'open_id');
  expect(card()).toContain('Research'); expect(card()).toContain('你把我拉进了'); expect(card()).toContain('🔒 权限档：只读 · 网络：关'); logged('bot-added', { to: 'adder', sent: 'yes' });
});
it('s36b 2: sends an administrator their own card', async () => {
  const { app } = harness(); await app.onBotAddedToChat(event('ou_admin'));
  expect(fixture.send).toHaveBeenCalledOnce(); expect(fixture.send.mock.calls[0]?.[1]).toBe('ou_admin');
});
it('s36b 3: retains a guest addition and tells the owner who invited it (main fails)', async () => {
  const { app } = harness(); await app.onBotAddedToChat(event('ou_guest'));
  expect(fixture.send.mock.calls[0]?.[1]).toBe('ou_owner'); expect(card()).toContain('访客'); expect(card()).toContain('拉我的不是主人或管理员'); expect(await pending()).toEqual([expect.objectContaining({ operator: 'ou_guest' })]);
});
it('s36b 4: missing contact and member names fall back to 有人 (main fails)', async () => {
  const h = harness(); h.batch.mockRejectedValue(new Error('contact')); h.get.mockRejectedValue(new Error('members'));
  await h.app.onBotAddedToChat(event('ou_guest')); expect(card()).toContain('有人'); expect(fixture.send).toHaveBeenCalledOnce();
});
it('s36b 5: contact and member lookup share one three-second deadline (main fails)', async () => {
  const h = harness(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  h.batch.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 1000)); throw new Error('contact'); }); h.get.mockImplementation(stall);
  const added = h.app.onBotAddedToChat(event('ou_guest')); await vi.waitFor(() => expect(h.batch).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(2900); expect(fixture.send).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(100); await added; expect(card()).toContain('有人');
});
it('s36b 6: ignores self joins without recording a candidate (main fails)', async () => {
  const { app } = harness(); await app.onBotAddedToChat(event('ou_bot')); expect(await pending()).toEqual([]); expect(fixture.send).not.toHaveBeenCalled(); logged('bot-added-self');
});
it('s36b 7: parallel redeliveries send only one card (main fails)', async () => {
  const { app } = harness(); await Promise.all([app.onBotAddedToChat(event()), app.onBotAddedToChat(event())]); expect(fixture.send).toHaveBeenCalledOnce(); expect(await pending()).toHaveLength(1); logged('bot-added-again');
});
it('s36b 8: replaces an eleven-minute-old addition (main fails)', async () => {
  await writeFile(file, JSON.stringify({ version: 1, groups: [{ chatId: 'oc_new', operator: 'ou_admin', addedAt: Date.now() - 660_000, generation: 'old', state: 'verifying' }] }));
  const { app } = harness(); await app.onBotAddedToChat(event('ou_guest'));
  expect(await pending()).toEqual([expect.objectContaining({ operator: 'ou_guest', generation: expect.not.stringMatching(/^old$/) })]); expect(fixture.send).toHaveBeenCalledOnce();
});
it.each(['topic', 'thread'])('s36b 9/10: %s groups offer two topic choices and retain their candidate (main fails)', async mode => {
  const h = harness(); h.chat.mockResolvedValue({ code: 0, data: { chat_mode: mode === 'topic' ? 'topic' : 'group', group_message_type: mode === 'thread' ? 'thread' : 'chat' } });
  if (mode === 'topic') h.getChatInfo.mockImplementation(async chatId => ({ chatId, name: 'Research', chatType: 'topic', ownerId: 'ou_owner' }));
  await h.app.onBotAddedToChat(event()); expect(card()).toContain('submit_topic'); expect(card()).toContain('submit_smart'); expect(card()).not.toContain('submit_single'); expect(card()).toContain('"t":"topic"'); expect(card()).toContain(topicConversationCopy.threads.subtitle);
  await vi.waitFor(async () => expect(await pending()).toEqual([expect.objectContaining({ state: 'ready', topic: true })]));
});
it('s36b 11: missing group information still sends an unnamed card', async () => {
  const h = harness(); h.getChatInfo.mockRejectedValue(new Error('chat')); await h.app.onBotAddedToChat(event()); expect(card()).toContain('一个群（没读到群名）'); expect(card()).not.toContain('Research');
});
it('s36b 12: hung group information expires after three seconds (main fails)', async () => {
  const h = harness(); h.isInChat.mockResolvedValue({ code: 0, data: { is_in_chat: false } }); h.getChatInfo.mockImplementation(stall); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const added = h.app.onBotAddedToChat(event()); await vi.waitFor(() => expect(h.getChatInfo).toHaveBeenCalled()); await vi.advanceTimersByTimeAsync(3000); await added; expect(card()).toContain('一个群（没读到群名）');
});
it('s36b 13: with no owner, keeps the candidate without sending', async () => {
  const { app } = harness({ accounts: cfg.accounts }); await app.onBotAddedToChat(event('ou_guest')); expect(fixture.send).not.toHaveBeenCalled(); expect(await pending()).toHaveLength(1); logged('bot-added-no-owner');
});
it('s36b 14: a failed private card leaves the candidate and logs the recipient', async () => {
  fixture.send.mockRejectedValue(new Error('private chat unavailable')); const { app } = harness(); await app.onBotAddedToChat(event()); expect(await pending()).toHaveLength(1); expect(fixture.fail).toHaveBeenCalledWith('intake', expect.any(Error), expect.objectContaining({ phase: 'bot-added-bindcard', to: 'adder' }));
});
it('s36b 15: shutdown releases a hung intake before its deadline and sends no card (main fails)', async () => {
  const h = harness(); h.isInChat.mockResolvedValue({ code: 0, data: { is_in_chat: false } }); h.getChatInfo.mockImplementation(stall); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const added = h.app.onBotAddedToChat(event()); await vi.waitFor(() => expect(h.getChatInfo).toHaveBeenCalled()); let stopped = false; const closing = h.app.shutdown().then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(1000); expect(stopped).toBe(true); await Promise.all([added, closing]); expect(fixture.send).not.toHaveBeenCalled(); expect(await pending()).toHaveLength(1); logged('bot-added-dropped');
});
it('s36b 16: binding while reads run suppresses the setup card (main fails)', async () => {
  const h = harness(); let bound = false; h.getChatInfo.mockImplementation(async chatId => {
    if (!bound) { bound = true; await addProject({ name: 'Research', chatId, cwd: paths.appDir, kind: 'multi', blank: false, origin: 'joined', createdAt: 1 }); }
    return { chatId, name: 'Research', chatType: 'group', ownerId: 'ou_owner' };
  });
  await h.app.onBotAddedToChat(event()); expect(fixture.send).not.toHaveBeenCalled(); logged('bot-added-bound');
});
it.each([undefined, 'claude-agent'])('s36b 17: the backend initial value follows configured default %s (main fails)', async backend => {
  const { app } = harness({ ...cfg, preferences: { ...cfg.preferences, defaults: { backend } } }); await app.onBotAddedToChat(event()); expect(card()).toContain(`"initial_option":"${backend ?? await effectiveDefaultBackend()}"`);
});
it.each([undefined, '这台电脑是 Linux，只能完全访问'])('s36b 18: the Linux warning follows backend capability %s (main fails)', async warning => {
  fixture.fullOnly = warning; const { app } = harness(); await app.onBotAddedToChat(event()); expect(card().includes('这台电脑是 Linux')).toBe(Boolean(warning));
});
it('s36b 19: every catalog backend permits the fixed read-only setup default', () => { for (const backend of BACKEND_CATALOG) expect(bindModeFor(backend.id)).toBeUndefined(); });
it('s36b 20: a hung sweep preserves the candidate, logs failure, and retries on redelivery (main fails)', async () => {
  const h = harness(); h.getChatInfo.mockImplementation(stall); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const added = h.app.onBotAddedToChat(event()); await vi.waitFor(() => expect(h.getChatInfo).toHaveBeenCalledTimes(2)); await vi.advanceTimersByTimeAsync(3000); await added;
  expect(await pending()).toEqual([expect.objectContaining({ state: 'verifying' })]); expect(fixture.fail).toHaveBeenCalledWith('intake', expect.any(Error), expect.objectContaining({ phase: 'pending-groups' }));
  h.getChatInfo.mockImplementation(async chatId => ({ chatId, name: 'Research', chatType: 'group', ownerId: 'ou_owner' })); await h.app.onBotAddedToChat(event());
  await vi.waitFor(async () => expect(await pending()).toEqual([expect.objectContaining({ state: 'ready' })])); expect(fixture.send).toHaveBeenCalledOnce();
});
it('s36b offline regression: an unbound mention only replies; it neither records nor privately sends a setup card', async () => {
  const { app, channel } = harness();
  const message: NormalizedMessage = { messageId: 'om_offline', chatId: 'oc_offline', chatType: 'group', senderId: 'ou_owner', content: '在吗', mentionedBot: true, createTime: Date.now(), mentions: [], mentionAll: false, rawContentType: 'text', resources: [] };
  await app.onMessage(message); expect(channel.send).toHaveBeenCalledWith('oc_offline', { markdown: '主人还没设置好这个群，设置好就能用。' }, expect.anything()); expect(fixture.send).not.toHaveBeenCalled(); expect(await pending()).toEqual([]);
});
