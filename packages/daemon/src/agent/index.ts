import type { AgentBackend } from './types';
import { DEFAULT_BACKEND_ID } from './types';
import { catalogBackendIds } from './catalog';
import { CodexAppServerBackend } from './codex-appserver/backend';
import { createClaudeBackend } from './claude-provider';
import { createACPBackend } from './acp-provider';
import { createCopilotBackend } from './copilot-provider';
import { createOpenCodeBackend } from './opencode-provider';
import { createPiBackend } from './pi-provider';
import { customAcpCommand, customAcpInvalidHint } from './custom-acp-command';

export { DEFAULT_BACKEND_ID } from './types';

/**
 * Backend registry. Construction is lazy (a factory per id) so merely having a
 * backend registered costs nothing until some project actually selects it.
 *
 * The CATALOG (catalog.ts) is the single registration入口 for backend metadata;
 * this map only carries the factory functions. `backendIds()` is derived from the
 * catalog (not these keys) so the catalog stays authoritative — a backend-registry
 * test asserts the two id sets match exactly (adding a backend to one but not the
 * other goes red).
 */
const REGISTRY = new Map<string, () => AgentBackend>([
  ['codex-appserver', () => new CodexAppServerBackend()],
  ['claude-agent', createClaudeBackend],
  ['copilot-acp', createCopilotBackend],
  ['opencode-server', createOpenCodeBackend],
  ['pi-rpc', createPiBackend],
  ['custom-acp', () => {
    const state = customAcpCommand();
    return state.kind === 'set' ? createACPBackend({ command: state.command })
      : new UnconfiguredACPBackend(state.kind === 'invalid' ? customAcpInvalidHint(state) : '未配置自定义 ACP 命令（主机设置 › 执行）', state.kind === 'invalid');
  }],
]);

class UnconfiguredACPBackend implements AgentBackend {
  readonly id = 'custom-acp';
  readonly displayName = '自定义 ACP';
  readonly supportedModes = ['full'] as const;
  readonly capabilities = { goal: true, steer: false, compact: false, resume: true, approvals: false };
  constructor(private readonly hint: string, private readonly invalid: boolean) {}
  async isAvailable() { return false; }
  async doctor() { return { ok: false, version: null, ...(this.invalid ? {} : { depState: 'external-missing' as const }), hint: this.hint }; }
  async listModels() { return []; }
  async listThreads() { return []; }
  async readHistory() { return { turns: [], totalTurns: 0 }; }
  async startThread(): Promise<never> { throw new Error(this.hint); }
  async resumeThread(): Promise<never> { throw new Error(this.hint); }
}

/** Registered backend ids（从 catalog 派生 —— catalog 是单一注册入口）。 */
export function backendIds(): string[] {
  return catalogBackendIds();
}

/** Construct an agent backend by id. No id → the codex app-server default. */
export function createBackend(id: string = DEFAULT_BACKEND_ID): AgentBackend {
  const make = REGISTRY.get(id);
  if (!make) {
    throw new Error(`未知 agent 后端「${id}」（可用：${backendIds().join('、')}）`);
  }
  return make();
}

export type * from './types';
export {
  BACKEND_CATALOG,
  visibleCatalog,
  catalogById,
  catalogByFamily,
  catalogBackendIds,
  isInstallable,
} from './catalog';
export type { AgentFamily, BackendAccess, DepKind, BackendDep, BackendCatalogEntry } from './catalog';
export {
  detectAgents,
  effectiveDefaultBackend,
  backendForProject,
  type AgentId,
  type AgentRuntime,
  type BackendAvailability,
} from './detect';
export {
  loadBackendDep,
  isBackendDepInstalled,
  isBackendBinInstalled,
  isBackendEntryInstalled,
  isBackendInstalledInUserDir,
  installedBackendVersion,
  backendsBinPath,
  BackendNotInstalledError,
} from './backend-loader';
export {
  installBackendDep,
  uninstallBackendDep,
  type UninstallResult,
  latestNpmVersion,
  buildInstallCommand,
  stripVersion,
  type InstallResult,
  type InstallProgress,
} from './installer';
