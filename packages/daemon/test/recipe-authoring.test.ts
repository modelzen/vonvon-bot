import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { realpath, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client, DefaultCache, type LarkChannel, type NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { authoringAuthorizationSchema, groupIdSchema, recipeAuthoringRequestSchema, type AuthoringAuthorization, type AuthoringOperation, type RecipeAuthoringReply } from '@vonvon/protocol';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';

const root = await realpath(await mkdtemp(join(tmpdir(),'vonvon-authoring-')));
vi.stubEnv('VONVON_HOME',root);
vi.stubEnv('HOME',root);
const { AuthoringService } = await import('../src/recipe/authoring-service');
const { blankPublic, digest, dispatchDigest, freezePayload, makeAuthoringProof } = await import('../src/recipe/authoring-wire');
const { createOrchestrator } = await import('../src/bot/handle-message');
const { useBotDir, botPaths } = await import('../src/config/paths');
const { addProject, mutateProjectByChatId, removeProject } = await import('../src/project/registry');
const bot = {appId:'cli_authoring', tenant:'feishu' as const, createdAt:1, registrationId:randomUUID()};
const peer = {id:randomUUID(), device:'fixture-device'}, otherPeer = {id:randomUUID(), device:'other-device'};
const appId = bot.appId, groupId = groupIdSchema.parse('oc_source'), chatId = 'oc_private';
const account = process.env.AUTHORING_TEST_ACCOUNT ?? randomUUID();
const owner = 'ou_author', stranger = 'ou_stranger', tenant = 'tenant_fixture';
const msg = (content: string, id = 'om_'+randomUUID(), openId = owner, chat = chatId): NormalizedMessage => ({
  content, messageId:id, senderId:openId,chatId:chat,chatType:'p2p',rawContentType:'text',resources:[],mentions:[],
  mentionAll:false,mentionedBot:false,createTime:Date.now(),raw:{sender:{sender_type:'user',sender_id:{open_id:openId},tenant_key:tenant},
    message:{message_id:id,chat_id:chat,chat_type:'p2p'}},
});
let server: Server, origin: string, session: string, n: number, clock: number;
let cfg: AppConfig, service: InstanceType<typeof AuthoringService>, channel: LarkChannel;
let orch: ReturnType<typeof createOrchestrator>;
let bodies: {path:string;body:string}[], cloud: {action:string;body:Record<string,string>}[];
let messages: Map<string,{message_id:string;chat_id:string;card_id:string}>, cards: Map<string,string>;
const textSend = vi.fn(async (..._args: unknown[])=>({messageId:'om_fixed'}));
let loseSend = false, loseAccept = false, loseDispatch = false;
const quiet = {error(){},warn(){},info(){},debug(){},trace(){}};
const sourceRole = 'SELECTED-LEGACY-ROLE', hiddenMemory = 'UNSELECTED-MEMORY-SENTINEL';
const accountApi = process.env.AUTHORING_TEST_ORIGIN;
const acct = async (route: string, body?: object) => {
  const res = await fetch(accountApi + '/v1' + route,{method:body?'POST':'GET',headers:{authorization:'Bearer '+process.env.AUTHORING_TEST_JWT,
    'content-type':'application/json','idempotency-key':randomUUID()}, body:body?JSON.stringify(body):undefined});
  if (!res.ok) throw new Error('account fixture ' + res.status + ' ' + route);
  return res.json();
};
const results = new Map<string,{draftId:string;revision:number}>();
function restart() {
  service?.close();
  service = new AuthoringService({bot,cfg,channel,now:()=>clock,origin:accountApi ?? origin,loopback:true,
    fetch: async (url,options) => {
      const {pathname} = new URL(String(url)), action = pathname.split('/').pop()!, body = JSON.parse(String(options!.body));
      expect(new Headers(options?.headers).has('authorization')).toBe(false);
      cloud.push({action,body});
      const res = await fetch(url,options);
      if (res.ok && ((action === 'accept' && loseAccept) || (action === 'dispatch' && loseDispatch))) {
        await res.text(); loseAccept = loseDispatch = false; throw new Error('response lost');
      }
      return res;
    }});
}
beforeEach(async () => {
  n = 0;clock=Date.now();bodies=[];cloud=[];messages=new Map();cards=new Map();results.clear();loseSend=loseAccept=loseDispatch=false;
  await rm(join(root,'recipe-authoring'),{recursive:true,force:true});
  await rm(botPaths(appId).dir,{recursive:true,force:true});
  useBotDir(appId); await mkdir(botPaths(appId).dir,{recursive:true});
  await writeFile(join(root,'bots.json'),JSON.stringify({version:1,bots:[{name:'fixture',...bot}]}));
  await addProject({chatId:groupId,name:'PRIVATE-GROUP-SENTINEL',createdAt:1,cwd:root,blank:false,
    profile:{persona:sourceRole,memory:hiddenMemory,inheritMemory:false,inheritPersona:false}});
  server = createServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString(), path = req.url ?? '', data = JSON.parse(text || '{}');
    bodies.push({path,body:text});
    let value: unknown = {code:0,data:{}};
    if (path.includes('tenant_access_token')) value = {code:0,tenant_access_token:'synthetic-token',expire:7200};
    else if (path.includes('is_in_chat')) value = {code:0,data:{is_in_chat:true}};
    else if (path === '/open-apis/cardkit/v1/cards' && req.method === 'POST') {
      const id = 'card_'+ ++n; cards.set(id,data.data); value = {code:0,data:{card_id:id}};
    } else if (path === '/open-apis/cardkit/v1/cards/id_convert') {
      value = {code:0,data:{card_id:[...messages.values()].find(m => m.message_id === data.message_id)?.card_id}};
    } else if (path.startsWith('/open-apis/cardkit/v1/cards/') && req.method === 'PUT') {
      cards.set(path.split('/').pop()!,data.card.data);
    } else if (path.startsWith('/open-apis/im/v1/messages?') && req.method === 'POST') {
      const m = messages.get(data.uuid) ?? {message_id:'om_card_'+ ++n,chat_id:data.receive_id,card_id:JSON.parse(data.content).data.card_id};
      messages.set(data.uuid,m);
      if (loseSend) { res.destroy(); return; }
      value = {code:0,data:m};
    } else if (path.startsWith('/open-apis/im/v1/messages/') && req.method === 'GET') {
      const m = [...messages.values()].find(m => path.endsWith('/'+m.message_id));
      value = {code:0,data:{items:m?[{...m,msg_type:'interactive'}]:[]}};
    } else if (path.startsWith('/v1/authoring/')) {
      const [, , , operationId, stage] = path.split('/');
      if (stage === 'dispatch') value = {operationId,status:'dispatched',stateRevision:2};
      else {
        const content = JSON.parse(Buffer.from(data.payload,'base64url').toString());
        const saved = results.get(operationId!) ?? {draftId:content.draftId ?? randomUUID(),revision:(content.baseRevision ?? 0)+1};
        results.set(operationId!,saved); value={operationId,status:'accepted',stateRevision:3,...saved};
      }
    }
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  origin = 'http://127.0.0.1:'+(server.address() as AddressInfo).port;
  // SDK path expansion treats the colon before a loopback port as a path placeholder.
  const client = new Client({appId,appSecret:'synthetic',domain:'http://authoring.test',logger:quiet,cache:new DefaultCache()});
  const http = client.httpInstance;
  const localUrl = (url: string) => origin + new URL(url).pathname;
  const transport = Object.create(http) as typeof http;
  transport.request = opts => http.request({...opts,url:localUrl(opts.url!)});
  transport.post = (url,data,opts) => http.post(localUrl(url),data,opts);
  const wired = new Client({appId,appSecret:'synthetic',domain:'http://authoring.test',logger:quiet,cache:new DefaultCache(),httpInstance:transport});
  textSend.mockClear();
  channel = {rawClient:wired,send:textSend} as unknown as LarkChannel;
  cfg = {accounts:{app:{id:appId,secret:'synthetic',tenant:'feishu'}},preferences:{access:{admins:[owner,stranger],ownerOpenId:stranger}}};
  restart();
  orch = createOrchestrator(channel,cfg,root,undefined,{authoring:service});
  await open();
});
afterEach(async () => { service.close(); await orch.shutdown(); server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); });
afterAll(async () => { vi.unstubAllEnvs();await rm(root,{recursive:true,force:true}); });

const rpc = (type: string, more: Record<string,unknown> = {}) => service.request(peer,recipeAuthoringRequestSchema.parse({type,botId:appId,session,...more}));
function kind<K extends RecipeAuthoringReply['kind']>(r: RecipeAuthoringReply,k: K): Extract<RecipeAuthoringReply,{kind:K}> {
  expect(r.kind).toBe(k);
  return r as Extract<RecipeAuthoringReply,{kind:K}>;
}
async function open() {
  session = kind(await service.request(peer,recipeAuthoringRequestSchema.parse({type:'open',botId:appId,accountId:account})),'session').session;
}
async function link() {
  const challenge = kind(await rpc('beginLink'),'challenge');
  await orch.onMessage(msg('/recipe link '+challenge.code));
  const seen = kind(await rpc('inspectLink',{challengeId:challenge.challengeId}),'link');
  expect(seen.recipient).toEqual({openId:owner,chatId,tenantKey:tenant});
  await rpc('confirmLink',{challengeId:challenge.challengeId,evidence:seen.evidence});
}
async function prepare() {
  const src = kind(await rpc('reviewSource',{groupId}),'source');
  expect(src.role).toBe(sourceRole); expect(src.untracked).toBe(true);
  return kind(await rpc('prepare',{groupId,reviewToken:src.reviewToken,sourceAttested:true}),'operation').operation;
}
async function status(id: string) { return kind(await rpc('status'),'status').operations.find(o=>o.operationId===id)!; }
async function auth(op: AuthoringOperation, stage: 'dispatch'|'accept'): Promise<AuthoringAuthorization> {
  const {operationId,targetPublicKey,nonceCommitment,draftId,baseRevision,purpose} = op;
  const registration={targetPublicKey,nonceCommitment,purpose,draftId,baseRevision};
  const fields={stage,stateRevision:stage==='dispatch'?1:2,payloadDigest:stage==='dispatch'?dispatchDigest:op.payloadDigest!};
  if (accountApi) {
    if (stage==='dispatch') await acct('/authoring/'+operationId+'/register',registration);
    return authoringAuthorizationSchema.parse(await acct('/authoring/'+operationId+'/authorize',fields));
  }
  return {...registration,...fields,operationId,accountId:account,status:stage==='dispatch'?'registered':'dispatched',
    operationDeadline:clock+86400000,deadline:clock+300000,serverPublicKey:generateKeyPairSync('x25519').publicKey.export({format:'jwk'}).x!,
    ticket:Buffer.alloc(32,3).toString('base64url')};
}
async function advance(op: AuthoringOperation, stage: 'dispatch'|'accept') {
  return kind(await rpc('advance',{operationId:op.operationId,authorization:await auth(op,stage)}),'operation').operation;
}
function ref(messageId?: string) {
  const m = messageId ? [...messages.values()].find(m=>m.message_id===messageId)! : [...messages.values()].at(-1)!;
  const card: {body:{elements:{behaviors?:{value:{ref:string}}[]}[]}} = JSON.parse(cards.get(m.card_id)!);
  return {messageId:m.message_id,ref:card.body.elements.find(e=>e.behaviors)?.behaviors?.[0]?.value.ref ?? ''};
}
async function act(action: ReturnType<typeof ref>, more: {by?:string;chat?:string;tenant?:string;messageId?:string;verb?:string} = {}) {
  const by = more.by ?? owner;
  await orch.dispatcher.handle({messageId:more.messageId ?? action.messageId,chatId:more.chat ?? chatId,operator:{openId:by},
    raw:{operator:{open_id:by,tenant_key:more.tenant ?? tenant}},action:{tag:'button',value:{a:'recipe.authoring',ref:action.ref,verb:more.verb ?? 'confirm'}}});
}

it('links the actual sender, then prepares and edits the same private draft through the intake and CardKit dispatcher',async()=>{
  await orch.onMessage(msg('/recipe'));
  expect(JSON.stringify(textSend.mock.calls)).not.toContain('PRIVATE-GROUP-SENTINEL');
  await link();
  const prepared=await prepare();
  expect(messages.size).toBe(0);expect(cards.size).toBe(0);
  const sent=await advance(prepared,'dispatch');
  expect(sent.state).toBe('waiting');expect(messages.size).toBe(1);
  const original=ref();
  for (const wrong of [{by:stranger},{chat:'oc_other'},{tenant:'other'},{messageId:'om_forward'}]) await act(original,wrong);
  expect((await status(sent.operationId)).state).toBe('waiting');
  await Promise.all([act(original),act(original)]);
  const confirmed=await status(sent.operationId);
  expect(confirmed.state).toBe('pendingCloud');
  const frozen = kind(await rpc('inspectCandidate',{operationId:sent.operationId}),'candidate');
  expect(JSON.parse(Buffer.from(frozen.payload,'base64url').toString())).toEqual({public:blankPublic(),config:{role:sourceRole}});
  const done=await advance(confirmed,'accept');
  expect(done.receipt).toMatchObject({status:'accepted',revision:1});
  const instruction = msg('/recipe name 作者提供的新标题');
  await orch.onMessage(instruction);
  const editing=kind(await rpc('status'),'status').operations.find(o=>o.purpose==='editDraft')!;
  const proposal=await advance(editing,'dispatch');
  expect(proposal.state).toBe('candidate');expect(messages.size).toBe(2);
  const preflight=kind(await rpc('inspectCandidate',{operationId:proposal.operationId}),'candidate');
  expect(JSON.parse(Buffer.from(preflight.payload,'base64url').toString())).toMatchObject({baseRevision:1,changes:[{op:'setPublicText',field:'name',value:'作者提供的新标题'}]});
  await act(ref()); const ready=await status(proposal.operationId);
  expect((await advance(ready,'accept')).receipt).toMatchObject({status:'accepted',revision:2,draftId:done.receipt!.status==='accepted'?done.receipt!.draftId:'missing'});
  const followup=await status(proposal.operationId);
  expect(await service.onMessage(msg('/recipe end'))).toBe(true);
  expect(await service.onMessage(msg('这是普通私聊'))).toBe(false);
  expect(followup.receipt?.status).toBe('accepted');
  expect(await service.onMessage(instruction)).toBe(true);
  expect(kind(await rpc('status'),'status').operations).toHaveLength(2);
  expect(cloud.map(c=>c.action)).toEqual(['dispatch','accept','dispatch','accept']);
  const wire=bodies.filter(b=>b.path.includes('/open-apis/im/')||b.path.includes('/cardkit/')).map(b=>b.body).join('');
  for (const secret of [sourceRole,hiddenMemory,'PRIVATE-GROUP-SENTINEL','作者提供的新标题']) expect(wire).not.toContain(secret);
  for (const send of cloud.filter(c=>c.action==='accept')) expect(Buffer.from(send.body.payload!,'base64url').toString()).not.toContain(hiddenMemory);
});

it('recovers lost dispatch and delivery without a second card and rejects stale carriers after explicit resend',async()=>{
  await link();const op=await prepare();
  loseDispatch=true;await expect(advance(op,'dispatch')).rejects.toThrow();
  expect(messages.size).toBe(0);
  service.disconnect(peer.id);restart();await open();
  loseSend=true;await expect(rpc('deliver',{operationId:op.operationId})).rejects.toThrow();
  const stale=ref();
  expect(messages.size).toBe(1);
  clock+=3600001;await open();loseSend=false;
  await rpc('deliver',{operationId:op.operationId});expect(messages.size).toBe(1);
  await rpc('resend',{operationId:op.operationId});expect(messages.size).toBe(2);
  await service.onAction({messageId:stale.messageId,chatId,operator:{openId:owner},raw:{operator:{open_id:owner,tenant_key:tenant}},
    action:{tag:'button',value:{a:'recipe.authoring',ref:stale.ref,verb:'confirm'}}});
  expect((await status(op.operationId)).state).toBe('waiting');
});

it('rejects a stale session, restricted role, missing binding, source ABA and removed admin',async()=>{
  await link();
  await expect(service.request(otherPeer,recipeAuthoringRequestSchema.parse({type:'status',botId:appId,session}))).rejects.toThrow();
  const op=await prepare();
  await mutateProjectByChatId(groupId,row=>{row.supplement='another';});
  await mutateProjectByChatId(groupId,row=>{row.supplement=sourceRole;});
  await expect(advance(op,'dispatch')).rejects.toThrow();expect(cards.size).toBe(0);
  await mutateProjectByChatId(groupId,row=>{row.recipeInstall={recipeId:randomUUID(),versionId:randomUUID(),authorId:randomUUID(),access:'coded',revision:1,manifestSha256:'a'.repeat(64),installedAt:1,base:{role:'restricted'}};});
  await expect(rpc('reviewSource',{groupId})).rejects.toThrow('受限');
  await removeProject('PRIVATE-GROUP-SENTINEL');await expect(rpc('reviewSource',{groupId})).rejects.toThrow();
  await service.adminRemoved(owner);expect(kind(await rpc('status'),'status').linked).toBe(false);
  await writeFile(join(root,'bots.json'),JSON.stringify({version:1,bots:[{...bot,name:'new',registrationId:randomUUID()}]}));
  await expect(rpc('status')).rejects.toThrow();
});

it('checks candidate revision, retains original cloud receipt after lost accept, pauses offline actions',async()=>{
  await link();const draft=randomUUID();
  const prepared=kind(await rpc('edit',{draftId:draft,baseRevision:2}),'operation').operation;
  await advance(prepared,'dispatch');
  await orch.onMessage(msg('/recipe role 第一版'));
  const old=ref();
  await orch.onMessage(msg('/recipe name 新名称'));const review=ref();
  await act(old);expect((await status(prepared.operationId)).state).toBe('candidate');
  const digestBefore=(await status(prepared.operationId)).payloadDigest;
  await orch.onMessage(msg('/recipe role '+'文'.repeat(2000)));
  expect((await status(prepared.operationId)).payloadDigest).toBe(digestBefore);
  await act(review);const op=await status(prepared.operationId);
  const cap=await auth(op,'accept');
  service.disconnect(peer.id);
  await expect(rpc('advance',{operationId:op.operationId,authorization:cap})).rejects.toThrow();
  expect(cloud.some(r=>r.action==='accept')).toBe(false);
  await open(); loseAccept=true;
  await expect(rpc('advance',{operationId:op.operationId,authorization:cap})).rejects.toThrow('response lost');
  await rpc('cancel',{operationId:op.operationId});
  const receipt={status:'accepted',operationId:op.operationId,stateRevision:3,draftId:draft,revision:3};
  expect(results.get(op.operationId)).toEqual({draftId:draft,revision:3});
  restart(); await open();
  const settled=kind(await rpc('settle',{operationId:op.operationId,receipt}),'operation').operation;
  expect(settled.state).toBe('completed');expect(settled.receipt).toEqual(receipt);
  expect((await rpc('settle',{operationId:op.operationId,receipt}))).toMatchObject({operation:{receipt}});
  clock+=31*60_000;
  expect(await service.onMessage(msg('普通消息'))).toBe(false);
});

it('recognizes a callback arriving after lost delivery only on the original CardKit entity',async()=>{
  await link();const op=await prepare();
  loseSend=true;await expect(advance(op,'dispatch')).rejects.toThrow();
  const trigger=ref();
  await act(trigger,{messageId:'om_forward'});
  expect((await status(op.operationId)).state).toBe('sending');
  await act(trigger);expect((await status(op.operationId)).state).toBe('pendingCloud');
  expect(messages.size).toBe(1);
  const pending=kind(await rpc('cancel',{operationId:op.operationId}),'operation').operation;
  expect(pending.state).toBe('cancelPending');
  await expect(advance(pending,'accept')).rejects.toThrow();
  const receipt={status:'cancelled',operationId:op.operationId,stateRevision:3};
  await rpc('settle',{operationId:op.operationId,receipt});
  expect((await status(op.operationId)).state).toBe('cancelled');
});

it('limits link attempts, requires the same peer evidence and enforces the account switch before a new send',async()=>{
  const c=kind(await rpc('beginLink'),'challenge');
  for(let n=0;n<5;n++) await orch.onMessage(msg('/recipe link wrong'));
  await orch.onMessage(msg('/recipe link '+c.code));
  await expect(rpc('inspectLink',{challengeId:c.challengeId})).rejects.toThrow();
  await link();const op=await prepare();
  await service.request(peer,recipeAuthoringRequestSchema.parse({type:'open',botId:appId,accountId:randomUUID()}));
  await expect(advance(op,'dispatch')).rejects.toThrow();
  expect(cloud.length).toBe(0);expect(messages.size).toBe(0);
});

it('starts a new chat creation only from the sole previously reviewed source',async()=>{
  await link();
  await orch.onMessage(msg('/recipe create'));
  expect(kind(await rpc('status'),'status').operations).toEqual([]);
  const first=await prepare();
  await rpc('cancel',{operationId:first.operationId});
  await rpc('settle',{operationId:first.operationId,receipt:{operationId:first.operationId,status:'cancelled',stateRevision:1}});
  const command=msg('/recipe create');
  await orch.onMessage(command);await service.onMessage(command);
  const active=kind(await rpc('status'),'status').operations.filter(op=>op.state==='pendingMain');
  expect(active).toHaveLength(1);expect(active[0]?.groupId).toBe(groupId);expect(messages.size).toBe(0);
});

it('verifies the published proof and rejects credentials before sending anything',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../../../services/recipe-api/test/fixtures/authoring-proof.json',import.meta.url),'utf8'));
  expect(Buffer.from(makeAuthoringProof(Buffer.from(fixture.targetPrivateKeyHex,'hex').toString('base64url'),fixture.binding),'base64url').toString('hex')).toBe(fixture.proofHex);
  expect(()=>freezePayload({public:blankPublic(),config:{role:'sk-'+ 'z'.repeat(30)}})).toThrow();
  expect(()=>freezePayload({public:blankPublic(),config:{role:'文件位于 /Users/private/test'}})).toThrow();
  expect(digest('')).toBe(dispatchDigest);
});
