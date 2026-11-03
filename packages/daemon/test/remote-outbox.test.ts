import { describe, expect, it } from 'vitest';
import type { DesktopSnapshot, Event, Response } from '@vonvon/protocol';
import { createRemoteOutbox, type Outgoing } from '../src/server/remote-outbox';

// 0.9.0 Mac 验收: server B's snapshot was 98 % pictures and went out in full on every change; over a 20 KB/s relay the
// pushes queued without end, replies waited behind them, and 8 MB later the connection closed 1013. main 必败: every
// snapshot went out whole, each push queued.
const BOT = `data:image/png;base64,${'B'.repeat(80_000)}`;
const GROUP = `data:image/png;base64,${'G'.repeat(20_000)}`;
const snapshot = (revision: number, bot = BOT): DesktopSnapshot => ({
  revision, observedAt: 1, stale: false, host: { kind: 'starting' },
  agents: [{ id: 'cli_a', name: 'A', avatarDataUrl: bot, enabled: true, running: true, connection: 'connected', activation: 'active' }, { id: 'cli_b', name: 'B', enabled: true, running: true, connection: 'connected', activation: 'active' }],
  groups: [{ id: 'oc_1', name: '一', avatarDataUrl: GROUP }, { id: 'oc_2', name: '二', avatarDataUrl: GROUP }],
  memberships: [], tools: [], jobs: [], application: { platform: 'linux', version: 'test', loginItem: false, dataPath: '/tmp' },
} as unknown as DesktopSnapshot);
const pushed = (revision: number, bot?: string): Event => ({ type: 'event', event: 'snapshot', payload: snapshot(revision, bot) });
const reply = (id: string, revision: number): Response => ({ type: 'response', id, method: 'snapshot', payload: snapshot(revision) });
const log: Event = { type: 'event', event: 'log', payload: { lines: 'x' } };

/** `written`: the frames in order, a ping as 'ping'. */
function socket() {
  const written: Array<Outgoing | 'ping'> = [];
  const state = { queues: true };
  const outbox = createRemoteOutbox({
    write: value => { if (!state.queues) return false; written.push(value); return true; },
    ping: () => { if (!state.queues) return false; written.push('ping'); return true; },
  });
  /** A push, answered by the client at once. */
  const push = (value: Event) => { outbox.event(value); outbox.pong(); };
  return { outbox, written, state, push, frames: () => written.filter((value): value is Outgoing => value !== 'ping') };
}
const payloadOf = (value: Outgoing | 'ping' | undefined): DesktopSnapshot => {
  if (typeof value === 'object' && value.type === 'event' && value.event === 'snapshot') return value.payload;
  if (typeof value === 'object' && value.type === 'response' && value.method === 'snapshot') return value.payload;
  throw new Error('not a snapshot');
};
/** Each frame as 'snapshot <revision>', 'response <revision>', 'log', 'error' or 'ping'. */
const kinds = (written: Array<Outgoing | 'ping'>) => written.map(value => value === 'ping' ? 'ping'
  : value.type === 'event' ? `${value.event} ${value.event === 'snapshot' ? value.payload.revision : ''}`.trim()
  : value.type === 'response' ? `${value.type} ${payloadOf(value).revision}` : value.type);
const pictures = (value: Outgoing | undefined) => {
  const payload = payloadOf(value);
  return [...payload.agents, ...payload.groups].map(item => [item.avatarDataUrl === undefined ? null : item.avatarDataUrl.length, item.avatarRef ?? null]);
};

describe('a remote connection\'s pictures', () => {
  it('go in full with their reference once, in a reply or a push, and as the reference alone after', () => {
    const { outbox, frames, push } = socket();
    outbox.send(reply('r1', 1));
    const [first] = frames();
    const [bot] = pictures(first);
    expect(bot).toEqual([BOT.length, expect.stringMatching(/^[\w-]{43}$/)]);
    // The second group has the same picture as the first: the reference already does
    expect(pictures(first)).toEqual([bot, [null, null], [GROUP.length, expect.any(String)], [null, expect.any(String)]]);
    expect(payloadOf(first).groups[1]?.avatarRef).toBe(payloadOf(first).groups[0]?.avatarRef);
    push(pushed(2));
    outbox.send(reply('r2', 2));
    expect(frames()).toHaveLength(3);
    for (const later of frames().slice(1)) expect(pictures(later)).toEqual(pictures(first).map(([, ref]) => [null, ref]));
    expect(JSON.stringify(frames()[1]).length).toBeLessThan(2_000);
  });

  it('are counted per connection: another one gets them in full again', () => {
    const one = socket();
    const two = socket();
    one.push(pushed(1));
    one.push(pushed(2));
    two.push(pushed(2));
    expect(payloadOf(one.frames()[1]).agents[0]?.avatarDataUrl).toBeUndefined();
    expect(payloadOf(two.frames()[0]).agents[0]?.avatarDataUrl).toBe(BOT);
  });

  it('send a changed picture in full once, under a new reference', () => {
    const { frames, push } = socket();
    push(pushed(1));
    const changed = `data:image/png;base64,${'C'.repeat(80_000)}`;
    push(pushed(2, changed));
    push(pushed(3, changed));
    const [one, two, three] = frames().map(value => payloadOf(value).agents[0]);
    expect(two).toMatchObject({ avatarDataUrl: changed });
    expect(two?.avatarRef).not.toBe(one?.avatarRef);
    expect(three?.avatarDataUrl).toBeUndefined();
    expect(three?.avatarRef).toBe(two?.avatarRef);
  });

  it('count as sent only once the frame was queued, and leave the published event and everything else as it is', () => {
    const { outbox, frames, state, push } = socket();
    const event = pushed(1);
    state.queues = false;
    push(event);
    state.queues = true;
    push(pushed(2));
    expect(payloadOf(frames()[0]).agents[0]?.avatarDataUrl).toBe(BOT);
    expect(event.payload).toEqual(snapshot(1));
    const status = { type: 'response', id: 's', method: 'admin', payload: { kind: 'daemonStatus' } } as unknown as Response;
    outbox.send(status);
    outbox.event(log);
    expect(frames().slice(1)).toEqual([status, log]);
    expect(frames()[1]).toBe(status);
  });
});

describe('a remote connection whose client does not have the last pushed snapshot yet', () => {
  it('pings after each pushed snapshot, keeps only the newest one until the pong, and lets other events through', () => {
    const { outbox, written } = socket();
    outbox.event(pushed(1));
    outbox.event(pushed(2));
    outbox.event(log);
    outbox.event(pushed(3));
    outbox.event(pushed(4));
    expect(kinds(written)).toEqual(['snapshot 1', 'ping', 'log']);
    outbox.pong();
    expect(kinds(written).slice(3)).toEqual(['snapshot 4', 'ping']);
    // The first push carried the pictures already
    expect(payloadOf(written[3]).agents[0]?.avatarDataUrl).toBeUndefined();
    outbox.pong();
    outbox.pong();
    expect(written).toHaveLength(5);
    outbox.event(pushed(5));
    expect(kinds(written).slice(5)).toEqual(['snapshot 5', 'ping']);
  });

  // 复核 P2: a write's reply names the revision its rebuild just published, and the client reads that state from the
  // event before the reply (docs/plan.md). With the event held, the reply came first and the Bot's switch flipped back
  // until the snapshot caught up. 954995c4 必败: 'response 3' came before 'snapshot 3'.
  it('writes the held snapshot ahead of a reply or an error, without another ping, and not ahead of a log event', () => {
    const { outbox, written } = socket();
    outbox.event(pushed(1));
    outbox.event(pushed(2));
    outbox.event(pushed(3));
    outbox.event(log);
    outbox.send(reply('r', 3));
    expect(kinds(written)).toEqual(['snapshot 1', 'ping', 'log', 'snapshot 3', 'response 3']);
    // Pictures went with the first push: the held one and the reply carry references alone
    for (const later of written.slice(3)) expect(payloadOf(later).agents[0]?.avatarDataUrl).toBeUndefined();
    outbox.event(pushed(4));
    const failed = { type: 'error', id: 'w', code: 'internal', message: 'x' } as const;
    outbox.send(failed);
    expect(kinds(written).slice(5)).toEqual(['snapshot 4', 'error']);
    // Nothing is held: a reply goes alone, and the pong of the first ping sends nothing
    outbox.send(reply('s', 4));
    outbox.pong();
    expect(kinds(written).slice(7)).toEqual(['response 4']);
    outbox.event(pushed(5));
    expect(kinds(written).slice(8)).toEqual(['snapshot 5', 'ping']);
  });

  it('drops the waiting snapshot when the connection closes', () => {
    const { outbox, written } = socket();
    outbox.event(pushed(1));
    outbox.event(pushed(2));
    outbox.close();
    outbox.pong();
    expect(written).toHaveLength(2);
  });
});
