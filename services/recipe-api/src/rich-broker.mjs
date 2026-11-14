import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {decodeRichRecipeContent} from '../../../packages/protocol/dist/index.js';
import {createVerifier,identityFromRequest} from './auth.mjs';
import {ApiError,badInput} from './errors.mjs';
import {uuid,bodyJson,objectKeys} from './input.mjs';
import {binary32} from './install-proof.mjs';
import {operationId} from './operation-input.mjs';
import {createObjectBroker} from './object-broker.mjs';
import {createObjectStore} from './object-store.mjs';
import {createPrivateStorage} from './object-storage.mjs';
import {makePool} from './database.mjs';
const singleton=(req,k)=>{const x=req.headersDistinct[k];if(x?.length!==1)throw badInput();return x[0];};
export function createRichBrokerServer({verify,store,storage,admit=false}) {
  const broker=createObjectBroker({store,storage,recordTextChecks:true,validateCanonicalManifest:b=>decodeRichRecipeContent(b),
    authorizeRead:({identity,scope,target,obj,proof})=>scope==='displayLogo'?store.call('display_logo',target):proof?store.call('install_descriptor',target,...proof,obj):store.call('read_descriptor',identity?.issuer??null,identity?.subject??null,scope,target,obj)});
  return createServer({requestTimeout:20000,headersTimeout:10000,maxHeaderSize:16384},async(req,res)=>{
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
    try{
      const put=/^(?:\/api)?\/v2\/objects\/([^/]+)\/members\/(0|[1-9]\d?)$/.exec(req.url);
      const get=/^(?:\/api)?\/v2\/(drafts|versions)\/([^/]+)\/objects\/([^/]+)$/.exec(req.url);
      const installed=/^(?:\/api)?\/v2\/operations\/([^/]+)\/objects\/([^/]+)$/.exec(req.url);
      const logo=/^(?:\/api)?\/v2\/versions\/([^/]+)\/display-logo$/.exec(req.url);
      if(logo&&req.method==='GET'){
        await identityFromRequest(req,true,verify);
        const bytes=await broker.readAuthorized({scope:'displayLogo',target:uuid(logo[1])});
        res.setHeader('Content-Type','image/webp');res.end(bytes);
      }else if(installed&&req.method==='POST'){
        if(req.headersDistinct.authorization)throw badInput();
        const body=await bodyJson(req,512);objectKeys(body,['ticket','nonce','proof']);
        const proof=['ticket','nonce','proof'].map(k=>binary32(body[k]));
        const bytes=await broker.readAuthorized({target:operationId(installed[1]),obj:uuid(installed[2]),proof});
        res.setHeader('Content-Type','application/octet-stream');res.end(bytes);
      }else if(put&&req.method==='PUT'){
        if(!admit)throw new ApiError(503,'rich_writes_disabled');
        const identity=await identityFromRequest(req,false,verify);
        const actor=await store.call('business_actor',identity.issuer,identity.subject);
        const size=singleton(req,'content-length'),kind=singleton(req,'x-recipe-kind'),sha256=singleton(req,'x-recipe-sha256');
        if(!/^\d{1,7}$/.test(size)||!['text','manifest','finalLogo'].includes(kind)||!/^application\/octet-stream$/i.test(singleton(req,'content-type'))||
          req.headersDistinct['content-encoding']||req.headersDistinct['transfer-encoding'])throw badInput();
        const descriptor=await broker.receive(actor,operationId(put[1]),{ordinal:Number(put[2]),kind,bytes:Number(size),sha256},Readable.toWeb(req));
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(descriptor));
      }else if(get&&req.method==='GET'){
        const scope=get[1]==='drafts'?'draft':'version',identity=await identityFromRequest(req,scope==='version',verify);
        const bytes=await broker.readAuthorized({identity,scope,target:uuid(get[2]),obj:uuid(get[3])});
        res.setHeader('Content-Type','application/octet-stream');res.end(bytes);
      }else throw new ApiError(404,'not_found');
    }catch(e){
      const status={forbidden:403,invalid_operation_proof:403,operation_cancelled:409,auth_required:401,account_disabled:403,not_found:404,conflict:409,operation_expired:410,
        object_unavailable:409,object_capacity:429,object_stream_limit:429,invalid_input:422}[e.message];
      const err=e instanceof ApiError?e:new ApiError(status??503,status?e.message:'object_broker_unavailable');
      res.statusCode=err.status;res.setHeader('Content-Type','application/json');if(!req.complete)res.setHeader('Connection','close');
      res.end(JSON.stringify({error:{code:err.code}}));
    }
  });
}
export async function startRichBroker(env=process.env) {
  const verify=createVerifier(env.RECIPE_AUTH_ISSUER),pool=makePool(env.RECIPE_VERIFIER_DATABASE_URL);
  try{
    const store=await createObjectStore(pool);
    const storage=createPrivateStorage({origin:env.RECIPE_STORAGE_ORIGIN,bucket:'recipe-private',apiKey:env.RECIPE_STORAGE_API_KEY,
      bearer:env.RECIPE_STORAGE_BEARER,verifyAbsent:(bucket,key)=>store.call('storage_absent',bucket,key)});
    const server=createRichBrokerServer({verify,store,storage,admit:env.RECIPE_RICH_WRITES==='1'});
    const port=Number(env.PORT??4318);if(!Number.isInteger(port)||port<0||port>65535)throw Error();
    await new Promise((yes,no)=>server.once('error',no).listen(port,'127.0.0.1',yes));
    return {server,close:async()=>{await new Promise((yes,no)=>server.close(e=>e?no(e):yes()));await pool.end();}};
  }catch(e){await pool.end();throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const s=await startRichBroker();const close=()=>s.close().catch(()=>{process.exitCode=1;});process.once('SIGTERM',close);process.once('SIGINT',close);}
  catch{console.error('Private recipe broker failed to start');process.exitCode=1;}
}
