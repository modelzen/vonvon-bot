import {execFileSync} from 'node:child_process';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {startRecipeService} from '../src/main.mjs';
import {createVerifier} from '../src/auth.mjs';
import {createObjectStore} from '../src/object-store.mjs';
import {createRichBrokerServer} from '../src/rich-broker.mjs';

const listen=server=>new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
const close=server=>new Promise(resolve=>server.close(resolve));
const origin=server=>'http://127.0.0.1:'+server.address().port;
const encoded=value=>Buffer.from(JSON.stringify(value)).toString('base64url');

/** A fresh Unix-socket Postgres with the product migrations, real API and broker, filesystem objects and ephemeral test identities. */
export async function startPublicationFixture(){
  const bin=process.env.PG_BINDIR||execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
  const root=await mkdtemp(join(tmpdir(),'vv-dm-publish-')),db=join(root,'db'),socket=join(root,'socket'),objects=join(root,'objects');
  const run=(name,args)=>execFileSync(join(bin,name),args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const pgArgs=['-Xq','-v','ON_ERROR_STOP=1','-h',socket,'-p','5432','-U','fixture','-d','postgres'];
  const sql=query=>run('psql',[...pgArgs,'-At','-c',query]).trim();
  const cleanups=[()=>rm(root,{recursive:true,force:true})];
  const dispose=async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();};
  try{
    await mkdir(socket,{mode:0o700});await mkdir(objects,{mode:0o700});
    run('initdb',['-D',db,'-U','fixture','--encoding=UTF8','--locale=C','--auth=trust']);
    run('pg_ctl',['-D',db,'-w','-l',join(root,'pg.log'),'-o',"-k '"+socket+"' -p 5432 -c listen_addresses='' -c unix_socket_permissions=0700",'start']);
    cleanups.push(()=>run('pg_ctl',['-D',db,'-m','fast','-w','stop']));
    const migrations=fileURLToPath(new URL('../../../supabase/migrations',import.meta.url));
    for(const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())run('psql',[...pgArgs,'-1','-f',join(migrations,file)]);
    sql('create role api_test login noinherit; grant recipe_api to api_test; create role objects_test login noinherit; grant recipe_object_verifier to objects_test');
    const keys=generateKeyPairSync('ec',{namedCurve:'P-256'}),jwk={...keys.publicKey.export({format:'jwk'}),kid:'test',alg:'ES256',use:'sig'};
    const jwks=createServer((req,res)=>{if(req.url!=='/auth/v1/.well-known/jwks.json'){res.writeHead(404).end();return;}res.end(JSON.stringify({keys:[jwk]}));});
    await listen(jwks);cleanups.push(()=>close(jwks));
    const issuer=origin(jwks)+'/auth/v1';
    const token=()=>{const signed=[encoded({alg:'ES256',kid:'test'}),encoded({iss:issuer,aud:'authenticated',role:'authenticated',sub:randomUUID(),exp:Math.floor(Date.now()/1000)+3600})].join('.');
      return signed+'.'+sign('sha256',Buffer.from(signed),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');};
    const author=token(),reader=token(),database=new URL('postgresql://api_test@localhost/postgres');
    database.searchParams.set('host',socket);database.searchParams.set('port','5432');
    const pool=new pg.Pool({user:'objects_test',database:'postgres',host:socket,port:5432});cleanups.push(()=>pool.end());
    const objectPath=(id,lane)=>join(objects,createHash('sha256').update(lane+'/'+id).digest('hex'));
    const storage={create:(id,lane,bytes)=>writeFile(objectPath(id,lane),bytes,{flag:'wx',mode:0o600}),
      read:async(id,lane)=>{try{return await readFile(objectPath(id,lane));}catch(err){if(err.code==='ENOENT')return null;throw err;}},
      remove:(id,lane)=>rm(objectPath(id,lane),{force:true})};
    const broker=createRichBrokerServer({verify:createVerifier(issuer),store:await createObjectStore(pool),storage,admit:true});
    await listen(broker);cleanups.push(()=>close(broker));
    const api=await startRecipeService({RECIPE_AUTH_ISSUER:issuer,RECIPE_DATABASE_URL:database.href,RECIPE_CODE_KEY:randomBytes(32).toString('hex'),RECIPE_RICH_WRITES:'1',RECIPE_BROKER_ORIGIN:origin(broker),PORT:'0'});
    cleanups.push(()=>api.close());
    const send=async(path,init={},jwt=author)=>{
      if(!/^\/v[12]\//.test(path))throw Error('Unexpected fixture path');
      const headers=new Headers(init.headers);if(jwt)headers.set('authorization','Bearer '+jwt);
      const object=/^\/v2\/(?:objects\/[^/]+\/members\/|(?:drafts|versions|operations)\/[^/]+\/objects\/)/.test(path);
      return fetch(origin(object?broker:api.server)+path,{...init,headers,redirect:'error'});
    };
    async function json(path,init,jwt){const response=await send(path,init,jwt);const value=await response.json();
      if(!response.ok)throw Error(path+' '+response.status+' '+value.error?.code);return value;}
    const {accountId}=await json('/v1/me');await json('/v1/me',{},reader);
    return {accountId,authorRequest:(path,init)=>send(path,init),possessionRequest:(path,init)=>send(path,init,null),close:dispose,
      publications:async()=> (await json('/v2/me/publications')).items,
      async download(recipeId,versionId){
        const time=Date.now().toString(16).padStart(12,'0'),key='a2.'+time.slice(0,8)+'-'+time.slice(8)+'-7'+randomUUID().slice(15);
        await json('/v2/versions/'+versionId+'/acquire',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:'{}'},reader);
        const detail=await json('/v2/recipes/'+recipeId+'/versions/'+versionId,{},reader);
        if(detail.release.versionId!==versionId)throw Error('Incorrect granted version');
        const preview=await json('/v2/versions/'+versionId+'/install-preview',{},reader);
        const get=async descriptor=>{const response=await send('/v2/versions/'+versionId+'/objects/'+descriptor.objectId,{},reader);
          const bytes=Buffer.from(await response.arrayBuffer());
          if(!response.ok||bytes.length!==descriptor.bytes||createHash('sha256').update(bytes).digest('hex')!==descriptor.sha256)throw Error('Downloaded recipe object mismatch');
          return bytes;};
        const manifest=JSON.parse((await get(preview.manifest)).toString('utf8'));
        const texts=new Map();
        for(const part of manifest.parts||[]){const bytes=await get(part);if(part.kind==='text')texts.set(part.objectId,bytes.toString('utf8'));}
        return {manifest,texts};
      }};
  }catch(error){await dispose();throw error;}
}
