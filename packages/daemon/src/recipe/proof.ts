import { createHmac, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto';
import type { RecipeAuthorization } from '@vonvon/protocol';
import { deviceKeyPair, type DeviceIdentity } from '../remote/device';

const uuidBytes = (id: string): Buffer => Buffer.from(id.replaceAll('-', ''), 'hex');
export function installTranscript(input: RecipeAuthorization): Buffer {
  const generation = Buffer.alloc(4); generation.writeUInt32BE(input.generation);
  const deadline = Buffer.alloc(8); deadline.writeBigUInt64BE(BigInt(input.deadline));
  return Buffer.concat([
    Buffer.from('vonvon.recipe.installBoundRole.v1\0'), uuidBytes(input.operationId), uuidBytes(input.accountId), uuidBytes(input.versionId),
    Buffer.from(input.manifestSha256, 'hex'), Buffer.from(input.targetPublicKey, 'base64url'), Buffer.from(input.nonceCommitment, 'base64url'),
    Buffer.from(input.serverPublicKey, 'base64url'), generation, deadline,
  ]);
}
export function installProof(device: DeviceIdentity, authorization: RecipeAuthorization): string {
  const shared = diffieHellman({privateKey: deviceKeyPair(device).privateKey,
    publicKey: createPublicKey({key: {kty: 'OKP', crv: 'X25519', x: authorization.serverPublicKey}, format: 'jwk'})});
  const key = hkdfSync('sha256', shared, Buffer.from(authorization.nonceCommitment, 'base64url'), Buffer.from('vonvon.recipe.installBoundRole.proof-key.v1\0'), 32);
  return createHmac('sha256', Buffer.from(key)).update(installTranscript(authorization)).digest('base64url');
}
