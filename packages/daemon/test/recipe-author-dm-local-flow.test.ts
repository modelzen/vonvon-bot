import {randomUUID} from 'node:crypto';
import {chmod,copyFile,mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterAll, expect, it, vi} from 'vitest';
import {agentIdSchema, groupIdSchema, recipeRichContentSchema, type AuthoringPublished, type RecipeAuthoringRequest, type RecipeRichText} from '@vonvon/protocol';
import type {VonvonClient} from '@vonvon/client/browser';
import type {LarkChannel} from '@larksuiteoapi/node-sdk';
import type {NativeAccount} from '../../desktop/src/account-session';
import type {AppConfig} from '../src/config/schema';
import type {Project} from '../src/project/registry';

const responses=vi.hoisted(()=>[] as string[]);
// Only the chat run's streaming display is out of scope. Authoring cards still use the transport below.
vi.mock('../src/card/run-card-stream', () => ({RunCardStream: class {
  constructor(){return new Proxy(this,{get:(target,key)=>key in target?target[key as keyof typeof target]:async()=>true});}
  getCardId(){return 'card_chat_progress';}
  async settleImages(text:string){responses.push(text);return new Map();}
  stats(){return {pushCount:0,cardPushes:0,elPushes:0,totalRttMs:0,maxRttMs:0};}
}}));
vi.mock('../src/bot/session-title-coordinator',()=>({SessionTitleCoordinator:class {startRecovery(){} async register(){} async shutdown(){}}}));

const root=await realpath(await mkdtemp(join(tmpdir(),'vv-recipe-dm-flow-')));
function isolate(){vi.stubEnv('HOME',root);vi.stubEnv('VONVON_HOME',root);}
afterAll(async()=>{vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});});

function privateTransport(){
  const cards=new Map<string,string>(),deliveries=new Map<string,{message_id:string;chat_id:string;msg_type:string;card?:string}>();
  const card={
    create:vi.fn(async({data}:{data:{data:string}})=>{const id='card_'+randomUUID();cards.set(id,data.data);return {code:0,data:{card_id:id}};}),
    idConvert:async({data}:{data:{message_id:string}})=>({code:0,data:{card_id:deliveries.get(data.message_id)?.card}}),
    update:async({path,data}:{path:{card_id:string};data:{card:{data:string}}})=>{cards.set(path.card_id,data.card.data);return {code:0};},
  };
  const plainTexts:string[]=[];
  const message={
    create:async({data}:{data:{receive_id:string;msg_type:string;content:string}})=>{
      if(data.msg_type==='text')plainTexts.push(JSON.parse(data.content).text);
      const m={message_id:'om_'+randomUUID(),chat_id:data.receive_id,msg_type:data.msg_type,card:JSON.parse(data.content).data?.card_id};
      deliveries.set(m.message_id,m);return {code:0,data:m};
    },
    get:async({path}:{path:{message_id:string}})=>{const m=deliveries.get(path.message_id);return {code:0,data:{items:m?[{...m,body:{content:cards.get(m.card??'')}}]:[]}};},
    list:async()=>({code:0,data:{items:[]}}),
  };
  const send=vi.fn(async(..._args:unknown[])=>({messageId:'om_'+randomUUID()}));
  const channel={send,rawClient:{cardkit:{v1:{card}},im:{v1:{message,chatMembers:{isInChat:async()=>({code:0,data:{is_in_chat:true}})},
    messageReaction:{create:async()=>({data:{}}),delete:async()=>({})}}}}} as unknown as LarkChannel;
  function button(label:string,detail=''){
    for(const m of [...deliveries.values()].reverse()){
      if(!m.card)continue;
      const body=JSON.parse(cards.get(m.card)!) as {body:{elements:{text?:{content:string};behaviors?:{value:Record<string,unknown>}[]}[]}};
      if(detail&&!body.body.elements.some(element=>element.text?.content.includes(detail)))continue;
      const choice=body.body.elements.find(e=>e.text?.content.startsWith(label)&&e.behaviors?.length);
      if(choice)return {messageId:m.message_id,value:choice.behaviors![0]!.value};
    }
  }
  return {channel,card,send,button,plainTexts};
}

// Keep this test's provider sessions, prompts and temporary credentials out of the user's Codex home.
const realUserHome=homedir();
const live=process.env.VONVON_RECIPE_LIVE_MODEL==='1';
const liveRename=live&&process.env.VONVON_RECIPE_TEST_RENAME==='1';
const publication=live&&!liveRename||process.env.VONVON_RECIPE_TEST_PG==='1';
const routes:('private chat'|'App source handoff'|'desktop reconnect')[]=live?['private chat']:['private chat','App source handoff','desktop reconnect'];
it.each(routes)('saves the selected group and actual skill bytes only on the linked machine from %s',async entry=>{
  isolate();vi.resetModules(); // Each orchestrator shuts down its process registry.
  const skillsRead:string[]=[];
  async function rolloutReadSkill(home:string){
    const folder=join(home,'sessions');
    const files=await readdir(folder,{recursive:true});
    for(const f of files.filter(name=>name.endsWith('.jsonl'))){
      const rows=(await readFile(join(folder,f),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {type:string;payload:Record<string,unknown>});
      const calls=new Map<string,string>();
      const nativeCalls:string[]=[];
      for(const row of rows){
        if(row.type!=='response_item')continue;
        if(row.payload.type==='function_call'||row.payload.type==='custom_tool_call')nativeCalls.push(String(row.payload.name)+': '+String(row.payload.arguments??row.payload.input).slice(0,350));
        const p=row.payload;
        if((p.type==='function_call'||p.type==='custom_tool_call')&&typeof p.call_id==='string')calls.set(p.call_id,String(p.arguments??p.input??''));
        if((p.type==='function_call_output'||p.type==='custom_tool_call_output')&&typeof p.call_id==='string'){
          const command=calls.get(p.call_id);
          const readSkill=command&&/vonvon-recipe/.test(command)&&(/skills__read\s*\(/.test(command)||/SKILL\.md/.test(command));
          if(readSkill&&JSON.stringify(p.output).includes('recipe_author_inventory')&&JSON.stringify(p.output).includes('盘点当前群'))return command;
        }
      }
      console.log('[原生工具调用]',nativeCalls);
    }
  }
  if(live){
    const events=await import('../src/agent/codex-appserver/event-map');
    const map=events.mapNotification;
    vi.spyOn(events,'mapNotification').mockImplementation((notification,context)=>{
      if(notification.method==='item/completed'){
        const item=notification.params.item;
        if(item.type==='commandExecution'&&item.exitCode===0&&/vonvon-recipe[^\n]*SKILL\.md/.test(item.command)&&item.aggregatedOutput?.includes('recipe_author_inventory'))skillsRead.push(item.command);
      }
      return map(notification,context);
    });
  }
  const {useBotDir,botPaths,paths}=await import('../src/config/paths');
  const {saveConfig}=await import('../src/config/store');
  const {addProject,dmChatId,dmProject,mutateProjectByChatId}=await import('../src/project/registry');
  const {createOrchestrator}=await import('../src/bot/handle-message');
  const {createAgentEntries}=await import('../src/agent/entry/registry');
  const {discoverLocalGroupSkills}=await import('../src/agent/group-skills');
  const {AuthoringService}=await import('../src/recipe/authoring-service');
  const {codexToolsFixture,closeCodexToolFixtures}=await import('./helpers/codex-tools-fixture');
  const {throughBridgeChannel,receive}=await import('./helpers/lark-events');
  const {RecipeAuthoringController}=await import('../../desktop/src/recipe-authoring');
  const {RecipeCreatorSupervisor}=await import(new URL('../../desktop/src/recipe-creator-supervisor.ts',import.meta.url).href);
  const {RecipeCreatorExecutor}=await import('../../desktop/src/recipe-creator');
  const {RecipeCreatorJournal}=await import('../../desktop/src/recipe-creator-journal');
  const {AuthoringJournal}=await import('../../desktop/src/recipe-authoring-journal');
  const {MetadataJournal}=await import('../../desktop/src/community-metadata-journal');
  const {LocalRecipeDrafts}=await import('../../desktop/src/local-recipe-drafts');
  const {recipeCreationTools}=await import('../src/agent/entry/recipe-creation-tools');
  const modelHome=process.env.VONVON_RECIPE_MODEL_HOME;
  if(live){
    const profile=join(root,'model-profile');
    await mkdir(profile,{mode:0o700});
    const source=modelHome??process.env.CODEX_HOME??resolve(realUserHome,'.codex');
    await copyFile(join(source,'auth.json'),join(profile,'auth.json'));await chmod(join(profile,'auth.json'),0o600);
    await writeFile(join(profile,'config.toml'),'model_reasoning_effort = "low"\n',{mode:0o600});
    vi.stubEnv('CODEX_HOME',profile);
  }
  const wire=live?undefined:codexToolsFixture(), botId=agentIdSchema.parse({
    'private chat':'cli_recipe_private','App source handoff':'cli_recipe_handoff','desktop reconnect':'cli_recipe_reconnect',
  }[entry]);
  const groupId=groupIdSchema.parse('oc_group_source'), chatId='oc_private_author', owner='ou_author';
  const pg=publication&&entry!=='desktop reconnect'?await (await import(new URL('../../../services/recipe-api/test/local-recipe-publication-fixture.mjs',import.meta.url).href)).startPublicationFixture():undefined;
  const accountId:string=pg?.accountId??randomUUID();
  const bot={appId:botId,tenant:'feishu' as const,createdAt:1,registrationId:randomUUID()},bindingIncarnation=randomUUID();
  useBotDir(botId);const dir=botPaths(botId).dir;
  const source=join(dir,'source'),skillDir=join(source,'.agents','skills','weekly-report');
  await mkdir(join(skillDir,'references'),{recursive:true});
  const skillText='---\nname: weekly-report\ndescription: 整理周报\n---\n逐项对照收据，标出尚未验收的事项。';
  const referenceText='复核清单：先找一手凭据，再核对处理结论。';
  await writeFile(join(skillDir,'SKILL.md'),skillText);await writeFile(join(skillDir,'references','check.md'),referenceText);
  const disabled=join(source,'.agents','skills','disabled','SKILL.md');
  await mkdir(join(source,'.agents','skills','disabled'),{recursive:true});
  await writeFile(disabled,'---\nname: disabled\ndescription: 仅供本人\n---\n不要分享。');
  await writeFile(join(skillDir,'helper.js'),'// executable support files are not recipe documents');
  const role='你是周报编辑，先记录事实再归类。',rule='没有一手资料，请保留问题。',privateMemory='PERSONAL_MEMORY_MUST_STAY_OUT';
  await writeFile(paths.botsFile,JSON.stringify({version:1,bots:[{...bot,name:entry==='private chat'?'private':'handoff',botName:'周报 Bot'}]}));
  const cfg:AppConfig={accounts:{app:{id:botId,secret:'fixture',tenant:'feishu'}},preferences:{access:{ownerOpenId:owner,admins:[owner]},completionReminder:{mode:'manual'}}};
  await saveConfig(cfg);
  await addProject({chatId:groupId,name:'周报组',createdAt:1,cwd:source,blank:false,bindingIncarnation,
    supplement:role,workRules:rule,noMention:true,skills:{disabledPaths:[disabled]},profile:{persona:role,memory:privateMemory,inheritPersona:false,inheritMemory:false}});
  const {channel,card,send,button,plainTexts}=privateTransport();
  const cloud=vi.fn(async()=>{throw Error('Cloud content transport must not be used by local authoring.');});
  let orchestrator:ReturnType<typeof createOrchestrator>;
  let elapsed=0,disconnected=entry==='desktop reconnect';
  const runtimeModel=process.env.VONVON_RECIPE_TEST_MODEL??'gpt-6.1-sol';
  const {recipeRuntimeInventory,recipeMcpNames}=await import('../src/recipe/authoring-runtime-inventory');
  const {createCommandTools}=await import('../src/agent/entry/command-tools');
  const {createFeishuReader}=await import('../src/feishu-read/reader');
  const unsupported=async()=>{throw Error('This synthetic source has no Feishu connection');};
  const commandTools=createCommandTools({appId:botId,groups:unsupported,members:unsupported,
    feishu:createFeishuReader({channel,app:{id:botId,tenant:'feishu'}}),schedule:{execute:(actor,request)=>orchestrator.scheduleAs(actor,request)}});
  const groupRegistry=createAgentEntries({appId:botId,isAdmin:id=>id===owner,tools:commandTools});
  if(live){
    const providerHome=join(root,'model-profile');
    await mkdir(join(source,'.codex'),{recursive:true});
    await writeFile(join(providerHome,'config.toml'),[
      'model = '+JSON.stringify(runtimeModel),'model_reasoning_effort = "low"',
      '[projects.'+JSON.stringify(source)+']','trust_level = "trusted"','',
    ].join('\n'));
    await writeFile(join(source,'.codex','config.toml'),[
      '[mcp_servers.weekly-docs]','command = "/usr/bin/true"','startup_timeout_sec = 1',
      '[mcp_servers.weekly-docs.env]','MARKER = "PRIVATE_TEST_TOKEN"','',
    ].join('\n'));
  }
  const runtimeInventory=(row:Project)=>{
    const tools=groupRegistry.toolNames({kind:'group',chatId:row.chatId});
    return live?recipeRuntimeInventory(row,cfg.preferences,tools):Promise.resolve({provider:'codex-appserver',model:runtimeModel,tools,
      mcp:recipeMcpNames({'weekly-docs':{url:'https://private.example.invalid',env:{token:'PRIVATE_TEST_TOKEN'}}}),mcpStatus:'available' as const});
  };
  const service=new AuthoringService({bot,cfg,channel,root:dir,now:()=>Date.now()+elapsed,runtimeInventory,origin:'http://127.0.0.1:9',loopback:true,fetch:cloud,
    groupSkills:row=>discoverLocalGroupSkills({backendId:'codex-appserver',cwd:row.cwd,home:root,env:{},disabledPaths:row.skills?.disabledPaths}),
    tasks:async chatId=>{
      const reply=await orchestrator.scheduleAs({kind:'local',via:'desktop'},{action:'list',chatId});
      if(reply.kind!=='tasks')throw Error('schedule list');return reply.tasks;
    },
  });
  type Trace={kind:string;action?:string;result:Record<string,unknown>};
  const trace:Trace[]=[];
  const entries=createAgentEntries({appId:botId,isAdmin:id=>id===owner,tools:recipeCreationTools(async(get,q)=>{
    const query=disconnected&&q.kind==='create'&&q.wait?{...q,wait:{...q.wait,notAfter:Math.min(q.wait.notAfter,Date.now()+3500)}}:q;
    const result=await service.conversation.tool(get,query);
    trace.push({kind:q.kind,...(q.kind==='draft'&&{action:q.action}),result:result as Record<string,unknown>});
    if(live)console.log('[Skill]',q.kind,q.kind==='draft'?q.action:'',(result as {state?:string}).state??'');
    return result;
  })});
  orchestrator=createOrchestrator(channel,cfg,root,undefined,{entries,authoring:service,bot});
  const lease=new AbortController(),peer={id:randomUUID(),device:randomUUID()};
  const rpcTrace:string[]=[];
  const client={supportsResourceContext:true,device:async()=>({kind:'deviceStatus',status:{device:{id:peer.device,name:'Mac',publicKey:Buffer.alloc(32,7).toString('base64url')},
    remote:{addresses:[],port:3000},clients:{active:1,total:1}}}),
    snapshot:async()=>({host:{kind:'connected'},agents:[{id:botId,name:'周报 Bot',running:true,connection:'connected',tenant:'feishu',registeredAt:bot.createdAt,registrationId:bot.registrationId}],
      memberships:[{agentId:botId,groupId,enabled:true,bindingIncarnation}],groups:[{id:groupId,name:'周报组'}]}),
    recipeAuthoring:async(req:RecipeAuthoringRequest)=>{
      if(disconnected&&req.type==='localDraftAdvance')throw Error('Test desktop went offline before the approved operation was dispatched.');
      try{const reply=await service.request(peer,req);
        if(req.type==='creatorAnswer'||req.type==='creatorCheck'||req.type==='creatorPoll'&&reply.kind==='creatorJobs'&&reply.jobs.length)
          rpcTrace.push(req.type+' '+JSON.stringify(req.type==='creatorAnswer'?req.answer.kind:reply.kind==='creatorJobs'?reply.jobs.map(j=>j.task.kind):reply.kind));
        return reply;
      }catch(error){rpcTrace.push(req.type+' '+(req.type==='creatorAnswer'?req.answer.kind+' ':'')+(error instanceof Error?error.stack?.split('\n').slice(0,5).join(' '):String(error)));throw error;}
    }} as unknown as VonvonClient;
  const state={kind:'signedIn' as const,accountId,displayName:'编辑',provider:'google' as const,persistence:'memory' as const};
  const request=vi.fn<NativeAccount['request']>(async(actor,path,init,beforeSend)=>{
    await beforeSend?.();if(actor!==accountId)throw Error('Unexpected account');
    if(pg){const response=await pg.authorRequest(path,init);rpcTrace.push((init?.method??'GET')+' '+path+' '+response.status);return response;}
    if(path!=='/v1/me'||(init?.method??'GET')!=='GET')throw Error('Forbidden cloud request: '+path);
    return Response.json({accountId});
  });
  const account:NativeAccount={status:()=>state,lease:()=>lease.signal,onStatus:()=>()=>{},request,
    recipeLink:(recipeId,versionId)=>'https://recipes.example.test/recipes/'+recipeId+'/versions/'+versionId,
    login:async()=>state,logout:async()=>state,cancelLogin:async()=>state,dispose:async()=>{}};
  const device={viewId:'local',client,signal:lease.signal,check:()=>lease.signal.throwIfAborted(),release(){}};
  const storage=join(dir,'desktop-drafts'),drafts=new LocalRecipeDrafts(storage),journal=new AuthoringJournal(),creators=new RecipeCreatorJournal();
  const controller=new RecipeAuthoringController(account,()=>device,journal,undefined,drafts);
  const {LocalRecipePublisher}=await import('../../desktop/src/local-recipe-publisher');
  const publisher=pg?new LocalRecipePublisher(join(dir,'publication'),async (actor,path,init,guard)=>{
    expect(actor).toBe(accountId);await guard();const r=await pg.possessionRequest(path,init);rpcTrace.push('proof '+path+' '+r.status);return r;
  }):undefined;
  if(publisher){
    const execute=publisher.publish.bind(publisher);
    vi.spyOn(publisher,'publish').mockImplementation(async(...args)=>{
      try{return await execute(...args);}catch(error){rpcTrace.push('publisher '+(error instanceof Error?error.stack:String(error)));throw error;}
    });
  }
  const published=vi.fn<(receipt:AuthoringPublished)=>void>(),saved=vi.fn();
  let supervisor:InstanceType<typeof RecipeCreatorSupervisor>|undefined;
  const dm=async(text:string,sender=owner)=>{
    const event=await receive({message_id:'om_'+randomUUID(),create_time:String(Date.now()),chat_id:chatId,chat_type:'p2p',message_type:'text',content:JSON.stringify({text})},
      {bot:{openId:'ou_bot',name:'周报 Bot'},sender:{openId:sender}});
    await throughBridgeChannel(event,m=>orchestrator.onMessage(m));
  };
  const wait={timeout:live?200_000:18_000,interval:100};
  async function turn(text:string,calls:Parameters<NonNullable<typeof wire>['scriptNext']>[0],expected:string,action?:string){
    const start=trace.length,lastResponse=responses.length;
    wire?.scriptNext(calls,false,{sequential:true});
    if(live)console.log('[测试作者]',text);
    await dm(text);
    // A new draft can need a desktop refresh to dispatch and another to acknowledge its local receipt.
    const toolWait=expected==='create'&&!live?{...wait,timeout:35_000}:wait;
    await vi.waitFor(()=>expect(trace.slice(start).some(t=>t.kind===expected&&(!action||t.action===action)),
      JSON.stringify({trace:trace.slice(start),response:responses.slice(lastResponse),replies:send.mock.calls.slice(-2)})).toBe(true),toolWait);
    await vi.waitFor(()=>expect(responses.length).toBeGreaterThan(lastResponse),wait);
    if(live)console.log('[模型]',responses.at(-1));
    return trace.slice(start).filter(t=>t.kind===expected&&(!action||t.action===action)).at(-1)!.result;
  }
  async function click(label:string,detail=''){
    await vi.waitFor(()=>expect(button(label,detail),JSON.stringify({label,trace:trace.slice(-1),rpcTrace:rpcTrace.slice(-12),cards:card.create.mock.calls.map(([{data}])=>data.data).slice(-2)})).toBeDefined(),wait);
    const selected=button(label,detail)!;
    await service.onAction({operator:{openId:owner},raw:{event_id:'ev_'+randomUUID(),operator:{open_id:owner,tenant_key:'t'}},
      chatId,messageId:selected.messageId,action:{tag:'button',value:selected.value}});
  }
  try{
    await orchestrator.initialize?.();
    await vi.waitFor(async()=>expect(await dmProject()).toBeDefined());
    await mutateProjectByChatId(dmChatId(botId),project=>{project.smart=false;if(live&&process.env.VONVON_RECIPE_TEST_MODEL)project.defaultModel=process.env.VONVON_RECIPE_TEST_MODEL;});
    const scheduled=await orchestrator.scheduleAs({kind:'local',via:'desktop'},{action:'create',chatId:groupId,name:'每周复核任务',
      instruction:'读取本周记录并复核。',spec:{kind:'once',at:Date.now()+86400_000},placement:{kind:'follow'},timeZone:'Asia/Shanghai'});
    expect(scheduled.kind).toBe('task');
    const linked=await controller.request({type:'open',accountId,viewId:'local',botId});if(linked.kind!=='session')throw Error('desktop session');
    const challenge=await controller.request({type:'beginLink',handle:linked.handle});if(challenge.kind!=='challenge')throw Error('link challenge');
    await dm('/recipe link '+challenge.code);
    const seen=await controller.request({type:'inspectLink',handle:linked.handle,challengeId:challenge.challengeId});if(seen.kind!=='link'||!seen.evidence)throw Error('link evidence');
    await controller.request({type:'confirmLink',handle:linked.handle,challengeId:challenge.challengeId,evidence:seen.evidence});
    const startSupervisor=()=>new RecipeCreatorSupervisor(account,async()=>device,()=>['local'],creators,journal,controller,
      new RecipeCreatorExecutor(account,creators,new MetadataJournal(),journal,published,saved,undefined,drafts,publisher),drafts);
    supervisor=startSupervisor();
    const worker=await supervisor.associated(accountId,'local',botId);if(!worker)throw Error('linked creator worker');
    if(entry==='App source handoff'){
      const handed=await supervisor.continue({type:'creatorContinue',accountId,retryId:randomUUID(),entry:{kind:'source',viewId:'local',botId,groupId,
        registrationId:bot.registrationId,registeredAt:bot.createdAt,bindingIncarnation}});
      expect(handed).toMatchObject({kind:'creatorContinuing',delivery:'delivered'});
    }
    expect(drafts.list(accountId)).toEqual([]);
    const renameCase=entry==='private chat'&&(!live||liveRename);
    const fields={name:renameCase?'cc01':'每周复核',summary:'团队周报',overview:'核对每周报告的角色、规则和技能。',version:'1.0'};
    await dm('用周报组的配置创作一份配方，名字叫每周复核。','ou_unlinked');
    expect(trace).toEqual([]);expect(drafts.list(accountId)).toEqual([]);
    await turn(entry!=='App source handoff'?'我想用周报组的配置创作一份配方，给其他团队做周报。先盘点群里实际有的内容，推荐带哪些，讲讲理由；我想先看，不要保存。':
      '用我在 App 选好的群创作配方，先盘点当前配置，推荐合适的内容。',[{tool:'recipe_author_sources'},{tool:'recipe_author_inventory',args:{groupId}}],'inventory');
    const inv=trace.find(t=>t.kind==='inventory'&&t.result.category==='all')?.result??trace.find(t=>t.kind==='inventory')!.result;
    const sources=trace.find(t=>t.kind==='sources')?.result;
    expect(sources).toMatchObject({state:'ready',groups:expect.arrayContaining([{groupId,name:'周报组'}]),
      ...(entry==='App source handoff'&&{selected:{groupId,name:'周报组'}})});
    expect(inv).toMatchObject({state:'ready',groupId,groupName:'周报组',model:runtimeModel,tools:expect.arrayContaining(['feishu_doc']),
      mcp:[{name:'weekly-docs',enabled:true}],inventoryId:expect.any(String)});
    expect(JSON.stringify(inv)).not.toMatch(/private\.example|PRIVATE_TEST_TOKEN/);
    const items=inv.items as {id:string;kind:string;label:string}[];
    expect(inv.counts).toMatchObject({rules:expect.any(Number),settings:expect.any(Number),skills:expect.any(Number),tasks:1});
    if(live){
      expect(responses.at(-1)).toMatch(/周报|weekly-report/);
      expect(responses.at(-1)).toContain('weekly-docs');expect(responses.at(-1)).toContain(runtimeModel);
      expect(responses.at(-1)).toMatch(/feishu_|schedule_|文档|工具/);
      const skill=skillsRead[0]??await rolloutReadSkill(join(root,'model-profile'));
      expect(skill,'Codex must read the mounted vonvon-recipe SKILL.md').toBeTruthy();
      console.log('[已读取 SKILL.md]',skill);
    }
    else expect(wire?.inputs()[0]?.text).toContain('vonvon-recipe');
    const selectedIds=items.filter(i=>['role','rule','skill','file'].includes(i.kind)||i.kind==='setting'&&/免|提及|@/.test(i.label)).map(i=>i.id);
    const changed=await turn('调整一下范围：只要角色、工作规则、免 @ 设置、weekly-report 技能以及它的 references/check.md，不要定时任务或其他依赖。名字叫'+fields.name+'，简介是团队周报，概览是核对每周报告的角色、规则和技能。，版本 1.0，直接获取。请展示这个确切范围，等我确认。',
      [{tool:'recipe_author_propose',args:{groupId,inventoryId:inv.inventoryId,selectedIds,public:fields,access:'direct'}}],'propose');
    expect(changed).toMatchObject({state:'awaitingConfirmation',proposalId:expect.any(String)});
    const shown=[...plainTexts].reverse().find(text=>text.startsWith('新建私人草稿 · 待确认'))!;
    expect(shown).toContain('技能与文件\n• weekly-report（群工作区）\n  SKILL.md\n  references/check.md');
    expect(shown.match(/SKILL\.md/g)).toHaveLength(1);expect(shown.match(new RegExp(rule,'g'))).toHaveLength(1);
    expect(drafts.list(accountId)).toEqual([]);
    const result=await turn('确认这个范围，保存草稿',[{tool:'recipe_author_create',args:{proposalId:changed.proposalId}}],'create');
    expect(result.state).toMatch(/^(saved|preparing)$/);
    if(entry==='desktop reconnect'){
      expect(result.state).toBe('preparing');expect(drafts.list(accountId)).toEqual([]);
      supervisor.dispose();service.disconnect(peer.id);peer.id=randomUUID();
      elapsed=31*60_000;disconnected=false;
      supervisor=startSupervisor();await supervisor.associated(accountId,'local',botId);
    }
    await vi.waitFor(()=>expect(drafts.list(accountId)).toHaveLength(1),wait);
    const draftId=drafts.list(accountId)[0]!.draft.draftId;
    const directory=drafts.directory(accountId,draftId);expect(directory).toBeTruthy();
    expect(await readFile(join(directory!,'skills','weekly-report','SKILL.md'),'utf8')).toBe(skillText);
    expect(await readFile(join(directory!,'skills','weekly-report','references','check.md'),'utf8')).toBe(referenceText);
    if(live)console.log('[本地草稿]',JSON.stringify({draftId,revision:1,directory}));
    expect(card.create.mock.calls.map(([payload])=>payload.data.data).join('')).not.toMatch(/"verb":"(?:source|handoff|confirm)"|确认所选来源|☐/u);
    expect(cloud).not.toHaveBeenCalled();expect(request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
    if(entry==='desktop reconnect'){
      expect(drafts.read(accountId,draftId)?.draft).toMatchObject({revision:1,public:{name:fields.name}});
      const selected=await controller.request({type:'open',accountId,viewId:'local',botId,groupId});
      if(selected.kind!=='session')throw Error('missing legacy source session');
      await controller.request({type:'beginHandoff',handle:selected.handle,groupId,retryId:randomUUID()});
      const saved=await turn('请查询刚刚确认的这份配方草稿在 App 的保存结果，告诉我草稿名称和版本。',[{tool:'recipe_author_status'}],'status');
      expect(saved).toMatchObject({state:'saved',draftId,revisionAtCreation:1});
      return;
    }
    const revisedSummary=renameCase?fields.summary:'跨团队周报复核',savedName=renameCase?'cx02':fields.name;
    if(renameCase){
      const next={groupId,inventoryId:inv.inventoryId,selectedIds,public:{...fields,name:'cx02'}};
      const pending=await turn('我还想另起一份新配方提案，沿用刚才的范围，拟用名 cx02，请给我看新建范围，先别保存。',[{tool:'recipe_author_propose',args:next}],'propose');
      expect(pending).toMatchObject({state:'awaitingConfirmation',operation:'createDraft'});
      const shown=plainTexts.length;
      if(live){
        const before=responses.length;const first=trace.length;
        await dm('改名');
        await vi.waitFor(()=>expect(responses.length).toBeGreaterThan(before),wait);
        console.log('[原话“改名”]',responses.at(-1));
        expect(responses.at(-1)).toMatch(/cc01|原稿|已保存|本地草稿/);
        expect(responses.at(-1)).toMatch(/cx02|提案|候选|新草稿/);
        expect(trace.slice(first).filter(t=>t.kind==='propose').every(t=>t.result.state==='chooseRenameTarget')).toBe(true);
      }else{
        const ambiguous=await turn('改名',[{tool:'recipe_author_propose',args:next}],'propose');
        expect(ambiguous).toMatchObject({state:'chooseRenameTarget',creationProposal:{proposedName:'cx02',proposalId:pending.proposalId},savedDrafts:[{draftId}]});
      }
      expect(plainTexts.length).toBe(shown);
      const list=await turn('要改 App 中已经保存的那份。请读取 App 里已保存的草稿列表，告诉我现在有哪几份和它们的名字。',[{tool:'recipe_author_draft',args:{action:'list'}}],'draft','list');
      expect(list.savedDrafts).toEqual([{draftId,name:'cc01',version:'1.0'}]);
      const requested=await turn('请把 App 中已经保存的草稿 cc01 改名为 cx02，保留原来的草稿编号。',
        [{tool:'recipe_author_draft',args:{action:'edit',draftId,change:{field:'name',value:savedName}}}],'draft','edit');
      expect(requested).toMatchObject({state:'requested',draftId});
      await vi.waitFor(()=>expect(button('采用修改','当前名称：cc01')).toBeDefined(),wait);
      const waiting=await turn('请查一下这次改名的保存状态，现在已经落盘了吗？',[{tool:'recipe_author_status'}],'status');
      expect(waiting).toMatchObject({state:'awaitingConfirmation',operation:'renameDraft',draftId,previousName:'cc01',proposedName:'cx02'});
      expect(drafts.read(accountId,draftId)?.draft.public.name).toBe('cc01');
    }else{
      await turn('把刚才这份私人配方草稿的简介改为“跨团队周报复核”，其他内容保持原样。',
        [{tool:'recipe_author_draft',args:{action:'edit',draftId,change:{field:'summary',value:revisedSummary}}}],'draft','edit');
    }
    await click('采用修改');
    await vi.waitFor(()=>expect(drafts.read(accountId,draftId)?.draft).toMatchObject({revision:2,public:{summary:revisedSummary,name:savedName}}),wait);
    await vi.waitFor(()=>expect(rpcTrace).toContain('creatorAnswer "saved"'),wait);
    if(renameCase){
      const saved=await turn('我已经点了采用修改。请查一下刚才的改名保存了吗，告诉我保存到原稿的修订。',[{tool:'recipe_author_status'}],'status');
      expect(saved).toMatchObject({operation:'renameDraft',state:'saved',draftId,revision:2,savedName:'cx02'});
      const inspected=await turn('请从本地读回这份草稿的当前名字。',[{tool:'recipe_author_draft',args:{action:'inspect',draftId}}],'draft','inspect');
      expect(inspected).toMatchObject({state:'ready',draftId,revision:2,name:'cx02'});
      expect(drafts.list(accountId)).toHaveLength(1);
      if(liveRename){
        const reopened=new LocalRecipeDrafts(storage);
        try{
          const [record]=reopened.list(accountId);
          expect(record?.draft).toMatchObject({draftId,revision:2,public:{name:'cx02'}});
          console.log('[重新打开 SQLite]',JSON.stringify({draftId,revision:record!.draft.revision,name:record!.draft.public.name,rows:reopened.list(accountId).length}));
        }finally{reopened.close();}
        return;
      }
      expect(request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
    }
    const head=await turn('我想把之前没放进配方的定时任务补回去，先帮我查看原群能补回哪个任务，暂时不要改。',
      [{tool:'recipe_author_draft',args:{action:'inventory',draftId}}],'draft','inventory');
    const task=(head.available as {id:string;kind:string;label:string}[]).find(item=>item.kind==='task'&&item.label.includes('每周复核任务'));
    expect(task).toBeTruthy();
    const add=await turn('把原群的“每周复核任务”加进刚才这份草稿，保留现有内容，请把这次修改范围列出来让我确认。',
      [{tool:'recipe_author_draft',args:{action:'propose',draftId,inventoryId:head.inventoryId,addIds:[task!.id],removeIds:[]}}],'draft','propose');
    expect(add).toMatchObject({state:'awaitingConfirmation',revision:2});expect(drafts.read(accountId,draftId)?.draft.revision).toBe(2);
    const confirmationStart=trace.length;
    const applied=await turn('确认这个范围，保存修改',[{tool:'recipe_author_status'},{tool:'recipe_author_draft',args:{action:'apply'}}],'draft','apply');
    const pending=trace.slice(confirmationStart).find(call=>call.kind==='status');
    if(!live||pending)expect(pending?.result).toMatchObject({state:'awaitingConfirmation',operation:'editDraftScope',proposalId:add.proposalId,draftId,revision:2});
    expect(applied).toMatchObject({state:'saved',draftId,revision:3});
    const reopened=new LocalRecipeDrafts(storage);
    try{
      expect(reopened.list(randomUUID())).toEqual([]);
      const [record]=reopened.list(accountId);if(record?.draft.format!=='rich-v2')throw Error('durable rich draft');
      expect(record.draft.draftId).toBe(draftId);expect(record.work.source?.groupId).toBe(groupId);expect(record.draft.public).toMatchObject({name:savedName,summary:revisedSummary,version:fields.version});
      const {content,texts}=record.draft.rich;
      const textOf=(t:NonNullable<typeof content.role>['text'])=>t.kind==='inline'?t.value:texts[t.objectId];
      expect(content.role&&textOf(content.role.text)).toBe(role);expect(content.rules.map(r=>textOf(r.text))).toContain(rule);
      expect(content.settings).toEqual(expect.arrayContaining([expect.objectContaining({field:'response.noMention',value:true})]));
      expect(content.tasks.map(t=>textOf(t.instruction))).toEqual(['读取本周记录并复核。']);expect(content.skills.map(s=>s.name)).toEqual(['weekly-report']);
      expect(Object.fromEntries(content.files.map(f=>[f.name,textOf(f.text)]))).toEqual({'SKILL.md':skillText,'references/check.md':referenceText});
      expect(content.memories).toEqual([]);expect(JSON.stringify(record)).not.toContain(privateMemory);
    }finally{reopened.close();}
    if(pg){
      expect(await pg.publications()).toEqual([]);
      await turn('现在从私聊正式发布这份配方，给我当前版本的最终确认。',
        [{tool:'recipe_author_draft',args:{action:'publish',draftId}}],'draft','publish');
      await vi.waitFor(()=>expect(button('确认发布','草稿修订 3'),JSON.stringify({trace:trace.slice(-1),rpcTrace:rpcTrace.slice(-12),cards:card.create.mock.calls.map(([{data}])=>data.data).slice(-2)})).toBeDefined(),wait);
      expect(await pg.publications()).toEqual([]);
      await click('确认发布','草稿修订 3');
      await vi.waitFor(()=>expect(published,JSON.stringify({rpc:rpcTrace.filter(t=>!t.startsWith('creatorCheck')).slice(-33),cards:card.create.mock.calls.map(([{data}])=>data.data).at(-1)?.slice(0,850)})).toHaveBeenCalledTimes(1),wait);
      const [receipt]=published.mock.calls[0]!;
      const versions=await pg.publications();
      expect(versions).toContainEqual(expect.objectContaining({recipeId:receipt.recipeId,versionId:receipt.versionId}));
      const download=await pg.download(receipt.recipeId,receipt.versionId);
      const manifest=recipeRichContentSchema.parse(download.manifest);
      const downloadedText=(value:RecipeRichText)=>value.kind==='inline'?value.value:download.texts.get(value.objectId);
      expect(manifest.public.summary.value).toBe(revisedSummary);
      expect(manifest.role&&downloadedText(manifest.role.text)).toBe(role);
      expect(manifest.rules.map(item=>downloadedText(item.text))).toContain(rule);
      expect(manifest.settings).toContainEqual(expect.objectContaining({field:'response.noMention',value:true}));
      expect(manifest.tasks.map(item=>downloadedText(item.instruction))).toEqual(['读取本周记录并复核。']);
      expect(manifest.skills.map(item=>item.name)).toEqual(['weekly-report']);
      expect(manifest.memories).toEqual([]);
      expect(Object.fromEntries(manifest.files.map(file=>[file.name,downloadedText(file.text)])))
        .toEqual({'SKILL.md':skillText,'references/check.md':referenceText});
      if(live)console.log('[发布收据]',JSON.stringify({draftId,revision:3,versionId:receipt.versionId,recipeId:receipt.recipeId,
        downloadedTasks:manifest.tasks.map(task=>task.name),downloadedFiles:manifest.files.map(file=>file.name)}));
    }
  }finally{
    supervisor?.dispose();controller.closeAll();drafts.close();await orchestrator.shutdown();service.close();publisher?.close();await pg?.close();await closeCodexToolFixtures();
  }
},live?1_200_000:95_000);
