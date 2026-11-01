import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { clientRecordSchema, type ClientRecord } from '@vonvon/protocol';
import { writeFileAtomic } from '../server/atomic-file';
import { RpcError } from '../server/errors';
import { devicesPath, prepareDevicesDirectory, refuseNewer } from './files';

/** `<dataRoot>/devices/clients.json` (devices 4.3): every write adds 1 to `generation`; a revoked client stays, with `revokedAt`.
 * Each entry is the protocol's `clientRecordSchema` (zod 3, so parsed apart from this zod 4 frame). Fields a newer version
 * added, outside or in an entry, are kept and written back; the RPC replies carry only the known ones. */
const clientsFileSchema = z.looseObject({ v: z.literal(1), generation: z.number().int().nonnegative(), clients: z.array(z.unknown()) });
const storedRecordSchema = clientRecordSchema.passthrough();
const wireRecordSchema = clientRecordSchema.strip();
type ClientsFile = { v: 1; generation: number; clients: ClientRecord[] };

export interface NewClient { name: string; publicKey: string; clientKind: ClientRecord['clientKind']; address: string; invitedBy: string }
export interface ClientRegistry {
  readonly generation: number;
  list(): ClientRecord[]; get(clientId: string): ClientRecord | undefined;
  /** Revoked ones too: D2 answers 4003 for them and 4002 for a key it never saw. */
  byPublicKey(publicKey: string): ClientRecord | undefined;
  /** A key already paired and not revoked: the same entry, seen again. */
  add(client: NewClient): Promise<ClientRecord>;
  rename(clientId: string, name: string): Promise<ClientRecord>;
  /** The ids revoked now; `cascade` also revokes the clients each of them invited, down the line. */
  revoke(clientId: string, options?: { cascade?: boolean }): Promise<string[]>;
  /** Memory only; written at most once a `touchEveryMs`, and by close(). */
  touch(clientId: string, address: string): void;
  /** After each write: D3 closes the connections of the revoked clients. */
  onChange(listener: (generation: number, revoked: readonly string[]) => void): () => void;
  close(): Promise<void>;
}
const copy = (client: ClientRecord | undefined): ClientRecord | undefined => client && wireRecordSchema.parse(client);
const notFound = (clientId: string): RpcError => new RpcError('invalid_request', `没有这个客户端：${clientId}。运行 vonvon clients ls 查看。`);

export async function createClientRegistry(home: string, options: { now?: () => number; touchEveryMs?: number } = {}): Promise<ClientRegistry> {
  await prepareDevicesDirectory(home);
  const file = devicesPath(home, 'clients.json');
  const now = options.now ?? Date.now;
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
  let writing: Promise<void> = Promise.resolve();
  let dirty = false;
  let timer: NodeJS.Timeout | undefined;
  const find = (clientId: string): ClientRecord => {
    const found = state.clients.find(client => client.id === clientId);
    if (!found) throw notFound(clientId);
    return found;
  };
  // One write at a time, in order; each takes the state as it is when its turn comes.
  function save(revoked: readonly string[] = []): Promise<void> {
    const write = writing.then(async () => {
      dirty = false;
      state.generation += 1;
      await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, { durable: true });
      for (const listener of listeners) { try { listener(state.generation, revoked); } catch { /* a listener's failure is its own */ } }
    });
    writing = write.catch(() => undefined);
    return write;
  }
  const flush = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    return dirty ? save() : writing;
  };
  function touch(clientId: string, address: string): void {
    const client = state.clients.find(entry => entry.id === clientId);
    if (!client) return;
    client.lastSeenAt = now();
    client.lastAddress = address;
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { void flush().catch(() => undefined); }, options.touchEveryMs ?? 60_000);
    timer.unref();
  }
  return {
    get generation() { return state.generation; },
    list: () => state.clients.map(client => wireRecordSchema.parse(client)),
    get: clientId => copy(state.clients.find(client => client.id === clientId)),
    byPublicKey: publicKey => copy(state.clients.find(client => client.publicKey === publicKey)),
    async add(client) {
      const existing = state.clients.find(entry => entry.publicKey === client.publicKey);
      if (existing?.revokedAt !== undefined) throw new RpcError('client_revoked', '这台设备的访问已经被撤销，要重新配对得换一对密钥。');
      if (existing) { touch(existing.id, client.address); return wireRecordSchema.parse(existing); }
      const at = now();
      const record: ClientRecord = {
        id: `cl_${randomBytes(8).toString('hex')}`, name: client.name, publicKey: client.publicKey, clientKind: client.clientKind,
        createdAt: at, lastSeenAt: at, lastAddress: client.address, pairedVia: 'invite', invitedBy: client.invitedBy,
      };
      state.clients.push(clientRecordSchema.parse(record));
      await save();
      return { ...record };
    },
    async rename(clientId, name) {
      const client = find(clientId);
      client.name = clientRecordSchema.shape.name.parse(name);
      await save();
      return wireRecordSchema.parse(client);
    },
    async revoke(clientId, { cascade = false } = {}) {
      const revoked: string[] = [];
      const visited = new Set<string>();
      const queue = [find(clientId)];
      for (let client = queue.shift(); client; client = queue.shift()) {
        if (visited.has(client.id)) continue;
        visited.add(client.id);
        if (client.revokedAt === undefined) { client.revokedAt = now(); revoked.push(client.id); }
        if (cascade) queue.push(...state.clients.filter(entry => entry.invitedBy === client?.id));
      }
      if (revoked.length) await save(revoked);
      return revoked;
    },
    touch,
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close: flush,
  };
}
