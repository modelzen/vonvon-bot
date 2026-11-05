import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { cleanFileName, downloadName, imageExtension, MAX_FILE_BYTES, prepareInboundDir, readHeader, saveInboundDownload } from '../bot/media';
import { withDeadline } from '../bot/names';
import { escapeInboundMarkers } from '../bot/hidden-blocks';
import { log } from '../core/logger';
import { apiRefusalOf, FeishuReadRefused } from './denial';
import { denialContext, RESULT_BUDGET, sliceText, type ReadDeps } from './shared';

/**
 * `feishu_api` (dm-agent 7.6): any Feishu API with the Bot's tenant token. The checks on `path` stop mistakes, they are
 * not a boundary (6.1): the session has full access. The answer is Feishu's own text, or a file for anything binary.
 */
type ApiValue = string | number | boolean;
export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  params?: Record<string, ApiValue | ApiValue[]>;
  body?: Record<string, unknown>;
}
/** Feishu's text, or where a binary answer was saved. */
export type ApiResult = string | { path: string; name: string; bytes: number; contentType?: string };
type RawAnswer = { data: ArrayBuffer | Uint8Array; headers: unknown };

/** One call and its body, up to a {@link MAX_FILE_BYTES} download; the registry's 70 seconds do not stop a call past its commit. */
const CALL_MS = 60_000;
/** How much of an error's body goes back. */
const ERROR_BUDGET = 8 * 1024;
/** More than a result can hold, as bytes: the rest of a long text is neither decoded nor scanned. */
const TEXT_BYTES = 2 * RESULT_BUDGET;
/** Feishu's errors are short: a longer answer is not parsed just to look for one. */
const CODE_BYTES = 1024 * 1024;

const refused = (message: string): FeishuReadRefused => new FeishuReadRefused(message);
/** Feishu's text unchanged but for vonvon's own markers, the boundary every read has (cleanText would also redo its white space). */
const textOf = (body: Buffer): string => escapeInboundMarkers(body.subarray(0, TEXT_BYTES).toString('utf8'));

/** Whether `bot` is the one this process is: any other's call goes through the host to that Bot's (dm-agent 7.3). */
export const isThisBot = (deps: ReadDeps, bot: string): boolean => bot === deps.app.id || bot === deps.channel.botIdentity?.name;

/** `path` as it may be sent: the host stays this Bot's tenant's, because the SDK only takes a URL as it is from `http`. */
export function checkedPath(path: string): string {
  if (!path.startsWith('/open-apis/')) throw refused('path 要以 /open-apis/ 开头，只写路径，不写完整网址。');
  if (/[^\x21-\x7e]|[\\?#]/.test(path)) throw refused('path 里不能有空格、中文、反斜杠、? 和 #：查询参数写进 params，别的字符先做 URL 编码。');
  let decoded: string;
  try { decoded = decodeURIComponent(path); }
  catch { throw refused('path 里的 % 编码不对。'); }
  const segments = decoded.split(/[\\/]/).filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..')) throw refused('path 里不能有 . 或 .. 这样的路径段。');
  if (segments[1]?.toLowerCase() === 'auth') throw refused('/open-apis/auth/ 是换令牌的接口，调不了：工具已经用 Bot 的令牌了。');
  return path;
}

/** Arrays as Feishu reads them: `a=1&a=2`, as the SDK's own calls send them. */
function query(params: NonNullable<ApiRequest['params']>): string {
  const out = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) for (const item of [value].flat()) out.append(name, String(item));
  return out.toString();
}

function parsed(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

/** Why no answer came, in words that keep a change from being repeated blindly: only a GET surely changed nothing. */
function noAnswer(request: ApiRequest): FeishuReadRefused {
  return new FeishuReadRefused(request.method === 'GET' ? '没连上飞书，稍后再试。' : '飞书没有回话，不知道这次调用生效没有。先查一下，再决定要不要重试。', 'no-answer');
}

/** A refused answer's body in Feishu's words, through the same boundary as what a read returns. */
function failed(deps: ReadDeps, request: ApiRequest, body: Buffer, status?: number): FeishuReadRefused {
  const said = sliceText(textOf(body).trim(), 0, ERROR_BUDGET).text;
  const http = status ? `HTTP ${status}` : '';
  return apiRefusalOf(denialContext(deps), body.length <= CODE_BYTES ? parsed(body.toString('utf8')) : undefined, said ? [http, said].filter(Boolean).join(' ') : `${http || '错误'}，没有内容`, request.method !== 'GET');
}

/** An answer's bytes: what this call asks for, but the SDK's own token request hands back parsed JSON. */
function bodyOf(data: unknown): Buffer {
  if (data === undefined || data === null) return Buffer.alloc(0);
  if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return Buffer.from(data as Uint8Array);
  return Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
}

function failureOf(deps: ReadDeps, request: ApiRequest, failure: unknown): FeishuReadRefused {
  const { response, message } = failure as { response?: { data?: unknown; status?: number }; message?: unknown };
  if (typeof message === 'string' && message.includes('maxContentLength')) return refused(`响应超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 上限，存不下。缩小范围再调。`);
  // The SDK gets its token first, and says so when it cannot: the call itself never went out.
  if (typeof message === 'string' && message.startsWith('failed to get ')) return refused(`没拿到 Bot「${denialContext(deps).botName()}」的飞书令牌，这次调用没有发出去。飞书的原话：${message}`);
  if (response) return failed(deps, request, bodyOf(response.data), response.status);
  log.warn('feishu-read', 'api-failed', { method: request.method, err: String(failure) });
  return noAnswer(request);
}

/** A file only when the answer says so: a download's disposition, or a type that is not text. An untyped answer goes by its bytes. */
function isText(headers: unknown, body: Buffer): boolean {
  if (/attachment/i.test(readHeader(headers, 'content-disposition') ?? '')) return false;
  const type = readHeader(headers, 'content-type')?.toLowerCase();
  return type ? /^text\/|[/+](json|xml)\b/.test(type) : !body.subarray(0, 8192).includes(0);
}

/** Feishu's text whole if it fits; else its start, saying so first, in case what shows the model the result cuts the end too. */
function textResult(body: Buffer): string {
  const text = textOf(body);
  if (!text.trim()) return '飞书返回成功，没有内容。';
  const { text: part, next } = sliceText(text, 0, RESULT_BUDGET);
  if (next === undefined && body.length <= TEXT_BYTES) return part;
  const kb = (bytes: number) => Math.ceil(bytes / 1024);
  return `[结果太长，被截断了：这里是前 ${kb(Buffer.byteLength(part))} KB，一共 ${kb(body.length)} KB。缩小范围或者翻页再调，比如 page_size、page_token。]\n${part}`;
}

async function saved(body: Buffer, headers: unknown): Promise<ApiResult> {
  const type = readHeader(headers, 'content-type')?.split(';')[0]?.trim();
  const name = cleanFileName(downloadName(headers)) || `feishu-api.${type?.startsWith('image/') ? imageExtension(headers) : 'bin'}`;
  await prepareInboundDir();
  const file = await saveInboundDownload({ headers, writeFile: path => writeFile(path, body) }, `api-${randomBytes(6).toString('hex')}`, name);
  if ('reason' in file) throw refused(`没存下来：${file.reason}。`);
  return { path: file.path, name: file.name, bytes: body.length, ...(type ? { contentType: type } : {}) };
}

export async function callApi(deps: ReadDeps, request: ApiRequest, beforeSend: () => void = () => undefined): Promise<ApiResult> {
  const url = checkedPath(request.path);
  const { method, params, body } = request;
  beforeSend();
  // Whichever it turns out to be, text or a file, the body comes whole: axios refuses it past maxContentLength.
  const abort = new AbortController();
  const call = deps.channel.rawClient.request<RawAnswer>({
    method, url, ...(params ? { params, paramsSerializer: { serialize: query } } : {}), ...(body ? { data: body } : {}),
    responseType: 'arraybuffer', maxContentLength: MAX_FILE_BYTES, signal: abort.signal, $return_headers: true,
  } as Parameters<typeof deps.channel.rawClient.request>[0]);
  let answer: RawAnswer | undefined;
  try {
    answer = await withDeadline(call, CALL_MS, 'feishu-api');
  } catch (failure) {
    throw failureOf(deps, request, failure);
  }
  if (!answer) { abort.abort(); throw noAnswer(request); }
  const content = Buffer.from(answer.data as Uint8Array);
  if (!isText(answer.headers, content)) return saved(content, answer.headers);
  const { code } = (content.length <= CODE_BYTES ? parsed(content.toString('utf8')) ?? {} : {}) as { code?: unknown };
  if (typeof code === 'number' && code !== 0) throw failed(deps, request, content);
  return textResult(content);
}
