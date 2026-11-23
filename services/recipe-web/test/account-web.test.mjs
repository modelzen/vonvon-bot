import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRecipeWeb} from '../server.mjs';
import {returnPath} from '../auth.mjs';

const accountId='11111111-1111-4111-8111-111111111111';
const json=(res,data)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const cookie=response=>response.headers.getSetCookie().map(x=>x.split(';',1)[0]).join('; ');
async function listen(server,t){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});return 'http://127.0.0.1:'+server.address().port;}
async function fixture(t){
  const calls=[],controls={};
  const api=await listen(createServer(async(req,res)=>{
    const pieces=[];for await(const piece of req)pieces.push(piece);
    calls.push({path:req.url,method:req.method,authorization:req.headers.authorization,body:Buffer.concat(pieces).toString()});
    if(controls.pending)await new Promise(resolve=>{controls.release=resolve;});
    json(res,{authorId:accountId,displayName:'昵称',revision:1});
  }),t);
  const issuer=await listen(createServer((req,res)=>json(res,{access_token:'account-access',refresh_token:'account-refresh',expires_in:3600})),t);
  const origin='https://recipes.example';
  const host=await listen(createRecipeWeb({RECIPE_WEB_ORIGIN:origin,RECIPE_API_ORIGIN:api,SUPABASE_URL:issuer,SUPABASE_PUBLISHABLE_KEY:'test',RECIPE_WEB_PROVIDERS:'github'}),t);
  const start=await fetch(host+'/auth/start',{method:'POST',redirect:'manual',headers:{origin},body:new URLSearchParams({provider:'github',returnTo:'/account'})});
  const finish=await fetch(host+'/auth/callback?code=account',{redirect:'manual',headers:{cookie:cookie(start)}});
  assert.equal(finish.headers.get('location'),'/account');
  const cookies=cookie(finish),session=await fetch(host+'/auth/session',{headers:{cookie:cookies}}).then(x=>x.json());
  const headers={origin,cookie:cookies,'X-Vonvon-Session':session.displaySession,'Content-Type':'application/json'};
  return {host,headers,calls,controls};
}

test('account assets and OAuth return paths have an exact local destination',async t=>{
  const {host}=await fixture(t);
  assert.equal(returnPath('/account'),'/account');
  for(const bad of ['/account?next=other','/account/other','https://example.test/account'])assert.equal(returnPath(bad),'/');
  for(const path of ['/account','/account.mjs','/account.css'])assert.equal((await fetch(host+path)).status,200,path);
  assert.equal((await fetch(host+'/account/other')).status,404);
});
test('account proxy guards reads and writes by the current website session and forwards only exact routes',async t=>{
  const {host,headers,calls}=await fixture(t),path='/api/v2/me/account-profile';
  for(const method of ['GET','POST']){
    const options={method,headers:{...headers,'X-Vonvon-Session':'old-tab'},...(method==='POST'&&{body:'{}'})};
    assert.equal((await fetch(host+path,options)).status,409);
  }
  assert.deepEqual(calls,[]);
  assert.equal((await fetch(host+path,{headers})).status,200);
  const body={displayName:'新昵称',revision:1,avatar:{kind:'keep'}};
  assert.equal((await fetch(host+path,{method:'POST',headers,body:JSON.stringify(body)})).status,200);
  assert.equal((await fetch(host+path+'/initialize',{method:'POST',headers,body:JSON.stringify({displayName:'Vonvon 用户'})})).status,200);
  assert.deepEqual(calls.map(x=>[x.path,x.method,x.authorization]),[
    ['/v2/me/account-profile','GET','Bearer account-access'],['/v2/me/account-profile','POST','Bearer account-access'],['/v2/me/account-profile/initialize','POST','Bearer account-access'],
  ]);
  assert.deepEqual(JSON.parse(calls[1].body),body);
  for(const bad of [path+'?accountId='+accountId,path+'/initialize?x=1'])assert.equal((await fetch(host+bad,{headers})).status,400);
  assert.equal((await fetch(host+path+'/initialize',{headers})).status,404);
  assert.equal((await fetch(host+path+'/extra',{headers})).status,404);
  assert.equal((await fetch(host+path,{method:'POST',headers:{...headers,origin:'https://other.invalid'},body:'{}'})).status,403);
});
test('logout invalidates late profile responses and rejects stale logout from an old tab',async t=>{
  const {host,headers,controls}=await fixture(t);
  assert.equal((await fetch(host+'/auth/logout',{method:'POST',redirect:'manual',headers:{...headers,'X-Vonvon-Session':'old-tab'}})).status,409);
  assert.equal((await fetch(host+'/auth/session',{headers})).status,200);
  controls.pending=true;
  const pending=fetch(host+'/api/v2/me/account-profile',{headers});
  while(!controls.release)await new Promise(setImmediate);
  assert.equal((await fetch(host+'/auth/logout',{method:'POST',redirect:'manual',headers})).status,303);
  controls.release();
  const response=await pending;assert.equal(response.status,409);assert.equal((await response.json()).error.code,'session_changed');
});
