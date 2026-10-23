import type { AgentBackend } from '../types';
import { claudeTable } from './claude';
import { codexTable } from './codex';
import { genericTable } from './generic';
import type { PermissionTable, TableEnv, Tier, TierInfo } from './types';

export * from './types';
export { unavailableTierReply } from './reply';

export function permissionTable(backendId: string): PermissionTable {
  if (backendId === 'codex-appserver') return codexTable;
  if (backendId === 'claude-agent') return claudeTable;
  return genericTable(backendId);
}
export function tableEnv(backend: Pick<AgentBackend, 'supportedModes' | 'fullAccessOnly'>, platform: NodeJS.Platform = process.platform): TableEnv {
  return { platform, supportedModes: backend.supportedModes, fullOnly: backend.fullAccessOnly?.() };
}
export function tierInfo(table: PermissionTable, env: TableEnv, tier: Tier): TierInfo {
  return table.tiers(env).find(info => info.tier === tier)!;
}
