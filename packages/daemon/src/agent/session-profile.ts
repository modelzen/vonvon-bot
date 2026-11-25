import { BRIDGE_DEVELOPER_INSTRUCTIONS } from './bridge-instructions';
import { SESSION_ENV } from '../config/session-env';

/** Session requirements, independent of either provider's configuration keys. */
export interface SessionProfile {
  instructions: string;
  /** Native context filtering only; files and CLI permissions are unchanged. */
  skills?: { disabledPaths: readonly string[]; enabledNames?: readonly string[]; disabledBuiltinNames?: readonly string[] };
  env: Readonly<Record<string, string>>;
  nativeSettings: { automaticMemory: false };
  additionalRoots: readonly { path: string; access: 'read' | 'write' }[];
  /** Plugin-shaped directories handed over natively; today only vonvon's builtin package (T4b), s39d adds `'user'`. */
  capabilityPackages: readonly { path: string; kind: 'builtin' }[];
  /** Explicit MCP delivery is added with capability packages in s39. */
  mcpServers: readonly { name: string }[];
  /**
   * vonvon's own tools beyond the always-on ones: the schedule tools (定时任务 T3) and the Feishu read tools (dm-agent 7.3),
   * both in a bound group's sessions. `feishuEdit` adds feishu_doc_edit, by the session's tier (7.2). `documentsOnly`: a
   * comment's session, whose Feishu tools are the document column only (7.4). `feishuApi` adds feishu_api, a private
   * chat's only (7.6). `acrossBots`: a private chat's, whose read tools take a `bot` (7.3). `askUser`: adds the Codex
   * `ask_user` dynamic tool so Codex can send interactive Feishu choice cards in normal (non-Plan) turns too.
   */
  tools?: { schedule: boolean; feishu?: boolean; feishuEdit?: boolean; feishuApi?: boolean; documentsOnly?: boolean; acrossBots?: boolean; askUser?: boolean };
}

export interface SessionProfileCapabilities {
  instructions: { channel: 'developer' | 'system-append'; replaceOnResume: false };
  additionalRoots: boolean;
  /** Per-path overrides beyond cwd's existing permission tier. */
  directoryAccess: boolean;
  capabilityPackages: boolean;
  /** Explicit profile delivery, distinct from native inherited MCP settings. */
  mcpServers: false;
  env: true;
  disableNativeMemory: true;
  reapplyOnResume: readonly ('env' | 'nativeSettings' | 'workspaceTrust' | 'additionalRoots' | 'directoryAccess')[];
}

export function resolveSessionProfile(input?: SessionProfile, capabilities?: { additionalRoots: boolean; capabilityPackages?: boolean }): SessionProfile {
  if ((!capabilities?.additionalRoots && input?.additionalRoots.length) || (!capabilities?.capabilityPackages && input?.capabilityPackages.length)
    || input?.mcpServers.length) {
    throw new Error('额外根、能力包和 MCP profile 交付尚未支持（s39）');
  }
  return {
    instructions: input?.instructions
      ? `${BRIDGE_DEVELOPER_INSTRUCTIONS}\n\n${input.instructions}`
      : BRIDGE_DEVELOPER_INSTRUCTIONS,
    env: { [SESSION_ENV]: '1', ...input?.env },
    nativeSettings: { automaticMemory: false },
    additionalRoots: input?.additionalRoots ?? [],
    capabilityPackages: input?.capabilityPackages ?? [],
    mcpServers: [],
    tools: { ...input?.tools, schedule: input?.tools?.schedule ?? false, feishu: input?.tools?.feishu ?? false },
    ...(input?.skills ? { skills: input.skills } : {}),
  };
}
