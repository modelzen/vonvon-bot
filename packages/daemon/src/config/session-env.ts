/** Marks bot sessions; agent credentials never go into shell environment variables.
 * Both providers pass TOKEN/KEY/SECRET-named variables too (e04/e04b); this name
 * is an identity convention, not a protection against shell access. */
export const SESSION_ENV = 'VONVON_SESSION';

/** A process started inside a bot's session: the session marker, or the marker the Codex app-server and the Claude SDK
 * children carry today (provider/transport/jsonrpc.ts, agent/claude-agent/backend.ts). */
export function inBotSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[SESSION_ENV]) || env.FEISHU_CODEX_BRIDGE === '1';
}
