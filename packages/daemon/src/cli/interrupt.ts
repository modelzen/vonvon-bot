import type { CommandError } from './command-error';

/** Installs a Ctrl-C handler and returns its removal; the tests press Ctrl-C through their own. */
export type OnInterrupt = (handler: () => void) => () => void;
export const onSigint: OnInterrupt = handler => { process.on('SIGINT', handler); return () => { process.off('SIGINT', handler); }; };

/**
 * Ctrl-C while a command waits on the daemon (cli-8-machine: `import start/rollback`, `daemon logs --follow`). The first
 * press decides the outcome, `error` (130): a wait through `until` ends with it at once, whatever the daemon answers
 * later and however the connection ends, and `signal` aborts. `on` hears each press with its count, for a cleanup a
 * second press cuts short. `stop` removes the handler: a Ctrl-C after it, while the command closes the connection,
 * ends the process as Node does.
 */
export type Interrupts = {
  readonly interrupted: boolean;
  readonly signal: AbortSignal;
  on(listener: (count: number) => void): () => void;
  until<T>(promise: Promise<T>): Promise<T>;
  stop(): void;
};

export function interrupts(install: OnInterrupt, error: () => CommandError): Interrupts {
  let count = 0;
  let decided: CommandError | undefined;
  const abort = new AbortController();
  const listeners = new Set<(count: number) => void>();
  const remove = install(() => {
    count++;
    decided ??= error();
    abort.abort();
    for (const listener of [...listeners]) listener(count);
  });
  const on = (listener: (count: number) => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  return {
    get interrupted() { return decided !== undefined; },
    signal: abort.signal,
    on,
    until: promise => new Promise((resolve, reject) => {
      const off = on(() => reject(decided));
      if (decided) reject(decided);
      // Settling after Ctrl-C changes nothing; the handlers stay so a late failure is not unhandled.
      promise.then(value => { off(); resolve(value); }, (failure: unknown) => { off(); reject(failure); });
    }),
    stop: () => { remove(); listeners.clear(); },
  };
}
