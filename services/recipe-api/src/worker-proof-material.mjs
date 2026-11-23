import { binary32, installProofKeyInfo, installTranscript, sha256 } from './install-proof.mjs';
import { authoringProofKeyInfo, authoringTranscript } from './authoring-proof.mjs';
import { richAuthoringProofKeyInfo, richTranscript } from './rich-proof.mjs';
import { richInstallProofKeyInfo, richInstallTranscript } from './rich-install-proof.mjs';
import { badInput } from './errors.mjs';

async function material(binding, info, transcripts) {
  const { subtle } = crypto;
  try {
    const target = await subtle.importKey('raw', binary32(binding.targetPublicKey), 'X25519', false, []);
    const pair = await subtle.generateKey('X25519', false, ['deriveBits']);
    const server = Buffer.from(await subtle.exportKey('raw', pair.publicKey));
    const complete = { ...binding, serverPublicKey: server.toString('base64url') };
    const shared = Buffer.from(await subtle.deriveBits({ name: 'X25519', public: target }, pair.privateKey, 256));
    let source;
    try {
      source = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    } finally {
      shared.fill(0);
    }
    const key = await subtle.deriveKey({
      name: 'HKDF', hash: 'SHA-256', salt: binary32(binding.nonceCommitment), info,
    }, source, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    const hashes = [];
    for (const transcript of transcripts(complete)) {
      const proof = Buffer.from(await subtle.sign('HMAC', key, transcript));
      try { hashes.push(sha256(proof)); }
      finally { proof.fill(0); }
    }
    return { server, ticket: Buffer.from(crypto.getRandomValues(new Uint8Array(32))), hashes };
  } catch {
    throw badInput();
  }
}

export const workerProofMaterials = {
  async authorizationMaterial(binding) {
    const { server, ticket, hashes: [proofHash] } = await material(binding, installProofKeyInfo, b => [installTranscript(b)]);
    return { serverPublicKey: server.toString('base64url'), ticket, proofHash };
  },
  async authoringMaterial(binding) {
    const { server, ticket, hashes: [proofHash] } = await material(binding, authoringProofKeyInfo, b => [authoringTranscript(b)]);
    return { serverPublicKey: server.toString('base64url'), ticket, proofHash };
  },
  async richMaterial(binding) {
    const { server: key, ticket, hashes: [hash] } = await material(binding, richAuthoringProofKeyInfo, b => [richTranscript(b)]);
    return { key, ticket, hash };
  },
  richInstallMaterial(binding) {
    return material(binding, richInstallProofKeyInfo(binding.purpose), b =>
      ['redeem', 'applied', 'rejected'].map(stage => richInstallTranscript(b, stage)));
  },
};
