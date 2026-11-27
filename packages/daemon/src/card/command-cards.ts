import { MODEL_ID_MAX_LENGTH } from '../agent/model-id';
import type { ModelInfo, ReasoningEffort, ServiceTier, ThreadSummary } from '../agent/types';
import { getSessionTitleEfforts } from '../config/schema';
import { stripBridgeMessageEnvelope } from '../bot/session-title';
import type { SessionMode } from '../project/registry';
import {
  actions,
  button,
  card,
  form,
  hr,
  input,
  linkButton,
  md,
  note,
  selectStatic,
  submitButton,
  type CardElement,
  type CardObject,
} from './cards';

/** Action ids for the `/model` card. */
export const MC = {
  model: 'model.set',
  effort: 'model.effort',
  speed: 'model.speed',
  speedOpen: 'model.speed.open',
  custom: 'model.custom',
} as const;

/** Action ids for the `/resume` card. */
export const RES = {
  pick: 'resume.pick',
} as const;

export const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  none: '无',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultra: '超强',
};

/** Keep model cards forward-compatible when Codex adds a new effort tier. */
export function reasoningEffortLabel(effort: string): string {
  return EFFORT_LABEL[effort as ReasoningEffort] ?? (effort || '未知');
}

// ── /model ────────────────────────────────────────────────────────────────

/** Server-side state for a pending `/model` card, keyed by its messageId. */
export interface ModelCardState {
  /** Explicit group allowsets disable the legacy free-form model escape hatch. */
  allowCustom?: boolean;
  chatId: string;
  /** the topic (session) whose model/effort this card edits */
  threadId: string;
  requesterOpenId: string;
  models: ModelInfo[];
  model: string;
  modelCustom?: boolean;
  effort: ReasoningEffort;
  serviceTier?: ServiceTier;
  /** the backend whose models this card lists（写回会话前复核，防跨后端把一个后端的
   * model id 持久化进另一后端的会话——resume 时会喂坏 CLI）。旧卡缺省。 */
  backend?: string;
  /** where the card was posted: a hand-typed id is a form submit, which locks the
   * card, so the result goes out as a new card in the same place. 旧卡缺省。 */
  replyTo?: string;
  inThread?: boolean;
  createdAt: number;
  /** transient confirmation line */
  note?: string;
}

/** A model id inside inline code. Hand-typed ids are checked by parseModelId;
 * older stored values only lose backticks so they cannot break out. */
export function modelIdCode(id: string): string {
  return `\`${id.replace(/`/g, '')}\``;
}

export function serviceTierLabel(tier?: ServiceTier): string {
  return tier === 'ultrafast' ? 'Ultrafast · 极速' : tier === 'fast' ? 'Fast · 快速' : tier === 'standard' ? 'Standard · 普通' : 'Codex 默认';
}

/**
 * The `/model` card —— **按后端能力自适应**，对齐 Codex 的诚实体验：
 *   - 只在「当前模型真的有 supportedEfforts」时才显示 effort 下拉（没有就不显示，不
 *     回退成点了没用的假 low/medium/high）。
 *   - 只在「有多个可见模型」时才显示模型下拉（单模型用文字呈现，不给只有一项的下拉）。
 *   - 既不能切模型也不能调 effort 的后端 → 只显示当前模型。
 *   - 总有一个「手填模型 ID」表单（3.11）：列表里没有的模型（第三方网关的）照样能用。
 *     当前模型是手填的（不在列表里）时，effort 下拉给后端协议的全部档位。
 * 能调的给控件、不能调的给清晰说明（不静默、不造假）。
 */
export function buildModelCard(state: ModelCardState): CardObject {
  const visible = state.models.filter((m) => !m.hidden);
  const cur = state.models.find((m) => m.id === state.model);
  const efforts = cur ? cur.supportedEfforts : [...getSessionTitleEfforts(state.backend ?? '')];
  const canPickModel = visible.length > 1;
  const canPickEffort = efforts.length > 0;
  const curLabel = cur ? `**${cur.displayName}**` : `${modelIdCode(state.model)}（手填）`;
  const supported = cur?.serviceTiers ?? [];
  const showSpeed = state.backend === 'codex-appserver' && !state.modelCustom
    && supported.some(item => item.id === 'fast' || item.id === 'ultrafast');
  const currentSpeed = state.serviceTier && supported.some(item => item.id === state.serviceTier)
    ? state.serviceTier : 'standard';
  const speedButton = showSpeed
    ? {
      tag: 'button', size: 'medium', type: 'text', width: 'fill',
      icon: { tag: 'standard_icon', token: 'speed_filled', color: currentSpeed === 'standard' ? 'grey-400' : currentSpeed === 'fast' ? 'yellow' : 'orange' },
      hover_tips: { tag: 'plain_text', content: `响应速度：${serviceTierLabel(currentSpeed)}；点击切换。Fast / Ultrafast 消耗更多额度。` },
      behaviors: [{ type: 'callback', value: { a: MC.speedOpen } }],
    }
    : undefined;

  // Reserve an icon-sized column so long model/effort labels cannot squeeze it.
  // Native icon-only buttons have no label to truncate into an adjacent ellipsis.
  const controlsRow = (controls: CardElement[]): CardElement => speedButton ? {
    tag: 'column_set', flex_mode: 'none', horizontal_spacing: 'small',
    columns: [
      ...controls.map(control => ({
        tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
        elements: [{ ...control, ...(control.tag === 'select_static' ? { width: 'fill' } : {}) }],
      })),
      { tag: 'column', width: '32px', vertical_align: 'center', elements: [speedButton] },
    ],
  } : actions(controls);

  const elements: CardElement[] = [md('🧠 **模型 / 推理强度**')];

  if (canPickModel || canPickEffort) {
    elements.push(note('选择后下一轮生效'), hr());
    // 手填的 id 不在下拉里，下拉会显示占位文字，所以单独写出当前模型。
    if (!cur) elements.push(md(`当前模型：${curLabel}`));
    const controls: CardElement[] = [];
    if (canPickModel) {
      controls.push(
        selectStatic({
          actionId: MC.model,
          placeholder: '选择模型',
          // 手填的 id 不在选项里，不当初值（上面单独写出了当前模型）
          initial: cur ? state.model : undefined,
          options: visible.map((m) => ({ label: m.displayName, value: m.id })),
        }),
      );
    }
    if (canPickEffort) {
      controls.push(
        selectStatic({
          actionId: MC.effort,
          placeholder: 'effort',
          initial: state.effort,
          options: efforts.map((e) => ({ label: `effort：${reasoningEffortLabel(e)}`, value: e })),
        }),
      );
    }
    elements.push(controlsRow(controls));
    // 只有一个维度可调时，给另一维度一句说明（避免「为什么只有一个下拉」的困惑）。
    if (canPickModel && !canPickEffort) {
      elements.push(note('该后端不调节推理强度（思考由模型自动调度，无 Codex 那样的 effort 档）'));
    }
  } else {
    elements.push(hr(), speedButton ? controlsRow([md(`当前模型：${curLabel}`)]) : md(`当前模型：${curLabel}`));
  }

  if (state.allowCustom !== false) elements.push(
    hr(),
    form('model_custom', [
      input({
        name: 'customModel',
        label: '手填模型 ID',
        placeholder: '列表里没有的模型，例如 deepseek-chat',
        value: cur ? undefined : state.model,
        maxLength: MODEL_ID_MAX_LENGTH,
        width: 'fill',
      }),
      actions([submitButton('用这个模型', { a: MC.custom }, 'default', 'submit_model_custom')]),
    ]),
    note('填错了，下一轮会报错；再发 /model 改回来。'),
  );

  if (state.note) elements.push(note(state.note));
  return card(elements, { summary: '模型设置' });
}

// ── /resume ─────────────────────────────────────────────────────────────────

/** Server-side state for a pending `/resume` card, keyed by its messageId. */
export interface ResumeCardState {
  chatId: string;
  /** the `@bot /resume` message — reply_in_thread to it creates the topic */
  originalMsgId: string;
  requesterOpenId: string;
  cwd: string;
  projectName?: string;
  /** agent backend id the sessions were listed from — rides each pick button's
   * callback value (`b`) so the resume stays on the same backend. Unset on
   * legacy state → default (codex). */
  backend?: string;
  threads: ThreadSummary[];
  /** Sessions of this cwd left off {@link threads}: another place of the group holds them (s15f). */
  inUse?: number;
  /** Where they are held, by place, e.g. `主区、话题「…」` (s15f): titles, never ids. */
  inUseAt?: string;
  createdAt: number;
  /** in-flight guard (anti double-click) */
  launching?: boolean;
  /** single-session group: resume IN PLACE (no new topic) —— pick rebinds the
   * group's session key flat instead of reply_in_thread-ing a new topic. */
  flat?: boolean;
  /** single-session group only: the session key (chatId / chatId#role) to rebind
   * on pick. Set together with {@link flat}. */
  sessionKey?: string;
}

/** Max length of the session title shown inside a picker button. */
const RESUME_TITLE_MAX = 30;

/**
 * The `/resume` card: recent codex threads under this cwd. Each thread is ONE
 * button labeled `↩️ <time> · <title>` (time first, title truncated to one line)
 * — modeled on codex's own `resume` TUI — so it's unambiguous which button
 * resumes which session even when titles are long, messy, or repeated. Same-
 * title sessions are told apart by the minute-precise timestamp.
 */
export function buildResumeCard(state: ResumeCardState): CardObject {
  const elements = [md('🕘 **恢复历史会话**'), note(metaNote(state)), hr()];
  const where = state.inUseAt ? `：${state.inUseAt}` : '';
  const inUse = state.inUse ? `另有 ${state.inUse} 条在本群别处用着，没有列出${where}。` : '';
  if (state.threads.length === 0) {
    elements.push(md(state.inUse
      ? `_该目录下的 ${state.inUse} 条历史会话都在本群别处用着${where}。到那里接着聊，或直接 @我 新建。_`
      : '_该目录下还没有历史会话。直接 @我 即可新建。_'));
  } else {
    elements.push(
      note(
        (state.flat
          ? '点一条即切回 —— 就地继续，不另起话题。'
          : '点一条即恢复 —— 在新话题里打开历史、可直接继续。') + inUse,
      ),
    );
    for (const t of state.threads) {
      // An unnamed session's preview is its first prompt as woven: keep only the
      // person's words. The name goes through the same stripping, as on the desktop list.
      const title = (stripBridgeMessageEnvelope(t.name ?? '').trim() || stripBridgeMessageEnvelope(t.preview).trim() || '(无摘要)').replace(/\s+/g, ' ');
      const label = `↩️ ${pickerTime(t.updatedAt || t.createdAt)} · ${truncate(title, RESUME_TITLE_MAX)}`;
      elements.push(actions([button(label, { a: RES.pick, t: t.sessionId, ...(state.backend ? { b: state.backend } : {}) })]));
    }
  }
  return card(elements, { summary: '恢复历史会话' });
}

/** Transient "resuming…" card — interactive controls removed (anti double-click). */
export function buildResumeLaunchingCard(state: ResumeCardState): CardObject {
  return card([md('⏳ 正在恢复历史会话…'), note(metaNote(state))], { summary: '恢复中' });
}

/** Terminal success card — resumed as a new topic (multi) or switched in place
 * (single, `flat`). */
export function buildResumeDoneCard(state: ResumeCardState): CardObject {
  const line = state.flat
    ? '↩️ 已切回 —— 就地继续，上面的历史消息保留。'
    : '✅ 已恢复 —— 已在上方新话题打开，可直接继续。';
  return card([md(line), note(metaNote(state))], { summary: '已恢复' });
}

// ── /clear ────────────────────────────────────────────────────────────────

/**
 * The `/clear` card (single-session groups only) — posted AFTER the group's
 * session is repointed to a fresh backend thread. It reassures on the one thing
 * Feishu can't do: the visible chat history above is NOT deleted — the agent
 * just stops reading it. The parked session stays on disk and is resumable via
 * `/resume`, so an accidental `/clear` is fully recoverable.
 */
export function buildClearedCard(): CardObject {
  return card(
    [
      md('🧹 **已开启全新会话**'),
      md('✅ 上下文已清空 —— 我从这里重新开始，不再参考上面的对话。'),
      md('💬 飞书聊天记录不受影响 —— 上面的消息都还在，只是我不再读取它们。'),
      md('🗂️ 刚才那段已归档 —— 发 `/resume` 随时切回继续。'),
    ],
    { summary: '已清空上下文' },
  );
}

/** Failure card after a failed resume launch. */
export function buildResumeErrorCard(state: ResumeCardState, message: string): CardObject {
  return card([md(`❌ 恢复失败：${truncate(message, 200)}`), note(metaNote(state))], { summary: '恢复失败' });
}

function metaNote(state: { cwd: string; projectName?: string }): string {
  const parts = [`📂 \`${state.cwd}\``];
  if (state.projectName) parts.unshift(`📁 ${state.projectName}`);
  return parts.join('   ');
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Coarse relative time from a unix-seconds (or millis) timestamp. */
export function relativeTime(unixSeconds: number): string {
  if (!unixSeconds) return '未知时间';
  const ms = unixSeconds < 1e12 ? unixSeconds * 1000 : unixSeconds;
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}

/**
 * Timestamp for the resume picker buttons: friendly for recent sessions,
 * minute-precise (absolute) for older ones so same-title sessions stay
 * distinguishable (coarse "20 天前" would collide on duplicates).
 */
export function pickerTime(unixSeconds: number): string {
  if (!unixSeconds) return '未知时间';
  const ms = unixSeconds < 1e12 ? unixSeconds * 1000 : unixSeconds;
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const d = new Date(ms);
  const now = new Date();
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `今天 ${hm}`;
  const md = `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
}

// ── /help & 建群欢迎卡 ────────────────────────────────────────────────────────

/** Where the user is when they ask for help — drives which commands we list. */
export type HelpScope = 'main' | 'topic' | 'single';

/** First bullet describing how to talk to the bot, honoring the group's
 * effective 免@ state so the card never promises免@ when it's actually off
 * (e.g. a joined single-session group, which defaults off). */
function talkLine(noMention: boolean, tail: string): string {
  return noMention
    ? `· 直接发消息（免@）→ ${tail}`
    : `· **@我 + 内容** → ${tail}（本群默认需 @）`;
}

/** What 选了智能 tells the group (3.4): the welcome card's first line when it is bound so, and a plain message
 * when the web switches a group to it (s25c). */
export const SMART_NOTICE = '我会读群消息，合适时接话。';
export const DEFAULT_WELCOME_CARD_TITLE = '🤖 本群使用说明';
export const DEFAULT_WELCOME_CARD_INTRO = '👋 **你的助手来了！~神奇田螺**';

export interface WelcomeCardCopy {
  title?: string;
  intro?: string;
}

export function resolveWelcomeCardCopy(copy?: WelcomeCardCopy): { title: string; intro: string } {
  return {
    title: copy?.title?.trim() || DEFAULT_WELCOME_CARD_TITLE,
    intro: copy?.intro?.trim() || DEFAULT_WELCOME_CARD_INTRO,
  };
}

/** How to talk to a group. 智能 has no 免@ and a judgement decides every message, an @ too: an @ is judged at once
 * and may get no answer; only a judgement that fails or times out answers it anyway (3.4, owner 2026-10-19). So the
 * card promises a look, not an answer (s25, s25c). */
function talkLines(kind: SessionMode, noMention: boolean, tail: string, smartTail: string): string[] {
  return kind === 'smart' ? [`· 直接说话 → ${smartTail}`, '· **@我 + 内容** → 我马上看，该回就回'] : [talkLine(noMention, tail)];
}

/** 后端能力（只取 /help 关心的三项）。undefined ⇒ 全支持（codex 不声明
 * capabilities，约定 undefined=全能；不支持某命令的后端显式标 false）。 */
export interface HelpCaps {
  goal?: boolean;
  compact?: boolean;
  resume?: boolean;
}

/** The `/help` card: commands available **right here** (this exact scope).
 * `noMention` is the group's effective 免@ state (`noMention ?? defaultNoMention`).
 * `isAdmin` gates the owner-only commands (`/resume`、`/new`): non-admins
 * don't see them listed (they'd be denied anyway — see handle-message 的门控).
 * `caps` 按会话后端能力裁剪：不支持 /goal、/compact、/resume 的后端
 * （能力守卫会拒），就不在速查卡里列出来——避免「列了点了才发现不支持」的不一致。
 * 缺省（undefined 或不传）= 全列（codex 行为，向后兼容）。`kind` 是群的会话方式：
 * 单会话和智能的话题里，新会话在主区的消息下开（s15）；智能没有免@（s25c）。 */
/** Only a private chat has `/menu` (dm-agent 5). */
const MENU_LINE = '· `/menu` → 常用入口：新建项目、项目列表、设置、用量、诊断、重启、更新';
export function buildHelpCard(scope: HelpScope, noMention = true, isAdmin = false, caps?: HelpCaps, kind: SessionMode = 'multi', dm = false): CardObject {
  const showGoal = caps?.goal ?? true;
  const showCompact = caps?.compact ?? true;
  const showResume = caps?.resume ?? true;
  const goalLine = '· `/goal <目标>` → 自主多轮跑到完成（卡上 ⏹ 终止 / 🎯 结束目标）';
  const compactLine = '· `/compact` → 压缩上下文（正忙时等这一轮结束再压）';

  const elements: CardElement[] = [];
  if (scope === 'single') {
    const lines = talkLines(kind, noMention, '交给我处理', '我看情况接话或开话题');
    if (showGoal) lines.push(goalLine);
    lines.push('· `/model` → 切换模型 / 推理强度', '· `/context` → 看上下文占比');
    if (showCompact) lines.push(compactLine);
    if (isAdmin) lines.push(`· \`/new\`（或 \`/clear\`）→ 换一条新会话${showResume ? '，旧的能 `/resume` 回来' : ''}（飞书消息保留）`);
    if (isAdmin && showResume) lines.push('· `/resume` → 切回历史会话');
    if (dm) lines.push(MENU_LINE);
    lines.push('· `/help` → 这张速查卡');
    const head = dm ? '💬 **私聊** — 直接跟我说就行。主区一条会话，上下文一直连着。'
      : kind === 'smart' ? `💬 **智能开话题** — 不用 @ 我，${SMART_NOTICE}主区一条会话；聊到新的事，我自己开话题。` : '💬 **整群一条会话** — 主区一条会话，上下文一直连着。';
    elements.push(md(head), hr(), md(lines.join('\n')));
  } else if (scope === 'topic') {
    const lines = talkLines(kind, noMention, '继续当前会话', '我看情况回');
    if (showGoal) lines.push(goalLine);
    lines.push('· `/model` → 切换模型 / 推理强度', '· `/context` → 看上下文占比');
    if (showCompact) lines.push(compactLine);
    if (dm) lines.push(MENU_LINE);
    lines.push('· `/help` → 这张速查卡');
    elements.push(
      md('🧵 **话题内** — 每个话题是一个独立会话。'),
      hr(),
      md(lines.join('\n')),
      note(kind !== 'multi' ? '要新的会话，就在主区的某条消息下开一个新话题。' : '开新话题：回到主群区 @我 + 内容。'),
    );
  } else {
    const lines = ['· **@我 + 内容** → 开一个新话题并开始'];
    if (showGoal) lines.push(goalLine);
    if (isAdmin && showResume) lines.push('· `/resume` → 恢复历史会话');
    lines.push('· `/model` → 需要在话题里用', '· `/help` → 这张速查卡');
    elements.push(md('👥 **主群区** — @我开话题，每个话题是独立会话。'), hr(), md(lines.join('\n')));
  }
  return card(elements, { header: { title: '🤖 可用命令', template: 'blue' }, summary: '可用命令' });
}

/**
 * Welcome card posted when a project group is created or a group is bound — a
 * full overview of every command this group supports, keyed off its session
 * kind. `noMention` is the group's effective 免@ state (so a joined
 * single-session group, which defaults off, doesn't promise免@). Adds a
 * "查看完整手册" link button when a doc URL is configured.
 */
/**
 * 欢迎卡按会话后端能力裁剪命令（与 {@link buildHelpCard} 同源 caps）：不支持
 * /goal /compact /resume 的后端就不在欢迎卡里列；codex（caps undefined ⇒ 全 true）
 * 保持全列。避免用户第一眼的「使用说明」就推销点了不支持的命令。
 */
export function buildWelcomeCard(
  kind: SessionMode,
  docUrl?: string,
  noMention = true,
  caps?: HelpCaps,
  /** Kept for call-site compatibility; the welcome greeting is no longer backend-specific. */
  _agentName = 'Codex',
  copy?: WelcomeCardCopy,
): CardObject {
  const showGoal = caps?.goal ?? true;
  const showCompact = caps?.compact ?? true;
  const showResume = caps?.resume ?? true;
  const welcome = resolveWelcomeCardCopy(copy);
  const goalLine = '· `/goal <目标>` → 自主多轮跑到完成（卡上 ⏹ 终止 / 🎯 结束目标）';
  // /context 总在；/compact 仅后端支持时合并进同一行。
  const ctxLine = showCompact ? '· `/context` · `/compact` → 看 / 压缩上下文' : '· `/context` → 看上下文占比';
  const elements: CardElement[] = [
    md(welcome.intro),
    hr(),
  ];
  if (kind !== 'multi') {
    elements.push(
      // 智能's first line is what 选了智能 tells the group, merged with how its main area runs (s25c).
      md(kind === 'smart' ? `💬 **智能开话题** — 不用 @ 我，${SMART_NOTICE}主区一条会话；聊到新的事，我自己开话题。` : '💬 **整群一条会话**（主区一条会话，上下文一直连着）'),
      md(
        [
          ...talkLines(kind, noMention, '交给我处理', '我看情况接话或开话题'),
          ...(showGoal ? [goalLine] : []),
          '· `/model` → 切换模型 / 推理强度',
          `· \`/new\`（或 \`/clear\`）→ 开新会话（管理员，${showResume ? '旧的能 `/resume` 回来，' : ''}飞书消息保留）`,
          ...(showResume ? ['· `/resume` → 切回历史会话（管理员）'] : []),
          '· `/help` → 命令速查卡',
        ].join('\n'),
      ),
    );
  } else {
    elements.push(
      md('👥 **主群区**'),
      md(
        [
          '· **@我 + 内容** → 开一个新话题并开始（一个话题一条会话）',
          ...(showGoal ? [goalLine] : []),
          ...(showResume ? ['· `/resume` → 恢复历史会话'] : []),
        ].join('\n'),
      ),
      md('🧵 **话题内**'),
      md([talkLine(noMention, '继续当前会话'), '· `/model` → 切换模型 / 推理强度', ctxLine].join('\n')),
      note('任意场景发 `/help` 看当前可用命令。'),
    );
  }
  if (docUrl) {
    elements.push(hr(), actions([linkButton('📖 查看完整使用手册', docUrl, 'primary')]));
  }
  return card(elements, { header: { title: welcome.title, template: 'turquoise' }, summary: welcome.title });
}
