import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { authorizationMaterial, binary32, installProof, installTranscript, sha256 } from '../src/install-proof.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/install-proof.json', import.meta.url)));
const privateKey = createPrivateKey({key:Buffer.from('302e020100300506032b656e04220420'+fixture.rawPrivateHex,'hex'),format:'der',type:'pkcs8'});

test('installBoundRole proof matches the portable binary transcript golden vector', () => {
  assert.equal(installTranscript(fixture.binding).toString('hex'), fixture.transcriptHex);
  assert.equal(installProof(privateKey, fixture.binding).toString('base64url'), fixture.proof);
  assert.equal(sha256(binary32(fixture.nonce)).toString('base64url'), fixture.binding.nonceCommitment);
  for (const [field, value] of [
    ['operationId','019a81cb-2a00-7000-8000-000000000002'], ['accountId','11111111-2222-4333-8444-555555555556'],
    ['versionId','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef'], ['manifestSha256','f'.repeat(64)],
    ['targetPublicKey',Buffer.alloc(32,9).toString('base64url')], ['nonceCommitment',Buffer.alloc(32,8).toString('base64url')],
    ['serverPublicKey',fixture.binding.targetPublicKey],
    ['generation',2], ['deadline',fixture.binding.deadline+1],
  ]) assert.notEqual(installProof(privateKey,{...fixture.binding,[field]:value}).toString('base64url'),fixture.proof,field);
});

test('server stores a proof hash matching only the prepared target key', () => {
  const { publicKey, privateKey:target } = generateKeyPairSync('x25519');
  const binding = {...fixture.binding,targetPublicKey:publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64url')};
  const material = authorizationMaterial(binding);
  const authorized = {...binding,serverPublicKey:material.serverPublicKey};
  assert.deepEqual(sha256(installProof(target,authorized)),material.proofHash);
  assert.notDeepEqual(sha256(installProof(privateKey,authorized)),material.proofHash);
  assert.equal(material.ticket.length,32);
  assert.throws(()=>authorizationMaterial({...binding,targetPublicKey:Buffer.alloc(32).toString('base64url')}));
  for (const invalid of [undefined,'a'.repeat(43)+'=','+'.repeat(43),'_'.repeat(43),'a'.repeat(42)]) {
    assert.throws(()=>binary32(invalid));
  }
});
