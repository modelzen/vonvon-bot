import { badInput } from './errors.mjs';
import { objectKeys, uuid } from './input.mjs';
import { binary32 } from './install-proof.mjs';

export function operationId(value) {
  const id = uuid(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw badInput();
  return id;
}

export function operationInput(action, id, body) {
  operationId(id);
  if (action === 'authorizeOperation') {
    objectKeys(body, ['purpose', 'versionId', 'manifestSha256', 'targetPublicKey', 'nonceCommitment', 'generation']);
    if (body.purpose !== 'installBoundRole' || body.generation !== 1 ||
        typeof body.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.manifestSha256)) throw badInput();
    const versionId = uuid(body.versionId);
    binary32(body.targetPublicKey);
    binary32(body.nonceCommitment);
    return [id, { ...body, versionId }];
  }
  if (action === 'cancelOperation') { objectKeys(body, []); return [id]; }
  objectKeys(body, ['ticket', 'nonce', 'proof'], action === 'completeOperation' ? ['outcome'] : []);
  if (action === 'completeOperation' && !['applied', 'rejected'].includes(body.outcome)) throw badInput();
  return [id, binary32(body.ticket), binary32(body.nonce), binary32(body.proof),
    ...(action === 'completeOperation' ? [body.outcome] : [])];
}
