import { describe, expect, it } from 'vitest';
import type { MemoryItem } from '@vonvon/protocol';
import {
  actorOf, botWriteGate, decideAdd, decideEdit, isMakeRoomCandidate, memoryTokens, textInMessage, type MemoryPlace, type MemoryTurn,
} from '../src/bot/memory-authority';

const turn = (patch: Partial<MemoryTurn> = {}): MemoryTurn => ({
  kind: 'human', steered: false, role: 'owner', openId: 'ou_owner', place: 'group', chatId: 'oc_a', active: true, typed: true,
  triggerText: '以后给我的东西都先写结论', botWrites: 0, ...patch,
});
const place: MemoryPlace = { chatProjectId: 'prj_00000001', botProjectIds: ['prj_00000001', 'prj_00000002'] };
const add = (patch: Partial<MemoryTurn> = {}, text = '给主人的东西都先写结论', scope?: Parameters<typeof decideAdd>[0]['scope'], via: 'tool' | 'hidden_block' = 'tool', where: MemoryPlace = place) =>
  decideAdd({ turn: turn(patch), place: where, via, text, ...(scope === undefined ? {} : { scope }) });

describe('who wrote it', () => {
  it('marks the owner and admin trusted, a member untrusted, and a turn without a human as the bot', () => {
    expect(actorOf(turn())).toEqual({ actorRole: 'owner', actorOpenId: 'ou_owner', trust: 'trusted' });
    expect(actorOf(turn({ role: 'admin', openId: 'ou_adm' }))).toMatchObject({ actorRole: 'admin', trust: 'trusted' });
    expect(actorOf(turn({ role: 'member', openId: 'ou_m' }))).toEqual({ actorRole: 'member', actorOpenId: 'ou_m', trust: 'untrusted' });
    for (const kind of ['wake', 'initiative', 'retry', 'bot'] as const) expect(actorOf(turn({ kind }))).toEqual({ actorRole: 'bot', trust: 'untrusted' });
    expect(actorOf(turn({ steered: true }))).toEqual({ actorRole: 'bot', trust: 'untrusted' });
  });
});

describe('writing project memory', () => {
  it('lands in the project this group is bound to', () => {
    expect(add({}, 'x', 'project')).toMatchObject({ allow: true, scope: { kind: 'project', projectId: 'prj_00000001' }, trust: 'trusted', actorRole: 'owner' });
    expect(add({ role: 'member', openId: 'ou_m' }, 'x')).toMatchObject({ allow: true, scope: { kind: 'project' }, trust: 'untrusted', actorRole: 'member', actorOpenId: 'ou_m' });
    expect(add({ kind: 'wake', openId: undefined, role: 'bot' }, 'x')).toMatchObject({ allow: true, scope: { kind: 'project' }, trust: 'untrusted', actorRole: 'bot' });
  });
  it('refuses another project in a group and, in a DM, one the bot is not bound to', () => {
    expect(add({}, 'x', { project: 'prj_00000002' })).toEqual({ allow: false, reason: 'not-allowed-here' });
    expect(add({}, 'x', { project: 'prj_00000001' })).toMatchObject({ allow: true, scope: { projectId: 'prj_00000001' } });
    expect(add({ place: 'dm' }, 'x', { project: 'prj_00000002' })).toMatchObject({ allow: true, scope: { projectId: 'prj_00000002' } });
    expect(add({ place: 'dm' }, 'x', { project: 'prj_00000009' })).toEqual({ allow: false, reason: 'not-allowed-here' });
  });
  it('has no project to write to for a group without one', () => {
    expect(add({}, 'x', undefined, 'tool', {})).toEqual({ allow: false, reason: 'no-project' });
  });
  it('refuses a comment, and a turn that is no longer the running one', () => {
    expect(add({ place: 'comment' })).toEqual({ allow: false, reason: 'not-allowed-here' });
    expect(add({ active: false })).toEqual({ allow: false, reason: 'not-allowed-here' });
  });
});

describe('writing private-chat memory (dm-agent 5)', () => {
  const own = { kind: 'dm', openId: 'ou_owner' };
  it('lands in the person\'s own memory unless a project is named, a hidden block too', () => {
    expect(add({ place: 'dm' }, 'x')).toMatchObject({ allow: true, scope: own, trust: 'trusted', actorOpenId: 'ou_owner' });
    expect(add({ place: 'dm' }, 'x', 'dm')).toMatchObject({ allow: true, scope: own });
    expect(add({ place: 'dm' }, 'x', undefined, 'hidden_block')).toMatchObject({ allow: true, scope: own });
    // main 必败: with one bound project a private word went to a memory the groups read
    expect(add({ place: 'dm' }, 'x', 'project', 'tool', { botProjectIds: ['prj_00000003'] })).toMatchObject({ allow: true, scope: own });
  });
  it('stays here when the Bot memory gate fails, with the reason', () => {
    expect(add({ place: 'dm', typed: false }, 'x', 'bot')).toMatchObject({ allow: true, scope: own, downgraded: 'not-typed' });
  });
  it('marks what no person said as the bot\'s own, and refuses a turn with no person', () => {
    expect(add({ place: 'dm', kind: 'initiative' })).toMatchObject({ allow: true, scope: own, trust: 'untrusted', actorRole: 'bot' });
    expect(add({ place: 'dm', openId: undefined })).toEqual({ allow: false, reason: 'not-allowed-here' });
  });
  it('is nobody\'s in a group or a comment', () => {
    expect(add({}, 'x', 'dm')).toEqual({ allow: false, reason: 'not-allowed-here' });
    expect(add({ place: 'comment' }, 'x', 'dm')).toEqual({ allow: false, reason: 'not-allowed-here' });
  });
});

describe('writing bot memory', () => {
  it('lets the owner’s own typed message put its own words in', () => {
    expect(add({}, '给主人的东西都先写结论', 'bot')).toMatchObject({ allow: true, scope: { kind: 'bot' }, trust: 'trusted', actorRole: 'owner' });
    expect(add({ role: 'admin', openId: 'ou_adm' }, '先写结论', 'bot')).toMatchObject({ allow: true, scope: { kind: 'bot' }, actorRole: 'admin' });
  });
  it('falls to the project with the reason for each condition that fails', () => {
    const reasons: Array<[Partial<MemoryTurn>, string, string]> = [
      [{ role: 'member', openId: 'ou_m' }, '先写结论', 'member'],
      [{ kind: 'wake', role: 'bot' }, '先写结论', 'not-human-turn'],
      [{ kind: 'initiative', role: 'bot' }, '先写结论', 'not-human-turn'],
      [{ steered: true }, '先写结论', 'steered'],
      [{ typed: false }, '先写结论', 'not-typed'],
      [{}, '周四发布新版本', 'not-in-message'],
      [{ botWrites: 1 }, '先写结论', 'quota'],
    ];
    for (const [patch, text, downgraded] of reasons) {
      const decision = add(patch, text, 'bot');
      expect(decision, downgraded).toMatchObject({ allow: true, scope: { kind: 'project', projectId: 'prj_00000001' }, downgraded });
    }
  });
  it('refuses outright in a comment and never writes it from a hidden block', () => {
    expect(add({ place: 'comment' }, '先写结论', 'bot')).toEqual({ allow: false, reason: 'not-allowed-here' });
    const hidden = add({}, '先写结论', 'bot', 'hidden_block');
    expect(hidden).toMatchObject({ allow: true, scope: { kind: 'project' } });
    expect('downgraded' in hidden && hidden.downgraded).toBeFalsy();
  });
  it('has a bot gate that is the same for edit, forget and move', () => {
    expect(botWriteGate(turn())).toBeUndefined();
    expect(botWriteGate(turn({ typed: false }))).toBe('not-typed');
    expect(botWriteGate(turn({ botWrites: 1 }))).toBe('quota');
    expect(botWriteGate(turn(), '完全无关的文字')).toBe('not-in-message');
  });
});

describe('the item text has to come from the trigger message', () => {
  it('counts CJK bigrams and ASCII words, and needs at least half', () => {
    expect([...memoryTokens('发版 Friday')].sort()).toEqual(['friday', '发版'].sort());
    expect(textInMessage('先写结论', '以后给我的东西都先写结论')).toBe(true);
    expect(textInMessage('周四发版', '周四发版前先测一遍')).toBe(true);
    expect(textInMessage('把 deploy 改到 Friday', '把 deploy 改到 friday 吧')).toBe(true);
    expect(textInMessage('周四发版', '随便聊聊')).toBe(false);
    expect(textInMessage('周四发版', undefined)).toBe(false);
    expect(textInMessage('！！！', '！！！')).toBe(false);
  });
});

const item = (patch: Partial<Pick<MemoryItem, 'scope' | 'source'>> = {}): Pick<MemoryItem, 'scope' | 'source'> => ({
  scope: { kind: 'project', projectId: 'prj_00000001' },
  source: { via: 'tool', botId: 'cli_a', actorRole: 'member', actorOpenId: 'ou_m', chatId: 'oc_a' }, ...patch,
});
const edit = (patch: Partial<MemoryTurn>, target = item(), text?: string) =>
  decideEdit({ turn: turn(patch), place, item: target, ...(text === undefined ? {} : { text }) });

describe('editing and forgetting', () => {
  it('lets the owner and admin touch any entry of the project, from any group', () => {
    expect(edit({}, item({ source: { via: 'tool', botId: 'x', actorRole: 'member', actorOpenId: 'ou_z', chatId: 'oc_other' } }))).toMatchObject({ allow: true });
    expect(edit({ role: 'admin' })).toMatchObject({ allow: true });
  });
  it('lets a member touch their own entries and this group’s bot entries only', () => {
    const member = { role: 'member' as const, openId: 'ou_m' };
    expect(edit(member)).toMatchObject({ allow: true });
    expect(edit({ ...member, openId: 'ou_other' })).toEqual({ allow: false, reason: 'not-yours' });
    const botOwn = item({ source: { via: 'tool', botId: 'x', actorRole: 'bot', chatId: 'oc_a' } });
    const botElsewhere = item({ source: { via: 'tool', botId: 'x', actorRole: 'bot', chatId: 'oc_b' } });
    expect(edit({ ...member, openId: 'ou_other' }, botOwn)).toMatchObject({ allow: true });
    expect(edit({ ...member, openId: 'ou_other' }, botElsewhere)).toEqual({ allow: false, reason: 'not-yours' });
  });
  it('lets a turn without a human, or a steered one, touch only this group’s bot entries', () => {
    const botOwn = item({ source: { via: 'tool', botId: 'x', actorRole: 'bot', chatId: 'oc_a' } });
    expect(edit({ kind: 'wake', role: 'bot' }, botOwn)).toMatchObject({ allow: true, actor: { actorRole: 'bot' } });
    expect(edit({ kind: 'wake', role: 'bot' })).toEqual({ allow: false, reason: 'not-yours' });
    expect(edit({ steered: true })).toEqual({ allow: false, reason: 'not-yours' });
    expect(edit({ steered: true }, botOwn)).toMatchObject({ allow: true });
  });
  it('refuses a project the group is not bound to and a comment', () => {
    expect(edit({}, item({ scope: { kind: 'project', projectId: 'prj_00000009' } }))).toEqual({ allow: false, reason: 'out-of-scope' });
    expect(edit({ place: 'comment' })).toEqual({ allow: false, reason: 'not-allowed-here' });
  });
  it('asks the bot-memory conditions for an entry of the bot memory, and the owner’s DM for a DM entry', () => {
    const botItem = item({ scope: { kind: 'bot' } });
    expect(edit({}, botItem)).toMatchObject({ allow: true });
    expect(edit({ role: 'member' }, botItem)).toEqual({ allow: false, reason: 'out-of-scope', downgraded: 'member' });
    expect(edit({}, botItem, '周四发布')).toEqual({ allow: false, reason: 'out-of-scope', downgraded: 'not-in-message' });
    const dm = item({ scope: { kind: 'dm', openId: 'ou_owner' } });
    expect(edit({ place: 'dm' }, dm)).toMatchObject({ allow: true });
    expect(edit({ place: 'group' }, dm)).toEqual({ allow: false, reason: 'out-of-scope' });
    expect(edit({ place: 'dm', openId: 'ou_x', role: 'admin' }, dm)).toEqual({ allow: false, reason: 'out-of-scope' });
  });
});

describe('making room', () => {
  it('lists only entries the bot wrote and imported ones', () => {
    const base = { state: 'active' as const };
    expect(isMakeRoomCandidate({ ...base, source: { via: 'tool', botId: 'x', actorRole: 'bot' } })).toBe(true);
    expect(isMakeRoomCandidate({ ...base, source: { via: 'import', botId: 'x', actorRole: 'desktop' } })).toBe(true);
    expect(isMakeRoomCandidate({ ...base, source: { via: 'tool', botId: 'x', actorRole: 'owner' } })).toBe(false);
    expect(isMakeRoomCandidate({ state: 'archived', source: { via: 'tool', botId: 'x', actorRole: 'bot' } })).toBe(false);
  });
});
