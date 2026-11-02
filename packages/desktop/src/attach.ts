import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { connectBrowser } from '@vonvon/client/browser';
import { PROTOCOL_VERSION } from '@vonvon/protocol';
import { getPidLockInfo, isPidLockOwnerRunning, readRunningPidLock } from '../../daemon/src/server/pid-lock.js';
import { verifyPidLockOwner } from '../../daemon/src/server/owner-verification.js';
import type { AttachedDaemon } from './ipc-contract.js';

export class AttachError extends Error {
  /** `protocol`: the daemon runs, with this other protocol version. */
  constructor(readonly reason: 'root' | 'owner' | 'credential' | 'connection' | 'identity' | 'close' | 'protocol', cause?: unknown, readonly serverProtocol?: number) {
    super({
      root: 'Vonvon 数据目录不可用。',
      owner: '没有找到在运行且通过校验的 Vonvon daemon。',
      credential: '本机 daemon 凭据不可用。',
      connection: '正在运行的 Vonvon daemon 不接受这次桌面连接。',
      identity: '桌面连接期间 daemon 换了进程。',
      close: '桌面连接没有正常关闭。',
      protocol: `正在运行的 Vonvon daemon 用的协议版本是 ${serverProtocol}，桌面端是 ${PROTOCOL_VERSION}。先别关它，把较旧的那一边更新到同一个版本。`,
    }[reason], { cause });
    this.name = 'AttachError';
  }
}

const localListen = /^127\.0\.0\.1:(\d{1,5})$/;

async function statusWithinDeadline(client: AttachedDaemon['client']): ReturnType<AttachedDaemon['client']['admin']> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.admin({ type: 'daemonStatus' }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Daemon status timed out')), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function attachExisting(root: string): Promise<AttachedDaemon> {
  let canonicalRoot: string;
  try {
    const selected = resolve(root);
    const info = await lstat(selected);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid root');
    canonicalRoot = await realpath(selected);
    if (selected !== canonicalRoot || root !== selected) throw new Error('Root is not canonical');
  } catch (cause) {
    throw new AttachError('root', cause);
  }

  let lock;
  let listen: string;
  try {
    lock = await readRunningPidLock(canonicalRoot);
    const candidate = lock?.listen;
    const match = localListen.exec(candidate ?? '');
    const port = Number(match?.[1]);
    if (!lock || !candidate || !match || port < 1 || port > 65535) throw new Error('Owner is not ready');
    listen = candidate;
    await verifyPidLockOwner(canonicalRoot, lock);
  } catch (cause) {
    throw new AttachError('owner', cause);
  }

  let credential: string;
  try {
    credential = (await readFile(join(canonicalRoot, 'local-credential'), 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/i.test(credential)) throw new Error('Invalid credential');
  } catch (cause) {
    throw new AttachError('credential', cause);
  }

  let client;
  let serverInfo;
  try {
    ({ client, serverInfo } = await connectBrowser({ url: `ws://${listen}`, credential, clientKind: 'desktop' }));
  } catch (cause) {
    throw new AttachError('connection', cause);
  }
  // 不同协议在本机启动时是致命的，由 `daemon-manager` 说清楚哪边旧（设计 4.5）。
  if (serverInfo.protocolVersion !== PROTOCOL_VERSION) {
    const rejection = new AttachError('protocol', undefined, serverInfo.protocolVersion);
    try { await client.close(); }
    catch (closeFailure) { throw new AggregateError([rejection, closeFailure], '连接 daemon 失败，桌面连接也没有正常关闭。'); }
    throw rejection;
  }

  try {
    const reply = await statusWithinDeadline(client);
    const current = await getPidLockInfo(canonicalRoot);
    if (reply.kind !== 'daemonStatus' || !reply.status.running || reply.status.pid !== lock.pid ||
        !current || current.pid !== lock.pid || current.startedAt !== lock.startedAt ||
        current.listen !== listen || !isPidLockOwnerRunning(current)) {
      throw new AttachError('identity');
    }
  } catch (cause) {
    const rejection = cause instanceof AttachError ? cause : new AttachError('identity', cause);
    try { await client.close(); }
    catch (closeFailure) { throw new AggregateError([rejection, closeFailure], '连接 daemon 失败，桌面连接也没有正常关闭。'); }
    throw rejection;
  }

  let closing: Promise<void> | undefined;
  return {
    client, serverInfo,
    identity: { pid: lock.pid, startedAt: lock.startedAt, listen },
    dispose() { return closing ??= client.close(); },
  };
}
