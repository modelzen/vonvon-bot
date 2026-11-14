import { hasAuthoringLocalPath, safeEditValue } from '../../../../services/recipe-api/src/draft-model-text.mjs';
import { createHash } from 'node:crypto';
// @ts-expect-error Shared with the HTTP API to preserve byte-for-byte validation and proof compatibility.
import { canonicalJson, checkDraftPatch } from '../../../../services/recipe-api/src/authoring-input.mjs';
// @ts-expect-error The HTTP API's field and credential validator.
import { checkDraft } from '../../../../services/recipe-api/src/input.mjs';

export const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
export const dispatchDigest = digest('');
export const blankPublic = () => ({name: '', summary: '', overview: '', version: '', access: 'direct' as const});
export function hasLocalPath(value: unknown): boolean {
  if (typeof value === 'string') return hasAuthoringLocalPath(value);
  return Boolean(value && typeof value === 'object' && Object.values(value).some(hasLocalPath));
}
export function freezePayload(payload: object): {payload: string; payloadDigest: string} {
  try {
    if ('schemaVersion' in payload) {
      checkDraftPatch(payload);
      if (!safeEditValue(payload)) throw new Error();
    } else {
      checkDraft(payload, false);
      if (hasLocalPath(payload)) throw new Error();
    }
    const bytes = Buffer.from(canonicalJson(payload), 'utf8');
    if (bytes.length > 128 * 1024) throw new Error();
    return {payload: bytes.toString('base64url'), payloadDigest: digest(bytes)};
  } catch { throw new Error('所选内容含敏感信息或超出草稿字段限制，请在 App 核对。'); }
}
