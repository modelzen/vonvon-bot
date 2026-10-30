import type { JudgeErrorKind } from '../agent/error-kind';
import type { ReasoningEffort } from '../agent/types';
import type { Project } from '../project/registry';
import type { JudgeProvider } from './global-models';

export type { JudgeErrorKind } from '../agent/error-kind';

/**
 * Where the message to judge was posted (product.md 3.4):
 *   main      group main area, named or unnamed: skip / main / topic
 *   topic     inside a topic (topic-group posts too): skip / reply
 */
export type JudgeVariant = 'main' | 'topic';
export type JudgeDecision = 'skip' | 'main' | 'topic' | 'reply';

/**
 * The judge model a bot (`preferences.judge`) or a group (`Project.judge`) stores (design 2.1).
 * New group choices are concrete snapshots; legacy `default`/`provider` references are frozen
 * before the next host profile edit. `llm` identifies the judge's backend independently of the
 * group's task backend; only the legacy Bot layer remains backend-scoped. `decision`, a decision model (product.md 3.4): no backend, the layer
 * applies to groups on every backend; s23f calls it. An unknown kind reads as unset and is never
 * rewritten.
 */
export type JudgeSelectionStored =
  | { kind: 'default' }
  | { kind: 'llm'; backend: string; model: string; effort?: ReasoningEffort; custom?: true }
  | { kind: 'decision'; provider: string; model: string }
  | { kind: 'provider'; provider: JudgeProvider };

export interface JudgeLine {
  /** message id: what an anchor names (s25b); never rendered */
  id?: string;
  /** A weak short/common-name match in this line, never an immediate signal. */
  sameNameWord?: true;
  /** Newly seen in this judgement; not stored. */
  fresh?: true;
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

export interface JudgeFacts {
  otherBots: { names: string[]; complete: boolean };
  here: { kind: 'main' | 'topic'; openedBy?: string; speakers: string[]; historyIncomplete: true };
  botExchangesSincePerson?: { count: number; atLeast: boolean };
}

export interface JudgeRequest {
  facts?: JudgeFacts;
  variant: JudgeVariant;
  /** Why this position is being looked at now, as one factual sentence. */
  why?: string;
  /** which bot (finds SMART.md) */
  appId: string;
  /** the 你 of the prompt */
  botName: string;
  /** the group's backend and its judge model override (unchecked, as stored) */
  group: Pick<Project, 'chatId' | 'name' | 'backend' | 'judge' | 'smartRules'>;
  /** `cfg.preferences.judge` as stored; the judge layer checks it (parseStoredJudge) */
  botJudge?: unknown;
  /** a summary of the bot's personality (SOUL.md from s38 on), cut to 1,500 characters */
  persona?: string;
  /** Memory is a separate bounded context field so a long persona cannot erase it. */
  memory?: string;
  /** topic variant: the topic's title */
  topicTitle?: string;
  /** oldest first, without the message to judge */
  context: JudgeLine[];
  message: JudgeLine;
  /** message id; the log keeps its last 6 characters */
  ref?: string;
  /** s25 and s26 abort when the message is recalled or they give up */
  signal?: AbortSignal;
  /** default by variant (JUDGE_TIMEOUT_MS); named messages pass JUDGE_NAMED_TIMEOUT_MS */
  timeoutMs?: number;
}

export interface JudgeResult {
  /** always set; skip on any failure, including aborted and closed */
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
  /** First 16 hex characters of the SMART.md hash; absent before the prompt is read. */
  promptHash?: string;
  promptSource: 'default' | 'bot' | 'group';
  /** from the call to the result */
  ms: number;
}
