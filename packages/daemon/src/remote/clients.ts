import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { clientRecordSchema, type ClientRecord } from '@vonvon/protocol';
import { writeFileAtomic } from '../server/atomic-file';
import { RpcError } from '../server/errors';
import { devicesPath, prepareDevicesDirectory, refuseNewer } from './files';
import { PairingError } from './pairing';

/** `<dataRoot>/devices/clients.json` (devices 4.3): every write adds 1 to `generation`; a revoked client stays, with `revokedAt`.
 * Each entry is parsed with the protocol's `clientRecordSchema`. Unknown fields in the file and its entries are
 * preserved on disk, while RPC replies carry only the known fields. */
const clientsFileSchema = z.looseObject({ v: z.literal(1), generation: z.number().int().nonnegative(), clients: z.array(z.unknown()) });
const storedRecordSchema = clientRecordSchema.passthrough();
const wireRecordSchema = clientRecordSchema.strip();
type ClientsFile = { v: 1; generation: number; clients: ClientRecord[] };

export interface NewClient { name: string; publicKey: string; clientKind: ClientRecord['clientKind']; address: string; invitedBy: string }
/** add, rename and revoke resolve once their write has landed. One whose write fails (EIO, ENOSPC...) rejects with that
 * error and changes nothing, in memory or on disk: its retry is a real one, and no listener hears of it. */
export interface ClientRegistry {
  readonly generation: number;
  list(): ClientRecord[]; get(clientId: string): ClientRecord | undefined;
  /** Revoked ones too: D2 answers 4003 for them and 4002 for a key it never saw. */
  byPublicKey(publicKey: string): ClientRecord | undefined;
  /** A key already paired and not revoked: the same entry, seen again. One a client invited pairs only while that client
   * is on the list and not revoked, as of the add's turn: `pairing_failed`. */
  add(client: NewClient): Promise<ClientRecord>;
  rename(clientId: string, name: string): Promise<ClientRecord>;
  /** The ids revoked now; `cascade` also revokes the clients each of them invited, down the line. */
  revoke(clientId: string, options?: { cascade?: boolean }): Promise<string[]>;
  /** Memory only; written at most once a `touchEveryMs`, and by close(). */
  touch(clientId: string, address: string): void;
  /** After each write: D3 closes the connections of the revoked clients. */
  onChange(listener: (generation: number, revoked: readonly string[]) => void): () => void;
  /** Settles once everything is written: the changes queued before it, and those queued while it waits, with the last-seen
   * they and touch() left. A failed last-seen write rejects it and keeps that last-seen for the next write or close().
   * One called while another waits (from an onChange listener too) waits with it. Not an end: the registry stays usable,
   * and a later close() writes what came after. */
  close(): Promise<void>;
}
const notFound = (clientId: string): RpcError => new RpcError('invalid_request', `没有这个客户端：${clientId}。运行 vonvon clients ls 查看。`);
const find = (clients: ClientRecord[], clientId: string): ClientRecord => {
  const found = clients.find(client => client.id === clientId);
  if (!found) throw notFound(clientId);
  return found;
};
type Seen = Pick<ClientRecord, 'lastSeenAt' | 'lastAddress'>;
/** What a change does to the next list: its result, whether there is anything to write, and whom it revoked. */
type Step<T> = { value: T; write: boolean; revoked?: readonly string[] };

export async function createClientRegistry(home: string, options: { now?: () => number; touchEveryMs?: number } = {}): Promise<ClientRegistry> {
  await prepareDevicesDirectory(home);
  const file = devicesPath(home, 'clients.json');
  const now = options.now ?? Date.now;
  /** The list as written; a change replaces it only once its write has landed. */
  let state: ClientsFile;
  let text: string | undefined;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (text === undefined) state = { v: 1, generation: 0, clients: [] };
  else {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    refuseNewer(file, parsed);
    try {
      const outer = clientsFileSchema.parse(parsed);
      state = { ...outer, clients: outer.clients.map(client => storedRecordSchema.parse(client)) };
    } catch (error) { throw new Error(`clients.json 损坏：${file} 不是有效的客户端列表。`, { cause: error }); }
  }
  const listeners = new Set<(generation: number, revoked: readonly string[]) => void>();
  /** Last-seen not written yet (touch): laid over `state` when read, and written with the next write. */
  const seen = new Map<string, Seen>();
  let turn: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const view = (client: ClientRecord): ClientRecord => wireRecordSchema.parse({ ...client, ...seen.get(client.id) });
  // One change at a time, in order. Each builds the next list from the written one at its turn, writes it, and only then
  // makes it current and tells the listeners; a failed write leaves the list as it was and rejects that change alone.
  function change<T>(step: (next: ClientsFile) => Step<T>): Promise<T> {
    const run = turn.then(async () => {
      const written = new Map(seen);
      const next = structuredClone(state);
      for (const client of next.clients) Object.assign(client, written.get(client.id));
      const { value, write, revoked = [] } = step(next);
      if (!write) return value;
      next.generation += 1;
      await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, { durable: true });
      state = next;
      for (const [id, entry] of written) if (seen.get(id) === entry) seen.delete(id);
      for (const listener of listeners) { try { listener(state.generation, revoked); } catch { /* a listener's failure is its own */ } }
      return value;
    });
    turn = run.catch(() => undefined);
    return run;
  }
  /** Writes the last-seen not written yet, if any, as a change of its own: what to write is decided at its turn, so it
   * includes the touches of the changes queued before it (an add of a known key only touches). It does the timer's job,
   * so it stops the timer then. */
  const flush = (): Promise<void> => change(() => {
    clearTimeout(timer);
    timer = undefined;
    return { value: undefined, write: seen.size > 0 };
  });
  // What is queued or touched while close() waits is flushed too, not refused: it settles only when its last flush was the
  // last change queued and no touch came during that write, so nothing is left unwritten and no timer runs. Adds and
  // touches come from connections, which shutdown stops (http.ts closes the listener first), so the loop ends.
  // One such loop at a time: a close() called while it runs, a listener's too, waits on that one. Two loops would each
  // take the other's flush for a change queued after its own and flush again forever, in microtasks that starve timers
  // and I/O. `closing` is cleared inside the loop, before it settles, so no close() called later gets one already done.
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= (async () => {
      try {
        for (;;) {
          const flushed = flush();
          const last = turn;
          await flushed;
          if (turn === last && seen.size === 0) return;
        }
      } finally { closing = undefined; }
    })();
    return closing;
  }
  function touch(clientId: string, address: string): void {
    if (!state.clients.some(entry => entry.id === clientId)) return;
    seen.set(clientId, { lastSeenAt: now(), lastAddress: address });
    if (timer) return;
    timer = setTimeout(() => { void flush().catch(() => undefined); }, options.touchEveryMs ?? 60_000);
    timer.unref();
  }
  return {
    get generation() { return state.generation; },
    list: () => state.clients.map(view),
    get: clientId => {
      const client = state.clients.find(entry => entry.id === clientId);
      return client && view(client);
    },
    byPublicKey: publicKey => {
      const client = state.clients.find(entry => entry.publicKey === publicKey);
      return client && view(client);
    },
    add: client => change(next => {
      // Checked at this turn: a revocation of the inviter that was still being written when the invite was redeemed is in now.
      if (client.invitedBy !== 'local') {
        const inviter = next.clients.find(entry => entry.id === client.invitedBy);
        if (!inviter || inviter.revokedAt !== undefined) throw new PairingError('pairing_failed');
      }
      const existing = next.clients.find(entry => entry.publicKey === client.publicKey);
      if (existing?.revokedAt !== undefined) throw new RpcError('client_revoked', '这台设备的访问已经被撤销，要重新配对得换一对密钥。');
      if (existing) { touch(existing.id, client.address); return { value: view(existing), write: false }; }
      const at = now();
      const record = clientRecordSchema.parse({
        id: `cl_${randomBytes(8).toString('hex')}`, name: client.name, publicKey: client.publicKey, clientKind: client.clientKind,
        createdAt: at, lastSeenAt: at, lastAddress: client.address, pairedVia: 'invite', invitedBy: client.invitedBy,
      } satisfies ClientRecord);
      next.clients.push(record);
      return { value: wireRecordSchema.parse(record), write: true };
    }),
    rename: (clientId, name) => change(next => {
      const client = find(next.clients, clientId);
      client.name = clientRecordSchema.shape.name.parse(name);
      return { value: wireRecordSchema.parse(client), write: true };
    }),
    revoke: (clientId, { cascade = false } = {}) => change(next => {
      const revoked: string[] = [];
      const visited = new Set<string>();
      const queue = [find(next.clients, clientId)];
      for (let client = queue.shift(); client; client = queue.shift()) {
        if (visited.has(client.id)) continue;
        visited.add(client.id);
        if (client.revokedAt === undefined) { client.revokedAt = now(); revoked.push(client.id); }
        if (cascade) queue.push(...next.clients.filter(entry => entry.invitedBy === client?.id));
      }
      return { value: revoked, write: revoked.length > 0, revoked: [...revoked] };
    }),
    touch,
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close,
  };
}
