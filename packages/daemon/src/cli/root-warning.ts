/** server-2 4.3: a daemon run as root gives every AI agent of every bot the whole machine. */
export const ROOT_WARNING = '以 root 运行 Vonvon Bot：AI 代理会有整机权限。';

/** The warning when this process is root; undefined elsewhere, Windows (no uid) included. */
export const rootWarning = (getuid: () => number | undefined = () => process.getuid?.()): string | undefined => getuid() === 0 ? ROOT_WARNING : undefined;
