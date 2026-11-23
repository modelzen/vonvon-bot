import { createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { badInput } from './errors.mjs';

const domain = Buffer.from('vonvon.recipe.installBoundRole.v1\0');
export const installProofKeyInfo = Buffer.from('vonvon.recipe.installBoundRole.proof-key.v1\0');
const spki = Buffer.from('302a300506032b656e032100', 'hex');
export const sha256 = bytes => createHash('sha256').update(bytes).digest();

export function binary32(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw badInput();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) throw badInput();
  return bytes;
}

export function installTranscript(binding) {
  const generation = Buffer.alloc(4);
  generation.writeUInt32BE(binding.generation);
  const deadline = Buffer.alloc(8);
  deadline.writeBigUInt64BE(BigInt(binding.deadline));
  return Buffer.concat([domain,
    ...[binding.operationId, binding.accountId, binding.versionId].map(id => Buffer.from(id.replaceAll('-', ''), 'hex')),
    Buffer.from(binding.manifestSha256, 'hex'), binary32(binding.targetPublicKey),
    binary32(binding.nonceCommitment), binary32(binding.serverPublicKey), generation, deadline]);
}

export function installProof(privateKey, binding) {
  const publicKey = createPublicKey({ key: Buffer.concat([spki, binary32(binding.serverPublicKey)]), format:'der', type:'spki' });
  const shared = diffieHellman({ privateKey, publicKey });
  try {
    const key = Buffer.from(hkdfSync('sha256', shared, binary32(binding.nonceCommitment), installProofKeyInfo, 32));
    try { return createHmac('sha256', key).update(installTranscript(binding)).digest(); }
    finally { key.fill(0); }
  } finally { shared.fill(0); }
}

export function authorizationMaterial(binding) {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const serverPublicKey = publicKey.export({ format:'der', type:'spki' }).subarray(-32).toString('base64url');
  const complete = { ...binding, serverPublicKey };
  let expected;
  try {
    const shared = diffieHellman({ privateKey,
      publicKey:createPublicKey({ key:Buffer.concat([spki, binary32(binding.targetPublicKey)]), format:'der', type:'spki' }) });
    try {
      const key = Buffer.from(hkdfSync('sha256', shared, binary32(binding.nonceCommitment), installProofKeyInfo, 32));
      try { expected = createHmac('sha256', key).update(installTranscript(complete)).digest(); }
      finally { key.fill(0); }
    } finally { shared.fill(0); }
  } catch { throw badInput(); }
  try {
    return { serverPublicKey, proofHash:sha256(expected), ticket:randomBytes(32) };
  } finally { expected.fill(0); }
}
