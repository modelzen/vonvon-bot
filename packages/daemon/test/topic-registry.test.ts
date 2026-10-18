import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() }, failRename: false }));
vi.mock('../src/core/logger', () => ({ log: fake.log }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rename: async (from: string, to: string) => {
    if (fake.failRename) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    return fs.rename(from, to);
  } };
});

import { createTopicRegistry, MAX_TOPICS, mergeTopic, topicTitle, type TopicRecord, type TopicSighting } from '../src/bot/topic-registry';
import type { SessionRecord } from '../src/bot/session-store';

const CHAT = 'oc_0123456789abcdef';
let dir: string;
let bindings: Partial<SessionRecord>[];
const registry = () => createTopicRegistry({ dir, sessions: async () => bindings as SessionRecord[] });
const file = () => join(dir, `${CHAT}.json`);
const user = (openId: string) => ({ kind: 'user' as const, openId });
const seen = (topicId: string, at: number, extra: Partial<TopicSighting> = {}): TopicSighting => ({ topicId, at, from: user('ou_a'), ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  fake.failRename = false;
  dir = mkdtempSync(join(tmpdir(), 'topic-registry-'));
  bindings = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('mergeTopic', () => {
  const base: TopicRecord = { topicId: 't', openedBy: user('ou_a'), openedAt: 100_000, lastAt: 100_000 };

  it('keeps the earliest opener, and lets this bot opening the topic win for good', () => {
    expect(mergeTopic(base, seen('t', 90_000, { from: user('ou_b') }))).toMatchObject({ openedBy: user('ou_b'), openedAt: 90_000 });
    expect(mergeTopic(base, seen('t', 100_500, { from: user('ou_b') }))).toBeUndefined();
    const self = mergeTopic(base, seen('t', 200_000, { from: { kind: 'self' } }))!;
    expect(self).toMatchObject({ openedBy: { kind: 'self' }, openedAt: 200_000 });
    expect(mergeTopic(self, seen('t', 1, { from: user('ou_c') }))).toBeUndefined();
  });

  it('fills the first message once and moves lastAt up by the minute only', () => {
    const filled = mergeTopic(base, seen('t', 100_000, { first: { id: 'om_root', from: user('ou_r'), at: 5, text: '  订单接口\n一直 500 ' } }))!;
    expect(filled).toMatchObject({ firstId: 'om_root', firstFrom: user('ou_r'), firstAt: 5, title: '订单接口 一直 500' });
    expect(mergeTopic(filled, seen('t', 100_000, { first: { id: 'om_root', text: '别的' } }))).toBeUndefined();
    expect(mergeTopic(filled, seen('t', 159_999))).toBeUndefined();
    expect(mergeTopic(filled, seen('t', 160_000))?.lastAt).toBe(160_000);
  });

  it("lets this bot opening the topic set the title over a looked-up one, once", () => {
    const looked = mergeTopic(base, seen('t', 100_000, { first: { id: 'om_resume', from: user('ou_a'), text: '/resume abc' } }))!;
    expect(looked.title).toBe('/resume abc');
    const opened = mergeTopic(looked, seen('t', 100_500, { from: { kind: 'self' }, first: { id: 'om_resume', text: '修订单接口' } }))!;
    expect(opened).toMatchObject({ title: '修订单接口', firstFrom: user('ou_a'), openedBy: { kind: 'self' } });
    expect(mergeTopic(opened, seen('t', 100_500, { from: { kind: 'self' }, first: { id: 'om_resume', text: '别的' } }))).toBeUndefined();
  });

  it('makes a short one-line title without file tokens', () => {
    expect(topicTitle('看下 <file key="x" name="a.log"/> 这个')).toBe('看下 这个');
    expect(topicTitle('看下 [设计稿](https://x.cn/design/very/long/path) 这个')).toBe('看下 设计稿 这个');
    expect(topicTitle('看 [词条](https://en.wikipedia.org/wiki/A_(b)_c) 吧')).toBe('看 词条 吧');
    expect(topicTitle('一'.repeat(40))).toBe(`${'一'.repeat(30)}…`);
    expect(topicTitle('   ')).toBeUndefined();
  });
});

describe('topic registry file', () => {
  it("records a topic and joins only this group's live bindings for it, not keys from before s15c", async () => {
    bindings = [
      { threadId: 'omt_a', chatId: CHAT, sessionId: 's-admin', backend: 'codex' },
      { threadId: 'omt_a#guest', chatId: CHAT, sessionId: 's-guest', backend: 'claude' },
      { threadId: 'omt_a#admin', chatId: CHAT, sessionId: 's-old', backend: 'codex', detached: true },
      { threadId: 'omt_ab', chatId: CHAT, sessionId: 's-other', backend: 'codex' },
    ];
    const reg = registry();
    await reg.note(CHAT, seen('omt_a', 1_000, { first: { id: 'om_root' } }));
    await reg.note(CHAT, seen('omt_b', 2_000));
    expect(await reg.get(CHAT, 'omt_a')).toMatchObject({
      topicId: 'omt_a',
      firstId: 'om_root',
      openedBy: user('ou_a'),
      sessions: [{ key: 'omt_a', sessionId: 's-admin', backend: 'codex' }],
    });
    expect((await reg.list(CHAT)).map((t) => t.topicId)).toEqual(['omt_b', 'omt_a']);
    expect((await reg.list(CHAT, { limit: 1 })).map((t) => t.topicId)).toEqual(['omt_b']);
    expect(await reg.get(CHAT, 'omt_missing')).toBeUndefined();
    expect(await reg.list('oc_other')).toEqual([]);
  });

  it('never loses a write when turns note the same group at once', async () => {
    const reg = registry();
    const topics = Array.from({ length: 20 }, (_, i) => reg.note(CHAT, seen(`omt_${i}`, 1_000 + i)));
    const same = [
      reg.note(CHAT, seen('omt_x', 5_000, { first: { id: 'om_x' } })),
      reg.note(CHAT, seen('omt_x', 400_000, { from: { kind: 'self' } })),
      reg.note(CHAT, seen('omt_x', 6_000, { first: { id: 'om_x', from: user('ou_r'), text: '标题' } })),
    ];
    await Promise.all([...topics, ...same]);
    expect(await reg.list(CHAT)).toHaveLength(21);
    expect(await reg.get(CHAT, 'omt_x')).toMatchObject({ openedBy: { kind: 'self' }, firstFrom: user('ou_r'), title: '标题', lastAt: 400_000 });
    // A second registry on the same directory shares the lock.
    await Promise.all([registry().note(CHAT, seen('omt_y', 1)), reg.note(CHAT, seen('omt_z', 1))]);
    expect(await reg.list(CHAT)).toHaveLength(23);
  });

  it('reads old or newer files tolerantly and keeps fields it does not know', async () => {
    await writeFile(file(), JSON.stringify({
      version: 9,
      later: { keep: true },
      topics: [
        { topicId: 'omt_old', openedAt: 10, future: 'x' },
        { openedAt: 1 },
        'junk',
      ],
    }));
    const reg = registry();
    expect(await reg.list(CHAT)).toEqual([{ topicId: 'omt_old', openedAt: 10, lastAt: 10, future: 'x', sessions: [] }]);
    await reg.note(CHAT, seen('omt_old', 120_000, { first: { id: 'om_1', text: '补上标题' } }));
    const written = JSON.parse(await readFile(file(), 'utf8'));
    expect(written).toMatchObject({ version: 1, later: { keep: true } });
    expect(written.topics).toEqual([expect.objectContaining({ topicId: 'omt_old', future: 'x', title: '补上标题', openedBy: user('ou_a'), lastAt: 120_000 })]);
  });

  it('survives a corrupt file: reads empty, then moves it aside and starts over', async () => {
    await writeFile(file(), '{"topics": [');
    const reg = registry();
    expect(await reg.list(CHAT)).toEqual([]);
    expect(await reg.note(CHAT, seen('omt_new', 1))).toMatchObject({ topicId: 'omt_new' });
    expect(await readFile(`${file()}.corrupt`, 'utf8')).toBe('{"topics": [');
    expect((await reg.list(CHAT)).map((t) => t.topicId)).toEqual(['omt_new']);
    expect(fake.log.warn).toHaveBeenCalledWith('intake', 'topic-registry-corrupt', { chatId: 'abcdef', action: 'moved-aside' });
    expect(JSON.stringify(fake.log.warn.mock.calls)).not.toContain(CHAT);
  });

  it('removes its temp file when the rename fails', async () => {
    fake.failRename = true;
    await expect(registry().note(CHAT, seen('omt_a', 1))).resolves.toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
    expect(fake.log.warn).toHaveBeenCalledWith('intake', 'topic-registry-write-failed', expect.objectContaining({ err: expect.stringContaining('EXDEV') }));
  });

  it('logs a failed write instead of throwing', async () => {
    await writeFile(join(dir, 'blocked'), '');
    const reg = createTopicRegistry({ dir: join(dir, 'blocked'), sessions: async () => [] });
    await expect(reg.note(CHAT, seen('omt_a', 1))).resolves.toBeUndefined();
    expect(fake.log.warn).toHaveBeenCalledWith('intake', 'topic-registry-write-failed', expect.objectContaining({ chatId: 'abcdef' }));
  });

  it(`keeps the ${MAX_TOPICS} most recently active topics`, async () => {
    const reg = registry();
    const minute = 60_000;
    for (let i = 0; i < MAX_TOPICS; i++) await reg.note(CHAT, seen(`omt_${i}`, (i + 10) * minute));
    // The oldest one gets new activity, so the next newest-but-quiet one goes instead.
    await reg.note(CHAT, seen('omt_0', (MAX_TOPICS + 20) * minute));
    await reg.note(CHAT, seen('omt_new', (MAX_TOPICS + 21) * minute));
    const ids = (await reg.list(CHAT)).map((t) => t.topicId);
    expect(ids).toHaveLength(MAX_TOPICS);
    expect(ids.slice(0, 2)).toEqual(['omt_new', 'omt_0']);
    expect(ids).not.toContain('omt_1');
    // A late message from a topic quieter than all kept ones is not stored.
    await expect(reg.note(CHAT, seen('omt_ancient', 1))).resolves.toBeUndefined();
    expect((await reg.list(CHAT)).map((t) => t.topicId)).not.toContain('omt_ancient');
  });

  it('keeps an older topic past the cap while it still has a session', async () => {
    const reg = registry();
    const minute = 60_000;
    for (let i = 0; i < MAX_TOPICS; i++) await reg.note(CHAT, seen(`omt_${i}`, (i + 10) * minute));
    bindings = [
      { threadId: 'omt_0', chatId: CHAT, sessionId: 's-0', backend: 'codex' },
      { threadId: 'omt_1', chatId: CHAT, sessionId: 's-1', backend: 'codex', detached: true },
      { threadId: 'omt_2', chatId: 'oc_other', sessionId: 's-2', backend: 'codex' },
      { threadId: 'omt_3#guest', chatId: CHAT, sessionId: 's-3', backend: 'codex' },
    ];
    for (let i = 0; i < 4; i++) await reg.note(CHAT, seen(`omt_new${i}`, (MAX_TOPICS + 20 + i) * minute));
    const ids = (await reg.list(CHAT)).map((t) => t.topicId);
    expect(ids).toHaveLength(MAX_TOPICS + 1);
    expect(ids.at(-1)).toBe('omt_0');
    expect(ids).not.toContain('omt_1');
    expect(ids).not.toContain('omt_2');
    expect(ids).not.toContain('omt_3'); // bound only under a key from before s15c
    expect((await reg.get(CHAT, 'omt_0'))?.sessions).toEqual([{ key: 'omt_0', sessionId: 's-0', backend: 'codex' }]);
  });
});
