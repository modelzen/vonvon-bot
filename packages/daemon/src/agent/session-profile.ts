import { BRIDGE_DEVELOPER_INSTRUCTIONS } from './bridge-instructions';
import { SESSION_ENV } from '../config/session-env';

/** Session requirements, independent of either provider's configuration keys. */
export interface SessionProfile {
  instructions: string;
  env: Readonly<Record<string, string>>;
  nativeSettings: { automaticMemory: false };
  additionalRoots: readonly { path: string; access: 'read' | 'write' }[];
  capabilityPackages: readonly { path: string }[];
  /** Explicit MCP delivery is added with capability packages in s39. */
  mcpServers: readonly { name: string }[];
}

export interface SessionProfileCapabilities {
  instructions: { channel: 'developer' | 'system-append'; replaceOnResume: false };
  additionalRoots: boolean;
  /** Per-path overrides beyond cwd's existing permission tier. */
  directoryAccess: boolean;
  capabilityPackages: false;
  /** Explicit profile delivery, distinct from native inherited MCP settings. */
  mcpServers: false;
  env: true;
  disableNativeMemory: true;
  reapplyOnResume: readonly ('env' | 'nativeSettings' | 'workspaceTrust' | 'additionalRoots' | 'directoryAccess')[];
}

export function resolveSessionProfile(input?: SessionProfile, capabilities?: { additionalRoots: boolean }): SessionProfile {
  if ((!capabilities?.additionalRoots && input?.additionalRoots.length) || input?.capabilityPackages.length || input?.mcpServers.length) {
    throw new Error('额外根、能力包和 MCP profile 交付尚未支持（s39）');
  }
  return {
    instructions: input?.instructions
      ? `${BRIDGE_DEVELOPER_INSTRUCTIONS}\n\n${input.instructions}`
      : BRIDGE_DEVELOPER_INSTRUCTIONS,
    env: { [SESSION_ENV]: '1', ...input?.env },
    nativeSettings: { automaticMemory: false },
    additionalRoots: input?.additionalRoots ?? [],
    capabilityPackages: [],
    mcpServers: [],
  };
}
