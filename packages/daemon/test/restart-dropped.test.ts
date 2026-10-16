import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DROPPED_MAX_AGE_MS, ReplyTimeoutError, droppedText, droppedUuid, readDropped, recordDroppedSync, replyFailure, settleDroppedSync,
  type DroppedOrigin,
} from '../src/bot/restart-dropped';

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vonvon-dropped-')); file = join(dir, 'dropped.json'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const NOW = 1_760_600_000_000;
const origin = (chat: string, message: string, at: number, fields: Partial<DroppedOrigin> = {}): DroppedOrigin =>
  ({ chatId: `oc_${chat}`, messageId: `om_${message}`, at, replyInThread: true, place: 'topic', ...fields });
const onDisk = (): unknown => JSON.parse(readFileSync(file, 'utf8'));

describe('dropped.json', () => {
  it('① touches nothing when nothing was dropped', () => {
    expect(recordDroppedSync(file, [], NOW)).toBe(0);
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, 'kept as it is');
    expect(recordDroppedSync(file, [], NOW)).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('kept as it is');
  });

  it('② merges a group across shutdowns: the newest message and place stay, counts add up', () => {
    expect(recordDroppedSync(file, [origin('a', 'a1', 100), origin('a', 'a2', 300, { replyInThread: false, place: 'main' }), origin('b', 'b1', 200)], NOW)).toBe(2);
    expect(recordDroppedSync(file, [origin('a', 'a3', 250)], NOW + 5000)).toBe(1);
    expect(onDisk()).toEqual({ v: 1, entries: [
      { chatId: 'oc_a', messageId: 'om_a2', at: 300, replyInThread: false, place: 'main', count: 3, droppedAt: NOW + 5000 },
      { chatId: 'oc_b', messageId: 'om_b1', at: 200, replyInThread: true, place: 'topic', count: 1, droppedAt: NOW },
    ] });
  });

  it('③ keeps the newest 200 groups', () => {
    for (let i = 0; i < 210; i++) recordDroppedSync(file, [origin(`g${i}`, `m${i}`, i)], NOW + i);
    const { entries } = readDropped(file, NOW + 300);
    expect(entries).toHaveLength(200);
    expect(entries.map(entry => entry.chatId)).not.toContain('oc_g9');
    expect(entries.map(entry => entry.chatId)).toContain('oc_g10');
  });

  it('④ drops a day-old entry when writing, and takes it out of the file when reading', () => {
    recordDroppedSync(file, [origin('old', 'o1', 1)], NOW - DROPPED_MAX_AGE_MS - 1);
    recordDroppedSync(file, [origin('old', 'o2', 2), origin('new', 'n1', 3)], NOW);
    expect(readDropped(file, NOW).entries.find(entry => entry.chatId === 'oc_old')?.count).toBe(1);
    recordDroppedSync(file, [origin('later', 'l1', 4)], NOW + 1000);
    const read = readDropped(file, NOW + DROPPED_MAX_AGE_MS + 1);
    expect([read.entries.map(entry => entry.chatId), read.stale]).toEqual([['oc_later'], 2]);
    expect((onDisk() as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it('⑤ reads without deleting, settles only the same message, and deletes a damaged file', () => {
    recordDroppedSync(file, [origin('a', 'a1', 1), origin('b', 'b1', 2)], NOW);
    expect(readDropped(file, NOW).entries).toHaveLength(2);
    expect(existsSync(file)).toBe(true);
    recordDroppedSync(file, [origin('a', 'a2', 5)], NOW);
    settleDroppedSync(file, { chatId: 'oc_a', messageId: 'om_a1' }); // merged into om_a2 meanwhile: kept
    settleDroppedSync(file, { chatId: 'oc_b', messageId: 'om_b1' });
    expect(readDropped(file, NOW).entries.map(entry => [entry.messageId, entry.count])).toEqual([['om_a2', 2]]);
    settleDroppedSync(file, { chatId: 'oc_a', messageId: 'om_a2' });
    expect(existsSync(file)).toBe(false);
    for (const bad of ['{not json', JSON.stringify({ v: 2, entries: [] }), JSON.stringify({ v: 1, entries: [], pad: 'x'.repeat(70_000) })]) {
      writeFileSync(file, bad);
      const onCorrupt = vi.fn();
      expect(readDropped(file, NOW, onCorrupt)).toEqual({ entries: [], stale: 0 });
      expect(onCorrupt).toHaveBeenCalledOnce();
      expect(existsSync(file)).toBe(false);
    }
    writeFileSync(file, '{not json');
    const onCorrupt = vi.fn();
    expect(recordDroppedSync(file, [origin('c', 'c1', 1)], NOW, onCorrupt)).toBe(1);
    expect(onCorrupt).toHaveBeenCalledOnce();
    expect(readDropped(file, NOW).entries.map(entry => entry.chatId)).toEqual(['oc_c']);
  });

  it('⑥ leaves out ids of the wrong kind or longer than 64 characters', () => {
    expect(recordDroppedSync(file, [
      { ...origin('a', 'a1', 1), chatId: 'ou_person' }, { ...origin('a', 'a1', 1), messageId: 'msg-1' },
      origin('x'.repeat(62), 'a1', 1), origin('a', 'y'.repeat(62), 1), origin('ok', 'ok1', 1),
    ], NOW)).toBe(1);
    expect(readDropped(file, NOW).entries.map(entry => entry.chatId)).toEqual(['oc_ok']);
    writeFileSync(file, JSON.stringify({ v: 1, entries: [{ ...origin('ok', 'ok1', 1), count: 1, droppedAt: NOW }, { chatId: 'oc_bad', text: '正文' }] }));
    expect(readDropped(file, NOW).entries).toHaveLength(1);
    expect((onDisk() as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it('⑦ writes 0600 and leaves no temp file', () => {
    recordDroppedSync(file, [origin('a', 'a1', 1)], NOW);
    recordDroppedSync(file, [origin('b', 'b1', 1)], NOW);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['dropped.json']);
  });
});

describe('the reply', () => {
  it('⑧ says how many and how long ago', () => {
    expect(droppedText(1, 0)).toBe('刚才重启了，这条没处理，请再发一次。');
    expect(droppedText(3, 0)).toBe('刚才重启了，这条和这个群里另外 2 条都没处理，请再发一次。');
    expect(droppedText(1, 11 * 60_000)).toBe('bot 停了一阵，这条没处理，请再发一次。');
  });

  it('⑨ has a uuid fixed by the message', () => {
    const uuid = droppedUuid('cli_app', { chatId: 'oc_a', messageId: 'om_a1' });
    expect(droppedUuid('cli_app', { chatId: 'oc_a', messageId: 'om_a1' })).toBe(uuid);
    expect(droppedUuid('cli_app', { chatId: 'oc_a', messageId: 'om_a2' })).not.toBe(uuid);
    expect(droppedUuid('cli_other', { chatId: 'oc_a', messageId: 'om_a1' })).not.toBe(uuid);
    expect(uuid).toMatch(/^vd-[0-9a-f]{40}$/);
    expect(uuid.length).toBeLessThanOrEqual(50);
  });

  it('⑩ tries a rate limit, 5xx, 429, no answer and a timeout again, and nothing else', () => {
    const http = (status: number, data?: unknown) => Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data } });
    const network = Object.assign(new Error('connect ECONNREFUSED'), { isAxiosError: true, code: 'ECONNREFUSED' });
    expect(replyFailure(network)).toMatchObject({ retry: true });
    expect(replyFailure(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toMatchObject({ retry: true });
    expect(replyFailure(new ReplyTimeoutError(10_000))).toEqual({ retry: true, detail: '10 秒没有响应' });
    expect(replyFailure(http(503, '<html>'))).toEqual({ retry: true, detail: 'HTTP 503' });
    expect(replyFailure(http(429))).toMatchObject({ retry: true });
    expect(replyFailure(http(400, { code: 99991400, msg: 'too many' }))).toMatchObject({ retry: true });
    expect(replyFailure(Object.assign(new Error('x'), { code: 230020, msg: 'rate' }))).toMatchObject({ retry: true });
    expect(replyFailure(http(400, { code: 230011, msg: 'The message was withdrawn.' }))).toEqual({ retry: false, recalled: true, detail: '飞书 230011：The message was withdrawn.' });
    expect(replyFailure(Object.assign(new Error('x'), { code: 230011 }))).toMatchObject({ retry: false, recalled: true });
    expect(replyFailure(http(400, { code: 99992354, msg: 'message not found' }))).toEqual({ retry: false, detail: '飞书 99992354：message not found' });
    expect(replyFailure(http(400, { code: 99991672, msg: 'scope required', error: { permission_violations: [{ subject: 'im:message:send_as_bot' }] } })))
      .toEqual({ retry: false, scope: 'im:message:send_as_bot', detail: '缺 im:message:send_as_bot' });
    expect(replyFailure(new TypeError("Cannot read properties of undefined (reading 'reply')"))).toMatchObject({ retry: false, unexpected: true });
  });
});
