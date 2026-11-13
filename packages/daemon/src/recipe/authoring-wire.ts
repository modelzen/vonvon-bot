import { hasLocalPath } from './authoring-payload';
import { checkModelText, fieldLabels, interpretDraftAnswer, relativeEdit, requestedField, type DraftField, type DraftInstructionParser, type DraftInterpretation, type PublicField, type CandidateCardDetails } from './draft-instruction';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { authoringChangeSchema, type AuthoringAuthorization } from '@vonvon/protocol';
// @ts-expect-error The cloud service exports plain ESM. tsup bundles these same implementations into the daemon.
import { authoringProof } from '../../../../services/recipe-api/src/authoring-proof.mjs';
export {blankPublic, digest, dispatchDigest, freezePayload} from './authoring-payload';
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

export function candidateCardDetails(payload?: string): CandidateCardDetails | undefined {
  if (!payload) return;
  const patch = JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
  if (patch.schemaVersion !== 1 || !Number.isSafeInteger(patch.baseRevision)) return;
  const changes = authoringChangeSchema.array().max(16).parse(patch.changes);
  return {revision:patch.baseRevision, fields:changes.map(change =>
    change.op === 'setPublicText' ? fieldLabels[change.field] : change.op === 'setDraftRole' ? '角色' : '使用前准备')};
}

const restricted = /(?:忽略.{0,10}(?:指令|约束|规则)|(?:执行|运行|启动|启用).{0,12}(?:脚本|命令|任务|调度)|(?:读取|查询|加入|导出).{0,8}(?:私聊|记忆|文件)|(?:删除|清空).{0,8}(?:目录|文件)|(?:直接|马上|立即|不用确认.{0,5})发布|\b(?:ignore (?:all |previous )?(?:instructions|rules)|execute|publish|run (?:a |the )?(?:command|script|task)|read (?:my |the )?(?:files|private chat))\b)/iu;
export async function parseChanges(instruction: string, options: {
  parser?: DraftInstructionParser; signal: AbortSignal; readField?: (field: PublicField) => Promise<DraftField | undefined>;
}): Promise<DraftInterpretation> {
  if ([...instruction].length > 2000 || hasLocalPath(instruction)) throw new Error('请在 App 编辑。');
  const match = /^\/recipe\s+(name|summary|overview|version|role|setup)(?:\s+([\s\S]*))?$/i.exec(instruction);
  if (match) {
    const field = match[1]!.toLowerCase(), value = match[2] ?? '';
    const change = field === 'role' ? {op:'setDraftRole', value} :
      field === 'setup' ? {op:'setSetup', value:JSON.parse(value)} : {op:'setPublicText',field,value};
    return {kind:'proposal',changes:[authoringChangeSchema.parse(change)]};
  }
  if (instruction.startsWith('/')) return {kind:'unavailable'};
  checkModelText(instruction);
  if (restricted.test(instruction)) return {kind:'refuse'};
  if (!options.parser) return {kind:'unavailable'};
  let current: DraftField | undefined;
  if (relativeEdit(instruction)) {
    const field = requestedField(instruction);
    if (!field || !options.readField) return {kind:'clarify'};
    current = await options.readField(field);
    if (!current || current.field !== field) return {kind:'clarify'};
    checkModelText(current.value);
  }
  options.signal.throwIfAborted();
  const input = {instruction, ...(current ? {current:{field:current.field,value:current.value}} : {})};
  const result = await options.parser.propose(input,options.signal);
  options.signal.throwIfAborted();
  return interpretDraftAnswer(result,input);
}
