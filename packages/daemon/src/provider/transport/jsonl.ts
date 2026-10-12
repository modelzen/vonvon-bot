import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';

export type JsonlFrame = Record<string, unknown>;

interface Pending {
  matches: (frame: JsonlFrame) => boolean;
  resolve: (frame: JsonlFrame) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isJsonlFrame(value: unknown): value is JsonlFrame {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class JsonlPeer {
  onFrame?: (frame: JsonlFrame) => void;
  onInvalidLine?: (line: string) => void;
  isRequest?: (frame: JsonlFrame) => boolean;
  onRequest?: (frame: JsonlFrame) => JsonlFrame | undefined | Promise<JsonlFrame | undefined>;

  readonly closed: Promise<void>;
  private finishClosed!: () => void;
  private readonly decoder = new StringDecoder('utf8');
  private readonly pending = new Set<Pending>();
  private buffer = '';
  private ended = false;

  get pendingCount(): number {
    return this.pending.size;
  }

  constructor(private readonly input: Readable, private readonly output: Writable) {
    this.closed = new Promise(resolve => { this.finishClosed = resolve; });
    input.on('data', (chunk: unknown) => {
      if (this.ended) return;
      if (Buffer.isBuffer(chunk)) this.acceptText(this.decoder.write(chunk));
      else if (typeof chunk === 'string') this.acceptText(chunk);
    });
    input.on('end', () => this.close(new Error('JSONL input ended')));
    input.on('close', () => this.close(new Error('JSONL input closed')));
    input.on('error', error => this.close(error));
    output.on('close', () => this.close(new Error('JSONL output closed')));
    output.on('error', error => this.close(error));
  }

  request(frame: JsonlFrame, matches: (reply: JsonlFrame) => boolean, timeoutMs?: number): Promise<JsonlFrame> {
    if (this.ended) return Promise.reject(new Error('JSONL peer closed'));
    return new Promise((resolve, reject) => {
      const pending: Pending = { matches, resolve, reject };
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(pending)) return;
          reject(new Error('JSONL response timed out; delivery unknown'));
        }, timeoutMs);
      }
      this.pending.add(pending);
      try {
        this.send(frame);
      } catch (error) {
        if (this.pending.delete(pending)) {
          clearTimeout(pending.timer);
          reject(toError(error));
        }
      }
    });
  }

  send(frame: JsonlFrame): void {
    if (this.ended) throw new Error('JSONL peer closed');
    try {
      this.output.write(`${JSON.stringify(frame)}\n`, error => {
        if (error) this.close(error);
      });
    } catch (error) {
      this.close(toError(error));
      throw error;
    }
  }

  close(error: Error = new Error('JSONL peer closed')): void {
    if (this.ended) return;
    this.ended = true;
    this.buffer = '';
    for (const pending of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
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
    let frame: unknown;
    try { frame = JSON.parse(line); }
    catch { this.invalidLine(line); return; }
    if (!isJsonlFrame(frame)) {
      this.invalidLine(line);
      return;
    }
    this.dispatch(frame);
  }

  private invalidLine(line: string): void {
    try { this.onInvalidLine?.(line); }
    catch (error) { this.close(toError(error)); }
  }

  private dispatch(frame: JsonlFrame): void {
    try {
      this.onFrame?.(frame);
      if (this.ended) return;
      for (const pending of this.pending) {
        const matched = pending.matches(frame);
        if (this.ended) return;
        if (!matched) continue;
        this.pending.delete(pending);
        clearTimeout(pending.timer);
        pending.resolve(frame);
        return;
      }
      if (this.ended) return;
      const isRequest = this.isRequest?.(frame);
      if (this.ended || !isRequest) return;
      const answer = this.onRequest?.(frame);
      void Promise.resolve(answer).then(reply => {
        if (this.ended || reply === undefined) return;
        this.send(reply);
      }).catch(error => this.close(toError(error)));
    } catch (error) {
      this.close(toError(error));
    }
  }
}
