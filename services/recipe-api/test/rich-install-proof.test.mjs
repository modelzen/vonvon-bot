import assert from 'node:assert/strict';
import test from 'node:test';
import {createPrivateKey} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {richInstallTranscript,richInstallProof} from '../src/rich-install-proof.mjs';
const fx=name=>JSON.parse(readFileSync(new URL('fixtures/'+name+'.json',import.meta.url)));
const priv=createPrivateKey({key:Buffer.from('302e020100300506032b656e04220420'+fx('install-proof').rawPrivateHex,'hex'),format:'der',type:'pkcs8'});
for(const {binding,transcriptHex,proofs} of fx('rich-install-proof')){
  test('rich device receipt vectors: '+binding.purpose,()=>{
    assert.equal(richInstallTranscript(binding).toString('hex'),transcriptHex);
    for(const [outcome,expected] of Object.entries(proofs))assert.equal(richInstallProof(priv,binding,outcome).toString('hex'),expected);
    if(binding.localPlanSha256)assert.notEqual(richInstallProof(priv,{...binding,localPlanSha256:'01'.repeat(32)},'applied').toString('hex'),proofs.applied);
  });
}

import {richProof,richTranscript} from '../src/rich-proof.mjs';
test('a device cannot sign a different ownership review with the approved rich draft proof',()=>{
  const f=fx('authoring-proof'),target=createPrivateKey({key:Buffer.from('302e020100300506032b656e04220420'+f.targetPrivateKeyHex,'hex'),format:'der',type:'pkcs8'});
  const binding={...f.binding,format:'rich-v2',sourceReviewSha256:'12'.repeat(32)};
  assert.equal(richTranscript(binding).subarray(-32).toString('hex'),binding.sourceReviewSha256);
  assert.notDeepEqual(richProof(target,binding),richProof(target,{...binding,sourceReviewSha256:'ab'.repeat(32)}));
  assert.throws(()=>richProof(target,{...binding,sourceReviewSha256:undefined}));
});
