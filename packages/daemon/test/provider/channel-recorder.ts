import { readFileSync } from 'node:fs';
import type { HolderChannel } from '../../src/provider/process/holder-channel';
import type { HolderReceipt, ReceiptLine } from '../../src/provider/process/holder-protocol';

type Kind = HolderReceipt['kind'];
type Of<K extends Kind> = HolderReceipt & { kind: K };

/** Collects every receipt on a channel; `take` resolves with the first unread one of a kind and fails with everything seen so far. */
export function recordReceipts(channel: HolderChannel, logPath?: string) {
  const lines: ReceiptLine[] = [];
  const waiters: Array<() => void> = [];
  channel.onReceipt(line => { lines.push(line); for (const wake of waiters.splice(0)) wake(); });
  void channel.closed.then(() => { for (const wake of waiters.splice(0)) wake(); });
  const context = () => {
    let log = '';
    if (logPath) { try { log = `; log: ${readFileSync(logPath, 'utf8')}`; } catch { /* no log yet */ } }
    return `saw ${JSON.stringify(lines)}${log}`;
  };
  /** The first unread receipt whose kind is one of `kinds`; one waiter, so no losing race can swallow a later receipt. */
  async function takeAny<K extends Kind>(kinds: readonly K[], timeoutMs = 20_000): Promise<Of<K>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = lines.findIndex(line => (kinds as readonly string[]).includes(line.kind));
      if (at !== -1) return lines.splice(at, 1)[0] as Of<K>;
      if (Date.now() > deadline) throw new Error(`no ${kinds.join('|')} within ${timeoutMs} ms; ${context()}`);
      await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, Math.max(1, deadline - Date.now())); });
    }
  }
  const take = <K extends Kind>(kind: K, timeoutMs?: number): Promise<Of<K>> => takeAny([kind], timeoutMs);
  const peek = <K extends Kind>(kind: K): Of<K>[] => lines.filter((line): line is Of<K> => line.kind === kind);
  return { lines, take, takeAny, peek, context };
}

export async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

export const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
