/** Set on the processes of a bot's session (s46 gives each session a token in it; s37 and s46 use this name), so
 * `vonvon secrets` can refuse them (product.md 3.7). No TOKEN, KEY or SECRET in it: Codex leaves variables with
 * those words out of a shell's environment. */
export const SESSION_ENV = 'VONVON_SESSION';

/** A process started inside a bot's session: s46's variable, or the marker the Codex app-server and the Claude SDK
 * children carry today (provider/transport/jsonrpc.ts, agent/claude-agent/backend.ts). */
export function inBotSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[SESSION_ENV]) || env.FEISHU_CODEX_BRIDGE === '1';
}
