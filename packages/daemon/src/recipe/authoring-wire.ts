import { createHash, createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { authoringChangeSchema, type AuthoringAuthorization, type AuthoringChange } from '@vonvon/protocol';
// @ts-expect-error The cloud service exports plain ESM. tsup bundles these same implementations into the daemon.
import { authoringProof } from '../../../../services/recipe-api/src/authoring-proof.mjs';
// @ts-expect-error Shared with the HTTP API to preserve byte-for-byte validation and proof compatibility.
import { canonicalJson, checkDraftPatch } from '../../../../services/recipe-api/src/authoring-input.mjs';
// @ts-expect-error The HTTP API's field and credential validator.
import { checkDraft } from '../../../../services/recipe-api/src/input.mjs';

export const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
export const dispatchDigest = digest('');
export const blankPublic = () => ({name: '', summary: '', overview: '', version: '', access: 'direct' as const});
const localPath = /(?:^|[\s"'(])(?:\/(?:Users|home|root|private|var|tmp|etc|mnt|Volumes)\/|~\/|[A-Za-z]:[\\/]|\\\\[a-zA-Z0-9])/;

function hasLocalPath(value: unknown): boolean {
  if (typeof value === 'string') return localPath.test(value);
  return Boolean(value && typeof value === 'object' && Object.values(value).some(hasLocalPath));
}
export function freezePayload(payload: object): {payload: string; payloadDigest: string} {
  try {
    if (hasLocalPath(payload)) throw new Error();
    if ('schemaVersion' in payload) checkDraftPatch(payload);
    else checkDraft(payload, false);
    const bytes = Buffer.from(canonicalJson(payload), 'utf8');
    if (bytes.length > 128 * 1024) throw new Error();
    return {payload: bytes.toString('base64url'), payloadDigest: digest(bytes)};
  } catch { throw new Error('所选内容含敏感信息或超出草稿字段限制，请在 App 核对。'); }
}
export function newAuthoringKey() {
  const {privateKey} = generateKeyPairSync('x25519');
  const key = privateKey.export({format: 'jwk'});
  const nonce = randomBytes(32);
  return {targetPublicKey: key.x!, secret: key.d!, nonce: nonce.toString('base64url'),
    nonceCommitment: createHash('sha256').update(nonce).digest('base64url')};
}
export function makeAuthoringProof(secret: string, binding: AuthoringAuthorization): string {
  const privateKey = createPrivateKey({format: 'jwk', key: {kty: 'OKP', crv: 'X25519', x: binding.targetPublicKey, d: secret}});
  return (authoringProof(privateKey, binding) as Buffer).toString('base64url');
}

export interface DraftInstructionParser {
  propose(instruction: string): Promise<unknown>;
}
export async function parseChanges(instruction: string, parser?: DraftInstructionParser): Promise<AuthoringChange[]> {
  if ([...instruction].length > 2000 || hasLocalPath(instruction)) throw new Error('请在 App 编辑。');
  // Check even the instruction before passing it to the optional external text-only parser.
  freezePayload({public: blankPublic(), config: {role: instruction}});
  const match = /^\/recipe\s+(name|summary|overview|version|role|setup)(?:\s+([\s\S]*))?$/i.exec(instruction);
  let changes: unknown;
  if (match) {
    const field = match[1]!.toLowerCase(), value = match[2] ?? '';
    if (field === 'role') changes = [{op: 'setDraftRole', value}];
    else if (field === 'setup') changes = [{op: 'setSetup', value: JSON.parse(value)}];
    else changes = [{op: 'setPublicText', field, value}];
  } else if (parser) {
    changes = await parser.propose(instruction);
  } else throw new Error('请使用配方编辑命令。');
  return authoringChangeSchema.array().min(1).max(16).parse(changes);
}
