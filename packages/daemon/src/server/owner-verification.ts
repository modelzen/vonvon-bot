import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { helloSchema, PROTOCOL_VERSION, serverInfoSchema } from '@vonvon/protocol';
import { getPidLockInfo, isPidLockOwnerRunning, PidLockError, type PidLockInfo } from './pid-lock';

/* devices 4.5: the owner of the lock may run another protocol (old stops new, new stops old), so only the fields read here are checked. */
const statusReplySchema = z.looseObject({ type: z.literal('response'), id: z.string(), method: z.literal('admin'),
  payload: z.looseObject({ kind: z.literal('daemonStatus'), status: z.looseObject({ running: z.boolean(), pid: z.number() }) }) });
const stopReplySchema = z.looseObject({ type: z.literal('response'), id: z.string(), method: z.literal('machine'), payload: z.looseObject({ type: z.literal('done') }) });
const isEvent = (raw: unknown): boolean => !!raw && typeof raw === 'object' && 'type' in raw && raw.type === 'event';

/** `reason: 'update'` rides on the stop only when given: an owner of an older protocol is still asked the way it knows. */
export function stopVerifiedOwner(home: string, lock: PidLockInfo, reason?: 'update'): Promise<void> {
  return exchangeWithOwner(home, lock, true, reason);
}

export function verifyPidLockOwner(home: string, lock: PidLockInfo): Promise<void> {
  return exchangeWithOwner(home, lock, false);
}

async function exchangeWithOwner(home: string, lock: PidLockInfo, stop: boolean, reason?: 'update'): Promise<void> {
  const failure = (): PidLockError => new PidLockError(`Cannot verify daemon owner (PID ${lock.pid}); leaving its process and lock untouched.`, lock);
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(lock.listen ?? '');
  const port = Number(match?.[1]);
  if (!match || port < 1 || port > 65535) throw failure();
  let credential: string;
  try { credential = (await readFile(join(home, 'local-credential'), 'utf8')).trim(); }
  catch { throw failure(); }
  if (!/^[a-f0-9]{64}$/i.test(credential)) throw failure();

  const socket = new WebSocket(`ws://${lock.listen}`, { perMessageDeflate: false, maxPayload: 4_000_000 });
  try {
    await new Promise<void>((resolve, reject) => {
      let phase: 'hello' | 'status' | 'identity' | 'stop' | 'settled' = 'hello';
      const statusId = randomUUID();
      const stopId = randomUUID();
      const fail = (): void => { phase = 'settled'; clearTimeout(timer); reject(failure()); };
      const succeed = (): void => { phase = 'settled'; clearTimeout(timer); resolve(); };
      const timer = setTimeout(fail, 2000);
      socket.on('error', fail);
      socket.on('close', fail);
      socket.once('open', () => socket.send(JSON.stringify(helloSchema.parse({ type: 'hello', protocolVersion: PROTOCOL_VERSION, clientKind: 'cli', credential }))));
      socket.on('message', (bytes, binary) => {
        if (phase === 'settled') return;
        let raw: unknown;
        try { if (binary) throw failure(); raw = JSON.parse(bytes.toString()); }
        catch { fail(); return; }
        if (phase === 'hello') {
          if (!serverInfoSchema.safeParse(raw).success) { fail(); return; }
          phase = 'status';
          socket.send(JSON.stringify({ type: 'request', id: statusId, method: 'admin', payload: { type: 'daemonStatus' } }));
          return;
        }
        if (isEvent(raw)) return;
        if (phase === 'stop') {
          const reply = stopReplySchema.safeParse(raw);
          if (!reply.success || reply.data.id !== stopId) { fail(); return; }
          succeed();
          return;
        }
        const reply = statusReplySchema.safeParse(raw);
        if (phase !== 'status' || !reply.success || reply.data.id !== statusId || !reply.data.payload.status.running || reply.data.payload.status.pid !== lock.pid) {
          fail(); return;
        }
        phase = 'identity';
        void getPidLockInfo(home).then(current => {
          if (phase !== 'identity') return;
          if (!current || current.pid !== lock.pid || current.startedAt !== lock.startedAt || current.listen !== lock.listen || !isPidLockOwnerRunning(current)) {
            fail(); return;
          }
          if (!stop) { succeed(); return; }
          phase = 'stop';
          socket.send(JSON.stringify({ type: 'request', id: stopId, method: 'machine', payload: reason ? { type: 'stopHost', reason } : { type: 'stopHost' } }));
        }).catch(fail);
      });
    });
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.terminate(); });
    }
    socket.removeAllListeners();
  }
}
