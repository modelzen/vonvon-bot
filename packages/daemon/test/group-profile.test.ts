import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config/paths', () => ({ botPaths: (id: string) => ({ dir: join(state.root, id) }) }));
import { readBotProfile, readGroupProfile, readGroupPersonality, updateBotProfile } from '../src/bot/group-profile';

beforeEach(async () => { state.root = await realpath(await mkdtemp(join(tmpdir(), 'vonvon-group-profile-'))); });
afterEach(async () => { await rm(state.root, { recursive: true, force: true }); });

describe('Bot and group personality integration', () => {
  it('reads the whole SOUL.md as the persona and no longer reads or writes AGENTS.md', async () => {
    const root = join(state.root, 'bot_a'); await mkdir(root);
    await writeFile(join(root, 'SOUL.md'), 'persona'); await writeFile(join(root, 'AGENTS.md'), 'work instructions');
    expect(await readBotProfile('bot_a')).toEqual({ persona: 'persona', memory: '' });
    await updateBotProfile('bot_a', current => ({ ...current, memory: 'shared fact' }));
    expect(await readBotProfile('bot_a')).toEqual({ persona: 'persona', memory: 'shared fact' });
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('work instructions');
  });
  it('keeps independent inheritance live and never leaks another bot or group', async () => {
    await updateBotProfile('bot_a', () => ({ persona: 'BOT_A', memory: 'MEMORY_A' }));
    await updateBotProfile('bot_b', () => ({ persona: 'BOT_B', memory: 'MEMORY_B' }));
    const project = { chatId: 'group_a', name: 'Group A', profile: { persona: 'GROUP_A', memory: 'GROUP_MEMORY', inheritPersona: false, inheritMemory: true } };
    const first = await readGroupPersonality('bot_a', project);
    expect(first.persona).toBe('GROUP_A'); expect(first.memory).toBe('MEMORY_A\n\nGROUP_MEMORY');
    expect(first.instructions).not.toContain('BOT_B');
    await updateBotProfile('bot_a', current => ({ ...current, memory: 'UPDATED' }));
    expect((await readGroupPersonality('bot_a', project)).memory).toBe('UPDATED\n\nGROUP_MEMORY');
    expect((await readGroupPersonality('bot_a', project)).version).not.toBe(first.version);
  });
  it('reads old group files only when no saved group profile exists', async () => {
    const group = join(state.root, 'bot', 'groups', 'group_a'); await mkdir(join(group, 'memory'), { recursive: true });
    await writeFile(join(group, 'SOUL.md'), 'LEGACY'); await writeFile(join(group, 'memory', 'group.md'), 'FACT');
    expect(await readGroupProfile('bot', { chatId: 'group_a' })).toEqual({ persona: 'LEGACY', memory: 'FACT', inheritPersona: true, inheritMemory: true });
    const profile = { persona: '', memory: '', inheritPersona: false, inheritMemory: false };
    expect(await readGroupProfile('bot', { chatId: 'group_a', profile })).toEqual(profile);
  });
  it('serializes concurrent updates and rejects stale revisions before any write', async () => {
    await updateBotProfile('bot', () => ({ persona: 'one', memory: 'base' }));
    await Promise.all([updateBotProfile('bot', current => ({ ...current, persona: 'two' })), updateBotProfile('bot', current => ({ ...current, memory: 'changed' }))]);
    expect(await readBotProfile('bot')).toEqual({ persona: 'two', memory: 'changed' });
    await expect(updateBotProfile('bot', () => ({ persona: 'bad', memory: '' }), () => { throw new Error('stale'); })).rejects.toThrow('stale');
    expect((await readBotProfile('bot')).persona).toBe('two');
  });
});
