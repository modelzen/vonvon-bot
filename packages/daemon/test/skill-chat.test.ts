import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBackend, AgentEvent, StartThreadOptions } from '../src/agent/types';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { createSkillChat } from '../src/bot/skill-chat';
import { claudeAccess, permissionOptions } from '../src/agent/claude-agent/permission';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function message(text: string, senderId = 'owner'): NormalizedMessage { return { content: text, senderId, chatId: 'private_chat', chatType: 'p2p', messageId: `message_${text.length}` } as NormalizedMessage; }
async function fixture(backendId = 'codex-appserver') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vonvon-skill-chat-'))); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const sent = vi.fn(async (..._args: unknown[]) => {});
  const create = vi.fn(async (options: StartThreadOptions) => ({ sessionId: 'native-session', close: vi.fn(async () => {}),
    runStreamed: vi.fn((text: unknown) => ({ turnId: () => 'turn', events: (async function* (): AsyncGenerator<AgentEvent> {
      const skill = join(options.cwd, 'my-skill'); await mkdir(skill, { recursive: true });
      await writeFile(join(skill, 'SKILL.md'), '---\nname: my-skill\ndescription: Task help\n---\nUse this skill.');
      yield { type: 'text', itemId: 'reply', text: `Created my-skill. ${JSON.stringify(text)}` };
      yield { type: 'done', turnId: 'turn' };
    })() })),
  }));
  const resume = vi.fn(create);
  const backend = { id: backendId, startThread: create, resumeThread: resume, listModels: async () => [{ id: 'model', displayName: 'model', supportedEfforts: ['high'], defaultEffort: 'high', isDefault: true, hidden: false }] } as unknown as AgentBackend;
  const project: import('../src/project/registry').Project = { name: 'Target group', chatId: 'target_group', cwd: workspace, blank: false, createdAt: 1, backend: backend.id };
  const chat = createSkillChat({ cfg: { accounts: { app: { id: 'current_bot', secret: 'fake', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner' } } }, backendFor: () => backend, project: async id => id === project.chatId ? project : undefined, send: sent, file: join(root, 'private-state.json') });
  return { root, workspace, chat, create, resume, sent, project };
}

describe('targeted private skill conversation', () => {
  it('rejects unauthorized and foreign groups before creating anything', async () => {
    const t = await fixture();
    expect(await t.chat.handle(message('/skill-add target_group write reports', 'other'))).toBe(true);
    expect(t.create).not.toHaveBeenCalled();
    expect(t.sent).toHaveBeenLastCalledWith('private_chat', '仅 Bot 管理员可以添加技能。', expect.any(String));
    await t.chat.handle(message('/skill-add foreign_group write reports'));
    expect(t.create).not.toHaveBeenCalled();
    await expect(readFile(join(t.workspace, '.agents', 'skills', 'my-skill', 'SKILL.md'), 'utf8')).rejects.toThrow();
  });
  it('writes only into the targeted workspace and resumes its conversation, with an explicit exit', async () => {
    const t = await fixture();
    expect(await t.chat.handle(message('/skill-add target_group write reports'))).toBe(true);
    expect(t.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: join(t.workspace, '.agents', 'skills'), mode: 'write' }));
    expect(await readFile(join(t.workspace, '.agents', 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toContain('name: my-skill');
    await t.chat.handle(message('Also support markdown reports'));
    expect(t.resume).toHaveBeenCalledWith(expect.objectContaining({ cwd: join(t.workspace, '.agents', 'skills'), sessionId: 'native-session' }));
    await t.chat.handle(message('/skill-done'));
    expect(await t.chat.handle(message('open menu'))).toBe(false);
    await t.chat.close();
  });
  it.each([
    { mode: 'full', network: false, expected: true },
    { mode: 'write', network: false, expected: false },
    { mode: 'qa', network: true, expected: true },
  ] as const)('uses the group network effect for $mode/$network', async ({ mode, network, expected }) => {
    const t = await fixture();
    Object.assign(t.project, { mode, network });
    await t.chat.handle(message('/skill-add target_group write reports'));
    expect(t.create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'write', network: expected }));
    await t.chat.close();
  });
  it('keeps Claude skill creation writable only in its skill directory with the group domain allowlist', async () => {
    const t = await fixture('claude-agent');
    t.project.custom = { backend: 'claude-agent', settings: { permissionMode: 'plan', sandbox: false, network: 'domains', domains: ['github.com', '*.npmjs.org'] } };
    await t.chat.handle(message('/skill-add target_group create reports'));
    await t.chat.handle(message('Also add examples'));
    for (const call of [t.create.mock.calls[0]!, t.resume.mock.calls[0]!]) {
      const opts = call[0];
      expect(opts).toMatchObject({cwd: join(t.workspace, '.claude', 'skills'), mode: 'write', network: true,
        native: {permissionMode: 'acceptEdits', sandbox: true, network: 'domains', domains: ['github.com', '*.npmjs.org']}, profile: {additionalRoots: []}});
      const sdk = permissionOptions(claudeAccess(opts.mode, opts.network, opts.cwd, opts.cwd, [], opts.native));
      expect(sdk).toMatchObject({permissionMode: 'acceptEdits', sandbox: {enabled: true, network: {allowedDomains: ['github.com', '*.npmjs.org'], strictAllowlist: true}}, disallowedTools: ['WebSearch']});
      expect(sdk.allowedTools).toEqual(expect.arrayContaining(['WebFetch(domain:github.com)', 'WebFetch(domain:*.npmjs.org)']));
      expect(sdk.allowedTools).not.toContain('WebFetch');
    }
    await t.chat.close();
  });
  it('closes a newly started thread if the progress message fails', async () => {
    const t = await fixture();
    t.sent.mockRejectedValueOnce(new Error('transport unavailable'));
    await t.chat.handle(message('/skill-add target_group build reports'));
    const thread = await t.create.mock.results[0]!.value;
    expect(thread.close).toHaveBeenCalled();
    expect(thread.runStreamed).not.toHaveBeenCalled();
    expect(t.sent).toHaveBeenLastCalledWith('private_chat', expect.stringContaining('transport unavailable'), expect.any(String));
  });
  it('refuses a skill directory pointing outside the group workspace', async () => {
    const t = await fixture(); const other = join(t.root, 'other'); await mkdir(other);
    await symlink(other, join(t.workspace, '.agents'));
    await t.chat.handle(message('/skill-add target_group write reports'));
    expect(t.create).not.toHaveBeenCalled();
    expect(t.sent).toHaveBeenLastCalledWith('private_chat', expect.stringContaining('不是普通目录'), expect.any(String));
  });
});
