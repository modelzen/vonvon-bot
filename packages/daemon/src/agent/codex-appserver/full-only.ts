/** Whether Codex's sandbox keeps reads, not only writes, inside the workspace on `platform`. Only
 * macOS Seatbelt does; on Linux it blocks writes and leaves reads open (product.md 3.8). */
export function codexConfinesReads(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

/** Why a Codex group on this host can only be set to 完全访问: the settings' reason. */
export const CODEX_FULL_ONLY =
  'Linux 上 Codex 的沙箱只挡写、不限制读，vonvon 不在 Linux 上用 Codex 的只读、工作区可写权限，只能选完全访问。完全访问下 Codex 能读写这个账号能碰到的所有文件，群里有别人时先想清楚。';

/** Thrown before spawning when a 只读 or 读写 Codex session would start where reads are not confined. */
export class CodexFullOnlyError extends Error {
  constructor() {
    super('Linux 上的 Codex 只能用完全访问（它的沙箱只挡写、不限制读），这一轮没有开始。请主人在群设置里把权限改成「完全访问」，不会自动改。');
    this.name = 'CodexFullOnlyError';
  }
}
