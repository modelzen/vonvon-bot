import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@vonvon/protocol';
import { LogFollowers } from '../src/server/logs';

describe('log followers', () => {
  it('replays only the last 16 KiB without a partial first line and stops after unsubscribe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vonvon-logs-'));
    const path = join(dir, `${new Date().toISOString().slice(0, 10)}.log`);
    const events: Event[] = [];
    const unrelated: Event[] = [];
    const peer = { id: 'follow', open: true, event: (value: Event) => events.push(value) };
    const other = { id: 'other', open: true, event: (value: Event) => unrelated.push(value) };
    const followers = new LogFollowers(dir);
    try {
      await writeFile(path, `${'x'.repeat(20_000)}\ncomplete\n`);
      followers.follow(peer, true);
      followers.follow(other, false);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]).toEqual({ type: 'event', event: 'log', payload: { lines: 'complete\n' } });
      await appendFile(path, 'next\n');
      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(events[1]).toEqual({ type: 'event', event: 'log', payload: { lines: 'next\n' } });
      followers.follow(peer, false);
      await appendFile(path, 'hidden\n');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(events).toHaveLength(2);
      expect(unrelated).toEqual([]);
    } finally { followers.close(); await rm(dir, { recursive: true, force: true }); }
  });
});

const readAudit = vi.hoisted(() => ({ lengths: [] as number[], limit: Infinity, zeroOnce: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    const read = handle.read.bind(handle);
    return { close: () => handle.close(), read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      readAudit.lengths.push(length);
      if (readAudit.zeroOnce) { readAudit.zeroOnce = false; return { bytesRead: 0, buffer }; }
      return read(buffer, offset, Math.min(length, readAudit.limit), position);
    } };
  } };
});
afterEach(() => { readAudit.lengths.length = 0; readAudit.limit = Infinity; readAudit.zeroOnce = false; vi.useRealTimers(); });

async function logFixture(initial: string | Buffer = 'ready\n') {
  const directory = await mkdtemp(join(tmpdir(), 'vonvon-log-bounds-'));
  const path = join(directory, `${new Date().toISOString().slice(0, 10)}.log`);
  await writeFile(path, initial);
  const chunks: string[] = [];
  const peer = { id: 'bounded', open: true, event: (event: Event) => {
    if (event.event === 'log') chunks.push(event.payload.lines);
  } };
  const followers = new LogFollowers(directory);
  followers.follow(peer, true);
  return { directory, path, chunks, peer, followers, text: () => chunks.join(''),
    close: async () => { followers.close(); await new Promise(resolve => setTimeout(resolve, 30)); await rm(directory, { recursive: true, force: true }); } };
}
const eventually = async (check: () => void) => vi.waitFor(check, { timeout: 3500, interval: 20 });

describe('log follower byte and decoder contracts', () => {
  it('bounds every raw read and event while delivering a multi-MiB mixed UTF-8 append in order', async () => {
    const fixture = await logFixture();
    try {
      await eventually(() => expect(fixture.text()).toBe('ready\n'));
      const burst = 'ASCII 汉字 😀\n'.repeat(130_000);
      await appendFile(fixture.path, burst);
      await eventually(() => expect(Buffer.byteLength(fixture.text())).toBe(Buffer.byteLength('ready\n' + burst)));
      expect(fixture.text()).toBe('ready\n' + burst);
      expect.soft(Math.max(...readAudit.lengths)).toBeLessThanOrEqual(65_536);
      expect(Math.max(...fixture.chunks.map(text => Buffer.byteLength(text)))).toBeLessThanOrEqual(65_536);
    } finally { await fixture.close(); }
  });

  it('caps decoded events even when invalid bytes expand into replacement characters', async () => {
    const fixture = await logFixture();
    try {
      await eventually(() => expect(fixture.text()).toBe('ready\n'));
      await appendFile(fixture.path, Buffer.alloc(65_536, 0xff));
      await eventually(() => expect(fixture.text().length).toBe(6 + 65_536));
      expect(fixture.chunks.slice(1).join('')).toBe('�'.repeat(65_536));
      expect(Math.max(...fixture.chunks.map(text => Buffer.byteLength(text)))).toBeLessThanOrEqual(65_536);
    } finally { await fixture.close(); }
  });

  it('holds three incomplete UTF-8 bytes and bounds the event when the fourth byte arrives', async () => {
    const fixture = await logFixture();
    try {
      await eventually(() => expect(fixture.text()).toBe('ready\n'));
      const reads = readAudit.lengths.length;
      await appendFile(fixture.path, Buffer.from([0xf0, 0x9f, 0x98]));
      await eventually(() => expect(readAudit.lengths.length).toBeGreaterThan(reads));
      expect(fixture.text()).toBe('ready\n');
      await appendFile(fixture.path, Buffer.concat([Buffer.from([0x80]), Buffer.alloc(65_535, 0x61)]));
      await eventually(() => expect(fixture.text()).toBe('ready\n😀' + 'a'.repeat(65_535)));
      expect(Math.max(...fixture.chunks.map(text => Buffer.byteLength(text)))).toBeLessThanOrEqual(65_536);
    } finally { await fixture.close(); }
  });

  it('carries a split emoji from the end of the replay into live output', async () => {
    const fixture = await logFixture(Buffer.concat([Buffer.from('x'.repeat(20_000) + '\nreplay'), Buffer.from([0xf0, 0x9f, 0x98])]));
    try {
      await eventually(() => expect(fixture.chunks.length).toBeGreaterThan(0));
      expect(fixture.text()).toBe('replay');
      await appendFile(fixture.path, Buffer.from([0x80, 0x0a]));
      await eventually(() => expect(fixture.text()).toBe('replay😀\n'));
    } finally { await fixture.close(); }
  });

  it('suppresses the partial replay line across short reads without losing the remaining window', async () => {
    readAudit.limit = 7;
    const fixture = await logFixture('x'.repeat(20_000) + '\nkept 汉😀\n');
    try {
      await eventually(() => expect(fixture.text()).toBe('kept 汉😀\n'));
    } finally { await fixture.close(); }
  });

  it('ends no-newline replay suppression at the captured replay boundary', async () => {
    const fixture = await logFixture('x'.repeat(20_000));
    try {
      await eventually(() => expect(readAudit.lengths.length).toBeGreaterThan(0));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(fixture.text()).toBe('');
      await appendFile(fixture.path, 'live without newline');
      await eventually(() => expect(fixture.text()).toBe('live without newline'));
    } finally { await fixture.close(); }
  });

  it('preserves live whitespace while retaining the initial whitespace-only replay policy', async () => {
    const fixture = await logFixture(' \n');
    try {
      await eventually(() => expect(readAudit.lengths.length).toBeGreaterThan(0));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(fixture.chunks).toEqual([]);
      await appendFile(fixture.path, '\t \n');
      await eventually(() => expect(fixture.text()).toBe('\t \n'));
    } finally { await fixture.close(); }
  });

  it.each(['shrink', 'date'] as const)('drops pending decoder carry on observed %s', async kind => {
    const fixture = await logFixture();
    try {
      await eventually(() => expect(fixture.text()).toBe('ready\n'));
      const reads = readAudit.lengths.length;
      await appendFile(fixture.path, Buffer.from([0xf0, 0x9f, 0x98]));
      await eventually(() => expect(readAudit.lengths.length).toBeGreaterThan(reads));
      await new Promise(resolve => setTimeout(resolve, 50));
      fixture.chunks.length = 0;
      if (kind === 'shrink') await writeFile(fixture.path, 'new\n');
      else {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(Date.now() + 86_400_000));
        await writeFile(join(fixture.directory, `${new Date().toISOString().slice(0, 10)}.log`), 'new\n');
      }
      await eventually(() => expect(fixture.text()).toBe('new\n'));
    } finally { await fixture.close(); }
  });

  it('advances by actual bytes on short reads and resumes after a zero-byte read', async () => {
    const fixture = await logFixture();
    try {
      await eventually(() => expect(fixture.text()).toBe('ready\n'));
      readAudit.limit = 5;
      readAudit.zeroOnce = true;
      const text = '汉😀 abc\n'.repeat(6);
      await appendFile(fixture.path, text);
      await eventually(() => expect(fixture.text()).toBe('ready\n' + text));
    } finally { await fixture.close(); }
  });

  it('stops a backlog at the event that unsubscribes and discards pending carry', async () => {
    const fixture = await logFixture();
    try {
      await eventually(() => expect(fixture.text()).toBe('ready\n'));
      const original = fixture.peer.event;
      fixture.peer.event = event => { original(event); fixture.followers.detach(fixture.peer); };
      await appendFile(fixture.path, 'z'.repeat(200_000));
      await eventually(() => expect(fixture.chunks.length).toBe(2));
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(Buffer.byteLength(fixture.chunks[1] ?? '')).toBeLessThanOrEqual(65_536);
      expect(fixture.chunks).toHaveLength(2);
    } finally { await fixture.close(); }
  });
});
