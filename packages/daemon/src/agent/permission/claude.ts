import { z } from 'zod';
import { PermissionInputError, permissionTiers, type PermissionTable, type Tier } from './types';

const schema = z.object({
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions']),
  network: z.enum(['off', 'all']).default('off'),
}).strict();
function parseCustom(raw: unknown): z.infer<typeof schema> {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new PermissionInputError('Claude 高级设置的 permissionMode 必须是 default、acceptEdits 或 bypassPermissions，network 必须是 off 或 all，不能有其他字段。');
  return result.data;
}
function mode(permissionMode: z.infer<typeof schema>['permissionMode']): Tier {
  return permissionMode === 'default' ? 'qa' : permissionMode === 'acceptEdits' ? 'write' : 'full';
}

export const claudeTable: PermissionTable = {
  backend: 'claude-agent',
  tiers: env => permissionTiers(env, {
    qa: 'Claude：Manual（default 模式），命令在沙箱里',
    write: 'Claude：Edit automatically（acceptEdits 模式），命令在沙箱里',
    full: 'Claude：Bypass permissions（bypassPermissions）',
  }),
  strength: () => '命令在系统沙箱里跑，改不了工作区以外的文件；工作区以外的文件读得到，包括别的群的记忆。',
  parseCustom,
  matchTier(settings) {
    const value = parseCustom(settings);
    if (value.permissionMode === 'bypassPermissions') return 'full';
    if (value.permissionMode === 'default' && value.network === 'off') return 'qa';
    if (value.permissionMode === 'acceptEdits' && value.network === 'all') return 'write';
    return undefined;
  },
  effect(settings) {
    const value = parseCustom(settings);
    return { mode: mode(value.permissionMode), network: value.permissionMode === 'bypassPermissions' || value.network === 'all' };
  },
  describe(settings) {
    const value = parseCustom(settings);
    const names = { default: '手动确认', acceptEdits: '自动接受编辑', bypassPermissions: '跳过权限检查' };
    return `权限模式：${names[value.permissionMode]}（${value.permissionMode}）` +
      (value.permissionMode === 'bypassPermissions' ? '' : `；网络：${value.network === 'all' ? '全部' : '关'}`);
  },
  fromLegacy: (tier, network) => ({ permissionMode: tier === 'qa' ? 'default' : 'acceptEdits', network: network ? 'all' : 'off' }),
};
