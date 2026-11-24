import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

/** SPKI DER prefix for raw 32-byte Ed25519 public keys (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const next = value[key];
      if (next !== undefined) out[key] = sortDeep(next);
    }
    return out;
  }
  return value;
}

/**
 * Exact byte-for-byte match with `packages/daemon/src/template/schema.ts` (`canonicalPromoBytes`).
 */
export function canonicalPromoBytes(promo) {
  return Buffer.from(`vonvon-template-promo/1\n${JSON.stringify(sortDeep(promo))}`, 'utf8');
}

export function verifyPromoSignature(promo, signature) {
  if (typeof signature !== 'string' || !signature.trim()) return false;
  const pubStr = promo?.author?.publicKey;
  if (typeof pubStr !== 'string' || !pubStr.trim()) return false;
  try {
    const rawPub = Buffer.from(pubStr, 'base64url');
    if (rawPub.length !== 32) return false;
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, rawPub]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const sig = Buffer.from(signature, 'base64url');
    if (sig.length !== 64) return false;
    return cryptoVerify(null, canonicalPromoBytes(promo), key, sig);
  } catch {
    return false;
  }
}

export function verifyCoverSignature(templateId, version, docUrl, authorPublicKey, coverBytes, signature) {
  if (typeof signature !== 'string' || !templateId || !version || !docUrl || !authorPublicKey || !Buffer.isBuffer(coverBytes)) return false;
  try {
    const rawPub = Buffer.from(authorPublicKey, 'base64url');
    if (rawPub.length !== 32) return false;
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, rawPub]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const sig = Buffer.from(signature, 'base64url');
    if (sig.length !== 64) return false;
    const hash = createHash('sha256').update(coverBytes).digest('hex');
    const message = Buffer.from(`vonvon-template-cover/1\n${templateId}\n${version}\n${docUrl}\n${authorPublicKey}\n${hash}`, 'utf8');
    return cryptoVerify(null, message, key, sig);
  } catch {
    return false;
  }
}

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
