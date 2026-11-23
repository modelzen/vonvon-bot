import { createHmac, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto';
import type { RecipeRichInstallAuthorization } from '@vonvon/protocol';
import { deviceKeyPair, type DeviceIdentity } from '../remote/device';
export type RichProofStage = 'redeem' | 'applied' | 'rejected';
const uuid = (value: string) => Buffer.from(value.replaceAll('-', ''), 'hex');
export function richInstallTranscript(b: RecipeRichInstallAuthorization, stage: RichProofStage): Buffer {
  const numbers = Buffer.alloc(12);
  numbers.writeUInt32BE(2);
  numbers.writeBigUInt64BE(BigInt(b.deadline), 4);
  return Buffer.concat([
    Buffer.from(`vonvon.recipe.${b.purpose}.v2\0`),
    uuid(b.operationId),
    uuid(b.accountId),
    uuid(b.versionId),
    Buffer.from(b.manifestSha256, 'hex'),
    Buffer.from(b.targetPublicKey, 'base64url'),
    Buffer.from(b.nonceCommitment, 'base64url'),
    Buffer.from(b.serverPublicKey, 'base64url'),
    numbers,
    ...(b.purpose === 'updateDirectRichRecipe' ? [uuid(b.fromVersionId), Buffer.from(b.localPlanSha256, 'hex')] : []),
    ...(stage === 'redeem' ? [] : [Buffer.from(`\0complete:${stage}`)]),
  ]);
}
export function richInstallProof(device: DeviceIdentity, b: RecipeRichInstallAuthorization, stage: RichProofStage): string {
  if (device.keypair.publicKey !== b.targetPublicKey) throw new Error('配方授权不属于本机');
  const shared = diffieHellman({
    privateKey: deviceKeyPair(device).privateKey,
    publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b.serverPublicKey }, format: 'jwk' }),
  });
  try {
    const key = Buffer.from(
      hkdfSync(
        'sha256',
        shared,
        Buffer.from(b.nonceCommitment, 'base64url'),
        Buffer.from(`vonvon.recipe.${b.purpose}.proof-key.v2\0`),
        32,
      ),
    );
    try {
      return createHmac('sha256', key).update(richInstallTranscript(b, stage)).digest('base64url');
    } finally {
      key.fill(0);
    }
  } finally {
    shared.fill(0);
  }
}
