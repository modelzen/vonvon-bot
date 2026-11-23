import { badInput } from './errors.mjs';
import { checkDraft, objectKeys, uuid } from './input.mjs';
import { operationId } from './operation-input.mjs';
import { binary32 } from './install-proof.mjs';
import { DISPATCH_DIGEST } from './authoring-proof.mjs';

const blankPublic = () => ({name:'',summary:'',overview:'',version:'',access:'direct'});
export function canonicalJson(value, depth = 0) {
  if (depth > 16) throw badInput();
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key], depth + 1)).join(',') + '}';
  return JSON.stringify(value);
}
export const payloadBytes = value => Buffer.from(canonicalJson(value));

export function checkDraftPatch(patch) {
  objectKeys(patch, ['schemaVersion','draftId','baseRevision','changes']);
  uuid(patch.draftId);
  if (patch.schemaVersion !== 1 || !Number.isInteger(patch.baseRevision) || patch.baseRevision < 1 || patch.baseRevision > 2147483647 ||
      !Array.isArray(patch.changes) || !patch.changes.length || patch.changes.length > 16) throw badInput();
  const body = {public:blankPublic(), config:{role:''}};
  const touched = new Set();
  for (const change of patch.changes) {
    objectKeys(change, ['op','value'], change?.op === 'setPublicText' ? ['field'] : []);
    let field;
    if (change.op === 'setPublicText') {
      if (!['name','summary','overview','version'].includes(change.field)) throw badInput();
      body.public[change.field] = change.value;
      field = 'public.' + change.field;
    } else if (change.op === 'setDraftRole') {
      body.config.role = change.value;
      field = 'role';
    } else if (change.op === 'setSetup') {
      if (change.value !== null) body.config.setup = change.value;
      field = 'setup';
    } else throw badInput();
    if (touched.has(field)) throw badInput();
    touched.add(field);
  }
  checkDraft(body, false);
}

export function decodePayload(value) {
  if (typeof value !== 'string' || value.length > 180000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw badInput();
  const bytes = Buffer.from(value,'base64url');
  if (bytes.toString('base64url') !== value || bytes.length > 128 * 1024) throw badInput();
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { throw badInput(); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !bytes.equals(payloadBytes(payload))) throw badInput();
  if (Object.hasOwn(payload,'schemaVersion')) checkDraftPatch(payload);
  else checkDraft(payload,false);
  return bytes;
}

export function authoringInput(action, id, body) {
  operationId(id);
  if (action === 'registerAuthoring') {
    objectKeys(body,['purpose','targetPublicKey','nonceCommitment'],['draftId','baseRevision']);
    if (!['prepareDraft','editDraft'].includes(body.purpose)) throw badInput();
    binary32(body.targetPublicKey); binary32(body.nonceCommitment);
    if (body.purpose === 'editDraft') {
      uuid(body.draftId);
      if (!Number.isInteger(body.baseRevision) || body.baseRevision < 1 || body.baseRevision > 2147483647) throw badInput();
    } else if (Object.hasOwn(body,'draftId') || Object.hasOwn(body,'baseRevision')) throw badInput();
    return [id,body];
  }
  if (action === 'getAuthoring' || action === 'cancelAuthoring') { objectKeys(body,[]); return [id]; }
  if (action === 'authorizeAuthoring') {
    objectKeys(body,['stage','payloadDigest','stateRevision']);
    if (!['dispatch','accept'].includes(body.stage) || !/^[0-9a-f]{64}$/.test(body.payloadDigest) ||
        typeof body.payloadDigest !== 'string' || !Number.isInteger(body.stateRevision) || body.stateRevision < 1 || body.stateRevision > 2147483647 ||
        (body.stage === 'dispatch' && body.payloadDigest !== DISPATCH_DIGEST)) throw badInput();
    return [id,body];
  }
  objectKeys(body,['ticket','nonce','proof'],action === 'acceptAuthoring' ? ['payload'] : []);
  if (action === 'acceptAuthoring' && !Object.hasOwn(body,'payload')) throw badInput();
  return [id,binary32(body.ticket),binary32(body.nonce),binary32(body.proof),
    action === 'acceptAuthoring' ? decodePayload(body.payload) : null];
}
