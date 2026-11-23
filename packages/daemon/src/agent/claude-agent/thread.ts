import { codeTool, codeNamespace } from '../entry/release-code-tools';
import { z } from 'zod';
import type { ClaudeSdkFacade } from './backend';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Options, PermissionResult, Query, SDKMessage, SDKUserMessage, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../../core/logger';
import type {
  AgentEntry,
  AgentEvent,
  AskRequest,
  AskResolution,
  AgentInput,
  AgentRun,
  AgentThread,
  CompactResult,
  ReasoningEffort,
  TurnOptions,
} from '../types';
import { createTurnMapper, resultErrorText } from './event-map';
import { decide, type ClaudeAccess, type ClaudePermissionOptions, type PathFs, type ToolCall } from './permission';
import { bridgeAsk, type BridgedAsk } from './ask-bridge';
import { findTranscript, scanTranscript } from './transcript';
import { FEISHU_API, FEISHU_DOC_EDIT, feishuReadToolNames } from '../entry/feishu-tools';
import { scheduleToolNames } from '../entry/schedule-tools';
import { toolReplyText } from '../entry/tools';
import { builtinSkillNames } from '../builtin-skills/registry';

/** Config the backend hands the thread to stand up its persistent query(). */
export interface ClaudeThreadConfig {
  entry?: AgentEntry;
  /** The session's profile has `tools.schedule`: vonvon_bot lists the schedule tools too. */
  scheduleTools?: boolean;
  /** The session's profile has `tools.feishu`: vonvon_bot lists the Feishu read tools too. */
  feishuTools?: boolean;
  /** The session's profile has `tools.feishuEdit`: vonvon_bot lists feishu_doc_edit too. */
  feishuEditTools?: boolean;
  /** The session's profile has `tools.feishuApi`: vonvon_bot lists feishu_api too. */
  feishuApiTools?: boolean;
  createSdkMcpServer?: ClaudeSdkFacade['createSdkMcpServer'];
  tool?: ClaudeSdkFacade['tool'];
  /** self-assigned UUID (start: options.sessionId) or the id to resume. */
  sessionId: string;
  /** true → resume an existing session; false → a fresh one. */
  resume: boolean;
  cwd: string;
  model?: string;
  effort?: ReasoningEffort;
  permission: ClaudePermissionOptions;
  access: ClaudeAccess;
  /** Test-only filesystem for exercising stalled permission checks. */
  permissionFs?: PathFs;
  /** appended to Claude Code's default system prompt (bridge developer guidance). */
  systemPromptAppend?: string;
  additionalDirectories?: string[];
  skills?: string[];
  /** The profile's capability package directories, loaded as local plugins (T4b). */
  plugins?: string[];
  recipePlugins?: readonly {pluginId:string; skills:readonly {qualifiedName:string}[]}[];
  /** Which filesystem settings the SDK loads. The SDK default is none — so
   * project/user CLAUDE.md, skills and `.claude/settings.json` are NOT read
   * unless set. The backend passes ['user','project'] to make a claude session
   * behave like Claude Code in its cwd (read CLAUDE.md + user skills). */
  settingSources?: SettingSource[];
  /** Env for the SDK's spawned CLI subprocess. NOTE: the SDK does NOT merge this
   * with process.env — callers must spread it themselves. The backend passes
   * `{ ...process.env, FEISHU_CODEX_BRIDGE: '1',
   * CLAUDE_CODE_ENTRYPOINT: 'feishu-codex-bridge' }`
   * so cli-bridge hooks the bridge installed recognize a bridge-owned session and
   * don't forward it, while Claude Code's native `/resume` picker treats a newly
   * created Bridge conversation like a selectable local CLI session. `cli`
   * itself cannot be used because headless Claude rewrites it to `sdk-cli`. */
  env?: Record<string, string>;
  /** the SDK's `query()` function, injected by the backend (lazy-loaded via
   * loadBackendDep) so thread.ts carries no static runtime dep on the SDK —
   * the on-demand package can be absent until downloaded. */
  query: (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
  /** A resumed session's file as it was when resumed (s15b); unset for a fresh one. */
  transcript?: TranscriptMark;
}

/** Where a thread's watch on its session file stands: see {@link ClaudeAgentThread.checkNative}. */
export interface TranscriptMark {
  file: string;
  /** Read up to here. */
  to: number;
  /** The last compaction seen in it. */
  compaction?: string;
}

/**
 * Flag-layer settings that keep Claude Code's auto-compaction on (s12) whatever
 * the user's ~/.claude says. Measured with getContextUsage() on SDK 0.3.296:
 * `autoCompactEnabled: false` and DISABLE_AUTO_COMPACT or DISABLE_COMPACT, in the
 * process env or a settings file's `env`, each turn it off; this layer wins over
 * all of them, and an empty env value counts as unset. Only bot sessions get it.
 */
export const NATIVE_MEMORY_OFF = {
  autoMemoryEnabled: false,
  env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
} satisfies Options['settings'];

/**
 * Claude Code's own scheduling, off in bot sessions: tasks go through vonvon's schedule tools only (3.13). The
 * tools are disallowed in thread.ts, not in permission.ts, whose full-access tier returns early; the bundled
 * `loop` and `schedule` skills still list after that, so they are turned off too. CLAUDE_CODE_DISABLE_CRON is the
 * second layer, here as well as in the child env: a user's or project's settings file `env` overrides the child
 * env, and this layer wins over both (as for DISABLE_AUTO_COMPACT above).
 */
export const NATIVE_SCHEDULING_TOOLS = ['CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup', 'RemoteTrigger'];
export const NATIVE_SCHEDULING_SKILLS = ['loop', 'schedule'];
export const NATIVE_SCHEDULING_ENV = { CLAUDE_CODE_DISABLE_CRON: '1' };

export const AUTO_COMPACT_SETTINGS = {
  autoCompactEnabled: true,
  ...NATIVE_MEMORY_OFF,
  env: { ...NATIVE_MEMORY_OFF.env, ...NATIVE_SCHEDULING_ENV, DISABLE_AUTO_COMPACT: '', DISABLE_COMPACT: '' },
  skillOverrides: Object.fromEntries(NATIVE_SCHEDULING_SKILLS.map(name => [name, 'off' as const])),
} satisfies Options['settings'];

/**
 * vonvon's builtin capability package is the plugin `vonvon` (builtin-skills/package.ts). Loaded from a directory its
 * id is `vonvon@inline`. A workspace's `.claude/settings.json` can turn it off; enabling it in the flag settings, which
 * outrank project and local settings, beats that (both measured, product.md 9.22). A session's skill whitelist gets
 * its skills too: all of them, a name its package does not have matching nothing.
 */
const BUILTIN_PLUGIN = 'vonvon';
export const BUILTIN_PLUGIN_ID = `${BUILTIN_PLUGIN}@inline`;
export const BUILTIN_SKILL_NAMES = builtinSkillNames().map(name => `${BUILTIN_PLUGIN}:${name}`);

/** Hard ceiling on a manual /compact (a summarization turn) so a wedged process
 * can't hang the「压缩中」card forever. Mirrors codex's COMPACT_TIMEOUT_MS. */
const COMPACT_TIMEOUT_MS = 120_000;
const PLAN_MODE_TIMEOUT_MS = 10_000;
/** A mid-turn getContextUsage() took about 40 ms on SDK 0.3.296; past this the reading shows tokens only. */
const WINDOW_READ_TIMEOUT_MS = 3_000;
const PLAN_RESET_FAILED = '这一轮没能回到先出方案的状态，先停下，请再发一次';

/** ⏹: how long to wait for interrupt() to end the turn before hard-aborting the
 * query. interrupt() reliably stops a STREAMING turn but HANGS when a blocking
 * tool (sleep / long build) is mid-execution (verified) — so we escalate to a
 * hard AbortController.abort() (thread dies → resolveThread resumes next message).
 * Generous enough that a normal interrupt (streaming) settles first and keeps the
 * warm process; short enough that ⏹ on a stuck tool feels responsive. */
const ABORT_ESCALATE_MS = 4_000;

type TurnItem =
  | { kind: 'msg'; msg: SDKMessage }
  | { kind: 'ask'; request: AskRequest; subagentId?: string }
  | { kind: 'ask_cancelled'; requestId: string }
  | { kind: 'end' }
  | { kind: 'error'; err: unknown };

/** A minimal single-consumer async queue (push now, await later). */
class Inbox<T> {
  private readonly buf: T[] = [];
  private readonly waiters: ((v: T) => void)[] = [];
  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.buf.push(v);
  }
  next(): Promise<T> {
    const v = this.buf.shift();
    if (v !== undefined) return Promise.resolve(v);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** A push-able AsyncIterable used as the query's streaming `prompt` source. */
class PushablePrompt {
  private readonly buf: SDKUserMessage[] = [];
  private readonly waiters: ((v: SDKUserMessage | null) => void)[] = [];
  private closed = false;
  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w(msg);
    else this.buf.push(msg);
  }
  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!(null);
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const v = this.buf.shift();
      if (v !== undefined) {
        yield v;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<SDKUserMessage | null>((resolve) => this.waiters.push(resolve));
      if (next == null) return;
      yield next;
    }
  }
}

/** Our ReasoningEffort → the SDK's EffortLevel ('low'|'medium'|'high'|'xhigh'|'max'). */
function toSdkEffort(e: ReasoningEffort | undefined): Options['effort'] | undefined {
  if (!e) return undefined;
  if (e === 'none' || e === 'minimal') return 'low';
  if (e === 'ultra') return 'max'; // Claude has no delegation-aware ultra tier
  if (e === 'low' || e === 'medium' || e === 'high' || e === 'xhigh' || e === 'max') return e;
  return undefined; // an unknown native effort is not a Claude SDK effort
}

/** Content blocks the SDK accepts in a streaming user message, derived from the
 * SDK's own MessageParam so this file carries no static dep on `@anthropic-ai/sdk`. */
type UserContentBlock = Exclude<SDKUserMessage['message']['content'], string>[number];

/** Skip a single image this large (raw bytes): a pathological upload must not
 * bloat the one stream-json line handed to the CLI. Normal chat images are far
 * under this, and the CLI down-scales what it forwards to the API. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Detect an image's type from its MAGIC BYTES, not its filename — media.ts derives
 * the on-disk extension from the HTTP content-type, which Feishu may omit (then it
 * defaults to `.png`), so a JPEG could land as `x.png`; trusting the extension
 * would mislabel it and the Anthropic API would reject the base64 for not matching
 * `media_type`. Returns the API media_type for the ONLY four types base64 image
 * blocks accept, or undefined for anything else (heic/bmp/tiff/unknown — the API
 * can't take those without transcoding, which the bridge doesn't do).
 */
function sniffImageType(b: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'; // ‰PNG
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'; // JFIF/EXIF
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'; // GIF8(7|9)a
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

/** Read one downloaded image into a base64 image content block, or undefined when
 * it can't be shown (unreadable / empty / oversized / a type the API rejects).
 * Best-effort — never throws, so one bad image can't break the turn. */
async function toImageBlock(path: string): Promise<UserContentBlock | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    log.warn('agent', 'image-read-failed', { backend: 'claude-agent', err: String(err) });
    return undefined;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    log.warn('agent', 'image-skip-size', { backend: 'claude-agent', bytes: bytes.byteLength });
    return undefined;
  }
  const mediaType = sniffImageType(bytes);
  if (!mediaType) {
    // heic/bmp/tiff or unrecognized bytes — see sniffImageType; log the header so a
    // surprising type is diagnosable, then skip (best-effort).
    log.info('agent', 'image-skip-unsupported', { backend: 'claude-agent', head: bytes.toString('hex', 0, 4) });
    return undefined;
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } };
}

/** A text-only user message (the common, I/O-free path). */
function textUserMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage;
}

/**
 * Build the SDK user message for a turn. Text-only → a plain string (fast path,
 * no I/O). With images (input.images = the local paths the bridge downloaded, the
 * same source codex reads as `localImage`) → an array of content blocks (optional
 * text + one base64 image block per readable image) so Claude actually SEES the
 * pixels — parity with codex. If every image drops (unsupported/unreadable), fall
 * back to plain text so a text-bearing turn is never blanked. Exported for tests.
 */
export async function toUserMessage(input: AgentInput): Promise<SDKUserMessage> {
  const text = input.text ?? '';
  const paths = input.images ?? [];
  if (paths.length === 0) return textUserMessage(text);

  const blocks: UserContentBlock[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const path of paths) {
    const block = await toImageBlock(path);
    if (block) blocks.push(block);
  }
  const imageCount = blocks.filter((b) => b.type === 'image').length;
  if (imageCount === 0) return textUserMessage(text); // every image dropped → plain text
  log.info('agent', 'images-attached', { backend: 'claude-agent', count: imageCount, of: paths.length });
  return { type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null } as SDKUserMessage;
}

/** Frame a /goal objective so Claude runs it autonomously to completion in one
 * turn (its agent loop already does multi-step; this nudges it not to stop and
 * ask mid-way, matching the "自主多轮跑到完成" expectation). */
function goalPrompt(objective: string): string {
  return [
    '【自主目标】请连续、自主地完成下面的目标：按需使用工具，一步步做到完成为止，',
    '中途不要停下来等我确认；完成后用一段话总结做了什么。',
    '',
    `目标：${objective}`,
  ].join('\n');
}

/** Synthesize a codex-style terminal goal status from a non-success result. */
function goalStatusFromResult(subtype: string | undefined): string {
  if (subtype === 'error_max_budget_usd') return 'budgetLimited';
  return 'blocked'; // error_max_turns / error_during_execution / other → blocked
}

/**
 * A Claude Agent SDK session as one persistent streaming-input `query()`.
 *
 * Design (verified by spike, SDK 0.3.178):
 *  - ONE query() per thread, prompt = a push-able AsyncIterable. Each user turn
 *    pushes one message; a single background `pump()` reads the query's message
 *    stream and routes each message to the CURRENT turn's inbox. Turns are strictly
 *    sequential (the orchestrator never starts a turn on a busy thread), so one
 *    "current sink" suffices. Reusing the warm process keeps 2nd+ turns fast
 *    (~2s to first token vs ~14s cold) — the reason we don't do per-turn query().
 *  - sessionId is self-assigned (options.sessionId on start / options.resume on
 *    resume), so it's known immediately without waiting on the init message.
 *  - interrupt() ends the in-flight turn (result subtype 'error_during_execution');
 *    the same query stays usable for the next turn (verified). We tell apart an
 *    interrupt from a real failure via `interruptRequested`.
 */
const toolOriginSchema = z.object({ _meta: z.object({ 'claudecode/toolUseId': z.string() }) });
let entryMissingWarned = false;

export class ClaudeAgentThread implements AgentThread {
  readonly sessionId: string;
  private readonly cwd: string;
  private model: string | undefined;
  private effort: ReasoningEffort | undefined;
  private readonly input = new PushablePrompt();
  private readonly query: Query;
  private readonly abortController = new AbortController();
  private dead = false;
  private interruptRequested = false;
  /** true while a runGoal() turn is in flight — clearGoal() only hard-stops then. */
  private goalRunning = false;
  /** true while ANY turn (runStreamed/runGoal) is in flight — gates abort escalation. */
  private turnInFlight = false;
  private escalateTimer: ReturnType<typeof setTimeout> | undefined;
  private turnSeq = 0;
  private currentTurnId: string | undefined;
  private lastActivityAt = Date.now();
  private sink: ((item: TurnItem) => void) | undefined;
  private askSink: ((item: TurnItem) => void) | undefined;
  private askSeq = 0;
  private readonly access: ClaudeAccess;
  private readonly permissionFs: PathFs | undefined;
  private readonly pending = new Map<string, {
    turnId?: string; signal: AbortSignal; planConfirmation?: boolean;
    settle(result: PermissionResult): void; toResult: BridgedAsk['toResult'];
  }>();
  /** maxTokens from the last getContextUsage(): the window Claude Code itself counts against */
  private contextWindow: number | undefined;
  /** The one read withWindow makes per process and model. */
  private windowRead: Promise<void> | undefined;
  /** The session file and how far it has been read (s15b). */
  private transcript: TranscriptMark | undefined;

  constructor(private readonly cfg: ClaudeThreadConfig) {
    this.sessionId = cfg.sessionId;
    this.cwd = cfg.cwd;
    this.access = cfg.access;
    this.permissionFs = cfg.permissionFs;
    this.model = cfg.model;
    this.effort = cfg.effort;
    this.transcript = cfg.transcript;

    const mcpServers: NonNullable<Options['mcpServers']> = {};
    if (cfg.entry) {
      const entry = cfg.entry;
      if (cfg.createSdkMcpServer && cfg.tool) {
        const tool = cfg.tool;
        const visible = entry.tools().filter(spec =>
          (cfg.scheduleTools || !scheduleToolNames.has(spec.name)) &&
          (cfg.feishuTools || !feishuReadToolNames.has(spec.name)) &&
          (cfg.feishuEditTools || spec.name !== FEISHU_DOC_EDIT) &&
          (cfg.feishuApiTools || spec.name !== FEISHU_API));
        for (const name of ['vonvon_bot', codeNamespace]) {
          const specs = visible.filter(spec => codeTool(spec.name) === (name === codeNamespace));
          if (name === codeNamespace && !specs.length) continue;
          const tools = specs.map(spec => tool(spec.name, spec.description, spec.input.shape, async (args, extra) => {
            const origin = toolOriginSchema.safeParse(extra);
            const toolUseId = origin.success ? origin.data._meta['claudecode/toolUseId'] : undefined;
            const reply = await entry.call(spec.name, args, { toolUseId });
            return { content: [{ type: 'text', text: toolReplyText(reply) }], ...(!reply.ok ? { isError: true } : {}) };
          }));
          mcpServers[name] = cfg.createSdkMcpServer({ name, version: '1', tools });
        }
      } else if (!entryMissingWarned) {
        entryMissingWarned = true;
        log.warn('agent', 'entry-missing', { reason: 'sdk' });
      }
    }
    const plugins = cfg.plugins ?? [];
    const options: Options = {
      cwd: cfg.cwd,
      abortController: this.abortController,
      includePartialMessages: true,
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(toSdkEffort(cfg.effort) ? { effort: toSdkEffort(cfg.effort) } : {}),
      ...(cfg.resume ? { resume: cfg.sessionId } : { sessionId: cfg.sessionId }),
      ...(cfg.systemPromptAppend
        ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: cfg.systemPromptAppend } }
        : {}),
      ...(cfg.settingSources ? { settingSources: cfg.settingSources } : {}),
      ...(cfg.additionalDirectories?.length ? { additionalDirectories: cfg.additionalDirectories } : {}),
      ...(plugins.length ? { plugins: plugins.map(path => ({ type: 'local' as const, path, skipMcpDiscovery: true })) } : {}),
      ...(cfg.skills ? { skills: plugins.length ? [...cfg.skills, ...BUILTIN_SKILL_NAMES, ...(cfg.recipePlugins ?? []).flatMap(pkg=>pkg.skills.map(s=>s.qualifiedName))] : cfg.skills } : {}),
      ...(cfg.env ? { env: cfg.env } : {}),
      settings: {
        ...AUTO_COMPACT_SETTINGS,
        ...(plugins.length ? { enabledPlugins: { [BUILTIN_PLUGIN_ID]: true, ...Object.fromEntries((cfg.recipePlugins ?? []).map(pkg=>[`${pkg.pluginId}@inline`,true])) } } : {}),
        // SDK consumes an absolute path; plan files stay inside the existing write boundary.
        ...(cfg.access.native?.permissionMode === 'plan'
          ? { plansDirectory: cfg.access.planState?.directory ?? resolve(cfg.access.realCwd, '.claude/plans') } : {}),
      },
      ...(mcpServers.vonvon_bot ? { mcpServers } : {}),
      // permission tier (permissionMode / sandbox / canUseTool / disallowedTools)
      ...cfg.permission,
      ...(mcpServers[codeNamespace] ? { allowedTools: [...cfg.permission.allowedTools ?? [],
        'mcp__' + codeNamespace + '__rg', 'mcp__' + codeNamespace + '__read'] } : {}),
      disallowedTools: [...cfg.permission.disallowedTools ?? [], ...NATIVE_SCHEDULING_TOOLS],
      canUseTool: (name, input, opts) => this.canUseTool(name, input, opts),
      stderr: (d: string) => {
        const s = String(d).trim();
        // file-only (not in stdout allowlist) — handy for diagnosing auth/sandbox.
        if (s) log.info('agent', 'sdk-stderr', { backend: 'claude-agent', line: s.slice(0, 300) });
      },
    };

    this.query = cfg.query({ prompt: this.input, options });
    void this.pump();
  }

  private async canUseTool(
    toolName: string, input: Record<string, unknown>,
    { signal, decisionReason, ...extra }: Parameters<NonNullable<Options['canUseTool']>>[2],
  ): Promise<PermissionResult> {
    this.lastActivityAt = Date.now();
    const call: ToolCall = { toolName, input, decisionReason, extra };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const verdict = await Promise.race([
        decide(this.access, call, 'callback', this.permissionFs),
        new Promise<{ kind: 'deny'; message: string }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'deny', message: '权限检查超时，这一步先不做。' }), 5_000);
        }),
      ]);
      log.info('agent', 'claude-perm', {
        tool: toolName, verdict: verdict.kind, tier: this.access.mode,
        reasonType: typeof call.extra.decisionReasonType === 'string' ? call.extra.decisionReasonType : undefined,
      });
      if (verdict.kind === 'allow') return { behavior: 'allow', updatedInput: input };
      if (verdict.kind === 'deny') return { behavior: 'deny', message: verdict.message };
      if (verdict.kind !== 'ask' || signal.aborted) return { behavior: 'deny', message: '权限检查出错，这一步先不做。' };
      const askSink = this.askSink;
      if (!askSink) return { behavior: 'deny', message: '现在没有在进行的对话，没法问人。按你自己的判断继续，或者停下来说明。' };
      const id = `c${++this.askSeq}`;
      const bridged = bridgeAsk(id, verdict.ask, this.access, call);
      if (!bridged) return { behavior: 'deny', message: verdict.ask === 'choices' ? '没法把这个问题做成卡片，改用文字问。' : '权限检查出错，这一步先不做。' };
      log.info('agent', 'claude-ask', { kind: verdict.ask, id });
      return new Promise<PermissionResult>((resolve) => {
        const abort = (): void => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          log.info('agent', 'claude-ask', { id, reason: 'aborted' });
          pending.settle({ behavior: 'deny', message: '权限检查出错，这一步先不做。' });
          askSink({ kind: 'ask_cancelled', requestId: id });
        };
        this.pending.set(id, {
          turnId: this.currentTurnId, signal, planConfirmation: bridged.planConfirmation, toResult: bridged.toResult,
          settle: (result) => { signal.removeEventListener('abort', abort); resolve(result); },
        });
        signal.addEventListener('abort', abort, { once: true });
        askSink({ kind: 'ask', request: bridged.request, subagentId: extra.agentID });
      });
    } catch {
      log.fail('agent', new Error('权限检查出错'), { phase: 'claude-perm' });
      return { behavior: 'deny', message: '权限检查出错，这一步先不做。' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async respondToAsk(id: string, resolution: AskResolution): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) {
      log.info('agent', 'claude-ask-late', { id });
      return;
    }
    this.pending.delete(id);
    log.info('agent', 'claude-ask', { id, reason: resolution.kind === 'unanswered' ? resolution.reason : resolution.kind });
    let result = pending.toResult(resolution);
    if (pending.planConfirmation && result.behavior === 'allow') {
      try {
        await this.setPlanMode('acceptEdits');
        if (this.dead || pending.signal.aborted || !this.turnInFlight || pending.turnId !== this.currentTurnId)
          result = { behavior: 'deny', message: '这一轮已经结束，先不要按这个方案做。' };
        else if (this.access.planState) this.access.planState.pending = false;
      } catch (err) {
        log.fail('agent', err, { phase: 'setPermissionMode' });
        result = { behavior: 'deny', message: '权限检查出错，这一步先不做。' };
      }
    }
    pending.settle(result);
  }

  private dropAsks(reason: 'turn-ended' | 'stopped', turnId?: string): void {
    for (const [id, pending] of this.pending) {
      if (turnId !== undefined && pending.turnId !== turnId) continue;
      this.pending.delete(id);
      log.info('agent', 'claude-ask', { id, reason });
      pending.settle(pending.toResult({ kind: 'unanswered', reason }));
    }
  }

  /** Single background consumer: route every query message to the current turn. */
  private async pump(): Promise<void> {
    try {
      for await (const msg of this.query) {
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use' && (block.name.startsWith('mcp__vonvon_bot__') || block.name.startsWith('mcp__'+codeNamespace+'__'))) this.cfg.entry?.noteToolUse(block.id);
          }
        }
        if (msg.type === 'stream_event' && msg.event.type === 'content_block_start') {
          const block = msg.event.content_block;
          if (block.type === 'tool_use' && (block.name.startsWith('mcp__vonvon_bot__') || block.name.startsWith('mcp__'+codeNamespace+'__'))) this.cfg.entry?.noteToolUse(block.id);
        }
        if (msg.type === 'system' && msg.subtype === 'init' && this.cfg.plugins?.length) {
          // The one check the code can make (T4b 4.4): the CLI's own report of the plugins it loaded.
          const loaded = msg.plugins ?? [];
          if (!loaded.some(plugin => plugin.name === BUILTIN_PLUGIN)) {
            log.warn('agent', 'builtin-plugin-missing', { backend: 'claude-agent', sessionId: this.sessionId, loaded: loaded.map(plugin => plugin.name).join(',') });
          }
        }
        this.lastActivityAt = Date.now();
        this.sink?.({ kind: 'msg', msg });
      }
      this.died();
      this.sink?.({ kind: 'end' });
    } catch (err) {
      this.died();
      log.fail('agent', err, { backend: 'claude-agent', phase: 'pump' });
      this.sink?.({ kind: 'error', err });
    }
  }

  /**
   * The process is gone: it exited, its stream failed, or it was hard-aborted. Between two turns no turn is there to
   * clean up after it, so the session's entry, and with it the session's token in the host, ends here (devices 5.3).
   */
  private died(): void {
    this.dead = true;
    this.askSink = undefined;
    this.dropAsks('turn-ended');
    this.cfg.entry?.revoke('dead');
  }

  private async setPlanMode(mode: 'plan' | 'acceptEdits'): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { signal } = this.abortController;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => this.query.setPermissionMode(mode)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Claude permission mode timed out')), PLAN_MODE_TIMEOUT_MS);
          abort = () => reject(new Error('Claude session closed'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
  }

  private async resetPlanMode(sink: (item: TurnItem) => void): Promise<boolean> {
    if (this.access.native?.permissionMode !== 'plan') return !this.dead;
    if (this.access.planState) this.access.planState.pending = true;
    try {
      await this.setPlanMode('plan');
      return !this.dead;
    } catch (err) {
      if (this.dead) return false;
      log.fail('agent', err, { phase: 'setPermissionMode' });
      // Queue the precise error before close lets the query pump report its end.
      sink({ kind: 'error', err: new Error(PLAN_RESET_FAILED) });
      await this.close();
      return false;
    }
  }

  runStreamed(input: AgentInput, turn?: TurnOptions): AgentRun {
    const turnId = `t${++this.turnSeq}`;
    this.currentTurnId = turnId;
    this.interruptRequested = false;
    this.turnInFlight = true;

    // Per-turn model override persists (mirrors codex). Effort can only be set at
    // query creation in the SDK, so a mid-session effort change is recorded but
    // takes effect on the next thread (documented limitation).
    if (turn?.model && turn.model !== this.model) {
      this.model = turn.model;
      this.contextWindow = undefined;
      this.windowRead = undefined;
      this.query.setModel(turn.model).catch((err) => log.fail('agent', err, { phase: 'setModel' }));
    }
    if (turn?.effort) this.effort = turn.effort;

    const mapper = createTurnMapper({ cwd: this.cwd });
    const inbox = new Inbox<TurnItem>();
    const mySink = (item: TurnItem): void => inbox.push(item);
    this.sink = mySink;
    this.askSink = mySink;

    // Fire the turn (push the user message) so inference overlaps the caller's
    // card setup; messages buffer in `inbox` until the for-await below drains
    // them. Text-only resolves on the next microtask; an image turn reads +
    // base64-encodes the files first (async), pushed as soon as ready. A build
    // failure (encoding is best-effort, so this shouldn't fire) still pushes the
    // text alone rather than leaving the turn waiting forever on `inbox`.
    void this.resetPlanMode(mySink).then(async ready => {
      if (!ready) return;
      try {
        const message = await toUserMessage(input);
        if (!this.dead) this.input.push(message);
      } catch (err) {
        log.fail('agent', err, { backend: 'claude-agent', phase: 'build-user-message' });
        if (!this.dead) this.input.push(textUserMessage(input.text ?? ''));
      }
    });

    const self = this;
    let query: Query | undefined = this.query;
    async function* gen(): AsyncGenerator<AgentEvent> {
      yield { type: 'turn_started', turnId };
      let terminalError = false;
      try {
        while (true) {
          const item = await inbox.next();
          if (item.kind === 'end' || item.kind === 'error') {
            if (terminalError) return;
            // A deliberate ⏹ (interrupt or the hard-abort escalation) ends here too —
            // treat it as a clean `done` (the orchestrator marks it interrupted), not
            // a scary error; a genuine crash surfaces the error.
            if (self.interruptRequested) {
              yield { type: 'done', turnId };
              return;
            }
            const msg = item.kind === 'error' && item.err instanceof Error ? item.err.message : 'Claude 会话进程已退出';
            yield { type: 'error', message: msg || 'Claude 会话出错', willRetry: false };
            return;
          }
          if (item.kind === 'ask') { yield { type: 'ask', request: item.request, subagentId: item.subagentId }; continue; }
          if (item.kind === 'ask_cancelled') { yield { type: 'ask_cancelled', requestId: item.requestId }; continue; }
          const msg = item.msg as unknown as { type?: string; subtype?: string };
          self.lastActivityAt = Date.now();
          for (const ev of mapper.map(item.msg)) {
            if (ev.type === 'error' && !ev.willRetry) {
              if (terminalError) continue;
              terminalError = true;
            }
            yield await self.withWindow(ev);
          }
          if (msg.type === 'result') {
            // Drain through the turn boundary so the warm query stays aligned,
            // but never let a contradictory success overwrite an API failure.
            if (terminalError) return;
            const ok = msg.subtype === 'success' || self.interruptRequested;
            if (ok) {
              // Authoritative context gauge — matches Claude's native /context
              // (totalTokens used, maxTokens window). Overrides the event-map's
              // fallback estimate. Best-effort: a control RTT that may fail.
              try {
                const usage = await self.readContextUsage();
                if (usage) yield { type: 'context_usage', ...usage };
              } catch (err) {
                log.fail('agent', err, { backend: 'claude-agent', phase: 'getContextUsage' });
              }
              yield { type: 'done', turnId };
            } else {
              yield { type: 'error', message: resultErrorText(msg as Record<string, unknown>), willRetry: false };
            }
            return;
          }
        }
      } finally {
        query = undefined;
        self.dropAsks('turn-ended', turnId);
        if (self.askSink === mySink) self.askSink = undefined;
        self.endTurn();
        if (self.sink === mySink) self.sink = undefined;
      }
    }

    return {
      events: gen(),
      respondToAsk: (id, resolution) => self.respondToAsk(id, resolution),
      askPending: (id) => self.pending.has(id),
      stopSubagent: async (id) => {
        if (!query || self.dead || self.sink !== mySink) throw new Error('这个子 agent 已经结束');
        try {
          await query.stopTask(id);
        } catch (err) {
          throw new Error(`停止子 agent 失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
      turnId: () => self.currentTurnId,
      lastActivity: () => self.lastActivityAt,
    };
  }

  /** End-of-turn bookkeeping: clear the in-flight flag + any pending ⏹ escalation. */
  private endTurn(): void {
    this.turnInFlight = false;
    if (this.escalateTimer) {
      clearTimeout(this.escalateTimer);
      this.escalateTimer = undefined;
    }
  }

  /**
   * /goal —— Claude 没有 codex 那种「目标引擎 + 多轮自动续跑」，但 Claude Code 的
   * agent loop 本身就能在 ONE query turn 内自主多步跑完一个目标。所以这里把目标当作
   * 「一个自主轮」：发带自主提示的目标 → 流式跑 → 合成 goal_update 状态（active 起、
   * complete/blocked/budgetLimited 收）。
   *
   * ── 与 codex 的差异（如实）──────────────────────────────────────────────
   *  - codex：N 个自动续跑的 turn（N 张卡片）+ 原生状态机（active/paused/complete/
   *    budgetLimited/usageLimited/blocked）+ token 预算。
   *  - claude：1 个自主 turn（1 张卡片，内部多步）+ 合成状态（仅 active→complete/
   *    blocked/budgetLimited）。无 paused/usageLimited、无预算。
   *  - ⏹ 终止 / 🎯 结束：经 clearGoal() 用 abortController 硬停（spike 实测 ~2s 停，
   *    且 abort 后会话可 resume 续聊）——比工具执行中途的 interrupt() 可靠。
   */
  runGoal(objective: string): AgentRun {
    const turnId = `g${++this.turnSeq}`;
    this.currentTurnId = turnId;
    this.interruptRequested = false;
    this.goalRunning = true;
    this.turnInFlight = true;
    const startedAt = Date.now();
    const mapper = createTurnMapper({ cwd: this.cwd });
    const inbox = new Inbox<TurnItem>();
    const mySink = (item: TurnItem): void => inbox.push(item);
    this.sink = mySink;
    this.askSink = mySink;

    void this.resetPlanMode(mySink).then(ready => {
      if (ready) this.input.push(textUserMessage(goalPrompt(objective)));
    });

    const self = this;
    let query: Query | undefined = this.query;
    async function* gen(): AsyncGenerator<AgentEvent> {
      yield { type: 'goal_update', status: 'active', objective, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null };
      yield { type: 'turn_started', turnId };
      let tokensUsed = 0;
      let terminalError = false;
      const finishGoal = (status: string): AgentEvent => ({
        type: 'goal_update',
        status,
        objective,
        tokensUsed,
        timeUsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        tokenBudget: null,
      });
      try {
        while (true) {
          const item = await inbox.next();
          if (item.kind === 'end' || item.kind === 'error') {
            if (terminalError) {
              yield finishGoal('blocked');
              return;
            }
            // Deliberate ⏹/🎯 (clearGoal aborted the query) → finish cleanly; a real
            // crash → surface the error.
            if (self.interruptRequested) {
              yield { type: 'done', turnId };
            } else {
              const m = item.kind === 'error' && item.err instanceof Error ? item.err.message : 'Claude 会话进程已退出';
              yield finishGoal('blocked');
              yield { type: 'error', message: m, willRetry: false };
            }
            return;
          }
          if (item.kind === 'ask') { yield { type: 'ask', request: item.request, subagentId: item.subagentId }; continue; }
          if (item.kind === 'ask_cancelled') { yield { type: 'ask_cancelled', requestId: item.requestId }; continue; }
          const msg = item.msg as unknown as { type?: string; subtype?: string; usage?: Record<string, number> };
          self.lastActivityAt = Date.now();
          for (const ev of mapper.map(item.msg)) {
            if (ev.type === 'usage') tokensUsed = (ev.inputTokens ?? 0) + (ev.outputTokens ?? 0);
            if (ev.type === 'error' && !ev.willRetry) {
              if (terminalError) continue;
              terminalError = true;
            }
            yield await self.withWindow(ev);
          }
          if (msg.type === 'result') {
            self.goalRunning = false;
            if (terminalError) {
              yield finishGoal('blocked');
              return;
            }
            if (msg.subtype !== 'success' && !self.interruptRequested) {
              yield finishGoal(goalStatusFromResult(msg.subtype));
              yield { type: 'error', message: resultErrorText(msg as Record<string, unknown>), willRetry: false };
              return;
            }
            try {
              const usage = await self.readContextUsage();
              if (usage) yield { type: 'context_usage', ...usage };
            } catch {
              /* best-effort */
            }
            yield finishGoal('complete');
            yield { type: 'done', turnId };
            return;
          }
        }
      } finally {
        query = undefined;
        self.goalRunning = false;
        self.dropAsks('turn-ended', turnId);
        if (self.askSink === mySink) self.askSink = undefined;
        self.endTurn();
        if (self.sink === mySink) self.sink = undefined;
      }
    }

    return {
      events: gen(),
      respondToAsk: (id, resolution) => self.respondToAsk(id, resolution),
      askPending: (id) => self.pending.has(id),
      stopSubagent: async (id) => {
        if (!query || self.dead || self.sink !== mySink) throw new Error('这个子 agent 已经结束');
        try {
          await query.stopTask(id);
        } catch (err) {
          throw new Error(`停止子 agent 失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
      turnId: () => self.currentTurnId,
      lastActivity: () => self.lastActivityAt,
    };
  }

  /**
   * Clear/terminate the goal. Claude has no goal engine, so "clear" = hard-stop the
   * in-flight goal turn via the AbortController (interrupt() can hang mid-tool;
   * abort reliably stops in ~2s and the session stays resumable, so chat continues
   * via resolveThread's resume on the next message). No-op when no goal is running
   * (this is also the orchestrator's idempotent end-of-run cleanup — keep the warm
   * query alive on natural completion).
   */
  async clearGoal(): Promise<void> {
    if (!this.goalRunning) return;
    this.askSink = undefined;
    this.dropAsks('stopped');
    this.goalRunning = false;
    this.interruptRequested = true;
    this.dead = true; // aborted → resolveThread evicts + resumes on next message
    try {
      this.abortController.abort();
    } catch {
      /* ignore */
    }
  }
  readonly supportsSteer = false;
  async steer(): Promise<void> {
    // capabilities.steer=false → orchestrator queues the steer as the next turn.
    throw new Error('claude-agent 后端暂不支持飞行中引导（steer），将自动改为下一轮发送');
  }
  /**
   * Manual /compact. Claude Code's `/compact` IS a real slash command (verified:
   * `supportedCommands()` lists it, and sending "/compact" as input is intercepted
   * and executed, not echoed). We send it through the persistent query and drain to
   * the result; a `compact_boundary`(trigger:manual) means it actually compacted —
   * "Not enough messages to compact." just ends with no boundary (compacted=false).
   */
  async compact(): Promise<CompactResult> {
    if (this.dead) throw new Error('Claude 会话已结束，无法压缩');
    const inbox = new Inbox<TurnItem>();
    const mySink = (item: TurnItem): void => inbox.push(item);
    this.sink = mySink;
    this.interruptRequested = false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), COMPACT_TIMEOUT_MS);
    });

    let compacted = false;
    try {
      this.input.push(textUserMessage('/compact'));
      while (true) {
        const step = await Promise.race([inbox.next(), timeout]);
        if (step === 'timeout') throw new Error(`压缩超时（Claude 未在 ${COMPACT_TIMEOUT_MS / 1000}s 内完成）`);
        if (step.kind === 'end') throw new Error('Claude 会话进程已退出');
        if (step.kind === 'error') throw step.err instanceof Error ? step.err : new Error(String(step.err));
        if (step.kind === 'ask' || step.kind === 'ask_cancelled') continue;
        const msg = step.msg as unknown as { type?: string; subtype?: string };
        this.lastActivityAt = Date.now();
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') compacted = true;
        if (msg.type === 'result') break; // the /compact turn ended
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (this.sink === mySink) this.sink = undefined;
    }

    let usage: CompactResult['usage'] = null;
    try {
      usage = (await this.readContextUsage()) ?? null;
    } catch {
      /* best-effort post-compaction usage */
    }
    return { compacted, usage };
  }

  /**
   * A reading or compaction line carries the window Claude Code reports, never a guess from the model id:
   * 0.10.0 showed claude-opus-5-5 as 200k for a first turn whose window was 400k (a settings file's
   * autoCompactWindow) and the model's own 1M. Read once at the first reading of a process or model; when
   * the read fails or times out the meter shows the tokens used until the turn-end reading.
   */
  private async withWindow(ev: AgentEvent): Promise<AgentEvent> {
    if (!('contextWindow' in ev)) return ev;
    if (this.contextWindow === undefined) {
      this.windowRead ??= this.readWindow();
      await this.windowRead;
    }
    return { ...ev, contextWindow: this.contextWindow ?? null };
  }

  private async readWindow(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.readContextUsage(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('getContextUsage timed out')), WINDOW_READ_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      log.fail('agent', err, { backend: 'claude-agent', phase: 'getContextUsage' });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** getContextUsage() as a reading (undefined when it lacks the numbers; throws
   * as the SDK does). Keeps maxTokens as the window of later readings, unless the
   * model changed while it was out (a read that answered after withWindow's timeout). */
  private async readContextUsage(): Promise<{ usedTokens: number; contextWindow: number } | undefined> {
    const model = this.model;
    const cu = await this.query.getContextUsage();
    if (!cu || typeof cu.totalTokens !== 'number' || typeof cu.maxTokens !== 'number') return undefined;
    if (this.model === model) this.contextWindow = cu.maxTokens;
    return { usedTokens: cu.totalTokens, contextWindow: cu.maxTokens };
  }

  async abort(_turnId: string): Promise<void> {
    this.interruptRequested = true;
    try {
      await this.query.interrupt();
    } catch (err) {
      log.fail('agent', err, { backend: 'claude-agent', phase: 'interrupt' });
    }
    // interrupt() ends a streaming turn cleanly (keeps the warm process), but HANGS
    // when a blocking tool is mid-execution — so escalate to a hard abort if the
    // turn hasn't ended shortly, guaranteeing ⏹ always stops.
    if (this.escalateTimer || !this.turnInFlight) return;
    this.escalateTimer = setTimeout(() => {
      this.escalateTimer = undefined;
      if (this.dead || !this.turnInFlight) return; // interrupt already ended it
      log.info('agent', 'interrupt-escalate', { backend: 'claude-agent' });
      this.dead = true; // hard abort → resolveThread evicts + resumes next message
      try {
        this.abortController.abort();
      } catch {
        /* ignore */
      }
    }, ABORT_ESCALATE_MS);
  }

  get lastCompaction(): string | undefined {
    return this.transcript?.compaction;
  }

  /**
   * Read what the session file gained since the last look (s15b). This process keeps the
   * history in memory and never rereads the file, so a terminal turn or `/compact` there is
   * `foreign`: the caller drops this thread and resumes from the file. A fresh session's file
   * appears with its first turn; until then there is nothing to read.
   */
  async checkNative(): Promise<{ foreign: boolean }> {
    if (!this.transcript) {
      const file = await findTranscript(this.sessionId);
      if (!file) return { foreign: false };
      this.transcript = { file, to: 0 };
    }
    const mark = this.transcript;
    const scan = await scanTranscript(mark.file, mark.to);
    this.transcript = { file: mark.file, to: scan.to, compaction: scan.compaction ?? mark.compaction };
    return { foreign: scan.foreign };
  }

  isAlive(): boolean {
    return !this.dead;
  }

  async close(): Promise<void> {
    this.cfg.entry?.revoke('closed');
    this.askSink = undefined;
    this.dropAsks('stopped');
    this.dead = true;
    this.endTurn();
    try {
      this.input.close();
    } catch {
      /* ignore */
    }
    try {
      this.abortController.abort();
    } catch {
      /* ignore */
    }
    try {
      this.query.close?.();
    } catch {
      /* ignore */
    }
  }
}
