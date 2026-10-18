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

/**
 * The judge model a bot (`preferences.judge`) or a group (`Project.judge`) stores (design 2.1).
 * `llm`, a language model: `backend` says whose model id this is, and the layer applies only to
 * groups on that backend. `decision`, a decision model (product.md 3.4): no backend, the layer
 * applies to groups on every backend; s23f calls it. An unknown kind reads as unset and is never
 * rewritten.
 */
export type JudgeSelectionStored =
  | { kind: 'llm'; backend: string; model: string; effort?: ReasoningEffort; custom?: true }
  | { kind: 'decision'; provider: string; model: string };

export interface JudgeLine {
  /** message id: what an anchor names (s25b); never rendered */
  id?: string;
  /** epoch ms */
  at: number;
  /** this bot, another bot, a person */
  from: 'self' | 'bot' | 'user';
  /** display name; s25 passes the cached real name, else 某人 */
  name: string;
  /** plain text; images and files as a record block writes them: [图片], [文件：名字] (recent-lines.ts) */
  text: string;
  /** names this message @-mentions */
  mentions?: string[];
  /** It @-mentions someone or everyone, also when the names are unknown (a line pulled from history): a topic never
   * opens under it, so it is never an anchor (s25b); never rendered */
  named?: true;
  /** whose line it quotes (s25 cuts the text to 200 characters) */
  quote?: { name: string; text: string };
}

export interface JudgeRequest {
  variant: JudgeVariant;
  /** which bot (finds SMART.md) */
  appId: string;
  /** the 你 of the prompt */
  botName: string;
  /** the group's backend and its judge model override (unchecked, as stored) */
  group: Pick<Project, 'chatId' | 'name' | 'backend' | 'judge'>;
  /** `cfg.preferences.judge` as stored; the judge layer checks it (parseStoredJudge) */
  botJudge?: unknown;
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
  /** the model's reason, at most 80 characters, empty on failure; a decision model's is written from its options (s23f) */
  reason: string;
  /** main variant: the earlier message the judged one follows up on (its m-number in the input, s25b), where a
   * topic opens; unset when that is the message itself, or the model named no line shown */
  anchor?: string;
  /** 0 to 1: a decision model's (s23f); a language model gives none */
  confidence?: number;
  error?: { kind: JudgeErrorKind; detail?: string };
  backend: string;
  model: string;
  effort?: ReasoningEffort;
  /** set when a decision model was chosen: whose `model` it is (`backend` is then the group's) */
  provider?: string;
  modelSource: 'default' | 'bot' | 'group';
  promptSource: 'default' | 'bot' | 'group';
  /** from the call to the result */
  ms: number;
}
