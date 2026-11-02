/** Marks bot sessions; agent credentials never go into shell environment variables.
 * Both providers pass TOKEN/KEY/SECRET-named variables too (e04/e04b); this name
 * is an identity convention, not a protection against shell access. */
export const SESSION_ENV = 'VONVON_SESSION';
/**
 * skills-scope: the `--scope` value of a session's own reach (devices 5.3), set beside its token for the builtin skills to
 * copy: neither the tools (session_info names no ids, s46 4.3) nor a Codex session (no session_info, T3b) can say it. Not
 * a permission: the daemon checks `--scope` against the token whatever it says.
 */
export const SESSION_SCOPE_ENV = 'VONVON_SCOPE';
/** `bot=<appId>` in a private chat or a comment, `bot=<appId>,group=<chatId>` in a group: the most a session reaches. */
export function sessionScope(appId: string, chatId?: string): string {
  return chatId ? `bot=${appId},group=${chatId}` : `bot=${appId}`;
}

/** A process started inside a bot's session: the session marker, or the marker the Codex app-server and the Claude SDK
 * children carry today (provider/transport/jsonrpc.ts, agent/claude-agent/backend.ts). */
export function inBotSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[SESSION_ENV]) || env.FEISHU_CODEX_BRIDGE === '1';
}

/**
 * The environment of a process the host starts for itself (its bots, its restart helper, a detached daemon), without the
 * session markers: a host started from inside a session (an older daemon, or one a bridge session started) carries them,
 * and the command line refuses its own internal commands where it sees them (devices-4a 4.9).
 */
export function withoutSessionMarkers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { [SESSION_ENV]: _session, [SESSION_SCOPE_ENV]: _scope, FEISHU_CODEX_BRIDGE: _bridge, ...rest } = env;
  return rest;
}
