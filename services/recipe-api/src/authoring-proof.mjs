import { createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { binary32, sha256 } from './install-proof.mjs';
import { badInput } from './errors.mjs';

const domain = Buffer.from('vonvon.recipe.authoring.v1\0');
const keyInfo = Buffer.from('vonvon.recipe.authoring.proof-key.v1\0');
const spki = Buffer.from('302a300506032b656e032100', 'hex');
export const DISPATCH_DIGEST = sha256(Buffer.alloc(0)).toString('hex');

export function authoringTranscript(binding) {
  if (!['prepareDraft','editDraft'].includes(binding.purpose) || !['dispatch','accept'].includes(binding.stage)) throw badInput();
  const revision = Buffer.alloc(4), base = Buffer.alloc(4), deadline = Buffer.alloc(8);
  revision.writeUInt32BE(binding.stateRevision);
  base.writeUInt32BE(binding.baseRevision ?? 0);
  deadline.writeBigUInt64BE(BigInt(binding.deadline));
  return Buffer.concat([domain,
    ...[binding.operationId, binding.accountId, binding.draftId ?? '00000000-0000-0000-0000-000000000000']
      .map(id => Buffer.from(id.replaceAll('-', ''), 'hex')),
    binary32(binding.targetPublicKey), binary32(binding.nonceCommitment), binary32(binding.serverPublicKey),
    Buffer.from([binding.purpose === 'prepareDraft' ? 1 : 2, binding.stage === 'dispatch' ? 1 : 2]),
    Buffer.from(binding.payloadDigest, 'hex'), revision, base, deadline]);
}

function proof(privateKey, publicKey, binding) {
  const shared = diffieHellman({privateKey, publicKey});
  try {
    const key = Buffer.from(hkdfSync('sha256', shared, binary32(binding.nonceCommitment), keyInfo, 32));
    try { return createHmac('sha256', key).update(authoringTranscript(binding)).digest(); }
    finally { key.fill(0); }
  } finally { shared.fill(0); }
}

export function authoringProof(privateKey, binding) {
  return proof(privateKey, createPublicKey({key:Buffer.concat([spki, binary32(binding.serverPublicKey)]), format:'der', type:'spki'}), binding);
}

export function authoringMaterial(binding) {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const serverPublicKey = publicKey.export({format:'der', type:'spki'}).subarray(-32).toString('base64url');
  let expected;
  try {
    expected = proof(privateKey, createPublicKey({key:Buffer.concat([spki, binary32(binding.targetPublicKey)]), format:'der', type:'spki'}),
      {...binding, serverPublicKey});
    return {serverPublicKey, ticket:randomBytes(32), proofHash:sha256(expected)};
  } catch { throw badInput(); }
  finally { expected?.fill(0); }
}
