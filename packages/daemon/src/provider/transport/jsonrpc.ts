import { approvalAnswer, CodexRequestScope, dynamicToolCall, userInputRequest, type DynamicToolHost, type InboundQuestion, type InboundCancellation } from '../../agent/codex-appserver/server-requests';
import { UnsentRequestError } from '../../agent/types';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mergeProcessEnv } from '../../platform/spawn';
import { log } from '../../core/logger';
import type { ServerNotification } from '../../agent/codex-appserver/protocol';
import { OwnedProviderProcess } from '../../agent/owned-process';
import { binChildEnv } from '../../platform/tool-path';

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined as never, done: true });
  }

  clear(): void {
    this.items.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    let ended = false;
    const owned = new Set<(v: IteratorResult<T>) => void>();
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => {
        if (ended) return Promise.resolve({ value: undefined as never, done: true });
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>(resolve => {
          const waiter = (v: IteratorResult<T>) => { owned.delete(waiter); resolve(v); };
          owned.add(waiter);
          this.waiters.push(waiter);
        });
      },
      return: async () => {
        ended = true;
        for (const waiter of owned) {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          waiter({ value: undefined as never, done: true });
        }
        return { value: undefined as never, done: true };
      },
    };
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const EOF_GRACE_MS = 500;
const resolvedRequestSchema = z.object({ threadId: z.string(), requestId: z.union([z.string(), z.number()]) });
const frameSchema = z.record(z.string(), z.unknown());
export type JsonRpcFrame = z.infer<typeof frameSchema>;
export type JsonRpcId = number | string;
export type JsonRpcAnswer = { result: unknown } | { error: { code: number; message: string } };

/** A newline-delimited JSON-RPC peer over streams owned by its caller. */
export class JsonRpcPeer {
  onFrame?: (frame: JsonRpcFrame) => void;
  onNotification?: (method: string, params: unknown, frame: JsonRpcFrame) => void;
  /** undefined leaves the method unknown; null retires an already server-resolved request without a reply. */
  onRequest?: (method: string, params: unknown, frame: JsonRpcFrame) => JsonRpcAnswer | null | undefined | Promise<JsonRpcAnswer | null | undefined>;
  onInvalidFrame?: (line: string) => void;

  readonly closed: Promise<void>;
  private finishClosed!: () => void;
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private ended = false;

  get pendingCount(): number {
    return this.pending.size;
  }

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    onInputClosed?: (error: Error) => void,
  ) {
    this.closed = new Promise(resolve => { this.finishClosed = resolve; });
    input.on('data', (chunk: unknown) => {
      if (this.ended) return;
      if (Buffer.isBuffer(chunk)) this.acceptText(this.decoder.write(chunk));
      else if (typeof chunk === 'string') this.acceptText(chunk);
    });
    const inputClosed = onInputClosed ?? ((error: Error) => this.close(error));
    input.on('end', () => inputClosed(new Error('JSON-RPC input ended')));
    input.on('error', error => this.close(error));
    input.on('close', () => inputClosed(new Error('JSON-RPC input closed')));
    output.on('close', () => this.close(new Error('JSON-RPC output closed')));
    output.on('error', error => this.close(error));
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.ended) return Promise.reject(new Error('JSON-RPC peer closed'));
    const id = ++this.nextId;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} response timed out; delivery unknown`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value as T); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try {
        this.output.write(payload, error => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          pending.reject(error);
        });
      } catch (error) {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.ended) return;
    this.output.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })}\n`);
  }

  close(error: Error = new Error('JSON-RPC peer closed')): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.finishClosed();
  }

  private acceptText(text: string): void {
    this.buffer += text;
    let newline: number;
    while (!this.ended && (newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.acceptLine(line);
    }
  }

  private acceptLine(line: string): void {
    let decoded: unknown;
    try { decoded = JSON.parse(line); }
    catch { this.invalidFrame(line); return; }
    const parsed = frameSchema.safeParse(decoded);
    if (!parsed.success) { this.invalidFrame(line); return; }
    const frame = parsed.data;
    try { this.onFrame?.(frame); }
    catch { }
    if (this.ended) return;
    const { id, method } = frame;
    if ((typeof id === 'number' || typeof id === 'string') && typeof method === 'string') {
      void this.answerRequest(id, method, frame);
      return;
    }
    if (typeof id === 'number' && ('result' in frame || 'error' in frame)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (frame.error) {
        const error = frameSchema.safeParse(frame.error);
        pending.reject(new JsonRpcError(error.success && typeof error.data.message === 'string'
          ? error.data.message : 'JSON-RPC error'));
      } else pending.resolve(frame.result);
      return;
    }
    if (typeof method === 'string') {
      try { this.onNotification?.(method, frame.params, frame); }
      catch { }
    }
  }

  private invalidFrame(line: string): void {
    try { this.onInvalidFrame?.(line); }
    catch { }
  }

  private async answerRequest(id: JsonRpcId, method: string, frame: JsonRpcFrame): Promise<void> {
    let answer: JsonRpcAnswer | null | undefined;
    try { answer = await this.onRequest?.(method, frame.params, frame); }
    catch (error) {
      answer = { error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' } };
    }
    if (this.ended || answer === null) return;
    try {
      this.output.write(`${JSON.stringify({ jsonrpc: '2.0', id,
        ...(answer ?? { error: { code: -32601, message: 'not handled' } }) })}\n`);
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export class JsonRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export interface AppServerClientOptions {
  bin: string;
  cwd: string;
  env?: Record<string, string>;
  /** Use an isolated configuration-only environment without inherited provider secrets. */
  replaceEnv?: boolean;
  clientName?: string;
  quietOutput?: boolean;
  initializeTimeoutMs?: number;
  /** Ephemeral native config, never written to the user's config.toml. */
  configOverrides?: readonly string[];
}

export class AppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private owned: OwnedProviderProcess | undefined;
  private peer: JsonRpcPeer | undefined;
  private readonly notifications = new AsyncQueue<ServerNotification | InboundQuestion | InboundCancellation>();
  private requestScope: CodexRequestScope | undefined;
  private requestSerial = 0;
  private toolHost: { threadId: string; host: DynamicToolHost } | undefined;
  private closed = false;
  private hasExited = false;

  constructor(private readonly opts: AppServerClientOptions) {}

  private get pending(): { size: number } {
    return { size: this.peer?.pendingCount ?? 0 };
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get exited(): boolean {
    return this.hasExited || this.closed;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new UnsentRequestError('app-server client closed');
    // Launch via cross-spawn (platform/spawn) so a Windows `.cmd` codex shim
    // runs instead of throwing EINVAL (CVE-2024-27980). With stdio all-piped the
    // streams are non-null, so the cast to *WithoutNullStreams is sound.
    const owned = new OwnedProviderProcess(this.opts.bin, [
      ...(this.opts.configOverrides ?? []).flatMap(value => ['-c', value]),
      'app-server', '--listen', 'stdio://',
    ], {
      cwd: this.opts.cwd,
      env: binChildEnv(this.opts.bin, mergeProcessEnv(this.opts.replaceEnv ? {} : process.env, { ...this.opts.env, FEISHU_CODEX_BRIDGE: '1' })),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const child = owned.child as ChildProcessWithoutNullStreams;
    this.owned = owned;
    this.child = child;
    log.info('agent', 'spawn', { pid: child.pid ?? null, cwd: this.opts.cwd });

    let inputCloseTimer: NodeJS.Timeout | undefined;
    const peer = new JsonRpcPeer(child.stdout, child.stdin, error => {
      if (this.closed) return;
      this.closed = true;
      this.requestScope?.close();
      // stdout can end before child exit delivers the legacy failure reason.
      inputCloseTimer = setTimeout(() => {
        peer.close(error);
        void this.close().catch(closeError => log.fail('agent', closeError, { phase: 'input-close' }));
      }, EOF_GRACE_MS);
    });
    this.peer = peer;
    peer.onNotification = (method, params, frame) => {
      if (method === 'serverRequest/resolved') {
        const resolved = resolvedRequestSchema.safeParse(params);
        if (resolved.success && this.requestScope) {
          for (const cancelled of this.requestScope.retireRpc(resolved.data.requestId, resolved.data.threadId)) this.notifications.push(cancelled);
        }
      }
      this.notifications.push(frame as unknown as ServerNotification);
    };
    peer.onRequest = (method, params, frame) => {
      const denial = approvalAnswer(method);
      if (denial) return denial;
      if (method === 'item/tool/call') {
        const id = frame.id;
        return dynamicToolCall(
          params,
          this.requestScope,
          threadId => this.toolHost?.threadId === threadId ? this.toolHost.host : undefined,
          typeof id === 'string' || typeof id === 'number'
            ? { rpcId: id, nextSerial: () => ++this.requestSerial, enqueue: question => this.notifications.push(question) }
            : undefined,
        );
      }
      if (method !== 'item/tool/requestUserInput') return undefined;
      const id = frame.id;
      if (typeof id !== 'string' && typeof id !== 'number') return undefined;
      return userInputRequest(params, id, ++this.requestSerial, this.requestScope, question => this.notifications.push(question));
    };
    peer.onInvalidFrame = line => {
      if (!this.opts.quietOutput) log.warn('agent', 'nonjson', { line: line.slice(0, 120) });
    };
    void peer.closed.then(() => {
      clearTimeout(inputCloseTimer);
      this.closed = true;
      this.hasExited = true;
      this.requestScope?.close();
      this.notifications.close();
    });
    child.stderr.on('data', (d: Buffer) => {
      const line = d.toString('utf8').trim();
      if (line && !this.opts.quietOutput) log.warn('agent', 'stderr', { line: line.slice(0, 200) });
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      this.hasExited = true;
      this.closed = true;
      peer.close(new Error(`app-server exited (code=${code} signal=${signal})`));
      this.requestScope?.close();
      this.notifications.close();
    });
    child.on('error', (err) => {
      this.closed = true;
      peer.close(err);
      this.requestScope?.close();
      this.notifications.close();
      void this.close().catch(error => log.fail('agent', error, { phase: 'process-error-close' }));
    });
    const outputClosed = (err: Error) => {
      peer.close(err);
      this.requestScope?.close();
      this.notifications.close();
      if (!this.hasExited) {
        this.closing ??= this.closeChild(4000, true);
        void this.closing.catch(error => log.fail('agent', error));
      }
    };
    child.stdin.on('error', outputClosed);
    child.stdin.on('close', () => outputClosed(new Error('app-server stdin closed')));

    await this.request('initialize', {
      clientInfo: { name: this.opts.clientName ?? 'feishu-codex-bridge', version: '0.0.1' },
      // experimentalApi opts into experimental JSON-RPC methods + fields — REQUIRED
      // for the goal RPCs (thread/goal/set|get|clear). Verified against codex 0.139:
      // without it, thread/goal/set is rejected. The `goals` feature itself is
      // stable+on by default there, so no experimentalFeature/enablement/set needed.
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, this.opts.initializeTimeoutMs);
    this.notify('initialized');
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed || !this.peer) return Promise.reject(new UnsentRequestError('app-server client closed'));
    return this.peer.request<T>(method, params, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.peer?.notify(method, params);
  }

  /** async-iterate server notifications (closes when the transport or process ends). */
  stream(): AsyncIterable<ServerNotification> {
    const source = this.events();
    return {
      [Symbol.asyncIterator]() {
        const iterator = source[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<ServerNotification>> {
            while (true) {
              const step = await iterator.next();
              if (step.done) return { done: true, value: undefined };
              if (!('method' in step.value)) {
                if (step.value.kind === 'request') step.value.settle();
              }
              else return { done: false, value: step.value };
            }
          },
          async return(): Promise<IteratorResult<ServerNotification>> {
            await iterator.return?.();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  events(): AsyncIterable<ServerNotification | InboundQuestion | InboundCancellation> {
    const queue = this.notifications;
    const scope = this.requestScope;
    return {
      [Symbol.asyncIterator]() {
        const iterator = queue[Symbol.asyncIterator]();
        return {
          next: () => iterator.next(),
          return: () => { scope?.close(); return iterator.return?.() ?? Promise.resolve({ done: true, value: undefined }); },
        };
      },
    };
  }

  openRequestScope(threadId: string, childTurn?: (id: string) => string | undefined): CodexRequestScope {
    this.requestScope?.close();
    return this.requestScope = new CodexRequestScope(threadId, childTurn);
  }

  /** The thread whose vonvon tool calls this process answers (定时任务 T3b); a client carries one thread. */
  hostTools(threadId: string, host: DynamicToolHost): void {
    this.toolHost = { threadId, host };
  }

  cancelRequests(threadId: string, turnId: string): void {
    if (this.requestScope?.threadId === threadId) this.requestScope.finishTurn(turnId);
  }

  /** Drop buffered, un-consumed notifications. Used when a prewarmed pool client
   * is taken for a real session: notifications buffered while it idled in the
   * pool (MCP startup progress, the ephemeral warmup thread/started, …) belong
   * to the warmup thread and must never leak into the session's event stream. */
  clearNotifications(): void {
    this.requestScope?.close();
    this.notifications.clear();
  }

  private closing: Promise<void> | undefined;

  close(graceMs = 4000): Promise<void> {
    this.closing ??= this.closeChild(graceMs);
    return this.closing;
  }

  private async closeChild(graceMs: number, waitForNaturalExit = false): Promise<void> {
    this.closed = true;
    this.requestScope?.close();
    this.peer?.close(new Error('app-server client closed'));
    this.notifications.close();
    const owned = this.owned;
    if (!owned) return;
    if (waitForNaturalExit) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([owned.exited, new Promise<void>(resolve => {
          timer = setTimeout(resolve, EOF_GRACE_MS);
        })]);
      } finally { clearTimeout(timer); }
    }
    await owned.close(graceMs);
  }

}
