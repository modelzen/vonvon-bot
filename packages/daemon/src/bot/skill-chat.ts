import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentBackend, AgentThread, ReasoningEffort } from '../agent/types';
import type { AppConfig } from '../config/schema';
import { isAdmin } from '../config/schema';
import { botPaths } from '../config/paths';
import type { Project } from '../project/registry';
import { groupBackendId, projectModelCatalog, resolveExecution } from '../config/execution';
import { writeFileAtomic } from '../server/atomic-file';

interface Target { chatId: string; sessionId?: string; backend?: string; cwd?: string }
interface Stored { [personId: string]: Target }
/** Private, admin-authored conversations explicitly target one existing Bot × group workspace. */
export function createSkillChat(input: {
  cfg: AppConfig;
  backendFor(id: string): AgentBackend;
  project(chatId: string): Promise<Project | undefined>;
  send(chatId: string, text: string, replyTo: string): Promise<void>;
  /** Injected only by tests; production state belongs to this Bot. */
  file?: string;
}) {
  // Do not resolve Bot storage until a private message actually needs it.
  const file = () => input.file ?? join(dirname(botPaths(input.cfg.accounts.app.id).configFile), 'skill-chats.json');
  const active = new Map<string, AgentThread>();
  const queues = new Map<string, Promise<unknown>>();
  let saveChain: Promise<unknown> = Promise.resolve();
  let closed = false;
  async function read(): Promise<Stored> {
    try {
      const raw: unknown = JSON.parse(await readFile(file(), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('技能对话记录无效');
      return raw as Stored;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  async function update(person: string, target?: Target): Promise<void> {
    const job = saveChain.catch(() => undefined).then(async () => {
      const stored = await read();
      if (target) stored[person] = target; else delete stored[person];
      await writeFileAtomic(file(), JSON.stringify(stored));
    });
    saveChain = job;
    return job;
  }
  async function skillDirectory(project: Project, backend: string): Promise<string> {
    const root = await realpath(project.cwd);
    let path = root;
    for (const segment of [backend === 'claude-agent' ? '.claude' : '.agents', 'skills']) {
      path = join(path, segment);
      await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('技能目录不是普通目录，无法安全添加');
    }
    if (await realpath(path) !== path) throw new Error('技能目录路径已改变');
    return path;
  }
  async function process(msg: NormalizedMessage, command: RegExpMatchArray | null): Promise<void> {
    const reply = (text: string) => input.send(msg.chatId, text, msg.messageId);
    if (!isAdmin(input.cfg, msg.senderId)) { await reply('仅 Bot 管理员可以添加技能。'); return; }
    if (msg.content.trim() === '/skill-done') { await update(msg.senderId); await reply('已结束技能对话。'); return; }
    const previous = (await read())[msg.senderId];
    const chatId = command?.[1] ?? previous?.chatId;
    if (!chatId || !/^[A-Za-z0-9_-]{1,200}$/u.test(chatId)) { await reply('请从群设置的「添加 Skill」复制带目标的请求。'); return; }
    const project = await input.project(chatId);
    if (!project) { await update(msg.senderId); await reply('这个 Bot 已不再连接目标群，请重新从群设置添加技能。'); return; }
    const text = command ? (command[2] ?? '').trim() : msg.content.trim();
    const backendId = groupBackendId(project);
    const target: Target = previous?.chatId === chatId && previous.backend === backendId ? { ...previous } : { chatId, backend: backendId };
    await update(msg.senderId, target);
    if (!text) { await reply(`为「${project.name}」添加技能。告诉我它要做什么；发 /skill-done 结束。`); return; }
    if (closed) return;
    const backend = input.backendFor(backendId);
    const cwd = await skillDirectory(project, backendId);
    const models = projectModelCatalog(project, backendId, await backend.listModels());
    const model = models.find(item => item.id === project.defaultModel) ?? models[0];
    if (!model) throw new Error('请先为目标群选择可用模型和 Effort');
    const effort: ReasoningEffort | undefined = model.supportedEfforts.includes(model.defaultEffort) ? model.defaultEffort : model.supportedEfforts[0];
    const execution = resolveExecution({ group: project });
    const native = backendId === 'claude-agent' && execution.custom?.network === 'domains'
      ? { permissionMode: 'acceptEdits', sandbox: true, network: 'domains', domains: [...(execution.custom.domains as string[])] } : undefined;
    const options = { cwd, model: model.id, effort, mode: 'write' as const, network: execution.network, ...(native ? { native } : {}),
      profile: { instructions: `你在私聊中为 Bot ${JSON.stringify(input.cfg.accounts.app.id)} 的群 ${JSON.stringify(project.name)}（${project.chatId}）创建或修改 Skill。当前目录是该群工作区的技能目录。只操作当前目录里的技能文件，不修改其他目录、全局设置或其他群。每个技能一个子目录，入口 SKILL.md 带 name 和 description 的 YAML frontmatter。需要脚本或资源时放入该技能子目录。需求不清楚时用普通回复提问；不要调用 AskUserQuestion。完成后说明技能名和实际创建的文件；不要声称已安装 CLI 或获得授权。`, env: {}, nativeSettings: { automaticMemory: false as const }, additionalRoots: [], capabilityPackages: [], mcpServers: [] } };
    // Resumption failure never silently destroys the prior conversation.
    const thread = target.sessionId && target.cwd === cwd ? await backend.resumeThread({ ...options, sessionId: target.sessionId }) : await backend.startThread(options);
    if (closed) { await thread.close(); return; }
    active.set(msg.senderId, thread);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void thread.close(); }, 10 * 60_000);
    timer.unref();
    try {
      await update(msg.senderId, { ...target, sessionId: thread.sessionId, cwd });
      await reply(`正在为「${project.name}」处理技能需求…`);
      const run = thread.runStreamed({ text });
      const answers = new Map<string, string>();
      let failure: string | undefined;
      for await (const event of run.events) {
        if (closed) break;
        if (event.type === 'text_delta') answers.set(event.itemId, (answers.get(event.itemId) ?? '') + event.delta);
        if (event.type === 'text') answers.set(event.itemId, event.text);
        if (event.type === 'error' && !event.willRetry) failure = event.message;
        if (event.type === 'ask') await run.respondToAsk?.(event.request.id, { kind: 'unanswered', reason: 'unavailable' });
      }
      if (closed) return;
      if (timedOut) throw new Error('技能处理超时，可以继续描述需求后重试');
      if (failure) throw new Error(failure);
      const answer = [...answers.values()].join('\n\n').trim();
      await reply(answer || '这一轮没有返回内容，请补充需求后重试。');
    } finally { clearTimeout(timer); active.delete(msg.senderId); await thread.close(); }
  }
  return {
    async handle(msg: NormalizedMessage): Promise<boolean> {
      if (msg.chatType !== 'p2p' || closed) return false;
      const command = msg.content.trim().match(/^\/skill-add(?:\s+([A-Za-z0-9_-]{1,200}))?(?:\s+([\s\S]*))?$/u);
      const done = msg.content.trim() === '/skill-done';
      const target = (await read())[msg.senderId];
      if (!command && !done && !target) return false;
      // Existing console slash commands stay reachable while a skill chat is selected.
      if (!command && !done && msg.content.trim().startsWith('/')) return false;
      const previous = queues.get(msg.senderId) ?? Promise.resolve();
      const operation = previous.catch(() => undefined).then(() => process(msg, command))
        .catch(error => input.send(msg.chatId, `技能处理未完成：${error instanceof Error ? error.message : String(error)}`, msg.messageId));
      queues.set(msg.senderId, operation);
      try { await operation; } finally { if (queues.get(msg.senderId) === operation) queues.delete(msg.senderId); }
      return true;
    },
    async close(): Promise<void> { closed = true; await Promise.allSettled([...active.values()].map(thread => thread.close())); },
  };
}
