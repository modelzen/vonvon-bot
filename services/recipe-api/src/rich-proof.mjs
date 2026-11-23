import {createHmac,createPublicKey,diffieHellman,generateKeyPairSync,hkdfSync,randomBytes} from 'node:crypto';
import {authoringTranscript} from './authoring-proof.mjs';
import {binary32,sha256} from './install-proof.mjs';
import {badInput} from './errors.mjs';
const domain=Buffer.from('vonvon.recipe.authoring.v2\0'), keyInfo=Buffer.from('vonvon.recipe.authoring.proof-key.v2\0');
const publicKey=wire=>createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b656e032100','hex'),binary32(wire)]),format:'der',type:'spki'});
export function richTranscript(b) {
  if(b.format!=='rich-v2')throw badInput();
  if(b.stage==='accept'&&!/^[0-9a-f]{64}$/.test(b.sourceReviewSha256??''))throw badInput();
  return Buffer.concat([domain,authoringTranscript(b).subarray(domain.length),...(b.stage==='accept'?[Buffer.from(b.sourceReviewSha256,'hex')]:[])]);
}
function proof(priv,pub,b) {
  const shared=diffieHellman({privateKey:priv,publicKey:pub});
  try {const key=Buffer.from(hkdfSync('sha256',shared,binary32(b.nonceCommitment),keyInfo,32));
    try{return createHmac('sha256',key).update(richTranscript(b)).digest();} finally{key.fill(0);}
  }finally{shared.fill(0);}
}
export function richProof(priv,b){return proof(priv,publicKey(b.serverPublicKey),b);}
export function richMaterial(b) {
  const pair=generateKeyPairSync('x25519'),wire=pair.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64url');
  let expected;
  try{expected=proof(pair.privateKey,publicKey(b.targetPublicKey),{...b,serverPublicKey:wire});
    return {key:binary32(wire),ticket:randomBytes(32),hash:sha256(expected)};
  }catch{throw badInput();}finally{expected?.fill(0);}
}
