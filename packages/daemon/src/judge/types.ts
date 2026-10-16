import type { JudgeErrorKind } from '../agent/error-kind';
import type { ReasoningEffort } from '../agent/types';
import type { Project } from '../project/registry';

export type { JudgeErrorKind } from '../agent/error-kind';

/**
 * Where the message to judge was posted (product.md 3.4):
 *   main      group main area, nobody named: skip / main / topic
 *   mentioned group main area, names this bot: it always replies, only main / topic
 *   topic     inside a topic (topic-group posts too): skip / reply
 */
export type JudgeVariant = 'main' | 'mentioned' | 'topic';
export type JudgeDecision = 'skip' | 'main' | 'topic' | 'reply';

export interface JudgeLine {
  /** epoch ms */
  at: number;
  /** this bot, another bot, a person */
  from: 'self' | 'bot' | 'user';
  /** display name; s25 passes the cached real name, else 某人 */
  name: string;
  /** plain text; s25 writes images and files as 〔图片〕〔文件 名字〕 */
  text: string;
  /** names this message @-mentions */
  mentions?: string[];
  /** whose line it quotes (s25 cuts the text to 200 characters) */
  quote?: { name: string; text: string };
}

export interface JudgeRequest {
  variant: JudgeVariant;
  /** which bot (finds SMART.md) */
  appId: string;
  /** the 你 of the prompt */
  botName: string;
  /** s23c adds the group's `judge` setting here, and `botJudge` next to it */
  group: Pick<Project, 'chatId' | 'name' | 'backend'>;
  /** a summary of the bot's personality (SOUL.md from s38 on), cut to 1,500 characters */
  persona?: string;
  /** topic variant: the topic's title */
  topicTitle?: string;
  /** oldest first, without the message to judge */
  context: JudgeLine[];
  message: JudgeLine;
  /** message id; the log keeps its last 6 characters */
  ref?: string;
  /** s25 and s26 abort when the message is recalled or they give up */
  signal?: AbortSignal;
  /** default by variant, see JUDGE_TIMEOUT_MS */
  timeoutMs?: number;
}

export interface JudgeResult {
  /** always set; on failure `main` for mentioned and `skip` otherwise, but `skip` for aborted and closed */
  decision: JudgeDecision;
  /** the model's reason, at most 80 characters; empty on failure */
  reason: string;
  error?: { kind: JudgeErrorKind; detail?: string };
  backend: string;
  model: string;
  effort?: ReasoningEffort;
  modelSource: 'default' | 'bot' | 'group';
  promptSource: 'default' | 'bot' | 'group';
  /** from the call to the result */
  ms: number;
}
