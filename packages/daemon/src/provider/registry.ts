import type { Engine } from './engines/engine';

// V7a adds the ACP member, which names AcpDialect; that type does not exist until then.
export type Registration =
  | { kind: 'codex'; engine: () => Engine }
  | { kind: 'claude'; engine: () => Engine };
