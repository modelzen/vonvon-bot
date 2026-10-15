import type { DesktopSnapshot } from '@vonvon/protocol';
export type RpcOutcome<T> =
  | { kind: 'read'; value: T }
  | { kind: 'mutation'; reply: (snapshot: DesktopSnapshot) => T }
  /** `cancel` runs instead of `afterReply` when the reply never went out. */
  | { kind: 'shutdown'; reply: (snapshot: DesktopSnapshot) => T; afterReply: () => void; cancel?: () => void };
