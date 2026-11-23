import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createLarkChannel, type NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { expect, it, vi } from 'vitest';
import type { BotIdentity } from '../src/config/bots';

it.skipIf(process.platform === 'win32')('configures an ordinary group through its registered bot and revokes setup on re-registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feedback-ordinary-group-'));
  vi.stubEnv('VONVON_HOME', root);
  vi.resetModules();
  const {bridgeFeedback} = await import('../src/feedback/bridge');
  const {NativeFeedbackIm} = await import('../src/feedback/im');
  vi.spyOn(NativeFeedbackIm.prototype, 'reply').mockResolvedValue();
  const {addProject, getProjectByChatId} = await import('../src/project/registry');
  const {botPaths} = await import('../src/config/paths');
  const bot = {appId: 'cli_feedback_test', createdAt: 1, tenant: 'feishu', registrationId: randomUUID()} satisfies BotIdentity;
  const channel = createLarkChannel({appId: bot.appId, appSecret: 'test'});
  const register = (identity: BotIdentity) => writeFile(join(root, 'bots.json'), JSON.stringify({version: 1, bots: [{...identity, name: 'test'}]}));
  const {dir, projectsFile} = botPaths(bot.appId);
  const chatId = 'oc_ordinary';
  const cfg = {accounts: {app: {id: bot.appId, secret: 'test', tenant: bot.tenant}}, preferences: {access: {admins: ['ou_admin']}}};
  const setup = (senderId: string): NormalizedMessage => ({messageId: 'om_setup', chatId, chatType: 'group', senderId,
    rawContentType: 'text', content: '/feedback setup https://tenant.feishu.cn/base/Test?table=tblData https://tenant.feishu.cn/share/base/shrFeedback',
    raw: {sender: {sender_type: 'user', tenant_key: 'org', sender_id: {open_id: senderId}}, message: {message_id: 'om_setup', chat_id: chatId, chat_type: 'group'}},
    createTime: 1, resources: [], mentions: [], mentionedBot: true, mentionAll: false});
  const generation = randomUUID(), managedDir = join(root, 'managed-tools', 'lark-cli');
  const binary = join(managedDir, 'releases', generation, 'bin', 'lark-cli');
  const hosts = [];
  try {
    await mkdir(dirname(binary), {recursive: true});
    await writeFile(binary, 'fixture only, never executed');
    await writeFile(join(managedDir, 'current.json'), JSON.stringify({schemaVersion: 1, tool: 'lark-cli', state: 'active', generation, version: '1.0.0'}));
    await mkdir(dir, {recursive: true});
    await register(bot);
    await addProject({name: 'group', chatId, cwd: root, createdAt: 1, blank: true, supplement: 'ordinary role'}, {file: projectsFile, dataRoot: root});
    const original = await readFile(projectsFile);
    const host = bridgeFeedback(bot, cfg, 'test', channel);
    hosts.push(host);
    await host.onMessage(setup('ou_member'));
    expect(await readFile(projectsFile)).toEqual(original);
    await host.onMessage(setup('ou_admin'));
    const saved = await getProjectByChatId(chatId, projectsFile);
    expect(saved).toMatchObject({supplement: 'ordinary role', feedback: {registration: bot.registrationId, bindingIncarnation: saved?.bindingIncarnation,
      destination: {baseToken: 'Test', tableId: 'tblData', shareToken: 'shrFeedback'}}});
    expect(saved?.richRecipe).toBeUndefined();
    expect(host.enabled(chatId)).toBe(true);
    const configured = await readFile(projectsFile);
    await host.onMessage(setup('ou_admin'));
    expect(await readFile(projectsFile)).toEqual(configured);
    const replacement = {...bot, registrationId: randomUUID()};
    await register(replacement);
    const current = bridgeFeedback(replacement, cfg, 'test', channel);
    hosts.push(current);
    expect(current.enabled(chatId)).toBe(false);
    await host.onMessage(setup('ou_admin'));
    expect(await readFile(projectsFile)).toEqual(configured);
    await current.onMessage(setup('ou_admin'));
    expect((await getProjectByChatId(chatId, projectsFile))?.feedback?.registration).toBe(replacement.registrationId);
  } finally {
    await Promise.all(hosts.map(host => host.close()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, {recursive: true, force: true});
  }
});
