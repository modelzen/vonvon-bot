import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {mkdtempSync,mkdirSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {createRichBrokerServer} from '../../../../services/recipe-api/src/rich-broker.mjs';
import {createObjectStore} from '../../../../services/recipe-api/src/object-store.mjs';
import {createVerifier} from '../../../../services/recipe-api/src/auth.mjs';
import {startRecipeService} from '../../../../services/recipe-api/src/main.mjs';

const root=fileURLToPath(new URL('../../../../',import.meta.url));
const temp=mkdtempSync(join(tmpdir(),'vv-authoring-pg-'));
const db=join(temp,'db'),sock=join(temp,'s');
const bin=process.env.PG_BINDIR || execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const env={...process.env,PGHOST:sock,PGPORT:'5432',PGDATABASE:'postgres',PGUSER:'bootstrap_test',PGPASSWORD:''};
const pg=(name,args)=>execFileSync(join(bin,name),args,{env,stdio:['ignore','pipe','pipe'],encoding:'utf8'});
const rich=process.argv.includes('--rich');
let up=false,service,issuerServer,broker,pool;
try {
  if (!pg('postgres',['--version']).includes(' 15.')) throw new Error('Expected PostgreSQL 15');
  mkdirSync(sock,{mode:0o700});
  pg('initdb',['-D',db,'-U','bootstrap_test','--encoding=UTF8','--locale=C','--auth=trust']);
  pg('pg_ctl',['-D',db,'-w','-l',join(temp,'log'),'-o',"-k '"+sock+"' -p 5432 -c listen_addresses='' -c unix_socket_permissions=0700",'start']);
  up=true;
  for(const name of readdirSync(join(root,'supabase/migrations')).filter(n=>n.endsWith('.sql')).sort()) {
    pg('psql',['-Xq','-1','-v','ON_ERROR_STOP=1','-f',join(root,'supabase/migrations',name)]);
  }
  pg('psql',['-Xq','-c','create role recipe_test login noinherit; grant recipe_api to recipe_test']);
  if(rich)pg('psql',['-Xq','-c','create role authoring_verifier login noinherit; grant recipe_object_verifier to authoring_verifier']);
  const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
  const jwk={...publicKey.export({format:'jwk'}),kid:'synthetic-authoring',alg:'ES256',use:'sig'};
  issuerServer=createServer((_req,res)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({keys:[jwk]})));
  issuerServer.listen(0,'127.0.0.1');await once(issuerServer,'listening');
  const issuer='http://127.0.0.1:'+issuerServer.address().port+'/auth/v1';
  const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const now=Math.floor(Date.now()/1000);
  const jwt=enc({alg:'ES256',kid:jwk.kid})+'.'+enc({iss:issuer,aud:'authenticated',role:'authenticated',sub:randomUUID(),iat:now,exp:now+300});
  const token=jwt+'.'+sign('sha256',Buffer.from(jwt),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  const dbUrl=new URL('postgresql://recipe_test@localhost/postgres');dbUrl.searchParams.set('host',sock);
  service=await startRecipeService({RECIPE_AUTH_ISSUER:issuer,RECIPE_DATABASE_URL:dbUrl.href,RECIPE_CODE_KEY:randomBytes(32).toString('hex'),PORT:'0',RECIPE_RICH_WRITES:rich?'1':'0'});
  const origin='http://127.0.0.1:'+service.server.address().port;
  const user=await fetch(origin+'/v1/me',{headers:{authorization:'Bearer '+token}}).then(r=>r.json());
  if(rich){
    const {Pool}=createRequire(new URL('../../../../services/recipe-api/package.json',import.meta.url))('pg');
    pool=new Pool({user:'authoring_verifier',database:'postgres',host:sock,port:5432});
    const objects=new Map();
    const store=await createObjectStore(pool);
    broker=createRichBrokerServer({verify:createVerifier(issuer),store,admit:true,storage:{
      async create(id,lane,bytes){const k=lane+id;if(objects.has(k))throw new Error('immutable fixture object exists');objects.set(k,Buffer.from(bytes));},
      async read(id,lane){return objects.get(lane+id)??null;},async remove(id,lane){objects.delete(lane+id);},
    }});
    broker.listen(0,'127.0.0.1');await once(broker,'listening');
  }
  const run=await promisify(execFile)(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','test/recipe-authoring.test.ts','-t',rich?'private-chat-reviewed':'links the actual sender'],{
    cwd:join(root,'packages/daemon'),env:{...env,...(rich&&{RICH_NATIVE_PG:'1',RICH_NATIVE_BROKER:'http://127.0.0.1:'+broker.address().port}),AUTHORING_TEST_ACCOUNT:user.accountId,AUTHORING_TEST_ORIGIN:origin,AUTHORING_TEST_JWT:token},timeout:120000,
  }).catch(err=>{throw new Error(err.stdout+'\n'+err.stderr);});
  process.stdout.write(run.stdout);
} finally {
  try { if(broker)await new Promise(r=>broker.close(r));await pool?.end();await service?.close(); if(issuerServer) await new Promise(r=>issuerServer.close(r)); }
  finally { if(up)pg('pg_ctl',['-D',db,'-m','fast','-w','stop']);rmSync(temp,{recursive:true,force:true}); }
}
