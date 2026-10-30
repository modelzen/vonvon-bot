import type { ScheduleReply, ScheduleRequest } from '@vonvon/protocol';
import type { Scheduler } from '../bot/schedule/scheduler';
import type { ScheduleStore } from '../bot/schedule/store';

/** Who asks. `chat`: a person in a group turn; `scheduled`: the task's own unattended run; `local`: the owner on this machine. */
export type ScheduleActor =
  | { kind: 'chat'; openId: string; name?: string; role: 'owner' | 'admin' | 'member'; chatId: string; topicId?: string; messageId?: string; text?: string }
  | { kind: 'scheduled'; taskId: string; runId: string; chatId: string }
  | { kind: 'local'; via: 'desktop' | 'cli' };

export interface ScheduleCommandsDeps {
  store: ScheduleStore;
  scheduler: Scheduler;
  botId: string;
  now: () => number;
  hostTimeZone: () => string;
  /** Defaults 20 per group, 200 per bot. */
  limits?: { perChat: number; perBot: number };
}

export interface ScheduleCommands {
  execute(actor: ScheduleActor, request: ScheduleRequest): Promise<ScheduleReply>;
}

/** The only entry that changes schedules.json on a user's behalf (terminal, desktop and agent tools). */
export function createScheduleCommands(deps: ScheduleCommandsDeps): ScheduleCommands {
  void deps;
  return { execute: async () => { throw new Error('schedule-commands: not implemented'); } };
}
