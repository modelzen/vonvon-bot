import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { eventSchema, helloSchema, PROTOCOL_VERSION, replyEnvelopeSchema, serverInfoSchema } from '@vonvon/protocol';
import { getPidLockInfo, isPidLockOwnerRunning, PidLockError, type PidLockInfo } from './pid-lock';

export async function verifyPidLockOwner(home: string, lock: PidLockInfo): Promise<void> {
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
      const timer = setTimeout(() => reject(failure()), 2000);
      const fail = (): void => { clearTimeout(timer); reject(failure()); };
      let authenticated = false;
      const id = randomUUID();
      socket.on('error', fail);
      socket.on('close', fail);
      socket.once('open', () => socket.send(JSON.stringify(helloSchema.parse({ type: 'hello', protocolVersion: PROTOCOL_VERSION, clientKind: 'cli', credential }))));
      socket.on('message', (bytes, binary) => {
        let raw: unknown;
        try { if (binary) throw failure(); raw = JSON.parse(bytes.toString()); }
        catch { fail(); return; }
        if (!authenticated) {
          const info = serverInfoSchema.safeParse(raw);
          if (!info.success || info.data.protocolVersion !== PROTOCOL_VERSION) { fail(); return; }
          authenticated = true;
          socket.send(JSON.stringify({ type: 'request', id, method: 'admin', payload: { type: 'daemonStatus' } }));
          return;
        }
        if (eventSchema.safeParse(raw).success) return;
        const reply = replyEnvelopeSchema.safeParse(raw);
        if (!reply.success || reply.data.type !== 'response' || reply.data.id !== id || reply.data.method !== 'admin'
          || reply.data.payload.kind !== 'daemonStatus' || !reply.data.payload.status.running || reply.data.payload.status.pid !== lock.pid) {
          fail(); return;
        }
        clearTimeout(timer);
        resolve();
      });
    });
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.terminate(); });
    }
    socket.removeAllListeners();
  }
  const current = await getPidLockInfo(home);
  if (!current || current.pid !== lock.pid || current.startedAt !== lock.startedAt || current.listen !== lock.listen || !isPidLockOwnerRunning(current)) throw failure();
}
