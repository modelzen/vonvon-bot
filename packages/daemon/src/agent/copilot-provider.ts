import { createACPCompatibleBackend, providerLogger } from './acp-provider';
import { CopilotACPAgentClient } from './providers/copilot-acp-agent';
import type { Logger } from './paseo/logger';
import type { AgentClient } from './paseo/agent-sdk-types';
import type { SessionBackend } from './paseo/session-backend';

export interface CopilotProviderDependencies {
  client?: AgentClient;
  logger?: Logger;
}

export function createCopilotBackend(dependencies: CopilotProviderDependencies = {}): SessionBackend {
  const client = dependencies.client ?? new CopilotACPAgentClient({
    logger: dependencies.logger ?? providerLogger('copilot'),
  });
  return createACPCompatibleBackend(client, 'copilot-acp', 'Copilot',
    'Copilot CLI 未安装；请安装 copilot 命令并加入 PATH');
}
