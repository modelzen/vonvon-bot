import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { eventSchema, helloSchema, PROTOCOL_VERSION, replyEnvelopeSchema, serverInfoSchema } from '@vonvon/protocol';
import { getPidLockInfo, isPidLockOwnerRunning, PidLockError, type PidLockInfo } from './pid-lock';

export function stopVerifiedOwner(home: string, lock: PidLockInfo): Promise<void> {
  return exchangeWithOwner(home, lock, true);
}

export function verifyPidLockOwner(home: string, lock: PidLockInfo): Promise<void> {
  return exchangeWithOwner(home, lock, false);
}

async function exchangeWithOwner(home: string, lock: PidLockInfo, stop: boolean): Promise<void> {
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
          const info = serverInfoSchema.safeParse(raw);
          if (!info.success || info.data.protocolVersion !== PROTOCOL_VERSION) { fail(); return; }
          phase = 'status';
          socket.send(JSON.stringify({ type: 'request', id: statusId, method: 'admin', payload: { type: 'daemonStatus' } }));
          return;
        }
        if (eventSchema.safeParse(raw).success) return;
        const reply = replyEnvelopeSchema.safeParse(raw);
        if (!reply.success || reply.data.type !== 'response') { fail(); return; }
        if (phase === 'stop') {
          if (reply.data.id !== stopId || reply.data.method !== 'machine' || reply.data.payload.type !== 'done') { fail(); return; }
          succeed();
          return;
        }
        if (phase !== 'status' || reply.data.id !== statusId || reply.data.method !== 'admin'
          || reply.data.payload.kind !== 'daemonStatus' || !reply.data.payload.status.running || reply.data.payload.status.pid !== lock.pid) {
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
          socket.send(JSON.stringify({ type: 'request', id: stopId, method: 'machine', payload: { type: 'stopHost' } }));
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
