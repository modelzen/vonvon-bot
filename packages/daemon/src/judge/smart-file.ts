import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { agentIdSchema, groupIdSchema, DEFAULT_SMART_RULES, smartRulesText } from '@vonvon/protocol';
import { botDir } from '../config/paths';
import { DEFAULT_SMART_PROMPT, LEGACY_DEFAULT_SMART_PROMPT, LEGACY_TWO_FIELD_SMART_RULES } from './prompt';

// Reading SMART.md lives here until s38's bot file module replaces it.

export const SMART_MAX_CHARS = 8_000;
export const SMART_MAX_BYTES = 32 * 1024;

/** SMART.md exists but cannot be used. The judgement fails with kind `prompt`; it does not quietly
 * fall back to the default, or the group would act unlike what the owner wrote (design 第 9 节第 7 条). */
export class SmartPromptError extends Error {
  readonly kind = 'prompt';
  constructor(message: string, readonly path?: string) {
    super(message);
    this.name = 'SmartPromptError';
  }
}

export interface SmartPrompt {
  source: 'default' | 'bot' | 'group';
  text: string;
  /** the file to edit now: the group's with a chatId, else the bot's */
  path: string;
}

/** One layer's text; undefined when the layer is absent or only whitespace. */
async function readLayer(path: string): Promise<string | undefined> {
  let handle;
  try {
    // O_NONBLOCK: a FIFO with no writer would block open() forever on a libuv pool thread, and
    // fs.open cannot be aborted. O_NOFOLLOW: an agent with full access can write into the group's
    // directory (product.md 3.6).
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    if (code === 'ELOOP') throw new SmartPromptError('SMART.md 是符号链接', path);
    if (code === 'EACCES' || code === 'EPERM') throw new SmartPromptError('没有权限读 SMART.md', path);
    throw new SmartPromptError(`读不了 SMART.md（${code ?? 'unknown'}）`, path);
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new SmartPromptError('SMART.md 不是普通文件', path);
    if (st.nlink !== 1) throw new SmartPromptError('SMART.md 有不止一个硬链接', path);
    if (st.size > SMART_MAX_BYTES) throw new SmartPromptError('SMART.md 超过 32 KB', path);
    const buffer = await handle.readFile();
    if (buffer.length > SMART_MAX_BYTES) throw new SmartPromptError('SMART.md 超过 32 KB', path);
    const text = buffer.toString('utf8');
    if (!text.trim()) return undefined;
    if ([...text].length > SMART_MAX_CHARS) throw new SmartPromptError(`SMART.md 超过 ${SMART_MAX_CHARS} 字`, path);
    return text;
  } catch (error) {
    if (error instanceof SmartPromptError) throw error;
    throw new SmartPromptError(`读不了 SMART.md（${(error as NodeJS.ErrnoException).code ?? 'unknown'}）`, path);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The smart prompt for a group (or the bot, without a chatId): the group's
 * `bots/<appId>/groups/<chatId>/SMART.md`, else the bot's `bots/<appId>/SMART.md`, else the
 * built-in default. The group layer replaces the bot's whole, it is not appended (product.md 3.2).
 * Read on every judgement, never cached. `dir` is the bot directory, for tests.
 */
export async function readSmartPrompt(appId: string, chatId?: string, dir?: string): Promise<SmartPrompt> {
  // The protocol's own id rules, so `../` never reaches a path and an appId accepted elsewhere is
  // accepted here too.
  if (!agentIdSchema.safeParse(appId).success) throw new SmartPromptError('Bot 的 id 不对');
  if (chatId !== undefined && !groupIdSchema.safeParse(chatId).success) throw new SmartPromptError('群的 id 不对');
  const base = dir ?? botDir(appId);
  const botPath = join(base, 'SMART.md');
  const groupPath = chatId === undefined ? undefined : join(base, 'groups', chatId, 'SMART.md');
  const path = groupPath ?? botPath;
  if (groupPath) {
    const text = await readLayer(groupPath);
    if (text !== undefined) return { source: 'group', text, path };
  }
  const text = await readLayer(botPath);
  if (text !== undefined) return { source: 'bot', text, path };
  return { source: 'default', text: DEFAULT_SMART_PROMPT, path };
}

/** Owner text remains separate from the fixed decision protocol. Legacy SMART is kept whole in respond. */
export function composeSmartRules(rules: { respond: string; newTopic: string }): string {
  return smartRulesText(resolveSmartRules(rules));
}

/** Upgrade only exact app-generated defaults; never split or replace an owner's custom SMART. */
export function resolveSmartRules(rules: { respond: string; newTopic: string }): { respond: string; newTopic: string } {
  const legacyFull = !rules.newTopic && [LEGACY_DEFAULT_SMART_PROMPT, smartRulesText(LEGACY_TWO_FIELD_SMART_RULES)].includes(rules.respond);
  const legacyTwoField = rules.respond === LEGACY_TWO_FIELD_SMART_RULES.respond && rules.newTopic === LEGACY_TWO_FIELD_SMART_RULES.newTopic;
  const legacyShort = rules.respond === '被 @、有人提问或需要我的能力时回应；闲聊和已解决的问题不主动接话。'
    && rules.newTopic === '出现一个需要独立跟进的新任务时创建话题；已有话题继续在原处回复。';
  return legacyFull || legacyTwoField || legacyShort ? { ...DEFAULT_SMART_RULES } : { ...rules };
}

export function rulesFromSmartPrompt(prompt: SmartPrompt): { respond: string; newTopic: string } {
  // Custom file contents are opaque, including instructions about where to reply.
  return prompt.source === 'default' ? { ...DEFAULT_SMART_RULES } : { respond: prompt.text, newTopic: '' };
}
