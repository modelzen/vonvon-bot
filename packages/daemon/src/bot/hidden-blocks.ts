import { randomBytes } from 'node:crypto';
import type { AssistantTextFilter } from '../core/token-redact';
import { log } from '../core/logger';

/**
 * 隐藏块（记忆设计 §3.4、§4.5、§6）：模型在回复末尾放 `<vonvon-remember n=… scope=project branch=…>文本</vonvon-remember>`，
 * vonvon 在事件流上把它收走，群里的卡片、历史卡和会话标题里都看不到。同一处也剥 `<vonvon-mem n=… used=…/>`（使用标记，
 * 解析在 `usage-marker.ts`，这里只剥、只把剥到的交出去）。
 *
 * 这个文件只管文本：流式剥离、终态解析、会话 nonce、入站标记全角化、隐藏块的说明文字。写记忆在 `memory-writer.ts`。
 */

/** 每轮最多收的隐藏块条数，多的丢 */
export const HIDDEN_BLOCKS_PER_TURN = 5;
/** 一个块的正文超过这个长度就整块丢（记忆本身 ≤ 500 字，留足 JSON 之外的余量） */
const BODY_MAX = 4_000;
/** 开始标签一直找不到 `>` 的上限，再长就当它不是标签 */
const OPEN_TAG_MAX = 2_000;

const OPENERS = ['<vonvon-remember', '<vonvon-mem'] as const;
const OPEN_RE = /<vonvon-(remember|mem)(?=[\s/>])/;

export interface RawBlock { attrs: Record<string, string>; body: string }
export interface FoundBlocks {
  remember: RawBlock[];
  /** `<vonvon-mem …/>` 使用标记，原样交给 usage-marker.ts */
  mem: RawBlock[];
  /** 没闭合、太长或超过每轮条数而丢掉的块数 */
  dropped: number;
}
const emptyFound = (): FoundBlocks => ({ remember: [], mem: [], dropped: 0 });

const ATTR = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of text.matchAll(ATTR)) {
    const key = match[1]!.toLowerCase();
    if (!(key in attrs)) attrs[key] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

/** buf 末尾那段是不是某个开始标签的前缀；是就留着等下一块，不推出去 */
function heldTail(buf: string): number {
  const longest = Math.min(buf.length, Math.max(...OPENERS.map(opener => opener.length)));
  for (let length = longest; length > 0; length--) {
    const tail = buf.slice(buf.length - length);
    if (OPENERS.some(opener => opener.startsWith(tail))) return length;
  }
  return 0;
}

/** 一段文字（一条消息、一个 item）的流式扫描：喂 delta，吐能给人看的部分，剥下来的块记在 `found` 里 */
class BlockScanner {
  readonly found: FoundBlocks = emptyFound();
  private buf = '';
  private mode: 'text' | 'tag' | 'body' = 'text';
  private kind: 'remember' | 'mem' = 'remember';
  private attrs: Record<string, string> = {};
  private body = '';
  private overflow = false;

  push(chunk: string): string {
    this.buf += chunk;
    let out = '';
    for (;;) {
      if (this.mode === 'text') {
        const open = OPEN_RE.exec(this.buf);
        if (open) {
          out += this.buf.slice(0, open.index);
          this.buf = this.buf.slice(open.index + open[0].length);
          this.kind = open[1] as 'remember' | 'mem';
          this.mode = 'tag';
          continue;
        }
        const hold = heldTail(this.buf);
        out += this.buf.slice(0, this.buf.length - hold);
        this.buf = this.buf.slice(this.buf.length - hold);
        return out;
      }
      if (this.mode === 'tag') {
        let quote = '';
        let end = -1;
        for (let index = 0; index < this.buf.length; index++) {
          const char = this.buf[index]!;
          if (quote) { if (char === quote) quote = ''; }
          else if (char === '"' || char === '\'') quote = char;
          else if (char === '>') { end = index; break; }
        }
        if (end < 0) {
          if (this.buf.length > OPEN_TAG_MAX) { this.found.dropped++; this.buf = ''; this.mode = 'text'; }
          return out;
        }
        const inside = this.buf.slice(0, end);
        this.buf = this.buf.slice(end + 1);
        const selfClosing = inside.trimEnd().endsWith('/');
        this.attrs = parseAttrs(selfClosing ? inside.trimEnd().slice(0, -1) : inside);
        if (selfClosing) { this.record(''); this.mode = 'text'; continue; }
        this.body = '';
        this.overflow = false;
        this.mode = 'body';
        continue;
      }
      const close = `</vonvon-${this.kind}>`;
      const at = this.buf.indexOf(close);
      if (at >= 0) {
        this.absorb(this.buf.slice(0, at));
        this.buf = this.buf.slice(at + close.length);
        this.record(this.body);
        this.mode = 'text';
        continue;
      }
      // 闭合标签可能被切在两块之间：只把确定不是它的前面部分收进正文
      const keep = Math.min(this.buf.length, close.length - 1);
      this.absorb(this.buf.slice(0, this.buf.length - keep));
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  private absorb(piece: string): void {
    if (this.overflow) return;
    this.body += piece;
    if (this.body.length > BODY_MAX) { this.overflow = true; this.body = ''; }
  }

  private record(body: string): void {
    if (this.overflow) { this.found.dropped++; this.overflow = false; return; }
    if (this.kind === 'mem') { this.found.mem.push({ attrs: this.attrs, body }); return; }
    if (this.found.remember.length >= HIDDEN_BLOCKS_PER_TURN) { this.found.dropped++; return; }
    this.found.remember.push({ attrs: this.attrs, body: body.trim() });
  }

  /** 流结束：开始标签或正文没闭合的整段丢掉，只留可能是标签前缀、结果不是的尾巴 */
  end(): string {
    if (this.mode === 'text') { const rest = this.buf; this.buf = ''; return rest; }
    this.found.dropped++;
    log.warn('memory', 'hidden-block-unclosed', { kind: this.kind });
    this.buf = ''; this.body = ''; this.mode = 'text';
    return '';
  }
}

/** 整段文字一次剥完（历史卡、标题、终态文本）。剥过块的，末尾被块撑出来的空白一起去掉 */
export function stripHiddenText(text: string): string {
  if (!text.includes('<vonvon-')) return text;
  const scanner = new BlockScanner();
  const out = scanner.push(text) + scanner.end();
  const found = scanner.found;
  return found.remember.length || found.mem.length || found.dropped ? out.trimEnd() : out;
}

/** 整段文字剥完，同时把剥下来的块交出去（单元测试和终态解析用） */
export function extractHiddenBlocks(text: string): { text: string; found: FoundBlocks } {
  const scanner = new BlockScanner();
  const out = scanner.push(text) + scanner.end();
  const found = scanner.found;
  return { text: found.remember.length || found.mem.length || found.dropped ? out.trimEnd() : out, found };
}

export interface HiddenBlockFilterOptions {
  /** 一轮结束（`done` 之前）调一次，参数是这一轮最后一条 agent 消息里剥到的块；可以是异步的 */
  onTurnEnd?(found: FoundBlocks): void | Promise<void>;
}

/**
 * 接在 `redactAgentEvents` 里的文本过滤：按 item 各一个扫描器。流式 delta 里剥，终态 `text` 整段再剥一遍
 * （终态才是解析的依据）；只认最后一条出过字的 agent 消息里的块，更早的评论性消息里的不收。
 */
export function createHiddenBlockFilter(options: HiddenBlockFilterOptions = {}): AssistantTextFilter {
  const scanners = new Map<string, BlockScanner>();
  const finals = new Map<string, FoundBlocks>();
  let last: string | undefined;
  const scannerOf = (itemId: string): BlockScanner => {
    let scanner = scanners.get(itemId);
    if (!scanner) { scanner = new BlockScanner(); scanners.set(itemId, scanner); }
    return scanner;
  };
  const reset = (): void => { scanners.clear(); finals.clear(); last = undefined; };
  return {
    delta(itemId, text) {
      last = itemId;
      return scannerOf(itemId).push(text);
    },
    flushItem(itemId) {
      const scanner = scanners.get(itemId);
      return scanner ? scanner.end() : '';
    },
    final(itemId, text) {
      last = itemId;
      const { text: visible, found } = extractHiddenBlocks(text);
      // 终态为准；没有终态的 item（只有 delta）用扫描器里剥到的
      finals.set(itemId, found);
      return visible;
    },
    flushAll() {
      const rest: Array<{ itemId: string; text: string }> = [];
      for (const [itemId, scanner] of scanners) {
        const text = scanner.end();
        if (text) rest.push({ itemId, text });
      }
      return rest;
    },
    async turnEnd() {
      const found = last === undefined ? emptyFound() : (finals.get(last) ?? scanners.get(last)?.found ?? emptyFound());
      reset();
      if (!options.onTurnEnd) return;
      if (found.remember.length || found.mem.length || found.dropped) await options.onTurnEnd(found);
    },
    abandon: reset,
  };
}

// ---- 会话 nonce ------------------------------------------------------------------------------------------------------

const NONCES_MAX = 2_048;
const nonces = new Map<string, string>();
const newNonce = (): string => randomBytes(5).toString('hex');
/**
 * 这条会话的隐藏块 / 使用标记 nonce，只放在 developer/system 通道的开场指令里。key 用 `thread.sessionId`。
 * 开场指令（P4a 的 context-assembly）和解析这里共用同一个值；压缩后整份重交时调 {@link rotateMemoryNonce} 换新的。
 */
export function memoryNonce(key: string): string {
  let nonce = nonces.get(key);
  if (!nonce) {
    nonce = newNonce();
    nonces.set(key, nonce);
    if (nonces.size > NONCES_MAX) nonces.delete(nonces.keys().next().value as string);
  }
  return nonce;
}
export function rotateMemoryNonce(key: string): string {
  nonces.delete(key);
  return memoryNonce(key);
}
export function forgetMemoryNonce(key: string): void { nonces.delete(key); }

/** 隐藏块的说明（开场指令里没有 memory 工具的会话用），照 §3.4 的原文，nonce 由调用方给 */
export function hiddenBlockInstructions(nonce: string): string {
  return [
    '没有 memory 工具时，把要记的东西放在回复最末尾，每条一个：',
    `<vonvon-remember n="${nonce}" scope="project" branch="决定" claim="asked">发版改到周四</vonvon-remember>`,
    'vonvon 会收走这个块。scope 只能是 project。branch 从项目记忆开头"分支："那一行里挑，都不合适才起一个 12 字以内的新名字。',
    '放了块的这一轮，正文里像平常说话一样带一句，比如"好，记住了"；不列记了什么、记在哪，不另发消息。',
  ].join('\n');
}

// ---- 入站标记全角化 ----------------------------------------------------------------------------------------------------

/**
 * 入站内容（触发消息、引用、合并转发展开、记录块）里能被解析的标记，确定性地换成全角字符：模型复述出来的也解析不了。
 * 只动 vonvon 自己会放的标记，别的尖括号和方括号不碰。
 */
const INBOUND_TAG = /<(\/?)(?=vonvon-(?:remember|mem)(?![\w-]))/gi;
const INBOUND_BRACKET = /\[(\/?)(?=\s*(?:vonvon\s*设置更新|项目记忆|Bot\s*记忆|角色设定|本项目的补充职责))/gi;
export function escapeInboundMarkers(text: string): string {
  if (!text) return text;
  return text.replace(INBOUND_TAG, (_all, slash: string) => `＜${slash}`).replace(INBOUND_BRACKET, (_all, slash: string) => `［${slash}`);
}

// ---- 没记上的提示（§3.4 最后一条）----------------------------------------------------------------------------------------

export const MEMORY_FULL_NOTICE = '项目记忆满了，记不进去；有人要你记，就说记不下了，请主人在 vonvon 里清理。';
export const missedNotice = (count: number, reasons: readonly string[]): string =>
  `上一轮有 ${count} 条没记上：${[...new Set(reasons)].join('、')}。有人问起或者要用到时照实说。`;

const NOTICES_MAX = 2_048;
const notices = new Map<string, { others: number; reasons: string[]; full: boolean }>();
/** 隐藏块没记上的原因（`memory-full` 单独算），攒到下一轮的更新块（P4a 的 context-assembly 调 {@link takeMemoryNotices} 取走） */
export function noteMissedBlocks(key: string, missed: readonly string[]): void {
  lastMissed.set(key, missed.map(describeMiss));
  if (lastMissed.size > NOTICES_MAX) lastMissed.delete(lastMissed.keys().next().value as string);
  if (!missed.length) { notices.delete(key); return; }
  const others = missed.filter(reason => reason !== 'memory-full');
  notices.set(key, { others: others.length, reasons: others.map(describeMiss), full: others.length < missed.length });
  if (notices.size > NOTICES_MAX) notices.delete(notices.keys().next().value as string);
}
/** 最近一轮没记上的原因（桌面端项目页显示"有 N 条没记上"，5.3），一轮一条原因、不带原文；取走即清，下一轮重新写 */
const lastMissed = new Map<string, string[]>();
export function takeLastMissed(key: string): string[] {
  const reasons = lastMissed.get(key) ?? [];
  lastMissed.delete(key);
  return reasons;
}
const MISS_TEXT: Record<string, string> = {
  'memory-full': '项目记忆满了',
  'bad-nonce': '标记不对', 'looks-like-secret': '像密钥', 'not-allowed-here': '这里不能记', 'no-project': '这个群没有绑定项目',
  duplicate: '已经记着了', 'bad-args': '内容不合要求', dropped: '块没写完整或太多',
};
const describeMiss = (reason: string): string => MISS_TEXT[reason] ?? reason;
export function takeMemoryNotices(key: string): string[] {
  const notice = notices.get(key);
  notices.delete(key);
  if (!notice) return [];
  const lines: string[] = [];
  if (notice.full) lines.push(MEMORY_FULL_NOTICE);
  if (notice.others > 0) lines.push(missedNotice(notice.others, notice.reasons));
  return lines;
}
