import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { IngestedContext } from './inbound';

/** Per bot, memory only: keep presentation beside the message, and reuse known
 * transcripts when Feishu returns the original audio in a history/quote pull. */
export class VoiceMessages {
  private readonly prepared = new WeakMap<NormalizedMessage, IngestedContext>();
  private readonly transcripts = new Map<string, { text: string; at: number }>();

  constructor(private readonly max = 1000, private readonly ttlMs = 60 * 60_000) {}

  remember(msg: NormalizedMessage, ingested: IngestedContext): NormalizedMessage {
    if (!ingested.voice?.transcribed) {
      this.prepared.set(msg, ingested);
      return msg;
    }
    const raw = msg.raw as { message?: Record<string, unknown> } | undefined;
    const text: NormalizedMessage = {
      ...msg, content: ingested.text, rawContentType: 'text',
      resources: msg.resources?.filter(resource => resource.type !== 'audio'),
      // Judge lines and name detection read the raw body, just as text does.
      ...(raw ? { raw: { ...raw, message: { ...raw.message, message_type: 'text', content: JSON.stringify({ text: ingested.text }) } } } : {}),
    };
    this.prepared.set(text, ingested);
    this.transcripts.set(msg.messageId, { text: ingested.text, at: Date.now() });
    this.prune();
    return text;
  }

  get(msg: NormalizedMessage): IngestedContext | undefined { return this.prepared.get(msg); }

  context<T extends { messageId: string; text: string }>(message: T): T {
    this.prune();
    const known = this.transcripts.get(message.messageId);
    return known ? { ...message, text: known.text } : message;
  }

  forget(id: string): void { this.transcripts.delete(id); }

  private prune(): void {
    const now = Date.now();
    for (const [id, value] of this.transcripts) {
      if (this.transcripts.size <= this.max && now - value.at < this.ttlMs) break;
      this.transcripts.delete(id);
    }
  }
}
