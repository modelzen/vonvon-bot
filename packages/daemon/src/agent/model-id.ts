/**
 * 手填的模型 id（product.md 3.11）。不按模型列表做白名单：第三方网关的 id 千奇百怪
 * （`moonshotai/kimi-k2`、`qwen2.5-coder:7b`、`claude-opus-4-8[1m]`、
 * `us.anthropic.claude-sonnet-4-5-v1:0`），列表里没有也照样传给后端，错了由后端在
 * 回合里报错。这里只挡显然不是 id 的输入：空白、控制字符、能在飞书 markdown 里
 * 拼出标签或代码块的字符、像命令行参数的开头，以及卡片下拉的保留值。
 */

/** Reserved select value that switches the adjacent free-text input on. Never a
 * real model id. */
export const CUSTOM_MODEL_OPTION = '__bridge_custom_model__';

/** Matches the Feishu input's max_length on the cards. */
export const MODEL_ID_MAX_LENGTH = 200;

export type ModelIdParseResult = { ok: true; id: string } | { ok: false; message: string };

export function parseModelId(raw: string | undefined): ModelIdParseResult {
  const id = raw?.trim() ?? '';
  if (!id) return { ok: false, message: '请填写模型 ID。' };
  if (id.length > MODEL_ID_MAX_LENGTH) return { ok: false, message: `模型 ID 不能超过 ${MODEL_ID_MAX_LENGTH} 个字符。` };
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f`<>]/.test(id)) return { ok: false, message: '模型 ID 不能包含空格、换行、反引号或尖括号。' };
  if (id.startsWith('-')) return { ok: false, message: '模型 ID 不能以 - 开头。' };
  if (id === CUSTOM_MODEL_OPTION) return { ok: false, message: '请填写模型 ID。' };
  return { ok: true, id };
}
