import { z } from 'zod';
import { codexTierUnavailable } from '../codex-appserver/full-only';
import { cachedCodexVersion, resolveCodexBin } from '../codex-appserver/locate';
import { cachedWindowsSandbox } from '../codex-appserver/windows-sandbox';
import type { TableEnv } from './types';
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
const sandboxes = { qa: 'read-only', write: 'workspace-write', full: 'danger-full-access' } as const;

function versionFor(env: TableEnv): string | null | undefined {
  if (env.codexVersion !== undefined) return env.codexVersion;
  const bin = resolveCodexBin();
  return bin ? cachedCodexVersion(bin) : undefined;
}

function windowsFor(env: TableEnv) {
  if (env.codexWindowsSandbox !== undefined) return env.codexWindowsSandbox;
  const bin = env.platform === 'win32' ? resolveCodexBin() : null;
  return bin ? cachedWindowsSandbox(bin) : undefined;
}

export const codexTable: PermissionTable = {
  backend: 'codex-appserver',
  tiers: env => {
    const version = versionFor(env);
    const rows = permissionTiers(env, {
      qa: 'Codex：Read Only（read-only 沙箱）',
      write: 'Codex：Default（workspace-write），比 Codex 自带的多开了网络',
      full: 'Codex：Full Access（danger-full-access）',
    });
    for (const row of rows) {
      const reason = codexTierUnavailable(row.tier, env.platform, version ?? null, windowsFor(env));
      if (reason && (version !== undefined || env.platform === 'win32')) row.unavailable ??= reason;
    }
    return rows;
  },
  strength: env => {
    const version = versionFor(env);
    const reason = env.fullOnly ?? (version === undefined && env.platform !== 'win32' ? undefined
      : codexTierUnavailable('qa', env.platform, version ?? null, windowsFor(env)));
    if (reason) return reason;
    return '系统沙箱管住命令的读、写和联网：工作区以外的文件读不到，也改不了。'
      + (env.platform === 'linux' ? '工作区里原来没有的 .mcp.json、.claude/ 这类配置，能被新建。'
        : env.platform === 'win32' ? 'Windows 工作区可写档下，原本不存在的 .codex、.agents/skills、.claude 配置仍能被新建。' : '');
  },
  fields: env => [
    { key: 'sandbox', label: '沙箱模式', native: 'sandbox', kind: 'choice', choices: codexTable.tiers(env).map(info => ({
      value: sandboxes[info.tier], label: info.name, native: sandboxes[info.tier],
      hint: info.unavailable ?? info.summary.replace(/，(?:不|能)联网/, ''),
    })) },
    { key: 'network', label: '网络', native: 'network', kind: 'switch', showWhen: { key: 'sandbox', in: ['read-only', 'workspace-write'] } },
  ],
  expand: tier => ({ sandbox: sandboxes[tier], network: tier !== 'qa' }),
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
