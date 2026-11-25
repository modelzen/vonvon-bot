/** Marks bot sessions; agent credentials never go into shell environment variables.
 * Both providers pass TOKEN/KEY/SECRET-named variables too (e04/e04b); this name
 * is an identity convention, not a protection against shell access. */
export const SESSION_ENV = 'VONVON_SESSION';
/**
 * The `--scope` value of a session's own reach (devices 5.3), set beside its token for a session's command line to copy
 * (the daemon's refusal of a call without `--scope` says so): neither the tools (session_info names no ids, s46 4.3) nor
 * a Codex session (no session_info, T3b) can say it. Not a permission: the daemon checks `--scope` against the token
 * whatever it says.
 */
export const SESSION_SCOPE_ENV = 'VONVON_SCOPE';
/**
 * The Bot a private chat's session belongs to. It reads every Bot (dm-agent 6.1), so its command line needs telling which
 * one a command with no `--bot` means: itself. Not a permission, like {@link SESSION_SCOPE_ENV}.
 */
export const SESSION_BOT_ENV = 'VONVON_BOT';
/** The full path of the launcher `<data>/bin/vonvon` (agent/session-cli.ts), for a shell whose PATH lost it. */
export const SESSION_CLI_ENV = 'VONVON_CLI';
/** Resolved local `lark-cli` executable path (if installed), handed to DM sessions so NVM/managed installs work out of the box. */
export const SESSION_LARK_CLI_ENV = 'VONVON_LARK_CLI';
/** `bot=<appId>` in a comment, `bot=<appId>,group=<chatId>` in a group: the most a session reaches. A private chat gets none (dm-agent 6.1). */
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
  const { [SESSION_ENV]: _session, [SESSION_SCOPE_ENV]: _scope, [SESSION_BOT_ENV]: _bot, FEISHU_CODEX_BRIDGE: _bridge, ...rest } = env;
  return rest;
}
