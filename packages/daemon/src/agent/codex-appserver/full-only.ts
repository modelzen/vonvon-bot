import type { PermissionMode } from '../types';

/** Whether Codex's sandbox keeps reads, not only writes, inside the workspace on `platform`. Only
 * macOS Seatbelt does; on Linux it blocks writes and leaves reads open (product.md 3.8). */
export function codexConfinesReads(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

/** Why a Codex group on this host can only be set to 完全访问: the settings' reason. */
export const CODEX_FULL_ONLY =
  'Linux 上 Codex 的沙箱只挡写、不限制读，vonvon 不在 Linux 上用 Codex 的只读、读写档，只能选完全访问。完全访问下 Codex 能读写这个账号能碰到的所有文件，群里有别人时先想清楚。';

/** Thrown before spawning when a 只读 or 读写 Codex session would start where reads are not confined. */
export class CodexFullOnlyError extends Error {
  constructor() {
    super('Linux 上的 Codex 只能用完全访问（它的沙箱只挡写、不限制读），这一轮没有开始。请主人在群设置里把权限改成「完全访问」，不会自动改。');
    this.name = 'CodexFullOnlyError';
  }
}

/** The group's reply when a turn in `mode` is refused. `role` is 'guest' only when the group splits
 * its tiers and a guest sent the message; `bot` is this bot's app id, given when the host has several. */
export function fullOnlyReply(groupId: string, mode: Exclude<PermissionMode, 'full'>, role: 'admin' | 'guest', bot?: string): string {
  const [label, field] = role === 'guest' ? ['普通成员权限', 'guestMode'] : ['管理员权限', 'mode'];
  const command = `vonvon settings set${bot ? ` --bot ${bot}` : ''} --group ${groupId} permission.${field}=full`;
  return `ℹ️ 这一轮没有开始：这个群是「${mode === 'qa' ? '只读' : '读写'}」档，Linux 上的 Codex 只能用完全访问（它的沙箱只挡写、不限制读）。` +
    `请 bot 的主人在群设置里把「${label}」改成「完全访问」，或者在终端运行 \`${command}\`。不会自动改。`;
}
