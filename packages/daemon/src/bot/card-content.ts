import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

/**
 * Recover the real text of an `interactive` (card 2.0) message that Feishu
 * delivers to bots only as a downgraded placeholder.
 *
 * Why this exists: when a card 2.0 / CardKit interactive card is *received* by a
 * bot (e.g. a 多维表格「发送消息卡片」自动化, or any app-sent card), the push
 * event — and the default `im.v1.message.get` body — carry a degraded legacy
 * representation: `{"title":"…","elements":[[{"tag":"text","text":"请升级至最新
 * 版本客户端，以查看内容"}]]}`. The actual body (markdown, links, the Base record
 * URL) is NOT in it, so the SDK's converter walks it to nothing and yields the
 * `[interactive card]` fallback — codex then sees no usable content.
 *
 * The full card is only returned when the message is fetched with
 * `card_msg_content_type=raw_card_content`, which gives a `json_card` in the
 * property-wrapped card-builder schema (distinct from the send-format schema the
 * SDK's walkCard handles). We re-fetch that here and extract its text + links so
 * codex reads「请处理这条记录 [查看…](base链接)」and can follow the link.
 *
 * Pulled history and quote lookups ask for `user_card_content` instead, the
 * send-format JSON (e10), read by {@link extractSendCardText}.
 */

/** True when the normalized card content is a downgraded placeholder (no real
 * body), so a `raw_card_content` re-fetch is worth it. Covers the SDK's
 * `[interactive card]` fallback and the literal「请升级…」client placeholder. */
export function isDegradedCardContent(content: string): boolean {
  const t = content.trim();
  if (t === '' || t === '[interactive card]') return true;
  return /请升级至最新版本客户端|请使用新版本.*查看|client to view|upgrade .*client/i.test(t);
}

/** Unwrap the `card_msg_content_type=raw_card_content` body: the API returns
 * `{"json_card":"<stringified card>","json_attachment":{…}}`. Returns the parsed
 * `json_card` object, the parsed body itself if it isn't wrapped, or undefined on
 * malformed JSON. */
export function parseRawCardWrapper(bodyContent: string): unknown {
  try {
    const parsed = JSON.parse(bodyContent) as Record<string, unknown>;
    if (typeof parsed.json_card === 'string') return JSON.parse(parsed.json_card);
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Extract readable text + links from the `raw_card_content` (json_card) schema —
 * the property-wrapped card-builder format where text lives in
 * `property.content`, links pair it with `property.url.url`, and structure nests
 * under `property.elements / columns / actions / title / text`. A multilingual
 * footer (`property.i18nElements`) is rendered in one locale only (zh_cn first)
 * to avoid 5× duplication. Output lines are de-duplicated, order preserved.
 */
export function extractRawCardText(jsonCard: unknown): string {
  const out: string[] = [];
  visit(jsonCard, out);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const piece of out) {
    const key = piece.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    lines.push(key);
  }
  return lines.join('\n');
}

function visit(node: unknown, out: string[]): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, out);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  // Top-level containers (header first so the card title leads the body).
  if (obj.header) visit(obj.header, out);
  if (obj.body) visit(obj.body, out);

  const prop = obj.property as Record<string, unknown> | undefined;
  if (!prop) return;

  // Leaf text: plain_text / link / markdown-leaf. A link pairs content with a URL.
  if (typeof prop.content === 'string' && prop.content.trim()) {
    const url = (prop.url as { url?: string } | undefined)?.url;
    out.push(url ? `[${prop.content.trim()}](${url})` : prop.content);
  }

  // Multilingual footer — keep one locale (else the「来自 …」line repeats ×5).
  const i18n = prop.i18nElements as Record<string, unknown> | undefined;
  if (i18n && typeof i18n === 'object') {
    visit(i18n.zh_cn ?? i18n.zh_hk ?? i18n.zh_tw ?? i18n.en_us ?? Object.values(i18n)[0], out);
  }

  // Nested structure: titles, button labels, rows/columns, action groups.
  visit(prop.title, out);
  visit(prop.text, out);
  visit(prop.elements, out);
  visit(prop.columns, out);
  visit(prop.actions, out);
}

/** True when a parsed `interactive` body is a card in the send format, as a
 * pull with `card_msg_content_type=user_card_content` returns it (e10), rather
 * than the down-converted `{title, elements:[[node…]]}` shape. */
export function isSendCard(card: unknown): boolean {
  if (!card || typeof card !== 'object') return false;
  const c = card as Record<string, unknown>;
  if (c.schema || c.body || c.header || c.config || c.i18n_elements) return true;
  return Array.isArray(c.elements) && c.elements.some((e) => e && typeof e === 'object' && !Array.isArray(e));
}

/** Whether a card body (the raw JSON string) is still streaming (`config.streaming_mode`). */
export function isStreamingCard(content: string | undefined): boolean {
  try {
    const card = JSON.parse(content ?? '') as { config?: { streaming_mode?: unknown } } | null;
    return card?.config?.streaming_mode === true;
  } catch {
    return false;
  }
}

/**
 * Readable text of a send-format card: schema 2.0 (`header` + `body.elements`)
 * or 1.0 (`header` + `elements`). Only what reads as the answer is kept:
 * collapsible panels (a Vonvon card keeps its process and tool output there),
 * notation-size lines and notes (status, such as the context meter), images,
 * buttons and rules are skipped. Lines are de-duplicated, order kept; '' when
 * nothing readable remains.
 *
 * `user_card_content` drops text sizes and colours, so on a pulled card the
 * notation check never fires. A Vonvon run card's status lines are told by
 * their text instead: a line that is grey as a whole and is one of Vonvon's
 * own status texts (用时, 已压缩), and the context meter. `<font>` tags are removed and their text kept.
 */
export function extractSendCardText(card: unknown): string {
  if (!card || typeof card !== 'object') return '';
  const c = card as Record<string, unknown>;
  const out: string[] = [];
  const header = (c.header ?? localized(c.i18n_header)) as { title?: unknown } | undefined;
  push(out, textOf(header?.title));
  const body = c.body as { elements?: unknown; i18n_elements?: unknown } | undefined;
  sendElements(body?.elements ?? localized(body?.i18n_elements) ?? c.elements ?? localized(c.i18n_elements), out);
  return [...new Set(out)].join('\n');
}

/** One locale of an i18n map (zh_cn first). */
function localized(v: unknown): unknown {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  return m.zh_cn ?? m.zh_hk ?? m.zh_tw ?? m.en_us ?? Object.values(m)[0];
}

/** A text object's `content`, else one locale of its `i18n_content`. */
function textOf(t: unknown): unknown {
  const x = t && typeof t === 'object' ? (t as { content?: unknown; i18n_content?: unknown }) : undefined;
  return typeof x?.content === 'string' && x.content.trim() ? x.content : localized(x?.i18n_content);
}

function push(out: string[], v: unknown): void {
  if (typeof v !== 'string') return;
  const grey = WHOLE_GREY.exec(v.trim())?.[1]?.trim();
  if ((grey !== undefined && VONVON_GREY_STATUS.test(grey)) || RUN_CARD_METER.test(v.trim())) return;
  const line = v.replace(FONT_TAG, '').trim();
  if (line) out.push(line);
}

const FONT_TAG = /<\/?font\b[^>]*>/g;
/** One `<font color='grey'>` around the whole text, as Vonvon writes a status line. */
const WHOLE_GREY = /^<font color=['"]?grey['"]?>((?:(?!<\/?font\b).)*)<\/font>$/s;
/** Vonvon's own grey lines: `processTitle`, `compactionLine`, `footerStatus` and the usage card's stamp.
 * Another bot's grey answer or caveat is kept. */
const VONVON_GREY_STATUS = /^(?:(?:❌ )?(?:执行过程|已处理 |用时 )|🗜️ |🤖 由 Vonvon Bot 于 |→ (?:还)?想 @ |(?:正在处理|正在调用工具|瞬断，自动重试中…|正在输出|已达单卡容量，后续内容见下一张卡片|过程已折叠，最终答复见下一张卡片)$)/u;
/** The context meter of a Vonvon run card (`runCardMeter`). */
const RUN_CARD_METER = /^(?:[🟡🟠🔴] )?上下文 (?:\d+% · \S+\/\S+|已用 \S+|—)$/u;

function sendElements(els: unknown, out: string[]): void {
  if (!Array.isArray(els)) return;
  for (const el of els) {
    if (!el || typeof el !== 'object') continue;
    const e = el as Record<string, unknown>;
    switch (e.tag) {
      case 'collapsible_panel':
      case 'note':
      case 'img':
      case 'img_combination':
      case 'button':
      case 'action':
      case 'hr':
        break;
      case 'markdown':
      case 'plain_text':
      case 'lark_md':
        if (e.text_size !== 'notation') push(out, textOf(e));
        break;
      case 'div': {
        const t = e.text as { text_size?: unknown } | undefined;
        if (t?.text_size !== 'notation') push(out, textOf(t));
        for (const f of Array.isArray(e.fields) ? e.fields : []) push(out, textOf((f as { text?: unknown } | null)?.text));
        break;
      }
      case 'column_set':
        for (const col of Array.isArray(e.columns) ? e.columns : []) sendElements((col as { elements?: unknown } | null)?.elements, out);
        break;
      default:
        // Containers (form, interactive_container, column, …) hold elements.
        sendElements(e.elements, out);
    }
  }
}

/**
 * Re-fetch a received interactive card with `card_msg_content_type=raw_card_content`
 * and return its extracted text, or undefined if the fetch fails / yields nothing
 * (caller keeps the degraded content). Best-effort: needs the `im:message` read
 * scope the bot already uses to receive messages.
 */
export async function fetchInteractiveCardText(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  let body: string | undefined;
  try {
    const res = await channel.rawClient.im.v1.message.get({
      path: { message_id: messageId },
      params: { card_msg_content_type: 'raw_card_content' },
    });
    body = (res.data as { items?: { body?: { content?: string } }[] } | undefined)?.items?.[0]?.body?.content;
  } catch (err) {
    log.warn('intake', 'card-content-fetch-failed', { messageId, err: String(err) });
    return undefined;
  }
  if (!body) return undefined;
  const card = parseRawCardWrapper(body);
  if (card == null) return undefined;
  const text = extractRawCardText(card);
  return text.trim() ? text : undefined;
}
