import {createHmac,createPublicKey,diffieHellman,generateKeyPairSync,hkdfSync,randomBytes} from 'node:crypto';
import {binary32,installTranscript,sha256} from './install-proof.mjs';
import {badInput} from './errors.mjs';
const uuidBytes=id=>Buffer.from(id.replaceAll('-',''),'hex');
const pub=b=>createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b656e032100','hex'),binary32(b)]),format:'der',type:'spki'});
export function richInstallTranscript(b,stage='redeem') {
  if(b.format!=='rich-v2'||b.generation!==2||!['installRichRecipe','updateDirectRichRecipe'].includes(b.purpose)||!['redeem','applied','rejected'].includes(stage))throw badInput();
  const tail=installTranscript(b).subarray(Buffer.byteLength('vonvon.recipe.installBoundRole.v1\0'));
  return Buffer.concat([Buffer.from('vonvon.recipe.'+b.purpose+'.v2\0'),tail,
    ...(b.purpose==='updateDirectRichRecipe'?[uuidBytes(b.fromVersionId),Buffer.from(b.localPlanSha256,'hex')]:[]),
    ...(stage==='redeem'?[]:[Buffer.from('\0complete:'+stage)])]);
}
export function richInstallProofKeyInfo(purpose) {
  return Buffer.from('vonvon.recipe.'+purpose+'.proof-key.v2\0');
}
function compute(privateKey,publicKey,b) {
  const shared=diffieHellman({privateKey,publicKey});
  try{
    const key=Buffer.from(hkdfSync('sha256',shared,binary32(b.nonceCommitment),richInstallProofKeyInfo(b.purpose),32));
    try{return ['redeem','applied','rejected'].map(s=>createHmac('sha256',key).update(richInstallTranscript(b,s)).digest());}
    finally{key.fill(0);}
  }finally{shared.fill(0);}
}
export function richInstallProof(privateKey,b,stage='redeem') {
  const values=compute(privateKey,pub(b.serverPublicKey),b);
  try{const i=['redeem','applied','rejected'].indexOf(stage);if(i<0)throw badInput();return Buffer.from(values[i]);}
  finally{values.forEach(v=>v.fill(0));}
}
export function richInstallMaterial(b) {
  const {privateKey,publicKey}=generateKeyPairSync('x25519'),wire=publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64url');
  let values;
  try{values=compute(privateKey,pub(b.targetPublicKey),{...b,serverPublicKey:wire});
    return {server:binary32(wire),ticket:randomBytes(32),hashes:values.map(sha256)};
  }catch{throw badInput();}finally{values?.forEach(v=>v.fill(0));}
}
