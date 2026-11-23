import {LocalRecipeDrafts} from '../src/local-recipe-drafts';
import {LocalRecipePublisher} from '../src/local-recipe-publisher';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,expect,it,vi} from 'vitest';
import type {LarkChannel,NormalizedMessage,CardActionEvent} from '@larksuiteoapi/node-sdk';
import {agentIdSchema,recipeAuthoringRequestSchema,creatorReplies,type RecipeAuthoringReply,type RecipeAuthoringRequest,type AccountStatus} from '@vonvon/protocol';
import {createClient,type ClientConnection} from '../../client/src/client.js';
import {RecipeCreatorExecutor,type CreatorContext} from '../src/recipe-creator.js';
import {RecipeCreatorJournal} from '../src/recipe-creator-journal.js';
import {AuthoringJournal} from '../src/recipe-authoring-journal.js';
import {MetadataJournal} from '../src/community-metadata-journal.js';
import type {NativeAccount} from '../src/account-session.js';
import type {AppConfig} from '../../daemon/src/config/schema.js';
const root=realpathSync(mkdtempSync(join(tmpdir(),'vonvon-creator-domain-')));
vi.stubEnv('VONVON_HOME',root);vi.stubEnv('HOME',root);
const {AuthoringService}=await import('../../daemon/src/recipe/authoring-service.js');
afterAll(()=>{vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});

it('drives actual private input and original final card through real daemon, client, Main journal and native executor',async()=>{
  const accountId=randomUUID(),draftId=randomUUID(),recipeId=randomUUID(),versionId=randomUUID(),deviceId=randomUUID();
  const bot={appId:'cli_native_domain',tenant:'feishu' as const,createdAt:1,registrationId:randomUUID()},botId=agentIdSchema.parse(bot.appId);
  writeFileSync(join(root,'bots.json'),JSON.stringify({version:1,bots:[{name:'本机验收',...bot}]}));
  const author='ou_author',chatId='oc_private',tenant='tenant_fixture',peer={id:randomUUID(),device:deviceId};
  const cards=new Map<string,string>(),messages=new Map<string,{message_id:string;chat_id:string;card_id:string}>();
  let lastMessage='',counter=0;
  const channel={send:vi.fn(async()=>({messageId:'om_text'})),rawClient:{cardkit:{v1:{card:{
    create:async({data}:{data:{data:string}})=>{const card_id='card_'+ ++counter;cards.set(card_id,data.data);return {code:0,data:{card_id}};},
    update:async({path,data}:{path:{card_id:string};data:{card:{data:string}}})=>{cards.set(path.card_id,data.card.data);return {code:0};},
    idConvert:async({data}:{data:{message_id:string}})=>({code:0,data:{card_id:messages.get(data.message_id)?.card_id}}),
  }}},im:{v1:{message:{
    create:async({data}:{data:{receive_id:string;content:string;uuid:string}})=>{
      const prior=[...messages.values()].find(row=>row.message_id===data.uuid);
      const row=prior??{message_id:'om_card_'+ ++counter,chat_id:data.receive_id,card_id:JSON.parse(data.content).data.card_id};
      lastMessage=row.message_id;messages.set(row.message_id,row);return {code:0,data:row};
    },
    get:async({path}:{path:{message_id:string}})=>{const row=messages.get(path.message_id);return {code:0,data:{items:row?[{...row,msg_type:'interactive',body:{content:cards.get(row.card_id)}}]:[]}};},
  }}}}} as unknown as LarkChannel;
  const cfg={accounts:{app:{id:bot.appId,secret:'synthetic',tenant:'feishu'}},preferences:{access:{admins:[author],ownerOpenId:author}}} as AppConfig;
  const daemon=new AuthoringService({root,bot,cfg,channel,origin:'http://127.0.0.1:1',loopback:true,currentBot:async()=>{}});
  let receive=(_:string)=>{};
  const socket:ClientConnection={isOpen:()=>true,onMessage:listener=>{receive=listener;},onClose:()=>{},onError:()=>{},close:async()=>{},send(frame,done){
    const input=JSON.parse(frame),request=recipeAuthoringRequestSchema.parse(input.payload);done();
    void daemon.request(peer,request).then(payload=>receive(JSON.stringify({type:'response',id:input.id,method:'recipeAuthoring',payload})),error=>receive(JSON.stringify({type:'error',id:input.id,code:'invalid_request',message:request.type+('answer'in request?'/'+request.answer.kind:'')+': '+error.message})));
  }};
  const client=createClient(socket),rpc=(request:RecipeAuthoringRequest)=>client.recipeAuthoring!(request);
  const asKind=<K extends RecipeAuthoringReply['kind']>(value:RecipeAuthoringReply,kind:K)=>{if(value.kind!==kind)throw Error(kind);return value as Extract<RecipeAuthoringReply,{kind:K}>;};
  const old=asKind(await rpc({type:'open',botId,accountId}),'session');
  const challenge=asKind(await rpc({type:'beginLink',botId,session:old.session}),'challenge');
  const message=(content:string):NormalizedMessage=>{const messageId='om_'+randomUUID();return {content,messageId,senderId:author,chatId,chatType:'p2p',rawContentType:'text',resources:[],mentions:[],mentionAll:false,mentionedBot:false,createTime:Date.now(),
    raw:{sender:{sender_type:'user',sender_id:{open_id:author},tenant_key:tenant},message:{chat_type:'p2p',chat_id:chatId,message_id:messageId}}};};
  await daemon.onMessage(message('/recipe link '+challenge.code));
  const seen=asKind(await rpc({type:'inspectLink',botId,session:old.session,challengeId:challenge.challengeId}),'link');
  await rpc({type:'confirmLink',botId,session:old.session,challengeId:challenge.challengeId,evidence:seen.evidence!});
  const discovery=asKind(await rpc({type:'creatorDiscover',botId,accountId}),'creatorBinding');if(!discovery.association)throw Error('association');
  const opened=asKind(await rpc({type:'creatorOpen',botId,accountId,binding:discovery.association.binding,scope:discovery.association.scope,wakeId:null}),'creatorSession');
  expect(opened.session).not.toBe(old.session);
  const publicValue={name:'实际私聊闭环',summary:'原简介',overview:'原概览',version:'1.0',access:'direct' as const};
  const draft={draftId,recipeId:null,revision:2,public:publicValue,config:{role:'仅发布，不执行任何技能或任务'}};
  const cloudWrites:string[]=[],signal=new AbortController();let remoteId:string|undefined,publicationRequest:string|undefined;
  const status:AccountStatus={kind:'signedIn',accountId,displayName:'作者',provider:'google',persistence:'memory'};
  const account:NativeAccount={status:()=>status,lease:id=>id===accountId?signal.signal:undefined,onStatus:()=>()=>{},login:async()=>status,cancelLogin:async()=>status,logout:async()=>status,dispose:async()=>{},recipeLink:(r,v)=>`https://vonvon.cc/recipes/${r}/versions/${v}`,
    request:async(id,path,init,beforeSend)=>{
      expect(id).toBe(accountId);await beforeSend?.();
      if(path==='/v2/me/publications')return Response.json({items:[]});
      if(path==='/v1/drafts'){
        remoteId=new Headers(init?.headers).get('idempotency-key')!;
        return Response.json({...draft,draftId:remoteId,revision:1});
      }
      if(path===`/v1/drafts/${remoteId}/publish`){cloudWrites.push(path);publicationRequest=new Headers(init?.headers).get('idempotency-key')!;return Response.json({recipeId,versionId,revision:1,public:publicValue});}
      if(path.startsWith('/v1/receipts/publications/'))return Response.json(publicationRequest?{status:'committed',receipt:{requestId:publicationRequest,format:'role-v1',draftId:remoteId,draftRevision:1,recipeId,versionId,revision:1,public:publicValue,firstCodeId:null}}:{status:'unknown'});
      throw Error(path);
    }};
  const authoring=new AuthoringJournal(),journal=new RecipeCreatorJournal(join(root,'native-journal')),metadata=new MetadataJournal();
  const drafts=new LocalRecipeDrafts(),publisher=new LocalRecipePublisher();
  const executor=new RecipeCreatorExecutor(account,journal,metadata,authoring,undefined,undefined,undefined,drafts,publisher);
  const association={accountId,viewId:'local',deviceId,deviceKey:Buffer.alloc(32,1).toString('base64url'),botId,binding:opened.binding,scope:opened.scope};
  const local={association,work:{draftId,source:null},members:[],draft};
  drafts.commit({requestId:randomUUID(),expectedRevision:null,record:{...local,draft:{...draft,revision:1}}});
  drafts.commit({requestId:randomUUID(),expectedRevision:1,record:local});
  const context:CreatorContext={association,session:opened.session,check:()=>signal.signal.throwIfAborted(),rpc,settled:async()=>{}};
  const jobs=async()=>asKind(await rpc({type:'creatorPoll',botId,session:opened.session}),'creatorJobs').jobs;
  const choice=(label:string)=>{
    const row=messages.get(lastMessage)!,card=JSON.parse(cards.get(row.card_id)!);
    const button=card.body.elements.find((item:{text?:{content:string};behaviors?:unknown[]})=>item.behaviors&&item.text?.content.includes(label));
    if(!button)throw Error('missing '+label);
    return {messageId:lastMessage,value:button.behaviors[0].value};
  };
  const tap=async(button:ReturnType<typeof choice>,openId=author)=>daemon.onAction({operator:{openId},raw:{operator:{open_id:openId,tenant_key:tenant}},chatId,messageId:button.messageId,action:{tag:'button',value:button.value}} as CardActionEvent);
  try{
    await daemon.onMessage(message('/recipe works'));
    for(const job of await jobs())await executor.run(context,job);
    await tap(choice('实际私聊闭环'));
    for(const job of await jobs())await executor.run(context,job);
    const publish=choice('确认发布');
    expect(await jobs()).toEqual([]);expect(cloudWrites).toEqual([]);
    await tap(publish,'ou_other');expect(await jobs()).toEqual([]);
    await tap(publish);
    const pending=await jobs();expect(pending).toHaveLength(1);expect(pending[0]?.task.kind).toBe('command');
    await executor.run(context,pending[0]!);
    expect(cloudWrites).toHaveLength(1);expect(publicationRequest).toBe(pending[0]!.id);
    expect(journal.command(accountId,pending[0]!.id)?.result).toMatchObject({kind:'published',target:{recipeId,versionId},draftRevision:2,revision:1});
    expect(await jobs()).toEqual([]);
  }finally{drafts.close();publisher.close();daemon.close();authoring.history.close();await client.close();}
},15000);
