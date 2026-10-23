import { z } from 'zod';
import { PermissionInputError, permissionTiers, type PermissionTable, type Tier } from './types';

const DOMAIN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const schema = z.object({
  permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']),
  sandbox: z.boolean().optional(),
  network: z.enum(['off', 'all', 'domains']).default('off'),
  domains: z.array(z.string().trim().toLowerCase().max(253).regex(DOMAIN)).max(50).default([]),
}).strict();
export type ClaudeNative = z.infer<typeof schema> & { sandbox: boolean };
export function parseClaudeNative(raw: unknown): ClaudeNative {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (input?.permissionMode === 'bypassPermissions' && (input.network !== undefined && input.network !== 'all'
    || input.domains !== undefined && (!Array.isArray(input.domains) || input.domains.length !== 0)))
    throw new PermissionInputError('跳过权限检查时不限网络，不能设网络');
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new PermissionInputError('Claude 高级设置无效：permissionMode 必须是 default、acceptEdits、plan、auto 或 bypassPermissions；sandbox 必须是布尔值；network 必须是 off、all 或 domains；domains 最多 50 个有效网站，不能有其他字段。');
  const value = result.data;
  if (value.permissionMode === 'bypassPermissions') value.network = 'all';
  const domains = value.network === 'domains' ? [...new Set(value.domains)] : [];
  if (value.network === 'domains' && !domains.length)
    throw new PermissionInputError('只允许这些网站时，至少写一个网站。');
  return { ...value, sandbox: value.sandbox ?? value.permissionMode !== 'bypassPermissions', domains };
}
function mode(permissionMode: z.infer<typeof schema>['permissionMode']): Tier {
  return permissionMode === 'default' ? 'qa' : permissionMode === 'bypassPermissions' ? 'full' : 'write';
}
const names = { default: '手动确认', acceptEdits: '自动接受编辑', plan: '先出方案', auto: '自动判断', bypassPermissions: '跳过权限检查' };
function effect(value: ClaudeNative) { return { mode: mode(value.permissionMode), network: value.permissionMode === 'bypassPermissions' || value.network !== 'off' }; }

export const claudeTable: PermissionTable = {
  backend: 'claude-agent',
  tiers: env => permissionTiers(env, {
    qa: 'Claude：Manual（default 模式），命令在沙箱里',
    write: 'Claude：Edit automatically（acceptEdits 模式），命令在沙箱里',
    full: 'Claude：Bypass permissions（bypassPermissions）',
  }),
  strength: env => '只读、工作区可写档下，命令和读写文件的工具都挡得住 vonvon 存的别的群、别的项目、私聊的资料（包括记忆）；工作区和 bot 的 skill 读得到。' + (env.platform === 'linux' ? '别的群的目录名看得到、里面读不到；会话开着时新建的群、项目、bot 目录，命令读得到，到这个话题下一次起会话才挡。' : ''),
  fields: () => [
    { key: 'permissionMode', label: '权限模式', native: 'permission mode', kind: 'choice', choices: [
      { value: 'default', label: names.default, native: 'default', hint: '要确认的操作在群里没人确认，一律拒绝。' },
      { value: 'acceptEdits', label: names.acceptEdits, native: 'acceptEdits' },
      { value: 'plan', label: names.plan, native: 'plan', hint: '每一轮先出方案，主人或管理员在卡片上确认后，按自动接受编辑动手。' },
      { value: 'auto', label: names.auto, native: 'auto', hint: 'Claude 自己的分类器判断能不能做，不问人。' },
      { value: 'bypassPermissions', label: names.bypassPermissions, native: 'bypassPermissions' },
    ] },
    { key: 'sandbox', label: '命令沙箱', native: 'sandbox', kind: 'switch', hint: '关掉以后命令不在沙箱里跑；除了跳过权限检查，命令一律不能用（群里没人确认）。' },
    { key: 'network', label: '网络', native: 'network', kind: 'choice', choices: [
      { value: 'off', label: '关', native: 'off' }, { value: 'all', label: '全部', native: 'all' },
      { value: 'domains', label: '只允许这些网站', native: 'allowedDomains' },
    ], showWhen: { key: 'permissionMode', in: ['default', 'acceptEdits', 'plan', 'auto'] } },
    { key: 'domains', label: '允许的网站', native: 'allowedDomains', kind: 'domains', hint: '一行一个，例如 github.com、*.npmjs.org。', showWhen: { key: 'network', in: ['domains'] } },
  ],
  expand: tier => ({ permissionMode: tier === 'qa' ? 'default' : tier === 'write' ? 'acceptEdits' : 'bypassPermissions', sandbox: tier !== 'full', network: tier === 'qa' ? 'off' : 'all', domains: [] }),
  parseCustom: parseClaudeNative,
  matchTier(settings) {
    const value = parseClaudeNative(settings);
    if (value.permissionMode === 'bypassPermissions' && !value.sandbox) return 'full';
    if (value.permissionMode === 'default' && value.sandbox && value.network === 'off') return 'qa';
    if (value.permissionMode === 'acceptEdits' && value.sandbox && value.network === 'all') return 'write';
    return undefined;
  },
  effect: settings => effect(parseClaudeNative(settings)),
  stored(settings) {
    const value = parseClaudeNative(settings), current = effect(value);
    return { mode: value.permissionMode === 'plan' ? 'qa' : value.permissionMode === 'bypassPermissions' && value.sandbox ? 'write' : current.mode,
      network: value.network === 'domains' ? false : current.network };
  },
  describe(settings) {
    const value = parseClaudeNative(settings);
    const network = value.network === 'domains' ? `只允许 ${value.domains[0]}${value.domains.length > 1 ? ` 等 ${value.domains.length} 个网站` : ''}` : value.network === 'all' ? '全部' : '关';
    return `权限模式：${names[value.permissionMode]}（${value.permissionMode}）；命令沙箱：${value.sandbox ? '开' : '关'}` +
      (value.permissionMode === 'bypassPermissions' ? '' : `；网络：${network}`);
  },
  fromLegacy: (tier, network) => parseClaudeNative({ permissionMode: tier === 'qa' ? 'default' : 'acceptEdits', network: network ? 'all' : 'off' }),
};
