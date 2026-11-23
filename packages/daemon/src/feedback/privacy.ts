import {isUtf8} from 'node:buffer';
import {looksLikeSecret} from '../bot/memory-secret-shape.js';
import {redactTokens} from '../core/token-redact.js';
import {feedbackDetailFields, type FeedbackSummary} from './types.js';

export class FeedbackPrivacyError extends Error {
  constructor(label: string) {
    super('「' + label + '」可能包含凭据或个人信息。请移除或遮盖后重新生成核对卡。');
    this.name = 'FeedbackPrivacyError';
  }
}

const fields = [
  ['title', '反馈标题'], ['description', '详细说明'], ['steps', '如何重现'], ['expected', '期望效果'],
  ['environment', '使用环境'], ...feedbackDetailFields,
] as const;

const sensitive = [
  /(?:\/(?:Users|home)\/|[A-Z]:[\\/]Users[\\/])[\p{L}\p{N}._-]+/iu,
  /\b(?:ou|on|oc|om)_[0-9a-f]{16,}\b/i,
  /\b[A-Z0-9.!#$%&'*+/=?^_{}|~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+\b/i,
  /(?<![0-9a-z])(?:\+?86[ -]?)?1[3-9]\d{9}(?![0-9a-z])/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:app[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|X-Amz-Signature)["']?\s*[:=]\s*["']?[a-z0-9+./_~=-]{8,}/i,
];

function checkText(value: string, label: string) {
  if (redactTokens(value) !== value || looksLikeSecret(value) || sensitive.some(pattern => pattern.test(value))) {
    throw new FeedbackPrivacyError(label);
  }
}

function checkFilename(name: string) {
  if (/^(?:\.env(?:\.(?!example$|sample$)[\w.-]+)?|id_(?:rsa|dsa|ecdsa|ed25519))$|\.(?:p12|pfx|key)$/i.test(name)) {
    throw new FeedbackPrivacyError('附件');
  }
  checkText(name, '附件名');
}

export function assertFeedbackTextPrivacy(summary: FeedbackSummary, filenames: readonly string[] = []) {
  for (const [key, label] of fields) {
    const value = summary[key];
    if (value) checkText(value, label);
  }
  for (const filename of filenames) checkFilename(filename);
}

export function assertFeedbackAttachmentPrivacy(filename: string, bytes: Buffer) {
  checkFilename(filename);
  let text: string;
  if (bytes.length >= 2 && (bytes.readUInt16BE(0) === 0xfffe || bytes.readUInt16BE(0) === 0xfeff)) {
    try {
      text = new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be', {fatal: true}).decode(bytes);
    } catch {
      throw new FeedbackPrivacyError('附件内容');
    }
  } else if (!bytes.includes(0) && isUtf8(bytes)) {
    text = bytes.toString('utf8');
  } else {
    if (/\.(?:txt|log|md|jsonl?|ya?ml|csv|ini|conf|xml)$/i.test(filename)) throw new FeedbackPrivacyError('附件内容');
    return;
  }
  // Split long text files with overlap so credentials at a chunk boundary are checked.
  const chunk = 16_384;
  for (let i = 0; i < text.length; i += chunk) {
    checkText(text.slice(Math.max(0, i - 256), i + chunk), '附件内容');
  }
}
