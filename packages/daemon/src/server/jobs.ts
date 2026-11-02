import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { agentIdSchema, jobIdSchema, type BackendInstallItem, type BackendInstallStatus, type CommandResult, type EnvironmentReply, type Event, type Job, type JobId } from '@vonvon/protocol';
import type { AdminService } from '../admin/service';
import { RpcError } from './errors';
import { BackendOutput, backendErrorSuffix } from './backend-output';

export interface JobPeer {
  readonly id: string;
  readonly open: boolean;
  event(event: Event): void;
}
interface Registration {
  job: Job;
  owner: string;
  abort: AbortController;
  done: Promise<void>;
  qrVersion: number;
  status?: string;
}
interface BackendOperation {
  operationId: string;
  id: string;
  update: boolean;
  /** the starting request's own id (cli-7-environment); a request that attaches does not change it */
  requestId?: string;
  abort: AbortController;
  output: BackendOutput;
  peers: Set<JobPeer>;
  done: Promise<void>;
  terminal?: BackendInstallItem;
  expiresAt?: number;
}
export interface BackendAdmission { operation: BackendOperation; attached: boolean }

export class Jobs {
  private readonly registrations = new Map<JobId, Registration>();
  private readonly unsettled = new Set<Registration>();
  private registration: Registration | undefined;
  private readonly views = new Map<JobId, Job>();
  private readonly expires = new Map<JobId, number>();
  private readonly backends = new Map<string, BackendOperation>();
  private readonly backendWork = new Set<BackendOperation>();
  private readonly backendLatest = new Map<string, BackendOperation>();
  private readonly poll: NodeJS.Timeout;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: { service: AdminService; changed: () => void; toolsSettled: () => void }) {
    this.poll = setInterval(() => this.refresh(), 250);
    this.poll.unref();
  }
  private set(job: Job): void {
    const previous = this.views.get(job.id);
    if (JSON.stringify(previous) === JSON.stringify(job)) return;
    this.views.set(job.id, job);
    if (job.phase === 'succeeded' || job.phase === 'failed' || job.phase === 'cancelled') {
      this.expires.set(job.id, Date.now() + 10 * 60_000);
    }
    this.options.changed();
  }
  snapshot(): Job[] { return [...this.views.values()]; }

  startRegistration(peer: JobPeer, agentId?: string): CommandResult {
    if (this.closed || this.unsettled.size >= 32) return { kind: 'refused', code: 'registration_busy', message: '已有注册正在保存，请稍后重试。' };
    if (this.registration) this.cancelRegistration(this.registration);
    const id = jobIdSchema.parse(randomUUID());
    const entry: Registration = { job: { id, type: 'registerAgent', phase: 'running', message: '正在创建扫码会话。' }, owner: peer.id, abort: new AbortController(), done: Promise.resolve(), qrVersion: 0 };
    this.registration = entry;
    this.registrations.set(id, entry);
    this.unsettled.add(entry);
    this.set(entry.job);
    const update = (job: Job): void => {
      if (entry.abort.signal.aborted || !this.unsettled.has(entry) || ['succeeded', 'failed', 'cancelled'].includes(entry.job.phase)) return;
      entry.job = job;
      this.set(job);
    };
    entry.done = Promise.resolve().then(async () => {
      entry.abort.signal.throwIfAborted();
      const callbacks: Parameters<AdminService['registerBotByQr']>[0] = {
        signal: entry.abort.signal,
        onQr: info => {
          const version = ++entry.qrVersion;
          const expiresAt = Date.now() + info.expireIn * 1000;
          void QRCode.toDataURL(info.url).then(image => {
            if (entry.qrVersion === version) update({ id, type: 'registerAgent', phase: 'qr', image, url: info.url, expiresAt, ...(entry.status ? { status: entry.status } : {}) });
          }).catch(() => { update({ id, type: 'registerAgent', phase: 'failed', code: 'unknown', message: '二维码生成失败。' }); entry.abort.abort(); });
        },
        onStatus: info => {
          if (entry.abort.signal.aborted) return;
          entry.status = info.status;
          if (entry.job.phase === 'qr') update({ ...entry.job, status: info.status });
        },
      };
      const result = agentId ? await this.options.service.refreshBotByQr(agentId, callbacks) : await this.options.service.registerBotByQr(callbacks);
      if (result.ok) update({ id, type: 'registerAgent', phase: 'succeeded', message: 'Bot 已保存。', agentId: agentIdSchema.parse(result.appId) });
      else if (result.code === 'abort') this.cancelRegistration(entry);
      else update({ id, type: 'registerAgent', phase: 'failed', code: result.code, message: result.reason.slice(0, 1024) });
    }).catch(error => {
      update({ id, type: 'registerAgent', phase: 'failed', code: 'unknown', message: error instanceof Error ? error.message.slice(0, 1024) : '注册失败。' });
    }).finally(() => {
      this.unsettled.delete(entry);
      if (this.registration === entry) this.registration = undefined;
      this.options.changed();
    });
    return { kind: 'started', jobId: id };
  }
  private cancelRegistration(entry: Registration): void {
    if (!this.unsettled.has(entry) || entry.abort.signal.aborted) return;
    entry.abort.abort();
    entry.job = { id: entry.job.id, type: 'registerAgent', phase: 'cancelled', message: '已取消扫码。' };
    this.set(entry.job);
  }
  async cancel(id: JobId): Promise<CommandResult> {
    const registration = this.registrations.get(id);
    if (registration) {
      this.cancelRegistration(registration);
      await registration.done;
    } else return { kind: 'refused', code: 'unknown_job', message: '任务不存在。' };
    return { kind: 'cancelled' };
  }
  /** Forgets finished jobs ten minutes after they end. */
  private refresh(): void {
    const now = Date.now();
    for (const [id, expiry] of this.expires) {
      if (expiry > now) continue;
      this.expires.delete(id);
      this.views.delete(id);
      this.registrations.delete(id);
      this.options.changed();
    }
  }
  selectBackend(id: string, update: boolean, requestId?: string): BackendAdmission {
    if (this.closed) throw new RpcError('conflict', 'daemon 正在停止，无法安装后端。');
    const key = JSON.stringify([id, update]);
    const existing = this.backends.get(key);
    if (existing) return { operation: existing, attached: true };
    const operation: BackendOperation = { operationId: randomUUID(), id, update, ...(requestId === undefined ? {} : { requestId }), abort: new AbortController(), output: new BackendOutput(), peers: new Set(), done: Promise.resolve() };
    this.backends.set(key, operation);
    this.backendWork.add(operation);
    this.backendLatest.set(id, operation);
    const emit = (item: BackendInstallItem): void => {
      if (operation.terminal) return;
      if (item.type !== 'log') { operation.terminal = item; operation.expiresAt = Date.now() + 10 * 60_000; }
      for (const peer of operation.peers) if (peer.open) peer.event({ type: 'event', event: 'backendInstall', payload: { operationId: operation.operationId, id, update, item } });
    };
    let install: ReturnType<AdminService['installBackend']>;
    try {
      install = this.options.service.installBackend(id, chunk => operation.output.append(chunk, piece => emit({ type: 'log', chunk: piece })), operation.abort.signal, { update });
    } catch (error) {
      install = Promise.reject(error);
    }
    operation.done = install
      .then(result => { emit(operation.abort.signal.aborted || result.aborted
        ? { type: 'error', code: 'aborted', message: operation.abort.signal.aborted ? '安装已取消。' : backendErrorSuffix(result.tail) }
        : result.ok ? { type: 'done' } : { type: 'error', code: 'install_failed', message: backendErrorSuffix(result.tail) }); })
      .catch(error => { emit(operation.abort.signal.aborted
        ? { type: 'error', code: 'aborted', message: '安装已取消。' }
        : { type: 'error', code: 'unknown', message: backendErrorSuffix(error instanceof Error ? error.message : '安装失败。') }); })
      .finally(() => { if (this.backends.get(key) === operation) this.backends.delete(key); this.backendWork.delete(operation); operation.peers.clear(); this.options.toolsSettled(); });
    return { operation, attached: false };
  }
  backendInstallStatus(id: string): BackendInstallStatus | null {
    const operation = this.backendLatest.get(id);
    if (!operation) return null;
    if (operation.expiresAt !== undefined && operation.expiresAt <= Date.now()) {
      this.backendLatest.delete(id);
      return null;
    }
    const { text, omittedBytes } = operation.output.snapshot();
    const replay: BackendInstallItem[] = text ? [{ type: 'log', chunk: text }] : [];
    if (operation.terminal) replay.push(operation.terminal);
    return {
      operationId: operation.operationId, id: operation.id, update: operation.update,
      ...(operation.requestId === undefined ? {} : { requestId: operation.requestId }),
      state: !operation.terminal ? 'running' : operation.terminal.type === 'done' ? 'succeeded'
        : operation.terminal.type === 'error' && operation.terminal.code === 'aborted' ? 'cancelled' : 'failed',
      replay, omittedBytes,
    };
  }
  cancelBackendInstall(operationId: string): boolean {
    const operation = [...this.backendWork].find(candidate => candidate.operationId === operationId);
    if (!operation || operation.terminal || operation.abort.signal.aborted) return false;
    operation.abort.abort();
    return true;
  }
  attachBackend(admission: BackendAdmission, peer: JobPeer): Extract<EnvironmentReply, { kind: 'backendInstall' }> {
    const { operation, attached } = admission;
    const { text, omittedBytes } = operation.output.snapshot();
    const replay: BackendInstallItem[] = text ? [{ type: 'log', chunk: text }] : [];
    if (operation.terminal) replay.push(operation.terminal);
    if (!this.closed && peer.open && !operation.terminal) operation.peers.add(peer);
    return { kind: 'backendInstall', operationId: operation.operationId, id: operation.id, update: operation.update, attached, replay, omittedBytes };
  }
  detach(peer: JobPeer): void {
    for (const entry of this.unsettled) if (entry.owner === peer.id) this.cancelRegistration(entry);
    for (const operation of this.backendWork) operation.peers.delete(peer);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.poll);
    const registrations = [...this.unsettled];
    const backends = [...this.backendWork];
    this.closing = Promise.resolve().then(async () => {
      for (const entry of registrations) this.cancelRegistration(entry);
      for (const operation of backends) operation.abort.abort();
      const results = await Promise.allSettled([...registrations, ...backends].map(entry => entry.done));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Jobs shutdown failed');
    });
    return this.closing;
  }
}
