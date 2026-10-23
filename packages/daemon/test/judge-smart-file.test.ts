import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SMART_RULES } from '@vonvon/protocol';
import { DEFAULT_SMART_PROMPT, LEGACY_DEFAULT_SMART_PROMPT } from '../src/judge/prompt';
import { readSmartPrompt, SmartPromptError, composeSmartRules, resolveSmartRules, rulesFromSmartPrompt } from '../src/judge/smart-file';

const APP = 'cli_a1_b-2';
const CHAT = 'oc_group1';
const dirs: string[] = [];
it('uses one default in runtime and editable fields, leaving explicit custom rules intact', () => {
  expect(composeSmartRules(DEFAULT_SMART_RULES)).toBe(DEFAULT_SMART_PROMPT);
  for (const rules of [{respond: '', newTopic: ''}, {respond: LEGACY_DEFAULT_SMART_PROMPT, newTopic: ''}, {respond: '被 @、有人提问或需要我的能力时回应；闲聊和已解决的问题不主动接话。', newTopic: '出现一个需要独立跟进的新任务时创建话题；已有话题继续在原处回复。'}]) {
    expect(resolveSmartRules(rules)).toEqual(DEFAULT_SMART_RULES);
    expect(composeSmartRules(rules)).toBe(DEFAULT_SMART_PROMPT);
  }
  const custom = {respond: '只回管理员；不要创建话题', newTopic: ''};
  expect(resolveSmartRules(custom)).toEqual(custom);
  expect(rulesFromSmartPrompt({source: 'bot', text: custom.respond, path: '/SMART.md'})).toEqual(custom);
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function botDir(): { dir: string; bot: string; group: string } {
  const dir = mkdtempSync(join(tmpdir(), 'judge-smart-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'groups', CHAT), { recursive: true });
  return { dir, bot: join(dir, 'SMART.md'), group: join(dir, 'groups', CHAT, 'SMART.md') };
}

async function failure(promise: Promise<unknown>): Promise<SmartPromptError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(SmartPromptError);
  return error as SmartPromptError;
}

describe('readSmartPrompt', () => {
  it('falls through group, bot, default', async () => {
    const { dir, bot, group } = botDir();
    expect(await readSmartPrompt(APP, CHAT, dir)).toEqual({ source: 'default', text: DEFAULT_SMART_PROMPT, path: group });
    expect(await readSmartPrompt(APP, undefined, dir)).toMatchObject({ source: 'default', path: bot });
    writeFileSync(bot, '  bot 的提示词\n');
    expect(await readSmartPrompt(APP, CHAT, dir)).toEqual({ source: 'bot', text: 'bot 的提示词', path: group });
    writeFileSync(group, '群的提示词');
    expect(await readSmartPrompt(APP, CHAT, dir)).toEqual({ source: 'group', text: '群的提示词', path: group });
    writeFileSync(group, ' \n\t\n');
    expect(await readSmartPrompt(APP, CHAT, dir)).toMatchObject({ source: 'bot' });
  });

  it('treats a groups/<chatId> that is a file as no group layer', async () => {
    const { dir, bot } = botDir();
    rmSync(join(dir, 'groups'), { recursive: true });
    mkdirSync(join(dir, 'groups'));
    writeFileSync(join(dir, 'groups', CHAT), 'not a directory');
    writeFileSync(bot, 'bot');
    expect(await readSmartPrompt(APP, CHAT, dir)).toMatchObject({ source: 'bot', text: 'bot' });
  });

  it('refuses a symlink, a directory, a hard link, a big or long file, without falling back', async () => {
    const { dir, bot, group } = botDir();
    writeFileSync(bot, 'bot');
    const target = join(dir, 'elsewhere.md');
    writeFileSync(target, 'x');
    symlinkSync(target, group);
    expect((await failure(readSmartPrompt(APP, CHAT, dir))).message).toContain('符号链接');
    rmSync(group);
    mkdirSync(group);
    expect((await failure(readSmartPrompt(APP, CHAT, dir))).message).toContain('不是普通文件');
    rmSync(group, { recursive: true });
    linkSync(target, group);
    const linked = await failure(readSmartPrompt(APP, CHAT, dir));
    expect(linked.message).toContain('硬链接');
    expect(linked.path).toBe(group);
    rmSync(group);
    writeFileSync(group, 'a'.repeat(33 * 1024));
    expect((await failure(readSmartPrompt(APP, CHAT, dir))).message).toContain('32 KB');
    writeFileSync(group, '字'.repeat(8_001));
    expect((await failure(readSmartPrompt(APP, CHAT, dir))).message).toContain('8000 字');
    writeFileSync(group, '字'.repeat(8_000));
    expect(await readSmartPrompt(APP, CHAT, dir)).toMatchObject({ source: 'group' });
  });

  it('does not hang on a FIFO with no writer', async () => {
    const { dir, group } = botDir();
    execFileSync('mkfifo', [group]);
    const started = Date.now();
    const error = await Promise.race([
      failure(readSmartPrompt(APP, CHAT, dir)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hung')), 1_000)),
    ]);
    expect(error.message).toContain('不是普通文件');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('checks ids with the protocol schemas before touching a path', async () => {
    const { dir } = botDir();
    await failure(readSmartPrompt(APP, '../../etc', dir));
    await failure(readSmartPrompt('cli_../x', CHAT, dir));
    await failure(readSmartPrompt('bot', CHAT, dir));
    expect(await readSmartPrompt('cli_A-b_9', 'oc_A-b_9', dir)).toMatchObject({ source: 'default' });
  });
});
