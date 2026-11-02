import type { PrincipalWire } from '@vonvon/protocol';

/** Who a connection acts as (devices 5.1). D2 and D4a fill the values in; the shape stays. */
export type Principal =
  | { kind: 'owner'; via: 'local' }
  | { kind: 'owner'; via: 'paired'; clientId: string; generation: number }
  | { kind: 'bot-session'; sessionId: string; appId: string; place: 'dm' | 'group' | 'comment'; chatId?: string }
  /** An owner whose client speaks another protocol: only the maintenance kinds (devices 4.5). */
  | { kind: 'maintenance'; protocolVersion: number; inner: 'owner:local' | 'owner:paired' }
  | { kind: 'unpaired' };

/** An unpaired connection never gets a server info or a reply, so it has no name on the wire. */
export function principalWire(principal: Principal): PrincipalWire {
  switch (principal.kind) {
    case 'owner': return principal.via === 'local' ? 'owner:local' : 'owner:paired';
    case 'bot-session': return `bot-session:${principal.place}`;
    case 'maintenance': return 'maintenance';
    case 'unpaired': throw new Error('An unpaired connection has no principal on the wire');
  }
}
