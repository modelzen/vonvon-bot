import { createHash, randomBytes } from 'node:crypto';
import { recipeManifestSchema, type RecipeManifest } from '@vonvon/protocol';

export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export function parseManifest(encoded: string, digest: string): RecipeManifest {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 80000) throw new Error('配方清单编码无效');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded || sha256(bytes) !== digest) throw new Error('配方清单校验失败');
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const manifest = recipeManifestSchema.parse(JSON.parse(text));
  if (manifest.setup?.steps.some(step => Buffer.byteLength(step.instructions) > 2048 || (step.check !== undefined && Buffer.byteLength(step.check) > 512))) throw new Error('配方准备步骤过长');
  return manifest;
}

/** The API refuses an unknown operation whose UUID timestamp is no longer fresh. */
export function operationUuid(now: number): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = 0x70 | (bytes[6]! & 15);
  bytes[8] = 0x80 | (bytes[8]! & 63);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
