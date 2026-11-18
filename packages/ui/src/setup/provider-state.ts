import type {ToolState} from '@vonvon/protocol';

export type SetupProvider = 'codex' | 'claude';
export const providerNames = {codex: 'Codex', claude: 'Claude'};
export const providerBackends = {codex: 'codex-appserver', claude: 'claude-agent'} as const;
export const providerIcons = {codex: './agent-icons/terminal.png', claude: './agent-icons/code.png'};
export const providerInstalled = (tool?: ToolState) => tool?.installation === 'installed' && tool.compatibility?.status !== 'tooOld';
export const providerAuthenticated = (tool?: ToolState) => tool?.authentication === 'signedIn' || tool?.authentication === 'notRequired';
/** A Provider may be offered for actual group work only when both checks pass. */
export const providerUsable = (tool?: ToolState) => providerInstalled(tool) && providerAuthenticated(tool);
export const providerSignature = (tool?: ToolState) => JSON.stringify([tool?.installation, tool?.authentication, tool?.version, tool?.compatibility?.status]);
export function preferredProvider(tools: readonly ToolState[]): SetupProvider {
  return (['codex', 'claude'] as const).find(id => {const tool = tools.find(item => item.tool === id); return providerInstalled(tool) && providerAuthenticated(tool);})
    ?? (['codex', 'claude'] as const).find(id => providerInstalled(tools.find(item => item.tool === id))) ?? 'codex';
}
