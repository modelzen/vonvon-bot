import type { PermissionMode } from '../types';

export const CODEX_LINUX_MIN_VERSION = '0.163.0';
// 0.163.0 natively protects root .codex even when absent; vonvon's existing-path
// entries do not establish this. Re-run F2/F3 when upgrading Codex before retaining true.
export const CODEX_LINUX_WRITE_OK: boolean = true;

export function codexConfinesReads(platform: NodeJS.Platform = process.platform, version: string | null = null): boolean {
  if (platform === 'darwin') return true;
  if (platform !== 'linux') return false;
  const parsed = version?.match(/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/);
  if (!parsed) return false;
  const actual = parsed.slice(1, 4).map(Number);
  const minimum = CODEX_LINUX_MIN_VERSION.split('.').map(Number);
  for (const [index, part] of actual.entries()) {
    const required = minimum[index] ?? 0;
    if (part !== required) return part > required;
  }
  return parsed[4] === undefined;
}

export function codexFullOnlyReason(version: string | null): string {
  if (!version?.match(/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/)) return '测不出 Codex 的版本，只读和工作区可写暂时不能用。请升级 Codex 后重启 daemon。';
  return `这台电脑上的 Codex 版本太旧（${version}），只读和工作区可写要 ${CODEX_LINUX_MIN_VERSION} 以上，升级后就能选。`;
}

export function codexTierUnavailable(tier: PermissionMode, platform: NodeJS.Platform, version: string | null): string | undefined {
  if (tier === 'full') return undefined;
  if (!codexConfinesReads(platform, version)) return codexFullOnlyReason(version);
  if (tier === 'write' && platform === 'linux' && !CODEX_LINUX_WRITE_OK) {
    return 'Linux 上的 Codex 还挡不住工作区里新建的 Codex 配置，工作区可写暂时不能用。';
  }
  return undefined;
}

export class CodexFullOnlyError extends Error {
  constructor(reason: string = codexFullOnlyReason(null)) {
    super(`${reason}这一轮没有开始，不会自动改权限。`);
    this.name = 'CodexFullOnlyError';
  }
}
