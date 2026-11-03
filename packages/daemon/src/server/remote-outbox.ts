import { createHash } from 'node:crypto';
import type { ErrorEnvelope, Event, PairResult, Response, ServerInfo } from '@vonvon/protocol';

export type Outgoing = Response | ErrorEnvelope | Event | ServerInfo | PairResult;

type Pictured = { avatarDataUrl?: string | undefined; avatarRef?: string | undefined };
/** A snapshot payload with every picture this connection already got as a reference (0.9.0 Mac 验收: 98 % of B's
 * snapshot was pictures). `fresh`: the ones it carries in full, counted as sent once its frame is queued. */
function withAvatarRefs(value: Outgoing, sent: ReadonlySet<string>): { value: Outgoing; fresh: Set<string> } {
  const fresh = new Set<string>();
  const snapshot = value.type === 'event' && value.event === 'snapshot' ? value.payload
    : value.type === 'response' && value.method === 'snapshot' ? value.payload : undefined;
  if (!snapshot) return { value, fresh };
  const swap = <T extends Pictured>(item: T): T => {
    if (!item.avatarDataUrl) return item;
    const ref = createHash('sha256').update(item.avatarDataUrl).digest('base64url');
    if (!sent.has(ref) && !fresh.has(ref)) { fresh.add(ref); return { ...item, avatarRef: ref }; }
    const { avatarDataUrl: _sent, ...rest } = item;
    return { ...rest, avatarRef: ref } as T;
  };
  const payload = { ...snapshot, agents: snapshot.agents.map(swap), groups: snapshot.groups.map(swap), memberships: snapshot.memberships.map(swap) };
  return { value: { ...value, payload } as Outgoing, fresh };
}

/**
 * What one remote connection writes, for a link of 20–30 KB/s: each picture once (`send`), and of the snapshots pushed
 * before the client has the last pushed one, only the newest, once it has (`event`). Replies and other events go at once,
 * a reply behind the snapshot held back.
 * That it has it is the client's pong to the ping sent right after it: what the socket still buffers says nothing of
 * what the kernel's send buffer and the relay hold, megabytes on a slow link. `write` and `ping` queue a frame on the
 * socket, false when they did not.
 */
export function createRemoteOutbox(socket: { write(value: Outgoing): boolean; ping(): boolean }) {
  const sent = new Set<string>();
  let waiting = false;
  let parked: Event | undefined;
  const send = (value: Outgoing): boolean => {
    const shown = withAvatarRefs(value, sent);
    if (!socket.write(shown.value)) return false;
    for (const ref of shown.fresh) sent.add(ref);
    return true;
  };
  const push = (value: Event): void => { if (send(value) && socket.ping()) waiting = true; };
  return {
    /** A reply goes after the snapshot it may refer to: a write's reply names the revision its rebuild just published, and
     * a client reads that state from the event before the reply (docs/plan.md, Snapshot and revision). The held one is
     * written first, still covered by the outstanding ping. */
    send(value: Outgoing): void {
      if ((value.type === 'response' || value.type === 'error') && parked) {
        const held = parked;
        parked = undefined;
        send(held);
      }
      send(value);
    },
    /** Snapshots are whole states with a revision: one that waits is replaced by the next, never queued behind it. */
    event(value: Event): void {
      if (value.event !== 'snapshot') send(value);
      else if (waiting) parked = value;
      else push(value);
    },
    /** The client's pong: the last pushed snapshot, and everything before it, has arrived. */
    pong(): void {
      waiting = false;
      const next = parked;
      parked = undefined;
      if (next) push(next);
    },
    close(): void { parked = undefined; },
  };
}
