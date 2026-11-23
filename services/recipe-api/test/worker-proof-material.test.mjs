import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { authoringProof } from '../src/authoring-proof.mjs';
import { installProof, sha256 } from '../src/install-proof.mjs';
import { richInstallProof } from '../src/rich-install-proof.mjs';
import { richProof } from '../src/rich-proof.mjs';
import { workerProofMaterials } from '../src/worker-proof-material.mjs';

const fixture = name => JSON.parse(readFileSync(new URL('fixtures/' + name + '.json', import.meta.url)));
const privateKey = raw => createPrivateKey({
  key: Buffer.from('302e020100300506032b656e04220420' + raw, 'hex'),
  format: 'der',
  type: 'pkcs8',
});

test('Worker install challenge matches the existing device proof and rejects invalid peer keys', async () => {
  const { binding, rawPrivateHex } = fixture('install-proof');
  const material = await workerProofMaterials.authorizationMaterial(binding);
  const complete = { ...binding, serverPublicKey: material.serverPublicKey };
  assert.deepEqual(sha256(installProof(privateKey(rawPrivateHex), complete)), material.proofHash);
  assert.equal(material.ticket.length, 32);
  await assert.rejects(workerProofMaterials.authorizationMaterial({
    ...binding,
    targetPublicKey: Buffer.alloc(32).toString('base64url'),
  }), { code: 'invalid_input' });
});

test('Worker authoring challenges match the existing device proofs', async () => {
  const { binding, targetPrivateKeyHex } = fixture('authoring-proof');
  const target = privateKey(targetPrivateKeyHex);
  const old = await workerProofMaterials.authoringMaterial(binding);
  assert.deepEqual(sha256(authoringProof(target, {
    ...binding,
    serverPublicKey: old.serverPublicKey,
  })), old.proofHash);

  const rich = { ...binding, format: 'rich-v2', sourceReviewSha256: '12'.repeat(32) };
  const next = await workerProofMaterials.richMaterial(rich);
  assert.deepEqual(sha256(richProof(target, {
    ...rich,
    serverPublicKey: next.key.toString('base64url'),
  })), next.hash);
});

test('Worker rich install verifies the device proof for redemption and both outcomes', async () => {
  const target = privateKey(fixture('install-proof').rawPrivateHex);
  for (const { binding } of fixture('rich-install-proof')) {
    const material = await workerProofMaterials.richInstallMaterial(binding);
    const complete = { ...binding, serverPublicKey: material.server.toString('base64url') };
    const hashes = ['redeem', 'applied', 'rejected'].map(stage => sha256(richInstallProof(target, complete, stage)));
    assert.deepEqual(material.hashes, hashes);
  }
});
