import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {agentIdSchema,groupIdSchema,type AccountStatus,type AuthoringOperation,type AuthoringReconciliation,
  type RecipeAuthoringReply,type RecipeAuthoringRequest,type RichFreezeInput} from '@vonvon/protocol';
import type {VonvonClient} from '@vonvon/client/browser';
import type {NativeAccount} from '../src/account-session';
import {RecipeAuthoringController} from '../src/recipe-authoring';
import {AuthoringJournal} from '../src/recipe-authoring-journal';
import {LocalRecipeDrafts,LocalRecipeDraftError,type LocalRecipeDraftRecord} from '../src/local-recipe-drafts';
import {bindRichMembers} from '../../daemon/src/recipe/authoring-rich-flow';

const cleanup:Array<()=>void>=[];
const ackValidationErrors:unknown[]=[];
afterEach(()=>{
  try{expect(ackValidationErrors.splice(0)).toEqual([]);}
  finally{for(const close of cleanup.splice(0).reverse())close();}
});
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function canonical(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b))
    .map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
  return JSON.stringify(value);
}
function fixture(options:{rich?:boolean;legacy?:boolean;lostAccept?:boolean;failBeforeAccept?:boolean;rejectAccept?:boolean;edit?:boolean;pendingMain?:boolean;reconciliation?:boolean;
  failAckOnce?:boolean;acceptedPending?:boolean;pruneAfterAck?:boolean;sourceVersionId?:string}={}){
  const accountId=randomUUID(),operationId=randomUUID(),draftId=options.edit?randomUUID():operationId,deviceId=randomUUID(),sessionId=randomUUID(),binding=randomUUID();
  const deviceKey=Buffer.alloc(32,7).toString('base64url'),identity='c'.repeat(64),scope='d'.repeat(64);
  const botId=agentIdSchema.parse('cli_local_authoring'),groupId=groupIdSchema.parse('oc_local_authoring');
  const publicInfo={name:'Local draft',version:'1.0',summary:'Small summary',overview:'Overview',access:'direct' as const};
  const roleCandidate=options.edit?{schemaVersion:1,draftId,baseRevision:1,changes:[{op:'setDraftRole',value:'Private role stays on this machine.'}]}:
    {public:publicInfo,config:{role:'Private role stays on this machine.'}};
  const rolePayload=canonical(roleCandidate),text='---\ndescription: Local skill description\n---\nPRIVATE SKILL CONTENT';
  const value=(value:string)=>({itemId:randomUUID(),originId:randomUUID(),value});
  const file={itemId:randomUUID(),originId:randomUUID(),name:'SKILL.md',use:'skillDescription' as const,text:{kind:'inline' as const,value:text}};
  const skill={itemId:randomUUID(),originId:randomUUID(),name:'local-skill',entryFileId:file.itemId,fileIds:[file.itemId]};
  let richRequest:RichFreezeInput={format:'rich-v2',access:'direct',...(options.sourceVersionId&&{sourceVersionId:options.sourceVersionId}),content:{format:'rich-v2',schemaVersion:2,
    public:{name:value('Local draft'),summary:value('Small summary'),overview:value('Overview'),version:value('1.0')},
    settings:[],rules:[],skills:[skill],files:[file],tasks:[],memories:[],setup:[],parts:[]},origins:[]};
  if('content'in richRequest)richRequest.origins=[...Object.values(richRequest.content.public),skill,file].map(item=>({itemId:item.itemId,source:{kind:'accountClaim'}}));
  const members=[{itemId:file.itemId,kind:'text' as const,sha256:sha(text),bytes:Buffer.from(text).toString('base64url')}];
  const digest=options.rich?'a'.repeat(64):sha(rolePayload);
  const op:AuthoringOperation={operationId,...(options.edit?{purpose:'editDraft' as const,draftId,baseRevision:1}:{purpose:'prepareDraft' as const,groupId}),targetPublicKey:deviceKey,nonceCommitment:deviceKey,
    ...(!options.legacy&&{storage:'local'}),...(options.rich&&{format:'rich-v2'}),state:options.pendingMain?'pendingMain':'pendingCloud',
    createdAt:Date.now(),payloadDigest:digest,deliveryUnknown:false};
  const reconciliations:AuthoringReconciliation[]=options.reconciliation?[{operationId:randomUUID(),purpose:'prepareDraft',
    targetPublicKey:deviceKey,nonceCommitment:deviceKey,createdAt:Date.now(),...(options.rich&&{format:'rich-v2'})}]:[];
  const calls:RecipeAuthoringRequest[]=[];
  let lostAccept=options.lostAccept??false,failBeforeAccept=options.failBeforeAccept??false,failAck=options.failAckOnce??false,bound=false,acknowledged=false;
  const rpc=vi.fn(async(input:RecipeAuthoringRequest):Promise<RecipeAuthoringReply>=>{
    calls.push(structuredClone(input));
    if(options.pruneAfterAck&&acknowledged&&'operationId'in input&&input.type!=='localDraftAcknowledged')throw Error('operation was collected after durable acknowledgement');
    switch(input.type){
      case 'open':return {kind:'session',session:sessionId,linked:true,leaseMs:45000};
      case 'close':return {kind:'closed'};
      case 'workflow':return {kind:'workflow',activity:0,ageMs:0,pausedContexts:[]};
      case 'status':return {kind:'status',linked:true,operations:options.pruneAfterAck&&acknowledged?[]:[structuredClone(op)],reconciliation:structuredClone(reconciliations)};
      case 'groupSourceIdentity':return {kind:'groupSourceIdentity',groupId,identity};
      case 'operationSourceIdentity':return {kind:'operationSourceIdentity',operationId,groupId,identity};
      case 'creatorDiscover':return {kind:'creatorBinding',association:{binding,scope,recipient:{openId:'ou_local_author',chatId:groupId,tenantKey:'local'}},wakeId:null};
      case 'inspectCandidate':return {kind:'candidate',operationId,payloadDigest:digest,...(options.edit&&{reviewedDigest:digest}),payload:Buffer.from(rolePayload).toString('base64url')};
      case 'richMembers':return {kind:'richMembers',operationId,reviewDigest:digest,cap:131072,members:members.map(({kind,sha256})=>({kind,sha256}))};
      case 'richReadMember':return {kind:'richMember',operationId,index:input.index,reviewDigest:digest,bytes:members[input.index]!.bytes};
      case 'richInspect':if(!input.preview&&!bound)throw Error('members must be bound before inspection');return {kind:'richCandidate',operationId,reviewDigest:digest,request:structuredClone(richRequest)};
      case 'richBindMembers':bound=true;richRequest=bindRichMembers({request:richRequest,members},input.descriptors,operationId);return {kind:'operation',operation:structuredClone(op)};
      case 'updateCard':delete op.cardUpdate;return {kind:'operation',operation:structuredClone(op)};
      case 'localDraftAcknowledged':{
        try{
          expect(input.receipt).toEqual(op.receipt);
          expect(drafts.pending(accountId,draftId,operationId)).toBeUndefined();
          if(input.receipt.status==='accepted'){
            expect(drafts.receipt(accountId,draftId,operationId)).toMatchObject({revision:input.receipt.revision,deleted:false});
            const visible=drafts.read(accountId,draftId);
            if(visible)expect(visible.draft.revision).toBeGreaterThanOrEqual(input.receipt.revision);
            else{
              const locator=journal.history.locator(accountId,operationId);if(!locator)throw Error('accepted draft was not durable before ACK');
              expect(journal.history.publication({accountId,...locator},operationId)).toBeDefined();
            }
          }
        }catch(error){ackValidationErrors.push(error);throw error;}
        if(failAck){failAck=false;throw Error('simulated acknowledgement transport failure');}
        acknowledged=true;return {kind:'localDraftAcknowledged',operationId};
      }
      case 'localDraftAdvance':{
        if(input.advance.kind==='dispatch'){op.state='pendingCloud';return {kind:'operation',operation:structuredClone(op)};}
        if(input.advance.kind==='roleAccept'||input.advance.kind==='richAccept'){
          if(failBeforeAccept){failBeforeAccept=false;throw Error('simulated failure before daemon acceptance');}
          if(options.rejectAccept)throw Error('final source context refused');
          op.state='completed';op.receipt={operationId,status:'accepted',stateRevision:3,draftId:input.advance.draftId,
            revision:input.advance.kind==='roleAccept'?input.advance.revision:1};
          if(lostAccept){lostAccept=false;throw Error('simulated local acknowledgement loss');}
          return {kind:'operation',operation:structuredClone(op)};
        }
        throw Error('committed local save must win cancellation');
      }
      case 'cancel':throw Error('committed local save must win cancellation');
      default:throw Error('unexpected local RPC '+input.type);
    }
  });
  const client={device:async()=>({kind:'deviceStatus',status:{device:{id:deviceId,name:'Local source',publicKey:deviceKey},
    remote:{addresses:[],port:3000},clients:{active:1,total:1}}}),
    snapshot:async()=>({agents:[{id:botId,name:'Local Bot',running:true}],groups:[{id:groupId,name:'Local group'}],memberships:[{agentId:botId,groupId}]}),recipeAuthoring:rpc} as unknown as VonvonClient;
  const state:AccountStatus={kind:'signedIn',accountId,displayName:'Local author',provider:'google',persistence:'memory'};
  const lease=new AbortController();
  const request=vi.fn(async(id:string,path:string,init?:RequestInit)=>{
    expect(id).toBe(accountId);
    if(path==='/v1/me')return Response.json({accountId});
    if(options.legacy){
      expect(init?.method??'GET').toBe('GET');
      if(path.startsWith('/v2/authoring/')&&path.endsWith('/recovery')||path.startsWith('/v1/authoring/'))
        return Response.json({error:{code:'not_found'}},{status:404});
    }
    throw Error('draft content network request forbidden: '+path);
  });
  const account:NativeAccount={lease:id=>id===accountId?lease.signal:undefined,status:()=>state,onStatus:()=>()=>{},
    request,login:async()=>state,cancelLogin:async()=>state,logout:async()=>state,dispose:async()=>{}};
  const dir=mkdtempSync(join(tmpdir(),'vv-local-controller-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const journal=new AuthoringJournal(join(dir,'authoring.json')),drafts=new LocalRecipeDrafts(join(dir,'drafts'));
  cleanup.push(()=>drafts.close());
  const original:LocalRecipeDraftRecord|undefined=options.edit?{association:{accountId,viewId:'local',deviceId,deviceKey,botId,binding,scope},
    work:{draftId,source:null},draft:{draftId,recipeId:null,revision:1,public:publicInfo,config:{role:'Original accepted role.'}},members:[]}:undefined;
  if(original)drafts.commit({requestId:randomUUID(),expectedRevision:null,record:original});
  if(options.acceptedPending){
    const record:LocalRecipeDraftRecord={association:{accountId,viewId:'local',deviceId,deviceKey,botId,binding,scope},
      work:{draftId,source:null},draft:{draftId,recipeId:null,revision:1,public:publicInfo,config:{role:'Accepted before this App opened.'}},members:[]};
    drafts.stage({requestId:operationId,expectedRevision:null,record});
    op.state='completed';op.createdAt=Date.now()-8*86400_000;op.cardUpdate='pending';
    op.receipt={operationId,status:'accepted',stateRevision:3,draftId,revision:1};
  }
  const onSaved=vi.fn();
  const controller=new RecipeAuthoringController(account,viewId=>({viewId,client,check(){}}),journal,onSaved,drafts);
  cleanup.push(()=>controller.closeAll());
  const open=()=>controller.request({type:'open',accountId,viewId:'local',botId,...(!options.edit&&{groupId})});
  const restart=()=>{
    controller.closeAll();drafts.close();
    const freshJournal=new AuthoringJournal(join(dir,'authoring.json')),freshDrafts=new LocalRecipeDrafts(join(dir,'drafts')),freshSaved=vi.fn();
    cleanup.push(()=>freshDrafts.close());
    const freshController=new RecipeAuthoringController(account,viewId=>({viewId,client,check(){}}),freshJournal,freshSaved,freshDrafts);
    cleanup.push(()=>freshController.closeAll());
    return {journal:freshJournal,drafts:freshDrafts,onSaved:freshSaved,controller:freshController,
      open:()=>freshController.request({type:'open',accountId,viewId:'local',botId,...(!options.edit&&{groupId})})};
  };
  return {accountId,operationId,draftId,botId,groupId,identity,calls,request,controller,journal,drafts,op,open,text,original,onSaved,restart,
    historyTarget:{accountId,deviceId,deviceKey,botId}};
}

it('saves a reviewed role draft through the public controller without creating or reading a cloud draft',async()=>{
  const f=fixture(),result=await f.open();
  expect(result).toMatchObject({kind:'session',operations:[{operationId:f.operationId,state:'completed',receipt:{status:'accepted',revision:1}}]});
  expect(f.drafts.read(f.accountId,f.operationId)?.draft).toMatchObject({draftId:f.operationId,revision:1,config:{role:'Private role stays on this machine.'}});
  expect(f.calls.some(call=>call.type==='localDraftAdvance'&&call.advance.kind==='roleAccept')).toBe(true);
  expect(f.request.mock.calls.map(([,path])=>path)).toEqual(['/v1/me']);
});

it('copies selected rich skill bytes only over local RPC and durably preserves the complete first saved source',async()=>{
  const f=fixture({rich:true}),result=await f.open();
  expect(result).toMatchObject({kind:'session',operations:[{state:'completed',receipt:{status:'accepted',revision:1}}]});
  const saved=f.drafts.read(f.accountId,f.operationId);
  expect(saved?.draft.format).toBe('rich-v2');
  if(saved?.draft.format!=='rich-v2')throw Error('rich saved draft');
  expect(Object.values(saved.draft.rich.texts)).toEqual([f.text]);
  expect(saved.sourceCanonical).toBe(saved.draft.rich.canonical);
  expect(saved.work.source).toEqual({preparationId:f.operationId,groupId:f.groupId,identity:f.identity});
  expect(saved.members.map(member=>Buffer.from(member.base64,'base64').toString())).toEqual([f.text]);
  expect(f.calls.filter(call=>call.type==='richReadMember')).toHaveLength(1);
  expect(f.request.mock.calls.map(([,path])=>path)).toEqual(['/v1/me']);
  if(result.kind!=='session')throw Error('session');
  await expect(f.controller.request({type:'sourceHistory',handle:result.handle,groupId:f.groupId})).resolves.toMatchObject({
    kind:'sourceHistory',entries:[{state:'draft',operationId:f.operationId,draftId:f.operationId,name:'Local draft',revision:1}],nextCursor:null,
  });
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
});

it('resolves a pure daemon rich preparation parent from the exact verified account, device, Bot and source version',async()=>{
  const parent={recipeId:randomUUID(),versionId:randomUUID()},f=fixture({rich:true,sourceVersionId:parent.versionId});
  f.journal.history.rememberParent(f.historyTarget,parent);
  expect(f.journal.parent(f.operationId)).toBeUndefined();
  const opened=await f.open();
  expect(opened).toMatchObject({kind:'session',operations:[{state:'completed',receipt:{status:'accepted'}}]});
  const saved=f.drafts.read(f.accountId,f.draftId);
  expect(saved?.parent).toEqual(parent);expect(saved?.draft.recipeId).toBe(parent.recipeId);
  expect(f.journal.parent(f.operationId)).toBeUndefined();
  expect(f.calls.some(call=>call.type==='beginHandoff'||call.type==='creatorContinue')).toBe(false);
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
});

it.each(['unknown','differentVersion','differentBot'] as const)('refuses to guess a rich preparation parent from %s history',async kind=>{
  const parent={recipeId:randomUUID(),versionId:randomUUID()},f=fixture({rich:true,sourceVersionId:parent.versionId});
  if(kind==='differentVersion')f.journal.history.rememberParent(f.historyTarget,{...parent,versionId:randomUUID()});
  if(kind==='differentBot')f.journal.history.rememberParent({...f.historyTarget,botId:agentIdSchema.parse('cli_other_parent')},parent);
  await f.open();
  expect(f.drafts.read(f.accountId,f.draftId)).toBeUndefined();expect(f.drafts.list(f.accountId)).toEqual([]);
  expect(f.drafts.pending(f.accountId,f.draftId,f.operationId)).toBeUndefined();
  expect(f.calls.some(call=>call.type==='localDraftAdvance'&&call.advance.kind==='richAccept')).toBe(false);
  expect(f.onSaved).not.toHaveBeenCalled();
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
});

it('creates an independent draft when the daemon did not select a source version despite a previously verified parent',async()=>{
  const f=fixture({rich:true});f.journal.history.rememberParent(f.historyTarget,{recipeId:randomUUID(),versionId:randomUUID()});
  await f.open();const saved=f.drafts.read(f.accountId,f.draftId);
  expect(saved?.draft.revision).toBe(1);expect(saved?.parent).toBeUndefined();expect(saved?.draft.recipeId).toBeNull();
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
});

it.each([false,true])('keeps an accepted save invisible until receipt recovery and never cancels or accepts it twice after acknowledgement loss (rich=%s)',async rich=>{
  const f=fixture({rich,lostAccept:true}),opened=await f.open();
  if(opened.kind!=='session')throw Error('session');
  expect(f.drafts.read(f.accountId,f.operationId)).toBeUndefined();expect(f.drafts.list(f.accountId)).toEqual([]);
  expect(f.drafts.receipt(f.accountId,f.operationId,f.operationId)).toBeUndefined();
  expect(f.drafts.pending(f.accountId,f.operationId,f.operationId)?.record.draft.revision).toBe(1);
  expect(f.onSaved).not.toHaveBeenCalled();
  expect(f.journal.localAcceptance(f.operationId)?.kind).toBe(rich?'richAccept':'roleAccept');
  const result=await f.controller.request({type:'cancel',handle:opened.handle,operationId:f.operationId});
  expect(result).toMatchObject({kind:'operation',operation:{state:'completed',receipt:{status:'accepted',revision:1}}});
  expect(f.drafts.read(f.accountId,f.operationId)?.draft.revision).toBe(1);
  expect(f.calls.filter(call=>call.type==='localDraftAdvance'&&['richAccept','roleAccept'].includes(call.advance.kind))).toHaveLength(1);
  expect(f.calls.some(call=>call.type==='cancel'||call.type==='localDraftAdvance'&&call.advance.kind==='cancel')).toBe(false);
  expect(f.journal.localAcceptance(f.operationId)).toBeUndefined();
  expect(f.drafts.pending(f.accountId,f.operationId,f.operationId)).toBeUndefined();
  expect(f.onSaved).toHaveBeenCalledExactlyOnceWith({accountId:f.accountId,draftId:f.draftId,revision:1});
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
});

it.each([false,true])('replays the same pending proof after failure before daemon acceptance without exposing a draft early (rich=%s)',async rich=>{
  const f=fixture({rich,failBeforeAccept:true}),opened=await f.open();if(opened.kind!=='session')throw Error('session');
  expect(f.op.state).toBe('pendingCloud');expect(f.drafts.read(f.accountId,f.draftId)).toBeUndefined();
  expect(f.drafts.pending(f.accountId,f.draftId,f.operationId)).toBeDefined();
  const result=await f.controller.request({type:'resume',handle:opened.handle,operationId:f.operationId});
  expect(result).toMatchObject({kind:'operation',operation:{state:'completed',receipt:{status:'accepted',revision:1}}});
  const attempts=f.calls.filter(call=>call.type==='localDraftAdvance'&&['richAccept','roleAccept'].includes(call.advance.kind));
  expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);
  expect(f.drafts.read(f.accountId,f.draftId)?.draft.revision).toBe(1);
  expect(f.drafts.pending(f.accountId,f.draftId,f.operationId)).toBeUndefined();
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
});

it.each([false,true])('finishes an accepted pending save through a fresh controller after restart and notifies exactly once (rich=%s)',async rich=>{
  const f=fixture({rich,lostAccept:true});await f.open();
  expect(f.drafts.read(f.accountId,f.draftId)).toBeUndefined();expect(f.onSaved).not.toHaveBeenCalled();
  const fresh=f.restart();
  expect(fresh.drafts.pending(f.accountId,f.draftId,f.operationId)?.record.draft.revision).toBe(1);
  const result=await fresh.open();if(result.kind!=='session')throw Error('session');
  expect(fresh.drafts.read(f.accountId,f.draftId)?.draft.revision).toBe(1);
  expect(fresh.onSaved).toHaveBeenCalledExactlyOnceWith({accountId:f.accountId,draftId:f.draftId,revision:1});
  await fresh.controller.request({type:'status',handle:result.handle});
  expect(fresh.onSaved).toHaveBeenCalledTimes(1);
  expect(f.calls.filter(call=>call.type==='localDraftAdvance'&&['richAccept','roleAccept'].includes(call.advance.kind))).toHaveLength(1);
  expect(f.calls.some(call=>call.type==='cancel'||call.type==='localDraftAdvance'&&call.advance.kind==='cancel')).toBe(false);
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
});

it('retries a failed durable ACK while preserving the accepted edit and caches success per handle',async()=>{
  const f=fixture({edit:true,failAckOnce:true}),opened=await f.open();if(opened.kind!=='session')throw Error('session');
  const expected={accountId:f.accountId,draftId:f.draftId,revision:2};
  expect(f.drafts.read(f.accountId,f.draftId)?.draft).toMatchObject({revision:2,config:{role:'Private role stays on this machine.'}});
  expect(f.onSaved).toHaveBeenCalledExactlyOnceWith(expected);
  expect(f.calls.filter(call=>call.type==='localDraftAcknowledged')).toHaveLength(1);
  await f.controller.request({type:'status',handle:opened.handle});
  expect(f.calls.filter(call=>call.type==='localDraftAcknowledged')).toHaveLength(2);
  await f.controller.request({type:'status',handle:opened.handle});
  expect(f.calls.filter(call=>call.type==='localDraftAcknowledged')).toHaveLength(2);
  expect(f.onSaved).toHaveBeenCalledTimes(1);
  const fresh=f.restart();await fresh.open();
  const acknowledgements=f.calls.filter(call=>call.type==='localDraftAcknowledged');
  expect(acknowledgements).toHaveLength(3);
  expect(acknowledgements.map(call=>call.receipt)).toEqual([f.op.receipt,f.op.receipt,f.op.receipt]);
  expect(fresh.onSaved).not.toHaveBeenCalled();
  expect(f.calls.filter(call=>call.type==='localDraftAdvance'&&call.advance.kind==='roleAccept')).toHaveLength(1);
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
});

it('finishes source and card reads before acknowledging an old accepted operation that is immediately collected',async()=>{
  const f=fixture({acceptedPending:true,pruneAfterAck:true}),opened=await f.open();
  expect(opened).toMatchObject({kind:'session',operations:[{state:'completed',receipt:{status:'accepted'}}]});
  expect(f.drafts.read(f.accountId,f.draftId)?.draft.revision).toBe(1);
  const ack=f.calls.findIndex(call=>call.type==='localDraftAcknowledged');
  expect(f.calls.findIndex(call=>call.type==='operationSourceIdentity')).toBeGreaterThanOrEqual(0);
  expect(f.calls.findIndex(call=>call.type==='updateCard')).toBeGreaterThanOrEqual(0);
  expect(ack).toBeGreaterThan(f.calls.findIndex(call=>call.type==='operationSourceIdentity'));
  expect(ack).toBeGreaterThan(f.calls.findIndex(call=>call.type==='updateCard'));
  expect(f.calls.slice(ack+1).some(call=>'operationId'in call&&call.type!=='localDraftAcknowledged')).toBe(false);
  expect(f.onSaved).toHaveBeenCalledExactlyOnceWith({accountId:f.accountId,draftId:f.draftId,revision:1});
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
});

it.each([false,true])('keeps final-context-rejected content hidden, preserves the previous head, and releases its lock only after known cancellation (edit=%s)',async edit=>{
  const f=fixture({rejectAccept:true,edit}),opened=await f.open();if(opened.kind!=='session')throw Error('session');
  expect(f.drafts.read(f.accountId,f.draftId)).toEqual(f.original);
  expect(f.drafts.list(f.accountId)).toEqual(f.original?[f.original]:[]);
  expect(f.drafts.receipt(f.accountId,f.draftId,f.operationId)).toBeUndefined();
  expect(f.drafts.pending(f.accountId,f.draftId,f.operationId)?.record.draft.revision).toBe(edit?2:1);
  if(!edit)await expect(f.controller.request({type:'sourceHistory',handle:opened.handle,groupId:f.groupId})).resolves.toMatchObject({
    kind:'sourceHistory',entries:[{state:'unknown',operationId:f.operationId,draftId:null,recipeId:null,versionId:null}],nextCursor:null,
  });
  if(f.original){
    const newer=structuredClone(f.original);newer.draft.revision=2;newer.draft.public.summary='Concurrent metadata';
    expect(()=>f.drafts.commit({requestId:randomUUID(),expectedRevision:1,record:newer})).toThrow(LocalRecipeDraftError);
    expect(()=>f.drafts.discard({accountId:f.accountId,draftId:f.draftId,requestId:randomUUID(),expectedRevision:1})).toThrow(LocalRecipeDraftError);
  }
  f.op.state='cancelled';f.op.receipt={operationId:f.operationId,status:'cancelled',stateRevision:2};
  await f.controller.request({type:'status',handle:opened.handle});
  expect(f.drafts.pending(f.accountId,f.draftId,f.operationId)).toBeUndefined();
  expect(f.drafts.read(f.accountId,f.draftId)).toEqual(f.original);expect(f.journal.localAcceptance(f.operationId)).toBeUndefined();
  if(!edit)await expect(f.controller.request({type:'sourceHistory',handle:opened.handle,groupId:f.groupId})).resolves.toMatchObject({
    kind:'sourceHistory',entries:[{state:'unknown',operationId:f.operationId,draftId:null,recipeId:null,versionId:null}],nextCursor:null,
  });
  if(f.original){
    const next=structuredClone(f.original);next.draft.revision=2;next.draft.public.summary='Metadata after confirmed cancellation';
    f.drafts.commit({requestId:randomUUID(),expectedRevision:1,record:next});
    expect(f.drafts.read(f.accountId,f.draftId)).toEqual(next);
  }
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
});

it('dispatches a new operation to the local stage without cloud registration',async()=>{
  const f=fixture({pendingMain:true}),result=await f.open();
  expect(result).toMatchObject({kind:'session',operations:[{state:'pendingCloud'}]});
  expect(f.calls.filter(call=>call.type==='localDraftAdvance')).toMatchObject([{advance:{kind:'dispatch',draftId:f.operationId}}]);
  expect(f.drafts.list(f.accountId)).toEqual([]);
  expect(f.request.mock.calls.map(([,path])=>path)).toEqual(['/v1/me']);
  if(result.kind!=='session')throw Error('session');
  await expect(f.controller.request({type:'sourceHistory',handle:result.handle,groupId:f.groupId})).resolves.toMatchObject({
    kind:'sourceHistory',entries:[{state:'unknown',operationId:f.operationId,draftId:null,recipeId:null,versionId:null}],nextCursor:null,
  });
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
});

it('retains the confirmed published source-history identity after local soft-discard and process restart without cloud draft reads',async()=>{
  const f=fixture({rich:true}),opened=await f.open();if(opened.kind!=='session')throw Error('session');
  const locator=f.journal.history.locator(f.accountId,f.operationId);if(!locator)throw Error('source locator');
  const published={state:'published' as const,operationId:f.operationId,draftId:f.draftId,recipeId:randomUUID(),versionId:randomUUID(),
    name:'Confirmed published title',version:'2.4.1',revision:7};
  f.journal.history.rememberPublication({accountId:f.accountId,...locator},published);
  await expect(f.controller.request({type:'sourceHistory',handle:opened.handle,groupId:f.groupId})).resolves.toEqual({kind:'sourceHistory',entries:[published],nextCursor:null});
  f.drafts.discard({accountId:f.accountId,draftId:f.draftId,requestId:randomUUID(),expectedRevision:1});
  const fresh=f.restart(),restored=await fresh.open();if(restored.kind!=='session')throw Error('session');
  expect(fresh.drafts.list(f.accountId)).toEqual([]);
  await expect(fresh.controller.request({type:'sourceHistory',handle:restored.handle,groupId:f.groupId})).resolves.toEqual({kind:'sourceHistory',entries:[published],nextCursor:null});
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
});

it.each([false,true])('pauses legacy background and reconciliation operations with read-only receipt requests (rich=%s)',async rich=>{
  const f=fixture({legacy:true,rich,reconciliation:true}),result=await f.open();
  expect(result).toMatchObject({kind:'session'});
  expect(f.request.mock.calls.some(([,path])=>path.includes('/authoring/'))).toBe(true);
  expect(f.request.mock.calls.every(([,path,init])=>path==='/v1/me'||(init?.method??'GET')==='GET')).toBe(true);
  expect(f.request.mock.calls.some(([,path])=>/register|reserve|freeze|cancel|upload/.test(path))).toBe(false);
  expect(f.calls.some(call=>call.type==='advance'||call.type==='richAdvance'||call.type==='localDraftAdvance'||call.type==='settle')).toBe(false);
  expect(f.drafts.list(f.accountId)).toEqual([]);
});
