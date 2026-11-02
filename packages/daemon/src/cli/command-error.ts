import { CommanderError } from 'commander';

/** devices 8.1: every command exits with one of these; 130 is the shell's code for a command cut short by Ctrl-C. */
export const commandExitCodes = { 'bad-args': 2, connection: 3, refused: 4, conflict: 5, failed: 1, 'outcome-unknown': 6, interrupted: 130 } as const;
export type CommandErrorKind = keyof typeof commandExitCodes;
/**
 * `reason` is the machine-readable cause, the daemon's error code or the CLI's own (`not_in_session`);
 * `current` is what a conflict found; `partial` is what a command read before it failed, so --json keeps it.
 */
export type CommandErrorDetail = { reason?: string; current?: unknown; partial?: object };
export class CommandError extends Error {
  readonly reason?: string;
  readonly current?: unknown;
  readonly partial?: object;
  constructor(readonly kind: CommandErrorKind, message: string, detail: CommandErrorDetail = {}) {
    super(message);
    if (detail.reason !== undefined) this.reason = detail.reason;
    if (detail.current !== undefined) this.current = detail.current;
    if (detail.partial !== undefined) this.partial = detail.partial;
  }
}
/** What the user typed is wrong: exit 2. Errors that are not a CommandError exit 1, as unexpected. */
export const badArgs = (message: string): CommandError => new CommandError('bad-args', message);

/** The daemon's error codes that are a refusal (exit 4), with those protocol 2 adds (devices 第 12 节). */
const REFUSED = new Set([
  'unauthorized', 'forbidden', 'permission_denied', 'scope_required', 'session_token_missing', 'session_token_invalid', 'not_in_session', 'not-dm', 'not-group',
  'desktop_not_running', 'client_revoked', 'pairing_failed', 'rate_limited', 'pairing_limit', 'no_remote_address',
]);
const CONNECTION = new Set(['protocol_mismatch', 'device_identity_changed']);
/** What was typed is wrong: a bad request, and a folder that is not there, not a folder, outside the daemon user's home
 * or picked too long ago (cli-3-groups). */
const BAD_ARGS = new Set(['invalid_request', 'invalid_directory', 'outside_home', 'invalid_folder_token']);
export function rpcErrorKind(code: string): CommandErrorKind {
  if (REFUSED.has(code)) return 'refused';
  if (CONNECTION.has(code)) return 'connection';
  if (code === 'conflict') return 'conflict';
  if (code === 'outcome_unknown') return 'outcome-unknown';
  return BAD_ARGS.has(code) ? 'bad-args' : 'failed';
}

/** commander's own usage errors (an unknown option, a missing argument or subcommand) are argument errors. */
function asCommandError(error: unknown): CommandError {
  if (error instanceof CommandError) return error;
  if (error instanceof CommanderError) {
    const missing = error.code === 'commander.help' || error.code === 'commander.helpDisplayed';
    return badArgs(missing ? '少了子命令。加 --help 看有哪些。' : error.message.replace(/^error: /, ''));
  }
  return new CommandError('failed', error instanceof Error ? error.message : String(error));
}

/** devices 8.1: a failure under --json is `{ ok: false, error: { kind, message }, exitCode }`. */
export function commandFailure(error: unknown) {
  const failure = asCommandError(error);
  const { kind, message, reason, current, partial } = failure;
  return {
    ok: false as const,
    error: { kind, message, ...(reason === undefined ? {} : { reason }), ...(current === undefined ? {} : { current }), ...(partial === undefined ? {} : { partial }) },
    exitCode: commandExitCodes[kind],
  };
}
