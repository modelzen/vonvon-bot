import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
