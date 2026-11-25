import type { VoiceReply } from '../voice/types';
import { voiceReplyElements } from './voice-reply';
import {
  actions,
  button,
  card,
  md,
  noteMd,
  splitRow,
  type CardElement,
  type CardObject,
} from './cards';
import type { AgentErrorKind } from '../agent/error-kind';
import type { ReasoningEffort } from '../agent/types';
import type { StopReason } from '../host/lifecycle';
import type { Block, FooterStatus, RunState } from './run-state';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { renderRichText } from './markdown-render';
import { fileComponentCount, renderFileAnswer, type InlineFiles } from './inline-files';
import { hasMarkdownTable, renderReport } from './report-render';
import { StreamingImages } from './outbound-images';
import type { RunCardStream } from './run-card-stream';
import { buildSubagentSection } from './subagent-section';
import { processPanel } from './process-panel';
import { statusSymbol } from './process-status';
import {
  buildProcessBodyWithKinds,
  currentAnswerIndex,
  formatOverflowAttachmentMarkdown,
  processTitle,
  runElapsedMs,
  type OverflowAttachmentView,
} from './run-process';
import { blockKey } from './run-segment';
import { runCardMeter } from './context-gauge';
import { toolCommand } from '../environment/tool-command';
import { CARD_DISPLAY_REMINDER_EID, DEFAULT_REMINDER_TEMPLATE, DEFAULT_REMINDER_REQUESTED_TEMPLATE, compileCardDisplay, type CardDisplayLayoutParts, type CardDisplayValues, type CardDisplayConfig } from '@vonvon/protocol';

/** Action ids for the in-topic run card. */
export const RC = {
  stop: 'run.stop',
  stopSub: 'run.stopSub',
  subPage: 'run.subPage',
  /** manual completion-reminder mode: notify this turn's requester when it ends. */
  remind: 'run.remind',
  /** goal-only: clear the goal but let the in-flight turn finish (no auto-continue). */
  endGoal: 'goal.end',
  /** terminal card of a turn stopped by the idle watchdog or a network failure:
   * run the same message again. */
  retry: 'run.retry',
} as const;

/**
 * Stable element_id of the streamed answer markdown while RUNNING. The answer
 * text is pushed to this element via cardkit.v1.cardElement.content for the
 * native typewriter (see {@link ../card/run-card-stream}); everything else
 * (reasoning / tools / footer) rides whole-card updates. Must be stable across
 * re-renders so the typewriter sees an append-only prefix.
 */
export const ANSWER_EID = 'answer';

/**
 * Stable element_id of the run or queued card's control row. Lets
 * a post-restart orphan card self-heal on click: the in-process maps are gone
 * by then, so the handler can only recover the entity's card_id from the
 * carrier message and delete THIS element — the rest of the card is
 * unreconstructable (see healDeadRunCard in ../bot/handle-message).
 */
export const CONTROLS_EID = 'controls';

const PROCESS_COMPONENT_BUDGET = 120;

type StopControlPresentation = 'run' | 'goal' | 'queue';

const STOP_CONTROL: Record<StopControlPresentation, {
  readonly label?: string;
  readonly type: 'default' | 'primary';
  readonly icon: string;
  readonly iconColor: 'blue' | 'grey';
  readonly tooltip: string;
}> = {
  run: {
    type: 'primary',
    icon: 'stop-record_filled',
    iconColor: 'blue',
    tooltip: '停止生成',
  },
  goal: {
    type: 'primary',
    icon: 'stop-record_filled',
    iconColor: 'blue',
    tooltip: '立即停止并结束目标',
  },
  queue: {
    label: '取消排队',
    type: 'default',
    icon: 'close_outlined',
    iconColor: 'grey',
    tooltip: '取消排队',
  },
};

function stopControl(cardKey: string, presentation: StopControlPresentation): CardElement {
  const control = STOP_CONTROL[presentation];
  return {
    tag: 'button',
    ...(control.label ? { text: { tag: 'plain_text', content: control.label } } : {}),
    type: control.type,
    size: 'medium',
    width: 'default',
    icon: { tag: 'standard_icon', token: control.icon, color: control.iconColor },
    hover_tips: { tag: 'plain_text', content: control.tooltip },
    behaviors: [{ type: 'callback', value: { a: RC.stop, m: cardKey } }],
  };
}

function reminderControl(cardKey: string, requested: boolean): CardElement {
  return {
    tag:'button',element_id:CARD_DISPLAY_REMINDER_EID,
    text:{tag:'plain_text',content:requested ? DEFAULT_REMINDER_REQUESTED_TEMPLATE : DEFAULT_REMINDER_TEMPLATE},
    type:'default',size:'medium',width:'default',
    ...(requested ? {
      disabled:true,
      hover_tips:{tag:'plain_text',content:'本轮结束后会提醒发起人'},
    } : {behaviors:[{type:'callback',value:{a:RC.remind,m:cardKey}}]}),
  };
}

export type ContinuationReason = 'steer' | 'ask' | 'capacity' | 'answer';

/** Routing + render inputs for one run card. */
export interface RunCardState {
  cardDisplay?: CardDisplayConfig;
  cardDisplayValues?: Record<string, Record<string, unknown>>;
  strictCardDisplay?: boolean;
  askWaiting?: string;
  askWaitingSubagentId?: string;
  subagentsCarried?: true;
  subagentPage?: number;
  rs: RunState;
  /** This display segment ended because another card took over (`true` = steer). */
  continued?: boolean | ContinuationReason;
  /** Keep every block inside the process panel on terminal render (never pull an
   * intermediate progress text out as a final answer when freezing a process card). */
  processOnly?: boolean;
  /** Omit the process panel on standalone final-answer or answer-continuation cards. */
  answerOnly?: boolean;
  /** Render process blocks in full rich mode without compact output erasure or
   * omission so multi-card continuation can measure true card capacity. */
  unboundedProcess?: boolean;
  /** Oversized single items (tool / code block / table / long unbroken text)
   * keyed by blockKey -> attachment status & preview. */
  overflowAttachments?: ReadonlyMap<string, OverflowAttachmentView>;
  /** The first card of a turn the smart mode joined on its own (s25b): deleted when the turn ends with nothing to say.
   * A card a steer splits off is not. */
  initiativeCard?: true;
  /** Such a card that could not be deleted: one short line, nothing else. */
  emptyNote?: true;
  /** Independent of model text, preserved across live and terminal renders. */
  voiceMessages?: VoiceReply[];
  /** Identity for stop routing, using the card's own messageId. */
  cardKey?: string;
  /** topic thread id (known after the topic is created) */
  threadId?: string;
  /** Who started this run. Only they or an admin may stop it. */
  requesterOpenId?: string;
  /** drop tool blocks from the render (pref) */
  showTools?: boolean;
  /** model id for the bottom-right「模型 · 推理强度」footnote (e.g. 'gpt-5.5'); set
   * when 模型显示 is running OR always. Absent ⇒ no footnote (default / off). */
  model?: string;
  /** reasoning effort (推理强度) shown alongside {@link model}; colored by tier
   * (低黄/中绿/高浅紫/极高深紫). Only the 推理强度 word is tinted — the model name
   * stays grey. */
  effort?: ReasoningEffort;
  /** keep the footnote on the TERMINAL card too (模型显示 = always). Running cards
   * always show it when {@link model} is set; this only gates the terminal render
   * so the running-only(仅输出时) mode drops it once the turn finishes. */
  modelOnTerminal?: boolean;
  /** Suppress the stop control for non-goal cards that opt out of stopping. */
  hideStop?: boolean;
  /** Terminal-only handoff failures, unknown results, or ambiguous names. */
  handoffNotes?: string[];
  /** Present only in the global `manual` reminder mode. `available` renders the
   * one-shot “完成后提醒我” button; `requested` replaces it with a visible
   * confirmation. Non-manual modes leave this unset and therefore never expose
   * the per-turn button. */
  completionReminder?: 'available' | 'requested';
  /** Goal run cards show two controls: stop clears the goal and cuts output now,
   * and `🎯 结束目标` (clear goal, let the current turn finish, then stop). */
  goalControls?: boolean;
  /** After 结束目标 is tapped, the goal is cleared and this turn is finishing.
   * Drop the 结束目标 button, keep stop, and show a notice. */
  goalEnding?: boolean;
  /** `![](src) → image_key`, filled in by the turn's background uploader
   * ({@link ./outbound-images}.StreamingImages) as each ref resolves — so a
   * running card swaps its placeholder for a real `img` element mid-stream, and
   * the terminal card shows every image that made it. An unresolved ref renders
   * as text, never as raw `![](…)` markdown (see {@link renderRichText}). */
  images?: ReadonlyMap<string, string>;
  /** Prepared at terminal, before rendering can discard local link targets. */
  localFiles?: InlineFiles;
  /** One line at the top of the card when this turn was forced onto a new
   * session (resume failed, cwd changed). Kept on the terminal frame too. */
  sessionNotice?: string;
  /** Terminal cards only. `available` renders [重试] (needs {@link cardKey});
   * `sent` replaces it with a note once someone tapped it. */
  retry?: 'available' | 'sent';
  /** The run's backend id, so a login hint names the right command. */
  backend?: string;
  /** A scheduled run's small top line (`⏰ 定时任务「…」`), on the progress card and the final one. */
  label?: string;
  /** A scheduled run whose task runs again on schedule after a failure (nextRunAfterFailure): a network failure says so. */
  nextRun?: boolean;
  /** Cut short by a stop, restart or update of the server (owner 2026-11-02); `resend` when a person sent the message. */
  stopped?: { reason: StopReason; resend: boolean };
}

/**
 * The last line of a turn a stop, restart or update cut short (owner 2026-11-02). A person is asked for the message
 * again; once the server is back, a turn whose card did not get this line is asked about in the group (restart-dropped.ts).
 */
export function stoppedLine(stopped: { reason: StopReason; resend: boolean }): string {
  const what = stopped.reason === 'restart' ? '服务端重启了' : stopped.reason === 'update' ? '服务端升级了' : 'Bot 停止运行了';
  const again = !stopped.resend ? '' : stopped.reason === 'stop' ? '，等它恢复后请再发一次' : '，请再发一次';
  return `${what}，这一轮被中断${again}`;
}

/**
 * Wire a turn's background image uploader onto its run card.
 *
 * Two things have to happen together, and forgetting the first is invisible at
 * the terminal frame but glaring mid-turn:
 *
 *  1. `rc.images` must point at the worker's live map. The worker mutates that
 *     one map in place, so `buildRunCard(rc)` sees each `src → image_key` the
 *     moment it lands. Without it every repaint still renders the unresolved
 *     placeholder `🖼️ x.jpg（图片处理中…）`, and the picture only shows up in the
 *     terminal frame — i.e. the running card looks stuck even though the uploads
 *     all succeeded.
 *  2. A resolved key repaints the LIVE card ({@link RunCardStream.updateLiveCard}),
 *     which no-ops once the turn has been finalized, so a late upload can't fight
 *     the terminal frame.
 *
 * Lives next to {@link buildRunCard} because that is what it repaints with; the
 * uploader itself ({@link ./outbound-images}.StreamingImages) is injectable so a
 * test can drive this without a network or a codex process.
 */
export function attachRunImages(opts: {
  stream: Pick<RunCardStream, 'setImageWorker' | 'updateLiveCard'>;
  rc: RunCardState;
  channel: LarkChannel;
  /** `src[] → image_key`. Injected so this wiring is testable without a network;
   * production passes `(s) => uploadOutboundImages(channel, s, runCwd, mode, network)`
   * (see {@link ./outbound-images}). */
  upload: (sources: string[]) => Promise<Map<string, string>>;
}): StreamingImages {
  const { stream, rc, channel, upload } = opts;
  const worker = new StreamingImages(upload, () => {
    // The map is mutated in place, so the frame built below already carries every
    // key that has landed — including the ones that arrived before this repaint.
    rc.images = worker.images;
    void stream.updateLiveCard(channel, buildRunCard(rc)).catch(() => undefined);
  });
  // Point at the live map up-front too: any frame built from here on sees keys as
  // they arrive, without waiting for a repaint.
  rc.images = worker.images;
  stream.setImageWorker(worker, () => runningAnswerText(rc.rs));
  return worker;
}

/**
 * Render the ordered process and current answer using the restrained native
 * presentation adapted from vonvon-dsh. The process is expanded while running
 * and collapsed at terminal; tool details remain independently expandable.
 * The current answer keeps the native typewriter and existing rich media path.
 */
export function buildRunCard(rc: RunCardState): CardObject {
  if (!rc.cardDisplay || rc.emptyNote) return buildRunCardBase(rc).card;
  try {
    const {card,parts,values} = buildRunCardBase(rc);
    return compileCardDisplay(card,rc.cardDisplay,{phase:rc.rs.terminal === 'running' ? 'running' : 'done',values,scriptValues:rc.cardDisplayValues,parts,strict:rc.strictCardDisplay});
  } catch (error) {
    if (rc.strictCardDisplay) throw error;
    return buildRunCardBase({...rc,cardDisplay:undefined}).card;
  }
}

/** Native builder plus semantic positions; fixtures and production use the same parts. */
export function buildRunCardBase(rc: RunCardState): {card:CardObject;parts:CardDisplayLayoutParts;values:CardDisplayValues} {
  const state = rc.rs;
  const running = state.terminal === 'running';
  const elements = rc.emptyNote ? [noteMd('_（没有要补的）_')] : running ? renderRunning(state, rc) : renderTerminal(state, rc);
  const prefix = [...rc.label ? [noteMd(rc.label)] : [], ...voiceReplyElements(rc.voiceMessages)];
  const all = [...prefix,...elements];
  const index = (kind:RunCardPart) => {const found = all.findIndex(element => runCardParts.get(element) === kind);return found < 0 ? undefined : found;};
  const parts: CardDisplayLayoutParts = {contextIndex:index('context') ?? 0,processIndex:index('process'),statusIndex:index('footer'),modelIndex:index('footer'),controlsIndex:all.findIndex(element => element.element_id === CONTROLS_EID),reminderIndex:index('reminder'),answerIndices:all.flatMap((element,i) => runCardParts.get(element) === 'answer' ? [i] : []),subagentIndices:all.flatMap((element,i)=>runCardParts.get(element)==='subagent'?[i]:[])};
  const processElement = all[parts.processIndex ?? -1];
  if (processElement) parts.processChildKinds = runCardProcessKinds.get(processElement);
  const footerElement = all[parts.statusIndex ?? -1];
  if (footerElement) {
    const footerParts=runCardFooterParts.get(footerElement);
    parts.statusElement=footerParts?.status;
    parts.modelElement=footerParts?.model;
  }
  if (parts.controlsIndex !== undefined && parts.controlsIndex < 0) delete parts.controlsIndex;
  const summary = rc.continued === 'capacity'
    ? '已达单卡容量，继续处理'
    : rc.continued === 'answer'
      ? '过程已折叠，最终答复见下一张卡片'
      : rc.continued === 'ask'
        ? '已收到选择，继续处理'
        : rc.continued
          ? '已接收补充，继续处理'
          : summaryText(state);
  const result = card(all.map(runTypography), { streaming: running, summary });
  result.body = { ...(result.body as Record<string, unknown>), vertical_spacing: '16px' };
  const usage = state.usage;
  const pct = usage?.window ? Math.max(0,Math.min(100,Math.round(100*usage.used/usage.window))) : undefined;
  const k = (n:number) => n >= 1000 ? `${Math.round(n/1000)}k` : String(Math.round(n));
  const elapsed = runElapsedMs(state) ?? 0;
  const effortLabels:Record<string,string> = {none:'无',minimal:'极简',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最高',ultra:'超强'};
  const effortColors:Record<string,string> = {none:'grey',minimal:'grey',low:'yellow',medium:'green',high:'violet',xhigh:'purple',max:'purple',ultra:'purple'};
  const status = rc.askWaiting || state.awaitingSubagents ? '' : state.footer === 'tool_running' ? '正在调用工具' : state.footer === 'streaming' ? '正在输出' : state.footer === 'retrying' ? '瞬断，自动重试中…' : state.footer === 'thinking' ? '正在处理' : '';
  const values:CardDisplayValues = {context:{percent:pct,used:usage ? k(usage.used) : undefined,window:usage?.window ? k(usage.window) : undefined,mark:''},model:{name:rc.model ?? '',effort:rc.effort ? effortLabels[rc.effort] ?? rc.effort : '',effortColor:rc.effort ? effortColors[rc.effort] ?? 'grey' : 'grey'},elapsed:{label:running?'已处理':'用时',value:`${Math.max(0,Math.floor(elapsed/1000))}秒`},status:{label:status}};
  return {card:result,parts,values};
}

type RunCardPart = 'context'|'process'|'footer'|'answer'|'subagent'|'reminder';
const runCardParts = new WeakMap<CardElement,RunCardPart>();
const runCardProcessKinds = new WeakMap<CardElement,Array<'tool'|'thinking'|'other'>>();
const runCardFooterParts = new WeakMap<CardElement,{status?:CardElement;model?:CardElement}>();
const markRunPart = (element:CardElement,kind:RunCardPart):CardElement => {runCardParts.set(element,kind);return element;};
const markFooter = (element:CardElement,parts:{status?:CardElement;model?:CardElement}):CardElement => {markRunPart(element,'footer');runCardFooterParts.set(element,parts);return element;};

function runTypography(element: CardElement): CardElement {
  return {
    ...element,
    ...(element.tag === 'markdown' && !element.text_size ? { text_size: 'normal' } : {}),
    ...(Array.isArray(element.elements) ? { elements: element.elements.map(runTypography) } : {}),
  };
}

/** The ordered process stays above the current answer. Only the trailing text
 * item streams through ANSWER_EID; earlier progress text remains in the process.
 * Controls stay at the bottom and preserve their stable routing element id. */
// Process budgeting also counts each panel's header markdown and icon.
function sectionPanelOverhead(elements: CardElement[]): number {
  return elements.reduce((n, el) => n + (el.tag === 'collapsible_panel' ? 2 : 0)
    + (Array.isArray(el.elements) ? sectionPanelOverhead(el.elements) : 0), 0);
}

function subagentSection(state: RunState, rc: RunCardState) {
  if (rc.continued) return { elements: state.subagents.length ? [noteMd(`子 agent（${state.subagents.length} 个）接着显示在下一张卡`)] : [], components: state.subagents.length ? 1 : 0 };
  return buildSubagentSection({ rows: state.subagents, running: state.terminal === 'running', terminal: state.terminal,
    cardKey: state.terminal === 'running' ? rc.cardKey : undefined, carried: rc.subagentsCarried, page: rc.subagentPage,
    waiting: rc.askWaiting && rc.askWaitingSubagentId ? { subagentId: rc.askWaitingSubagentId, label: rc.askWaiting } : undefined });
}

/** Filter before capacity budgeting; the pure compiler repeats this for fixtures. */
function processBlockVisible(rc:RunCardState,kind:'tool'|'reasoning',running:boolean):boolean {
  if (!rc.cardDisplay) return kind !== 'tool' || rc.showTools !== false;
  const block=rc.cardDisplay.blocks.find(item=>item.kind===(kind==='tool'?'tools':'thinking'));
  return Boolean(block && (block.mode==='always'||block.mode===(running?'running':'done')));
}
function subagentsVisible(rc:RunCardState,running:boolean):boolean {
  if (!rc.cardDisplay) return rc.showTools!==false;
  if (rc.cardDisplay.reply?.streamText===false) return false;
  return processBlockVisible(rc,'tool',running);
}

function renderRunning(state: RunState, rc: RunCardState): CardElement[] {
  const section = subagentsVisible(rc,true) ? subagentSection(state, rc) : {elements:[],components:0};
  // The context meter heads every run card (s12), running and terminal.
  const elements: CardElement[] = [markRunPart(runCardMeter(state.usage),'context')];
  if (rc.sessionNotice) elements.push(noteMd(rc.sessionNotice));

  const answerIdx = rc.processOnly ? -1 : currentAnswerIndex(state.blocks);
  if (!rc.answerOnly) {
    const processBlocks = state.blocks.filter((b, i) => i !== answerIdx && (b.kind !== 'tool'||processBlockVisible(rc,'tool',true)) && (b.kind !== 'reasoning'||processBlockVisible(rc,'reasoning',true)));
    const process = buildProcessBodyWithKinds(
      processBlocks,
      rc.images,
      PROCESS_COMPONENT_BUDGET - section.components - sectionPanelOverhead(section.elements),
      true,
      { unbounded: rc.unboundedProcess, overflowAttachments: rc.overflowAttachments },
    );
    const title = processTitle(state.terminal, runElapsedMs(state));
    if (process.elements.length) {
      const panel = markRunPart(processPanel(title, process.elements, true, { titleColor: false }),'process');
      runCardProcessKinds.set(panel,process.kinds);
      elements.push(panel);
    }
    else if (state.startedAt !== undefined) elements.push(markRunPart(md(title),'process'));
  }
  elements.push(...section.elements.map(element=>markRunPart(element,'subagent')));
  const answerBlock = answerIdx >= 0 ? (state.blocks[answerIdx] as Extract<Block, { kind: 'text' }>) : undefined;
  const answerOverflow = answerBlock ? rc.overflowAttachments?.get(blockKey(answerBlock)) : undefined;
  const answer = answerOverflow ? formatOverflowAttachmentMarkdown(answerOverflow) : (answerBlock?.content ?? '');
  if (answer) {
    elements.push(...renderRichText(answer, rc.images, { streamTailId: ANSWER_EID, live: true }).map(element => markRunPart(element,'answer')));
  }

  // Footer: status (left) + 模型·effort footnote (right) share one row when the
  // 显示模型 pref is on; either alone falls back to a single line.
  const mEl = modelEl(rc);
  if (rc.askWaiting) elements.push(md(`${statusSymbol('waiting')} ${rc.askWaiting.replace(/^⏸️?\s*/u, '')}`));
  else if (state.awaitingSubagents) elements.push(md(`${statusSymbol('waiting')} 主回合已答完，等 ${state.subagents.filter(row => row.status === 'running').length} 个子 agent 结束`));
  else if (state.footer && mEl) {const status=footerStatus(state.footer);elements.push(markFooter(splitRow(status,mEl),{status,model:mEl}));}
  else if (state.footer) {const status=footerStatus(state.footer);elements.push(markFooter(status,{status}));}
  else if (mEl) elements.push(markFooter(mEl,{model:mEl}));

  // The controls row stays at the bottom, next to the newest output where the
  // reader is looking (tradeoff: a long stream may push it below the fold; see
  // the layout note above). CONTROLS_EID anchor is position-independent.
  if (rc.cardKey && rc.goalControls) {
    if (rc.goalEnding) {
      elements.push(noteMd('_🎯 目标已解除，本轮输出完成后停止_'));
      elements.push(actions([stopControl(rc.cardKey, 'run')], CONTROLS_EID));
    } else {
      // Goal: 终止 = clear goal + cut output now; 结束目标 = clear goal, let this
      // turn finish, then stop (no auto-continue). Both routed by the card's msgId.
      elements.push(
        actions(
          [
            stopControl(rc.cardKey, 'goal'),
            button('🎯 结束目标', { a: RC.endGoal, m: rc.cardKey }, 'default'),
          ],
          CONTROLS_EID,
        ),
      );
    }
  } else if (rc.cardKey) {
    // Ordinary turns only: the one-shot reminder is deliberately absent from
    // goal cards (goal has its own terminal summary) and from every non-manual
    // global strategy. Once tapped, keep the same footprint and disable the
    // button so confirmation never shifts the card or submits twice.
    const controls: CardElement[] = [];
    if (!rc.hideStop) {
      controls.push(stopControl(rc.cardKey, 'run'));
    }
    if (rc.completionReminder === 'available' || rc.completionReminder === 'requested') {
      controls.push(reminderControl(rc.cardKey, rc.completionReminder === 'requested'));
    }
    if (controls.length > 0) elements.push(actions(controls, CONTROLS_EID));
  }

  return elements;
}

/**
 * Terminal layout: fold the process (reasoning + tools + every non-final text
 * block) into one collapsed panel and surface only the final answer below it.
 * The final answer is the last non-empty text block (codex emits preamble /
 * progress messages before the real reply). Interrupt / error / timeout still
 * land here — whatever process happened folds away and the status note shows;
 * a partial answer (if any text streamed) stays visible above the note.
 */
function renderTerminal(state: RunState, rc: RunCardState): CardElement[] {
  const section = subagentsVisible(rc,false) ? subagentSection(state, rc) : {elements:[],components:0};
  const elements: CardElement[] = [markRunPart(runCardMeter(state.usage),'context')];
  if (rc.sessionNotice) elements.push(noteMd(rc.sessionNotice));

  const answerIdx = rc.processOnly ? -1 : lastTextIndex(state.blocks);
  const answerBlock = answerIdx >= 0 ? (state.blocks[answerIdx] as Extract<Block, { kind: 'text' }>) : undefined;
  const answerOverflow = answerBlock ? rc.overflowAttachments?.get(blockKey(answerBlock)) : undefined;
  const answer = rc.localFiles?.text ?? (answerOverflow ? formatOverflowAttachmentMarkdown(answerOverflow) : (answerBlock?.content.trim() ?? ''));
  const answerElements = rc.localFiles ? renderFileAnswer(rc.localFiles, rc.images)
    : hasMarkdownTable(answer) ? renderReport(answer, { images: rc.images }) : renderRichText(answer, rc.images);

  // Everything except the final answer block is "process". (A block after the
  // answer can only be a trailing tool call — keep it folded with the rest.)
  if (!rc.answerOnly) {
    const processBlocks = state.blocks.filter((_, i) => i !== answerIdx);
    const blocks = processBlocks.filter(b=>(b.kind!=='tool'||processBlockVisible(rc,'tool',false))&&(b.kind!=='reasoning'||processBlockVisible(rc,'reasoning',false)));
    const processBudget = rc.localFiles?.links.length
      ? Math.max(10, Math.min(PROCESS_COMPONENT_BUDGET, 170 - fileComponentCount(answerElements))) : PROCESS_COMPONENT_BUDGET;
    const processEls = buildProcessBodyWithKinds(
      blocks,
      rc.images,
      Math.max(10, processBudget - section.components - sectionPanelOverhead(section.elements)),
      false,
      { unbounded: rc.unboundedProcess, overflowAttachments: rc.overflowAttachments },
    );
    const title = processTitle(state.terminal, runElapsedMs(state));
    if (processEls.elements.length) {
      const panel = markRunPart(processPanel(title, processEls.elements, false, { titleColor: false }),'process');
      runCardProcessKinds.set(panel,processEls.kinds);
      elements.push(panel);
    }
    else if (state.startedAt !== undefined) elements.push(markRunPart(md(title),'process'));
  }

  elements.push(...section.elements.map(element=>markRunPart(element,'subagent')));

  // Terminal answer. A reply that TABLES its data goes through the report
  // renderer: card markdown has no tables, so `| a | b |` would otherwise show up
  // as raw pipes, and an image written inside a table can't be rendered there at
  // all (feishu's table nests nothing) — the report renderer hoists those to the
  // end as image pills. Everything else is the normal markdown path: uploaded
  // images become pills in place, and a ref that never resolved (path outside the
  // project, missing/oversized file, failed upload) renders as text — never raw
  // `![](…)`, which the client would resolve as a broken image node.
  if (answer) {
    elements.push(...answerElements.map(element => markRunPart(element,'answer')));
  }

  if (rc.continued === 'capacity') {
    elements.push(greyNote('已达单卡容量，后续内容见下一张卡片'));
  } else if (rc.continued === 'answer') {
    elements.push(greyNote('过程已折叠，最终答复见下一张卡片'));
  } else if (rc.continued === 'ask') {
    elements.push(greyNote('已收到选择，后续输出见下一张卡片'));
  } else if (rc.continued) {
    elements.push(noteMd('已接收补充，后续输出见下一张卡片'));
  } else if (state.terminal === 'interrupted') {
    elements.push(noteMd(`${statusSymbol('stopped')} ${rc.stopped ? stoppedLine(rc.stopped) : '已被中断'}`));
  } else if (state.terminal === 'idle_timeout') {
    elements.push(noteMd(`${statusSymbol('unknown')} ${failureText(state)}`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`${statusSymbol('failed')} ${failureText(state)}`));
    // Only a scheduled run's card has a label; its next run, if there is one, is the retry.
    const advice = errorAdvice(state.errorKind, rc.retry === 'available' && Boolean(rc.cardKey), rc.backend,
      rc.label === undefined ? undefined : { nextRun: rc.nextRun === true });
    if (advice) elements.push(noteMd(advice));
  } else if (state.terminal === 'done' && !answer) {
    elements.push(noteMd('_（未返回内容）_'));
  }
  if (rc.retry === 'sent') {
    elements.push(noteMd('已重试，结果见下一张卡片'));
  }

  for (const line of rc.handoffNotes ?? []) elements.push(greyNote(line));

  // 「模型 · 推理强度」footnote, bottom-right — only the always(始终) mode keeps it
  // on the terminal card; running(仅输出时) drops it once the turn ends.
  const mEl = rc.modelOnTerminal ? modelEl(rc) : null;
  if (mEl) elements.push(markFooter(mEl,{model:mEl}));

  if (rc.cardKey && rc.retry === 'available') {
    elements.push(actions([button('🔁 重试', { a: RC.retry, m: rc.cardKey }, 'primary')], CONTROLS_EID));
  }

  return elements;
}

/** A terminal card's failure line without its symbol, also a scheduled run's recorded error; undefined unless it failed. */
export function failureText(state: RunState): string | undefined {
  if (state.terminal === 'idle_timeout') return `${idleLabel(state.idleTimeoutSeconds ?? 0)}没有输出，已自动停止`;
  if (state.terminal === 'error') return `${state.errorKind === 'network' ? '网络失败' : 'agent 失败'}：${state.errorMsg ?? ''}`;
  return undefined;
}

/** `600` → "10 分钟", `90` → "90 秒". */
export function idleLabel(seconds: number): string {
  return seconds > 0 && seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}

/**
 * One next-step suggestion for a fatal error (登录 / 用量 / 网络). Pure copy —
 * NEVER fires a request (the codex 401 chain stays codex's own business);
 * unclassified errors get no advice line.
 */
function errorAdvice(kind: AgentErrorKind | undefined, canRetry: boolean, backend?: string, scheduled?: { nextRun: boolean }): string | null {
  if (kind === 'auth') {
    // A managed copy is on no PATH: the command is what starts it (0.9.0 Linux acceptance).
    if (backend === 'codex-appserver') return `🔑 Codex 的登录可能失效了：在运行 bot 的电脑上运行 \`${toolCommand('codex')} login\` 重新登录，再重试。`;
    if (backend === 'claude-agent') return `🔑 Claude 的登录可能失效了：在运行 bot 的电脑上运行 \`${toolCommand('claude')}\`，用 \`/login\` 重新登录，再重试。`;
    return '🔑 登录可能失效了：在运行 bot 的电脑上重新登录，再重试。';
  }
  if (kind === 'version') return '⬆️ Codex 版本太旧，服务端不让它用这个模型：在 Vonvon 的本机环境里更新 Codex，再重试。';
  if (kind === 'quota') return '📊 可能触达用量上限：发送 /usage 查看用量，稍后再试';
  if (kind === 'network') {
    if (scheduled) {
      return scheduled.nextRun
        ? '连不上模型服务，可能是网络断了，或者服务暂时不可用。下一次定时运行会再试；也可以在任务里手动运行。'
        : '连不上模型服务，可能是网络断了，或者服务暂时不可用。可以在任务里手动运行。';
    }
    return canRetry
      ? '连不上模型服务，可能是网络断了，或者服务暂时不可用。点「重试」再跑一次。'
      : '连不上模型服务，可能是网络断了，或者服务暂时不可用。稍后重发本条消息即可重试。';
  }
  return null;
}

/** Index of the last non-empty text block (the final answer), or -1 if none. */
function lastTextIndex(blocks: Block[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === 'text' && b.content.trim()) return i;
  }
  return -1;
}

/**
 * The running card's answer text: every non-empty text block in order, joined —
 * exactly what {@link renderRunning} feeds to the answer elements. The image
 * uploader scans THIS string, so a ref starts uploading as soon as the model has
 * written it (see {@link ../card/outbound-images}.StreamingImages).
 */
export function runningAnswerText(state: RunState): string {
  const parts: string[] = [];
  for (const b of state.blocks) {
    if (b.kind === 'text' && b.content.trim()) parts.push(b.content);
  }
  return parts.join('\n\n');
}

/** Button-less version — used to demote a previous turn's card. */
export function buildRunCardPlain(rc: RunCardState): CardObject {
  return buildRunCard({ ...rc, cardKey: undefined });
}

/** Render inputs for the queue placeholder card (M-3 排队可见可取消). */
export interface QueuedCardState {
  voiceMessages?: VoiceReply[];
  /** 1-based position in the global run queue (waiting layout only). */
  position?: number;
  /** Routes the cancel button with the card's own messageId. Unset means no button
   * (the first frame, before the messageId exists). */
  cardKey?: string;
  /** ⏹ tapped while waiting — terminal「已取消排队」layout. */
  cancelled?: boolean;
  /** With {@link cancelled}: the bot stopped, nobody cancelled; it says so once back (s18c). */
  stopped?: boolean;
  /** follow-up messages queued behind the cancelled run (told, not swallowed). */
  dropped?: number;
  /** goal runs only: slot granted — the goal's own (lazily created) run cards
   * take over, this entity is repainted into a short started note. */
  started?: boolean;
  /** Same manual-only, per-turn reminder control as {@link RunCardState}. */
  completionReminder?: 'available' | 'requested';
}

/**
 * Queue placeholder card — posted BEFORE the global semaphore acquire when the
 * run pool is full, so a queued run is visible and cancellable. The cancel
 * button reuses the run card's {@link RC.stop} action: while waiting,
 * `state.interrupt` resolves to「移除 waiter + 释放预订」(see acquireRunSlot).
 * Once the slot is granted the SAME CardKit entity is repainted in place into
 * the first run card (launchRun) or a started note (goal) — no
 * delete-and-recreate flicker.
 */
export function buildQueuedCard(qc: QueuedCardState): CardObject {
  if (qc.cancelled) {
    const els: CardElement[] = [...voiceReplyElements(qc.voiceMessages), noteMd(qc.stopped ? '_⏹ bot 停止运行了，这一轮没开始_' : '_⏹ 已取消排队_')];
    if (qc.dropped) els.push(noteMd(`${statusSymbol('failed')} ${qc.dropped} 条排队消息已丢弃，请重发。`));
    return card(els, { summary: qc.stopped ? 'bot 停止运行了' : '已取消排队' });
  }
  if (qc.started) return card([noteMd('_🎯 排队结束，目标已开始执行_')], { summary: '已开始执行' });
  const els: CardElement[] = [
    ...voiceReplyElements(qc.voiceMessages),
    md(`${statusSymbol('waiting')} 排队中（第 **${qc.position ?? 1}** 位）`),
    noteMd('全局并发池已满（所有群/话题共享），轮到后自动开始。'),
  ];
  if (qc.cardKey) {
    const controls: CardElement[] = [stopControl(qc.cardKey, 'queue')];
    if (qc.completionReminder === 'available' || qc.completionReminder === 'requested') {
      controls.push(reminderControl(qc.cardKey, qc.completionReminder === 'requested'));
    }
    els.push(actions(controls, CONTROLS_EID));
  }
  return card(els, { summary: '排队中' });
}

const FOOTER_STATUS: Record<Exclude<FooterStatus, null>, { readonly icon: string; readonly text: string; }> = {
  thinking: { icon: 'time_outlined', text: '正在处理' },
  tool_running: { icon: 'setting-inter_outlined', text: '正在调用工具' },
  retrying: { icon: 'warning_outlined', text: '瞬断，自动重试中…' },
  streaming: { icon: 'edit_outlined', text: '正在输出' },
};

function greyNote(text: string): CardElement {
  return { tag: 'markdown', content: `<font color='grey'>${text}</font>`, text_size: 'notation' };
}

function footerStatus(status: Exclude<FooterStatus, null>): CardElement {
  const item = FOOTER_STATUS[status];
  return {
    tag: 'markdown',
    content: [`<font color='grey'>${item.text}</font>`, statusSymbol(status === 'retrying' ? 'waiting' : 'running')].filter(Boolean).join(' '),
    text_size: 'notation',
    icon: { tag: 'standard_icon', token: item.icon, color: 'grey' },
  };
}

/**
 * Effort → 中文档位 + 飞书颜色。只给 effort 词上色（模型名保持灰）：低=黄 / 中=绿 /
 * 高=浅紫(violet) / 极高及以上=深紫(purple)；none·minimal 不强调（灰）。命名色取自飞书
 * 色板，浅深紫的差异以真机为准（可在此调成色阶或换色名）。
 */
const EFFORT_TIER: Record<ReasoningEffort, { label: string; color: string }> = {
  none: { label: '无', color: 'grey' },
  minimal: { label: '极简', color: 'grey' },
  low: { label: '低', color: 'yellow' },
  medium: { label: '中', color: 'green' },
  high: { label: '高', color: 'violet' },
  xhigh: { label: '极高', color: 'purple' },
  max: { label: '最高', color: 'purple' },
  ultra: { label: '超强', color: 'purple' },
};

/**
 * `<model> · <colored effort>` for the footnote. The effort word is tinted via
 * lark_md inline `<font color='…'>`; the whole element also carries
 * text_color:'grey' so the model name is muted and, on any client that ignores
 * the inline tag, the effort degrades to grey instead of breaking.
 */
function modelEffortMd(model: string, effort?: ReasoningEffort): string {
  if (!effort) return model;
  const t = EFFORT_TIER[effort];
  if (!t) return `${model} · ${effort}`;
  return `${model} · <font color='${t.color}'>${t.label}</font>`;
}

/** Right-aligned, notation-sized「模型 · effort」footnote, or null when off. */
function modelEl(rc: RunCardState): CardElement | null {
  if (!rc.model) return null;
  return {
    tag: 'markdown',
    content: modelEffortMd(rc.model, rc.effort),
    text_size: 'notation',
    text_color: 'grey',
    text_align: 'right',
  };
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  if (state.footer === 'retrying') return '自动重试中';
  return '思考中';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
