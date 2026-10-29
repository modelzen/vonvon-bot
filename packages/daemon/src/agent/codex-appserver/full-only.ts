import type { PermissionMode } from '../types';

export type WindowsSandboxCapability = {
  status: 'ready' | 'notConfigured' | 'updateRequired' | 'unsupported' | 'probeFailed';
  implementation?: 'mxc';
};
// Separate from Linux: Windows requires a native MXC execution probe, too.
export const CODEX_WINDOWS_MIN_VERSION = '0.163.0';

export const CODEX_LINUX_MIN_VERSION = '0.163.0';
// 0.163.0 natively protects root .codex even when absent; vonvon's existing-path
// entries do not establish this. Re-run F2/F3 when upgrading Codex before retaining true.
export const CODEX_LINUX_WRITE_OK: boolean = true;

export function codexConfinesReads(platform: NodeJS.Platform = process.platform, version: string | null = null,
  windows?: WindowsSandboxCapability): boolean {
  if (platform === 'darwin') return true;
  if (platform !== 'linux' && platform !== 'win32') return false;
  const parsed = version?.match(/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/);
  if (!parsed) return false;
  if (platform === 'win32' && (parsed[4] || windows?.status !== 'ready' || windows.implementation !== 'mxc')) return false;
  const actual = parsed.slice(1, 4).map(Number);
  const minimum = (platform === 'win32' ? CODEX_WINDOWS_MIN_VERSION : CODEX_LINUX_MIN_VERSION).split('.').map(Number);
  for (const [index, part] of actual.entries()) {
    const required = minimum[index] ?? 0;
    if (part !== required) return part > required;
  }
  return parsed[4] === undefined;
}

export function codexFullOnlyReason(version: string | null): string {
  if (!version?.match(/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/)) return '测不出 Codex 的版本，只读和工作区可写暂时不能用。请升级 Codex 后重启 daemon。';
  return `这台电脑上的 Codex 是 ${version}，只读和工作区可写要 ${CODEX_LINUX_MIN_VERSION} 正式版以上，升级后就能选。`;
}

export function codexTierUnavailable(tier: PermissionMode, platform: NodeJS.Platform, version: string | null,
  windows?: WindowsSandboxCapability): string | undefined {
  if (tier === 'full') return undefined;
  if (platform === 'win32') {
    const parsed = version?.match(/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/);
    if (!parsed) return '测不出 Windows 上 Codex 的版本。请在环境检测中重新检测，原权限保持不变。';
    if (parsed[4]) return `这台电脑上的 Codex 是预发布版 ${version}，Windows 受限权限需要经验证的正式版（最低 ${CODEX_WINDOWS_MIN_VERSION}）。请选择正式版后重新检测。`;
    if (!codexConfinesReads('win32', version, { status: 'ready', implementation: 'mxc' })) {
      return `Windows 上的 Codex 是 ${version}，受限权限最低需要 ${CODEX_WINDOWS_MIN_VERSION} 正式版及可用的 MXC 沙箱。请更新 Codex 后重新检测。`;
    }
    if (windows?.status === 'ready' && windows.implementation === 'mxc') {
      return undefined;
    }
    switch (windows?.status) {
      case 'notConfigured': return 'Windows 沙箱尚未配置，受限权限暂不可用。请在 Codex 中完成官方沙箱设置后重新检测；Vonvon 仍需可用的 MXC 读取隔离。';
      case 'updateRequired': return 'Windows 沙箱需要更新。请在 Codex 中完成官方沙箱更新后重新检测；Vonvon 仍需可用的 MXC 读取隔离。';
      case 'unsupported': return '这台电脑的 MXC 沙箱不能提供所需的读取隔离。elevated 需要全盘可读，unelevated 也不满足隔离要求。请更新 Windows、确认 MXC 可用后重新检测。';
      case 'probeFailed': return 'Windows MXC 沙箱探测失败，暂时无法确认隔离能力。请在环境检测中重新检测；原权限保持不变，不会自动改为完全访问。';
      default: return '尚未完成 Windows MXC 沙箱探测。请在环境检测中重新检测；原权限保持不变。';
    }
  }
  if (platform !== 'darwin' && platform !== 'linux') return '当前平台的 Codex 尚未验证所需的读取隔离，只读和工作区可写暂不可用。';
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
