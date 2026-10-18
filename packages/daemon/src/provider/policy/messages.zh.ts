import type { Os, ProviderId, Tier } from '../model';
import type { Refusal, RefuseReason } from './enforcement';

export const BASH_OFF_NOTICE = '此机器没有命令沙箱，已关闭 Bash。可读写项目文件，不能运行命令。';
export const MCP_OFF_NOTICE = '此档位已停用你配置的 MCP 服务器，完全访问下可用。';

const names: Record<ProviderId, string> = {
  codex: 'Codex', claude: 'Claude Code',
};
const systems: Record<Os, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
const tiers: Record<Tier, string> = { qa: '只读', write: '读写', full: '完全访问' };
const loginCommands: Record<ProviderId, string> = {
  codex: 'codex login', claude: 'claude login',
};

export function refusalMessage(
  reason: RefuseReason,
  context: { provider: ProviderId; os: Os; tier: Tier; detail?: string; installHint?: string },
): Refusal {
  const name = names[context.provider];
  const detail = context.detail ?? '未报告';
  switch (reason) {
    case 'read-scope-unenforceable':
      return { reason, message: `此项目设置为「仅读取项目目录」，但 ${name} 在这台机器上无法限制读取范围，已拒绝启动。管理员可在私聊的项目设置卡或网页的项目设置里改为「不限读取」，或改用 Claude Code。`, hint: '在项目设置中改为「不限读取」，或选择能够限制读取范围的提供方。' };
    case 'tier-unenforceable':
      return { reason, message: `${name} 没有自己的沙箱，暂时只支持「完全访问」。请把此项目改为完全访问，或改用 Claude Code / Codex。`, hint: '在项目设置中选择「完全访问」，或更换能够执行当前档位的提供方。' };
    case 'sandbox-dependency-missing':
      return { reason, message: `这台机器缺少 ${detail}，${name} 的沙箱无法启动，已拒绝运行。请安装后重试。`, hint: `在主机安装并检查 ${detail}，然后重新运行主机检查。` };
    case 'unverified-combination':
      return { reason, message: `${name} 在 ${systems[context.os]} 上的「${tiers[context.tier]}」尚未经过实机验证，已拒绝运行，没有降级。`, hint: `此提供方、系统、档位或已安装版本缺少匹配的实机证明。请完成对应探针并登记证明。${context.detail ? `状态：${context.detail}。` : ''}` };
    case 'windows-sandbox-not-ready':
      return { reason, message: `Codex 的 Windows 沙箱尚未就绪（${detail}）。请在这台机器上完成 Codex 沙箱设置后重试。`, hint: '在 Windows 主机完成 Codex 沙箱设置，确认 windowsSandbox/readiness 为 ready 后重试。' };
    case 'sandbox-not-confirmed':
      return { reason, message: `${name} 启动后未确认沙箱设置已生效，已结束进程并拒绝本次运行。`, hint: '检查提供方返回的实际权限配置和沙箱日志，修复后重新运行实机探针。' };
    case 'provider-not-installed':
      return { reason, message: `未检测到 ${name}。${context.installHint ?? '请在这台机器上安装后重试。'}`, hint: context.installHint ?? `在主机安装 ${name}，运行 doctor 检查安装状态。` };
    case 'not-logged-in':
      return { reason, message: `${name} 已安装但未登录，请在这台机器上运行 ${loginCommands[context.provider]}。`, hint: `在运行 Vonvon 的主机上完成 ${name} 登录，随后运行 doctor 检查授权状态。` };
    case 'custom-command-unset':
      return { reason, message: '还没有设置自定义 ACP 命令。请在主机设置的「执行」里填写命令。', hint: '在主机设置的「执行」里填写自定义 ACP 命令。' };
    case 'custom-command-invalid':
      return { reason, message: `自定义 ACP 命令无法执行：${detail}。`, hint: '检查主机设置中的自定义 ACP 命令、路径和执行权限。' };
    case 'owned-work-unverified':
      return ownedWorkUnverified();
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** The process host's admission refusal; it reads no provider, OS, or tier. */
export function ownedWorkUnverified(): Refusal {
  return { reason: 'owned-work-unverified', message: '上次运行留下的 agent 进程尚未确认退出，暂不能启动新的 agent。请运行 doctor 查看。', hint: '运行 doctor 查看未确认退出的进程记录，确认这些进程已结束后重试。' };
}
