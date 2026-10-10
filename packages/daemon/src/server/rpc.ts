import type { DesktopSnapshot } from '@vonvon/protocol';
export type RpcOutcome<T> =
  | { kind: 'read'; value: T }
  | { kind: 'mutation'; reply: (snapshot: DesktopSnapshot) => T }
  | { kind: 'shutdown'; reply: (snapshot: DesktopSnapshot) => T; afterReply: () => void };
