/**
 * 记忆条目里的密钥检测（记忆设计 §6"密钥"）。`protocol/secrets.ts` 的 `API_KEY_SHAPE` 校验的是整串可见 ASCII，
 * `token-redact.ts` 只认 `vvs1_`，都不能拿来扫一句话，所以这里按子串找常见密钥的形状。
 * 这是给"不小心把密钥说出口"挡一道，不是边界：命中了就拒写，宁可误拒，主人能在桌面端自己写。
 */

export type SecretShape =
  | 'openai-key' | 'anthropic-key' | 'github-token' | 'slack-token' | 'aws-key-id' | 'google-api-key'
  | 'jwt' | 'private-key' | 'app-secret' | 'high-entropy';

// A token starts at a boundary, so "task-force" and "desk-lamp" do not look like `sk-`.
const START = String.raw`(?<![A-Za-z0-9_-])`;
const PATTERNS: ReadonlyArray<readonly [SecretShape, RegExp]> = [
  ['anthropic-key', new RegExp(`${START}sk-ant-[A-Za-z0-9_-]{8,}`)],
  ['openai-key', new RegExp(`${START}sk-[A-Za-z0-9_-]{16,}`)],
  ['github-token', new RegExp(`${START}(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}`)],
  ['github-token', new RegExp(`${START}github_pat_[A-Za-z0-9_]{20,}`)],
  ['slack-token', new RegExp(`${START}xox[abp]-[A-Za-z0-9-]{8,}`)],
  ['aws-key-id', new RegExp(`${START}AKIA[0-9A-Z]{16}(?![A-Za-z0-9])`)],
  ['google-api-key', new RegExp(`${START}AIza[A-Za-z0-9_-]{30,}`)],
  ['jwt', new RegExp(`${START}eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}`)],
  ['private-key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/],
];
// 飞书 app secret：32 位字母数字
const APP_SECRET = /(?<![A-Za-z0-9])(?=[A-Za-z0-9]{32}(?![A-Za-z0-9]))(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{32}(?![A-Za-z0-9])/;
const LONG_TOKEN = /[A-Za-z0-9_+=-]{32,}|[A-Za-z0-9+/]{40,}={0,2}/g;
const GIT_SHA = /^[0-9a-f]{40}$/;
// 飞书的 open_id / chat_id / union_id（ou_ oc_ om_ + 32 位小写十六进制）和 32 位十六进制的 trace id 不是密钥
const FEISHU_ID = /^o[cum]_[0-9a-f]{32}$/;
const HEX_ID = /^[0-9a-f]{32}$/;
const isIdentifier = (token: string): boolean => FEISHU_ID.test(token) || HEX_ID.test(token);

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) { const p = count / value.length; bits -= p * Math.log2(p); }
  return bits;
}

/** The kind of secret the text looks like, or undefined. A path such as `/var/log/pay` and a git commit id pass. */
export function findSecretShape(text: string): SecretShape | undefined {
  for (const [shape, pattern] of PATTERNS) if (pattern.test(text)) return shape;
  const secret = APP_SECRET.exec(text);
  if (secret && !isIdentifier(secret[0]) && /[0-9]/.test(secret[0]) && entropy(secret[0]) >= 3.5) return 'app-secret';
  for (const [token] of text.matchAll(LONG_TOKEN)) {
    if (GIT_SHA.test(token) || isIdentifier(token)) continue;
    // ≥ 32 high-entropy characters with letters and digits both; long words and plain base names are not that.
    // A token joined by - or _ (a slug like deploy-config-staging-us-west-2) counts only when it also mixes cases.
    const words = /[-_]/.test(token) && !(/[a-z]/.test(token) && /[A-Z]/.test(token));
    if (!words && /[A-Za-z]/.test(token) && /[0-9]/.test(token) && entropy(token) >= 3.6) return 'high-entropy';
  }
  return undefined;
}

export const looksLikeSecret = (text: string): boolean => findSecretShape(text) !== undefined;
