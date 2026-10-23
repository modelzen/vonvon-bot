import type { PermissionTable, TableEnv, Tier } from './types';

/** 建议最近的更高可用档；没有时才向下找，不自动改设置。 */
export function unavailableTierReply(groupId: string, table: PermissionTable, env: TableEnv, tier: Tier, bot?: string): string {
  const tiers = table.tiers(env);
  const current = tiers.findIndex(info => info.tier === tier);
  const info = tiers[current]!;
  if (!info.unavailable) return '';
  const message = `ℹ️ 这一轮没有开始：这个群的权限是「${info.name}」，${info.unavailable}`;
  const suggestion = tiers.slice(current + 1).find(candidate => !candidate.unavailable) ??
    tiers.slice(0, current).reverse().find(candidate => !candidate.unavailable);
  if (!suggestion) return `${message}\n这个 provider 暂时没有可用的权限，请 bot 的主人检查 provider 设置。`;
  const command = `vonvon settings set${bot ? ` --bot ${bot}` : ''} --group ${groupId} permission.mode=${suggestion.tier}`;
  return `${message}\n请 bot 的主人在群设置里换成「${suggestion.name}」，或者在终端运行 \`${command}\`。`;
}
