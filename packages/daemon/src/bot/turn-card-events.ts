import type { AgentEvent } from '../agent/types';
import type { VoiceReply } from '../voice/types';

export interface SteerCardEvent {
  type: 'steer_accepted';
  messageId: string;
  voice?: VoiceReply;
}

export interface AskAnsweredCardEvent {
  type: 'ask_answered';
  messageId: string;
}

export type TurnCardEvent = SteerCardEvent | AskAnsweredCardEvent;

/** Serialize accepted steering and answered-ask boundaries with backend events. Card creation
 * may await I/O, while the source keeps collecting events in arrival order. */
export class TurnCardEvents {
  private queue: (AgentEvent | TurnCardEvent)[] = [];
  private wake?: () => void;
  private open = true;
  private ended = false;
  private failure?: { error: unknown };

  accept(messageId: string, voice?: VoiceReply): boolean {
    if (!this.open) return false;
    this.push({ type: 'steer_accepted', messageId, voice });
    return true;
  }

  askAnswered(messageId: string): boolean {
    if (!this.open) return false;
    this.push({ type: 'ask_answered', messageId });
    return true;
  }

  private push(event: AgentEvent | TurnCardEvent): void {
    this.queue.push(event);
    this.wake?.();
  }

  async *consume(source: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent | TurnCardEvent> {
    const produce = async (): Promise<void> => {
      try {
        for await (const event of source) {
          if (this.ended) break;
          if (event.type === 'done' || (event.type === 'error' && !event.willRetry)) this.open = false;
          this.push(event);
        }
      } catch (error) {
        this.failure = { error };
      } finally {
        this.open = false;
        this.ended = true;
        this.wake?.();
      }
    };
    void produce();
    try {
      for (;;) {
        const event = this.queue.shift();
        if (event) { yield event; continue; }
        if (this.ended) {
          if (this.failure) throw this.failure.error;
          return;
        }
        await new Promise<void>(resolve => { this.wake = resolve; });
        this.wake = undefined;
      }
    } finally {
      this.open = false;
      this.ended = true;
      this.queue = [];
    }
  }
}
