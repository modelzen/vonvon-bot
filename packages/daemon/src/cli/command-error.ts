export const commandExitCodes = { 'bad-args': 2, connection: 3, refused: 4, conflict: 5, failed: 1, 'outcome-unknown': 6 } as const;
export class CommandError extends Error {
  constructor(readonly kind: keyof typeof commandExitCodes, message: string, readonly current?: unknown) { super(message); }
}
export function commandFailure(error: unknown) {
  const failure = error instanceof CommandError ? error : new CommandError('bad-args', error instanceof Error ? error.message : String(error));
  return { ok: false, error: { kind: failure.kind, message: failure.message, ...(failure.current === undefined ? {} : { current: failure.current }) }, exitCode: commandExitCodes[failure.kind] };
}
