import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Event, PairRequest } from '@vonvon/protocol';
import type { log as logger } from '../core/logger';
import { RpcError } from '../server/errors';
import type { ClientRegistry } from './clients';

/** devices 4.3: one-time, 10 minutes, at most 3 unused at once, in the daemon's memory only. */
export interface Invite { id: string; secret: string; expiresAt: number; invitedBy: string }
export interface InviteBook {
  create(options: { ttlMs?: number; invitedBy: string }): Invite;
  /** The invite, used up, when the id and secret match one that has not expired. */
  redeem(id: string, secret: string): Invite | undefined;
  /** An unexpired invite has this id: D3 does not count such a handshake as an unknown key. */
  has(id: string): boolean;
  size(): number;
}
export const INVITE_TTL_MS = 600_000;
const MAX_UNUSED = 3;

export function createInviteBook({ now = Date.now }: { now?: () => number } = {}): InviteBook {
  const invites = new Map<string, Invite>();
  const prune = (): void => { for (const [id, invite] of invites) if (invite.expiresAt <= now()) invites.delete(id); };
  return {
    create({ ttlMs = INVITE_TTL_MS, invitedBy }) {
      prune();
      if (invites.size >= MAX_UNUSED) throw new RpcError('pairing_limit', '已经有 3 条没用过的连接链接了，先用掉或等它们过期（10 分钟）。');
      const invite = { id: `inv_${randomBytes(8).toString('hex')}`, secret: randomBytes(32).toString('base64url'), expiresAt: now() + ttlMs, invitedBy };
      invites.set(invite.id, invite);
      return { ...invite };
    },
    redeem(id, secret) {
      prune();
      const invite = invites.get(id);
      if (!invite) return undefined;
      const expected = Buffer.from(invite.secret);
      const given = Buffer.alloc(expected.length);
      const raw = Buffer.from(secret);
      raw.copy(given);
      // Compared at the same length either way; a different length never matches.
      if (!timingSafeEqual(given, expected) || raw.length !== expected.length) return undefined;
      invites.delete(id);
      return invite;
    },
    has(id) { prune(); return invites.has(id); },
    size() { prune(); return invites.size; },
  };
}

export class PairingError extends Error {
  constructor(readonly code: 'pairing_failed') { super('邀请无效、过期或已经用过。'); this.name = 'PairingError'; }
}

export interface PairingDeps {
  invites: InviteBook; clients: ClientRegistry; device: { readonly name: string };
  publish(event: Event): void; log: Pick<typeof logger, 'info'>;
}
/** Registers the key the secure channel authenticated (D2), once the invite checks out. Neither the link nor the secret is logged. */
export async function completePairing(deps: PairingDeps, input: { publicKey: string; request: PairRequest; address: string }): Promise<{ clientId: string; deviceName: string }> {
  const invite = deps.invites.redeem(input.request.inviteId, input.request.inviteSecret);
  if (!invite) throw new PairingError('pairing_failed');
  const client = await deps.clients.add({
    name: input.request.clientName, publicKey: input.publicKey, clientKind: input.request.clientKind, address: input.address, invitedBy: invite.invitedBy,
  });
  const fields = { clientId: client.id, name: client.name, clientKind: client.clientKind, address: input.address, invitedBy: invite.invitedBy };
  deps.publish({ type: 'event', event: 'device', payload: { change: 'client-paired', ...fields } });
  deps.log.info('device', 'client-paired', fields);
  return { clientId: client.id, deviceName: deps.device.name };
}
