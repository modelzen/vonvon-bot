/**
 * 账号用量数据层 facade —— bot/卡片层唯一允许的取数入口（对 codex-appserver 的
 * 深 import 收编在 src/agent 内，M-8）。支持 Codex（ChatGPT 登录）和 Claude 订阅；
 * 对外类型是归一化形状（UsageError/AccountUsageBundle 等，见 ./types）。
 */
import { fetchUsageBundle as fetchCodexUsageBundle } from './codex-appserver/usage';
import { fetchClaudeUsageBundle } from './claude-agent/usage';
import type { AccountUsageBundle } from './types';

export function fetchUsageBundle(force = false, backend: 'codex-appserver' | 'claude-agent' = 'codex-appserver'): Promise<AccountUsageBundle> {
  return backend === 'claude-agent' ? fetchClaudeUsageBundle(force) : fetchCodexUsageBundle(force);
}
