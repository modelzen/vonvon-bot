import { z } from 'zod';
import { PermissionInputError, permissionTiers, type PermissionTable, type Tier } from './types';

const schema = z.object({
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  network: z.boolean().default(false),
}).strict();
function parseCustom(raw: unknown): z.infer<typeof schema> {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new PermissionInputError('Codex 高级设置的 sandbox 必须是 read-only、workspace-write 或 danger-full-access，network 必须是布尔值，不能有其他字段。');
  return result.data;
}
function mode(sandbox: z.infer<typeof schema>['sandbox']): Tier {
  return sandbox === 'read-only' ? 'qa' : sandbox === 'workspace-write' ? 'write' : 'full';
}

export const codexTable: PermissionTable = {
  backend: 'codex-appserver',
  tiers: env => permissionTiers(env, {
    qa: 'Codex：Read Only（read-only 沙箱）',
    write: 'Codex：Default（workspace-write），比 Codex 自带的多开了网络',
    full: 'Codex：Full Access（danger-full-access）',
  }),
  strength: env => env.fullOnly
    ? 'Linux 上的 Codex 暂时只能用完全访问，没有沙箱。'
    : '系统沙箱管住命令的读、写和联网：工作区以外的文件读不到，也改不了。',
  parseCustom,
  matchTier(settings) {
    const value = parseCustom(settings);
    if (value.sandbox === 'danger-full-access') return 'full';
    if (value.sandbox === 'read-only' && !value.network) return 'qa';
    if (value.sandbox === 'workspace-write' && value.network) return 'write';
    return undefined;
  },
  effect(settings) {
    const value = parseCustom(settings);
    return { mode: mode(value.sandbox), network: value.sandbox === 'danger-full-access' || value.network };
  },
  describe(settings) {
    const value = parseCustom(settings);
    const names = { 'read-only': '只读', 'workspace-write': '工作区可写', 'danger-full-access': '完全访问' };
    return `沙箱模式：${names[value.sandbox]}（${value.sandbox}）` +
      (value.sandbox === 'danger-full-access' ? '' : `；网络：${value.network ? '开' : '关'}`);
  },
  fromLegacy: (tier, network) => ({ sandbox: tier === 'qa' ? 'read-only' : 'workspace-write', network }),
};
