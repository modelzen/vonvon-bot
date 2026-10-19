import { JUDGE_ALLOWED, JUDGE_FORMAT_HEADER, JUDGE_INPUT_BOUNDS, JUDGE_INPUT_EXAMPLE_REQUEST, JUDGE_INPUT_LIMITS, lineFields, oneLine, plainText, shownContext } from './prompt';
import { callTypeSafe, probeTypeSafe, type DecisionReply, type ProbeResult } from './typesafe';
import type { JudgeDecision, JudgeLine, JudgeRequest, JudgeVariant } from './types';

/**
 * A decision model's service (product.md 3.4): a stored `{kind:'decision', provider, model}` names one by `id`.
 * Another service is one more entry here and its call; the settings keep their shape.
 */
export interface DecisionProvider {
  id: string;
  displayName: string;
  /** what a judge model picker lists (s28, s41); any other id is taken too, as a hand-typed one */
  models: readonly { id: string; displayName: string }[];
  /** its name in the keystore (`vonvon secrets set <keyId>`), one per machine */
  keyId: string;
  /** running and queued per bot process, as a backend's (judge.ts) */
  limit: { running: number; queued: number };
  /** the model's name in a reason */
  label(model: string): string;
  call(body: DecisionBody, key: string, signal: AbortSignal, fetchImpl?: typeof fetch): Promise<DecisionReply>;
  /** the key page's 试一次 (s23g): one request that sends no group message */
  probe(key: string, signal: AbortSignal, fetchImpl?: typeof fetch): Promise<ProbeResult>;
}

/** A Map, so an id such as `constructor` names nothing. */
const PROVIDERS = new Map<string, DecisionProvider>([
  ['typesafe', {
    id: 'typesafe',
    displayName: 'TypeSafe',
    models: [{ id: 'jev-latest', displayName: 'Jev' }],
    keyId: 'typesafe-api-key',
    // Jev report 2.6: 6 at once met no 429; a 429 cools the provider (typesafe.ts)
    limit: { running: 8, queued: 32 },
    label: (model) => (model.startsWith('jev') ? 'Jev' : model),
    call: (body, key, signal, fetchImpl) => callTypeSafe(body, key, signal, fetchImpl),
    // GET /v1/models; whether it needs the key is checked with a real one at s23g's acceptance (v1-plan s23g 做法)
    probe: (key, signal, fetchImpl) => probeTypeSafe(key, signal, fetchImpl),
  }],
]);

export const decisionProvider = (id: string): DecisionProvider | undefined => PROVIDERS.get(id);
export const decisionProviders = (): DecisionProvider[] => [...PROVIDERS.values()];

/** After a decision model is chosen without its key: what happens meanwhile, and where to fill it in: the web page's
 * 密钥 page (s23g2), or the terminal, which asks for the key without echoing it, so it stays out of the shell history
 * and of files. A keystore that cannot be read is not a missing key: filling one in would hit the same error, so it
 * says where to see that error. */
export function keyMissingText(m: { displayName: string; keyId: string; keyUnreadable?: boolean }): string {
  const meanwhile = '要判断的消息按出错处理（没 @ Bot 的不回，@ 的回在主区）';
  return m.keyUnreadable
    ? `读不了密钥库，看不出填没填 ${m.displayName} 的 key，读得了之前${meanwhile}。原因在网页状态与诊断页底部的 daemon 日志（secrets.unreadable），或者在终端运行 vonvon secrets list 看`
    : `还没填 ${m.displayName} 的 key，填之前${meanwhile}。在网页的密钥页填，或者在终端运行 vonvon secrets set ${m.keyId}，按提示粘贴`;
}

// The decision question of the Jev report's Chinese runs, word for word (2.1: 30/31 right with four more questions,
// 19/20 asked alone); the `bot_name` and `topic_title` it names are decisionBody's state keys.
const SKIP = '不回：闲聊、寒暄、"好的""收到"这类话；说给别人的话；别人已经在处理或答过；bot 说不出新的有用的东西；拿不准';
/** The options in JUDGE_ALLOWED's order, 不回 first: a Choice leans to the options asked first. */
const QUESTIONS: Record<JudgeVariant, { question: string; criteria: Partial<Record<JudgeDecision, string>> }> = {
  main: {
    question: '`new_message` 发在群主区，没有点名谁。按 `rules`，bot（`bot_name`）该怎么处理它？',
    criteria: {
      skip: SKIP,
      main: '在主区回：需要 bot 回应，接着主区正在聊的事，或者一两句就能答完',
      topic: '开新话题回：需要 bot 回应，而且是一件新的事，要来回好几轮，或者要查、要改、要写东西',
    },
  },
  mentioned: {
    question: '`new_message` 在群主区点名了 bot（`bot_name`），bot 一定要回。按 `rules`，回在哪里？',
    criteria: {
      main: '在主区回：接着主区正在聊的事，或者一两句就能答完',
      topic: '开新话题回：一件新的事，要来回好几轮，或者要查、要改、要写东西',
    },
  },
  topic: {
    question: '`new_message` 发在话题 `topic_title` 里，要回就回在这个话题里。按 `rules`，bot（`bot_name`）回不回？',
    criteria: {
      skip: SKIP,
      reply: '回：有人在问问题、请人帮忙、讨论 bot 能帮上的事，或者接着 bot 刚才的话，或者想听 bot 的意见',
    },
  },
};
/** The anchor question of the report's five (35/36 right): m0 and up to 4 earlier lines, each "who：its first 40 characters". */
const ANCHOR_QUESTION = '群里哪一条消息是在等 bot（`bot_name`）回应的？';
const ANCHOR_OPTIONS = 4;
const SPEAKER_TYPE = { user: 'person', bot: 'other_bot', self: 'this_bot' } as const;
const LABELS: Record<JudgeDecision, string> = { skip: '不回', main: '主区', topic: '开话题', reply: '回' };

interface StateLine {
  id: string; time: string; speaker: string; speaker_type: (typeof SPEAKER_TYPE)[keyof typeof SPEAKER_TYPE]; text: string;
  mentions?: string[]; quote?: { speaker: string; text: string };
}
interface Choice { type: 'choice'; instructions: string | { rules: string; question: string }; criteria: Record<string, string> }
export interface DecisionBody {
  model: string;
  state: {
    group: string; bot_name: string; bot_role?: string; topic_title?: string;
    recent_messages: StateLine[]; new_message: StateLine;
  };
  questions: { decision: Choice; anchor?: Choice };
}

const snippet = (line: StateLine): string => {
  const chars = [...line.text];
  return `${line.speaker}：${chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : line.text}`;
};

/**
 * One judgement's request (s23f 做法（问法）): SMART.md as the rules, the variant's Choice, and in the main variant
 * the anchor. The lines and their m-numbers are the text input's (shownContext, same cuts and cleaning), so an anchor
 * names the same message whichever kind of model judged (s25b). Built in memory only, never logged.
 */
export function decisionBody(req: Pick<JudgeRequest, 'variant' | 'botName' | 'group' | 'persona' | 'topicTitle' | 'context' | 'message'>, rules: string, model: string): DecisionBody {
  const bot = oneLine(req.botName);
  const entry = (id: string, line: JudgeLine, max: number): StateLine => {
    const { time, speaker, text, ...more } = lineFields(line, max);
    return { id, time, speaker: speaker ?? bot, speaker_type: SPEAKER_TYPE[line.from], text, ...more };
  };
  // newest first, as numbered
  const recent = shownContext(req.context).map(({ line }, i) => ({ line, item: entry(`m${i + 1}`, line, JUDGE_INPUT_LIMITS.lineChars) }));
  const message = entry('m0', req.message, JUDGE_INPUT_LIMITS.messageChars);
  const persona = req.persona?.trim();
  const topic = req.variant === 'topic' ? req.topicTitle?.trim() : undefined;
  const { question, criteria } = QUESTIONS[req.variant];
  const body: DecisionBody = {
    model,
    state: {
      group: oneLine(req.group.name, 100),
      bot_name: bot,
      ...(persona ? { bot_role: plainText(persona, JUDGE_INPUT_LIMITS.personaChars) } : {}),
      ...(topic ? { topic_title: oneLine(topic, 100) } : {}),
      recent_messages: recent.map(({ item }) => item).reverse(),
      new_message: message,
    },
    questions: { decision: { type: 'choice', instructions: { rules, question }, criteria: criteria as Record<string, string> } },
  };
  if (req.variant === 'main') {
    // Only lines a topic may open under (handle-message anchorLine): a person's, with an id, naming no one.
    const options = recent.filter(({ line }) => line.from === 'user' && line.id && !line.named && !line.mentions?.length).slice(0, ANCHOR_OPTIONS);
    if (options.length) {
      body.questions.anchor = { type: 'choice', instructions: ANCHOR_QUESTION, criteria: Object.fromEntries([message, ...options.map(({ item }) => item)].map((line) => [line.id, snippet(line)])) };
    }
  }
  return body;
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
const isShare = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export type DecisionAnswer =
  | {
    decision: JudgeDecision; reason: string; confidence: number;
    /** the anchor's m-number, unset for m0 or none */
    anchor?: number;
    /** what an answer got wrong that the verdict survives: info lines */
    notes: string[];
    providerModel?: string; inputTokens?: number; outputTokens?: number;
  }
  | { why: 'no-decision' | 'no-probabilities' | 'unknown-option' | 'bad-number' };

/**
 * The decision of an answer (s23f 做法（原因和把握度）): the highest probability, ties to the option asked first
 * (the one leaning to 不回), whatever `choice` says; the reason written from the probabilities. Never keeps any text
 * of the answer but the model's version.
 */
export function readDecision(sent: DecisionBody, variant: JudgeVariant, label: string, reply: unknown): DecisionAnswer {
  const body = asObject(reply);
  const answers = asObject(body?.answers);
  const decision = asObject(answers?.decision);
  if (!decision) return { why: 'no-decision' };
  const p = asObject(decision.probabilities);
  if (!p) return { why: 'no-probabilities' };
  const options = JUDGE_ALLOWED[variant];
  const keys = Object.keys(p);
  if (keys.length !== options.length || !options.every((o) => Object.hasOwn(p, o))) return { why: 'unknown-option' };
  if (!options.every((o) => isShare(p[o]))) return { why: 'bad-number' };
  const share = (o: JudgeDecision): number => p[o] as number;
  const best = options.reduce((a, b) => (share(b) > share(a) ? b : a));
  const notes: string[] = [];
  if (decision.choice !== best) notes.push('choice-mismatch');
  const sum = options.reduce((total, o) => total + share(o), 0);
  if (Math.abs(sum - 1) > 0.02) notes.push('probabilities-sum');
  const n = options.length;
  // worked out as the service does (Jev report 第 1 节), to its two decimals
  const confidence = isShare(decision.confidence) ? decision.confidence : Math.round(Math.min(1, Math.max(0, (share(best) - 1 / n) / (1 - 1 / n))) * 100) / 100;
  const reason = `${label}：${options.map((o) => `${LABELS[o]} ${share(o).toFixed(2)}`).join('、')}（把握度 ${confidence.toFixed(2)}）`;
  // an anchor not among the options sent is dropped, not the verdict (as s25b's text answers)
  let anchor: number | undefined;
  if (sent.questions.anchor) {
    const choice = asObject(answers?.anchor)?.choice;
    if (typeof choice === 'string' && Object.hasOwn(sent.questions.anchor.criteria, choice)) anchor = Number(choice.slice(1)) || undefined;
    else notes.push('anchor-invalid');
  }
  const usage = asObject(body?.usage);
  const providerModel = typeof body?.model === 'string' ? body.model.replace(/[^\w.-]/g, '').slice(0, 40) : '';
  const inputTokens = count(usage?.input_tokens);
  const outputTokens = count(usage?.output_tokens);
  return {
    decision: best, reason, confidence, ...(anchor ? { anchor } : {}), notes,
    ...(providerModel ? { providerModel } : {}), ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

/** What `settings get judge` shows in place of the format lines when a decision model judges (read only, 3.4). */
export const DECISION_FORMAT_LINES: Record<JudgeVariant, string> = Object.fromEntries(
  (Object.keys(QUESTIONS) as JudgeVariant[]).map((variant) => [variant, [
    JUDGE_FORMAT_HEADER,
    '决策模型不读格式行：上面的提示词作为 rules 发给它，程序问它一道选择题，取概率最高的一项。',
    `问题：${QUESTIONS[variant].question}`,
    ...Object.entries(QUESTIONS[variant].criteria).map(([option, text]) => `${option}：${text}`),
    ...(variant === 'main' ? [`另问一题锚点：${ANCHOR_QUESTION}选项是 m0（它自己）和前面最近 ${ANCHOR_OPTIONS} 条真人发的、没 @ 人的消息。`] : []),
  ].join('\n')]),
) as Record<JudgeVariant, string>;

/** The state a decision model is given, filled with the sample data of JUDGE_INPUT_EXAMPLE. */
export const DECISION_INPUT_EXAMPLE = `${JSON.stringify(decisionBody(JUDGE_INPUT_EXAMPLE_REQUEST, '', 'jev-latest').state, null, 2)}\n${JUDGE_INPUT_BOUNDS}`;
