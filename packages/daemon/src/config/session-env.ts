/** Marks bot sessions; s46 can replace the default marker with a session token.
 * Both providers pass TOKEN/KEY/SECRET-named variables too (e04/e04b); this name
 * is an identity convention, not a protection against shell access. */
export const SESSION_ENV = 'VONVON_SESSION';

/** A process started inside a bot's session: s46's variable, or the marker the Codex app-server and the Claude SDK
 * children carry today (provider/transport/jsonrpc.ts, agent/claude-agent/backend.ts). */
export function inBotSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[SESSION_ENV]) || env.FEISHU_CODEX_BRIDGE === '1';
}
