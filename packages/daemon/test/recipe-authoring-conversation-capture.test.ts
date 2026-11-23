import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {agentIdSchema,groupIdSchema,type RecipeRichContent} from '@vonvon/protocol';
import type {AuthoringIm} from '../src/recipe/authoring-im';
import {AuthoringJournal,linkKey,maintain,type AuthoringLedger,type Link} from '../src/recipe/authoring-journal';
import {PrivateHandoffs} from '../src/recipe/authoring-handoff';
import {conversationSource,type RichNativeOptions} from '../src/recipe/authoring-rich-flow';

vi.mock('../src/recipe/authoring-source',()=>({groupSourceIdentity:async()=> 'identity'}));
vi.mock('../src/recipe/authoring-rich-flow',async load=>({...await load<object>(),conversationSource:vi.fn()}));

function fixture(){
  const botId=agentIdSchema.parse('cli_handoff'),groupId=groupIdSchema.parse('oc_group'),account=randomUUID();
  const recipient={openId:'ou_owner',chatId:'oc_private',tenantKey:'tenant'};
  const p={session:randomUUID(),scope:'scope',account,binding:'bound'};
  const link:Link={bot:'bot',binding:p.binding,recipient,sources:[]};
  let db:AuthoringLedger={version:1,operations:{},links:{[linkKey(p.scope,p.account)]:link},daily:{}};
  class Memory extends AuthoringJournal {
    override async run<T>(edit:(db:AuthoringLedger)=>T,guard?:()=>void){
      const next=structuredClone(db);maintain(next,1000);
      const result=structuredClone(edit(next));guard?.();db=next;
      return result;
    }
  }
  const sendText=vi.fn(async()=> 'message');
  const im={sendText,createJson:vi.fn(),send:vi.fn(),updateJson:vi.fn()} as unknown as AuthoringIm;
  const native={bot:{appId:botId,createdAt:1000,tenant:'feishu' as const},channel:{} as RichNativeOptions['channel']};
  const service=new PrivateHandoffs(native,new Memory('',()=>1000),im,()=>1000,()=>{});
  const begin={type:'beginHandoff' as const,conversation:true as const,groupName:'工作群',groupId,botId,retryId:randomUUID(),session:p.session};
  const proposalId=randomUUID(),reviewedScope={lease:'a'.repeat(64),selected:[] as string[]};
  const input={groupId,requestId:proposalId,reviewedScope,expectedSelection:{order:0,identity:'identity'},public:{name:'群配方',summary:'',overview:'',version:''}};
  link.conversationProposal={id:proposalId,groupId,inventoryId:'digest',lease:reviewedScope.lease,selected:reviewedScope.selected,public:input.public,
    access:'direct',identity:'identity',binding:link.binding,order:0,from:'first',offeredAt:1,expiresAt:5000,shownAt:2,acceptedBy:'human-confirmation'};
  return {service,sendText,im,p,link,begin,input,ledger:()=>db};
}

it('retries the same plain message UUID after an unknown delivery and preserves the latest selected group',async()=>{
  const f=fixture();
  f.sendText.mockRejectedValueOnce(new Error('reply lost'));
  expect((await f.service.begin(f.p,f.link,f.begin)).state).toBe('deliveryUnknown');
  expect((await f.service.begin(f.p,f.link,f.begin)).state).toBe('selecting');
  expect((await f.service.begin(f.p,f.link,f.begin)).state).toBe('selecting');
  expect(f.sendText).toHaveBeenCalledTimes(2);
  expect(f.sendText.mock.calls[0]).toEqual(f.sendText.mock.calls[1]);
  expect(f.sendText).toHaveBeenCalledWith('oc_private',expect.stringContaining('工作群'),expect.any(String));
  const next={...f.begin,groupId:groupIdSchema.parse('oc_other'),retryId:randomUUID()};
  await f.service.begin(f.p,f.link,next);
  expect(f.ledger().handoffs![f.begin.retryId]!.phase.state).toBe('cancelled');
  expect(f.ledger().handoffs![next.retryId]!.phase.state).toBe('selecting');
  expect(f.im.createJson).not.toHaveBeenCalled();
  expect(vi.mocked(conversationSource)).not.toHaveBeenCalled();
});

function inventory(){
  const field=()=>({itemId:randomUUID(),originId:randomUUID(),value:''});
  const role={itemId:randomUUID(),originId:randomUUID(),text:{kind:'inline' as const,value:'有效角色'}};
  const content:RecipeRichContent={format:'rich-v2',schemaVersion:2,public:{name:field(),summary:field(),overview:field(),version:field()},
    role,settings:[],skills:[],files:[],memories:[],setup:[],tasks:[],parts:[],rules:[]};
  const edge={versionId:randomUUID(),itemId:randomUUID(),baselineSha256:'1'.repeat(64)};
  const evidence:Awaited<ReturnType<typeof conversationSource>>['inventory']['evidence']=new Map(Object.values(content.public).map(i=>[i.itemId,{kind:'native'}]));
  evidence.set(role.itemId,{kind:'managed',parents:[edge]});
  return {value:{row:{name:'群',blank:false,createdAt:10,bindingIncarnation:'group',chatId:'oc_group',cwd:'/unused'},catalog:[],unavailable:[],options:{skills:[],includeTasks:true,includeBotMemories:false},inventory:{content,evidence,lease:'a'.repeat(64),files:{}}},edge};
}
it('keeps one managed capture across tool retries and rejects external coded attestations without a card or operation',async()=>{
  const f=fixture(),src=inventory(),start=vi.fn();
  f.input.reviewedScope.selected.push(src.value.inventory.content.role!.itemId);
  vi.mocked(conversationSource).mockResolvedValue(src.value);
  const call=()=>f.service.capture(f.p,f.link,f.input,()=>{},start);
  expect(await call()).toEqual({state:'preparing'});
  expect(await call()).toEqual({state:'preparing'});
  const rows=Object.values(f.ledger().handoffs!);
  expect(rows).toHaveLength(1);
  const request=f.service.pending(f.ledger().handoffs,f.p,f.link)!;
  expect(request.items).toEqual([{versionId:src.edge.versionId,itemIds:[src.edge.itemId]}]);
  await expect(f.service.answer(f.p,f.link,{type:'answerHandoff',botId:f.begin.botId,session:f.p.session,request,
    attestations:[{versionId:src.edge.versionId,authorId:randomUUID(),access:'coded',items:[{itemId:src.edge.itemId,kind:'role',baselineSha256:src.edge.baselineSha256}]}]},start)).rejects.toThrow('来源受限');
  expect(f.ledger().handoffs![request.retryId]!.phase.state).toBe('needsReview');
  expect(start).not.toHaveBeenCalled();
  expect(f.im.createJson).not.toHaveBeenCalled();expect(f.sendText).not.toHaveBeenCalled();
});
it('checks the originating turn after group inventory before committing the capture',async()=>{
  const f=fixture(),src=inventory(),start=vi.fn();
  let expired=false;
  vi.mocked(conversationSource).mockImplementationOnce(async()=>{expired=true;return src.value;});
  await expect(f.service.capture(f.p,f.link,f.input,()=>{if(expired)throw Error('expired turn');},start)).rejects.toThrow('expired turn');
  expect(f.ledger().handoffs).toBeUndefined();expect(start).not.toHaveBeenCalled();
});

it('rejects sensitive public text before persisting it or looking up a source',async()=>{
  const f=fixture(),start=vi.fn(),calls=vi.mocked(conversationSource).mock.calls.length;
  const input={...f.input,public:{...f.input.public,overview:'api_key: private_example_value'}};
  await expect(f.service.capture(f.p,f.link,input,()=>{},start)).rejects.toThrow('敏感信息');
  expect(f.ledger().handoffs).toBeUndefined();
  expect(vi.mocked(conversationSource)).toHaveBeenCalledTimes(calls);
});

it('refuses to silently omit a sensitive rule from a full group capture',async()=>{
  const {nativeRichInventory}=await import('../src/recipe/authoring-rich-inventory');
  const row={name:'群',blank:false,createdAt:10,workRules:'密码：private_example_value',bindingIncarnation:'group',chatId:'oc_group',cwd:'/unused'};
  const options={botRoot:'/unused',botId:'bot',seed:'seed',row,
    skills:[],includeBotMemories:false,skillRoots:new Map<string,string>()};
  await expect(nativeRichInventory(options)).rejects.toThrow('敏感信息');
  const unavailable:string[]=[];
  const shareable=await nativeRichInventory({...options,unavailable});
  expect(unavailable).toEqual(['工作规则']);expect(shareable.content.rules).toEqual([]);
});

it('keeps group configuration on the first inventory page and makes every tool selectable by category and offset',async()=>{
  const {inventoryPage}=await import('../src/recipe/conversation-inventory');
  const extra=Array.from({length:80},(_,n)=>({id:'tool-'+n,kind:'tool',label:'工具 '+n,detail:'指引',requirement:'工具 '+n}));
  const inv={groupId:'oc_group',groupName:'工作群',inventoryId:'digest',lease:'lease',provider:'codex-appserver',modelProvider:'openai',model:'actual-model',
    mcpStatus:'unavailable' as const,mcp:[],tools:extra.map(i=>i.label),skills:[{name:'群技能',source:'workspace' as const}],unavailable:[],
    items:[...extra,{id:'role',kind:'role',label:'角色',detail:'工作范围'},{id:'group-skill',kind:'skill',label:'群技能',detail:'技能说明'}]};
  const first=inventoryPage(inv);
  expect(first.items.slice(0,2).map(i=>i.id)).toEqual(['role','group-skill']);expect(first.items).toHaveLength(16);
  expect(first.summary).toContain('Codex · 模型服务商：openai · 模型：actual-model');expect(first.summary).toContain('暂时无法核对');
  expect(first.counts).toMatchObject({skills:1,tools:80});expect(first.tools).toHaveLength(8);
  const ids:string[]=[];let offset:number|undefined=0;
  while(offset!==undefined){const page=inventoryPage(inv,'tools',offset);ids.push(...page.items.map(i=>i.id));offset=page.nextOffset;}
  expect(ids).toEqual(extra.map(i=>i.id));expect(inventoryPage(inv,'skills').items.map(i=>i.id)).toEqual(['group-skill']);
});

it('recognizes independent scope authorization in natural replies and distinguishes an edit from a creation',async()=>{
  const {confirmsConversationScope:confirm}=await import('../src/recipe/conversation-authoring');
  for(const message of ['确认这个范围，保存草稿','好，就按你推荐的保存','没问题，按上面推荐的范围建草稿','确认保存草稿'])expect(confirm(message)).toBe(true);
  for(const message of ['就叫周报','确认','确认发布','确认这个范围，但去掉定时任务','确认这个范围，保存修改'])expect(confirm(message)).toBe(false);
  expect(confirm('确认这个范围，保存修改',true)).toBe(true);expect(confirm('确认这个范围，保存草稿',true)).toBe(false);
});
