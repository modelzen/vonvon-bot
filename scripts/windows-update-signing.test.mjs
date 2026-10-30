import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {signWindowsUpdate, verifyWindowsUpdate, publicKeyFromPrivate, normalizeWindowsPublicKey} from './windows-update-signing.mjs';

const key = () => {
  const pair=generateKeyPairSync('ed25519');
  return {privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString(), publicKey:pair.publicKey.export({type:'spki',format:'pem'}).toString()};
};
const payload = architecture => ({schemaVersion:1,product:'vonvon-bot',version:'1.2.3',architecture,
  url:`https://dl.vonvon.cc/bot/windows/1.2.3/Vonvon-Bot-Setup-1.2.3-${architecture}.exe`,size:7,sha512:createHash('sha512').update('fixture').digest('base64'),notes:'更新说明'});

test('signatures bind both architectures, exact bytes, version, URL, size and summary',()=>{
  const keys=key();
  for(const architecture of ['x64','arm64']) {
    const data=payload(architecture),envelope=signWindowsUpdate(data,keys.privateKey);
    assert.deepEqual(verifyWindowsUpdate(envelope,keys.publicKey,architecture),data);
    assert.equal(publicKeyFromPrivate(keys.privateKey),normalizeWindowsPublicKey(keys.publicKey));
    assert.throws(()=>verifyWindowsUpdate(envelope,key().publicKey,architecture));
    assert.throws(()=>verifyWindowsUpdate(envelope,keys.publicKey,architecture==='x64'?'arm64':'x64'));
    for(const field of ['version','url','size','sha512','notes']) {
      const tampered={...data,[field]:field==='size'?8:'tampered'};
      assert.throws(()=>verifyWindowsUpdate({...envelope,payload:Buffer.from(JSON.stringify(tampered)).toString('base64')},keys.publicKey,architecture));
    }
  }
});
test('valid cryptography does not permit another product, URL, malformed size/hash or extra fields',()=>{
  const keys=key();
  for(const change of [{product:'another'},{url:'http://dl.vonvon.cc/bot/windows/app.exe'},{size:-1},{sha512:'aaa'},{version:'01.2.3'},{packages:{}},{notes:'a'.repeat(4097)}]) {
    const bytes=Buffer.from(JSON.stringify({...payload('x64'),...change}));
    const envelope={payload:bytes.toString('base64'),signature:sign(null,bytes,keys.privateKey).toString('base64')};
    assert.throws(()=>verifyWindowsUpdate(envelope,keys.publicKey,'x64'));
    assert.throws(()=>signWindowsUpdate({...payload('x64'),...change},keys.privateKey));
  }
});
test('envelope and trust key parsing fails closed',()=>{
  const keys=key(),valid=signWindowsUpdate(payload('x64'),keys.privateKey);
  for(const envelope of [null,[],{}, {...valid,extra:true},{...valid,payload:valid.payload+' '},{...valid,signature:'bad'}, {...valid,payload:'a'.repeat(40000)}])assert.throws(()=>verifyWindowsUpdate(envelope,keys.publicKey,'x64'));
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'}).toString();
  assert.throws(()=>normalizeWindowsPublicKey(rsa));
  assert.throws(()=>normalizeWindowsPublicKey(keys.privateKey));
});
