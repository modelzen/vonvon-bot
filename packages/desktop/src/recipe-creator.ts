import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {creatorSnapshotSchema,recipeAuthoringReplySchema,validateWritableRichRecipeContent,recipePublicSchema,richMetadataRequestSchema,
  communityResponseSchemas,type CreatorJob,type CreatorAnswer,type CreatorRead,type CreatorWork,type CreatorVersion,type CreatorSnapshot,type RecipeDraft,type CommunityRequest,
  type DesktopAuthoringReply,type AuthoringPublished,type AuthoringSaved,type RecipeAuthoringRequest,type RecipeAuthoringReply} from '@vonvon/protocol';
import type {NativeAccount} from './account-session.js';
import {RecipeCreatorJournal,checkVersionSource,sameCreatorSource,creatorSha,creatorSnapshotDigest,type CreatorAssociation,type CreatorCommandRecord} from './recipe-creator-journal.js';
import {creatorDraft,creatorJson,creatorCodes,publicationReceipt,issueReceipt,metadataReceipt,verifyMetadataReceipt,CreatorCloudRejected} from './recipe-creator-cloud.js';
import {MetadataJournal} from './community-metadata-journal.js';
import {communityRequest,CommunityError} from './community-api.js';
import {inheritedPublication,UnsupportedLegacyPublication} from './recipe-publication-inheritance.js';
import {richCommunity} from './community-rich.js';
import {richAuthoringCloud} from './recipe-authoring-rich-cloud.js';
import {authoringCloud} from './recipe-authoring-cloud.js';
import {AuthoringJournal} from './recipe-authoring-journal.js';

export interface CreatorContext {
  association:CreatorAssociation;
  check():void;
  rpc(request:RecipeAuthoringRequest):Promise<RecipeAuthoringReply>;
  session:string;
  settled(draftId:string):Promise<void>;
}
type DispatchResult=CreatorAnswer|'awaitingReceipt'|undefined;
type Checked=Extract<RecipeAuthoringReply,{kind:'creatorChecked'}>;
const invalid=()=>new Error('原私聊操作已变化，请在原卡片重新核对。');
function expect<K extends RecipeAuthoringReply['kind']>(raw:RecipeAuthoringReply,kind:K){
  if(raw.kind!==kind)throw invalid();return raw as Extract<RecipeAuthoringReply,{kind:K}>;
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
function pages(text:string){
  const result:string[]=[];let page='';
  for(const point of text){if(page.length+point.length>4000){result.push(page);page='';}page+=point;}
  result.push(page);return result;
}
export class RecipeCreatorExecutor {
  constructor(private readonly account:NativeAccount,private readonly journal:RecipeCreatorJournal,
    private readonly metadata:MetadataJournal,private readonly authoring:AuthoringJournal,private readonly onPublished?:(receipt:AuthoringPublished)=>void,
    private readonly onSaved?:(receipt:AuthoringSaved)=>void) {}
  private async checked(context:CreatorContext,job:CreatorJob):Promise<Checked>{
    context.check();
    const reply=expect(recipeAuthoringReplySchema.parse(await context.rpc({type:'creatorCheck',botId:context.association.botId,session:context.session,id:job.id})),'creatorChecked');
    context.check();
    if(!isDeepStrictEqual(reply.job,job)||job.binding!==context.association.binding||job.scope!==context.association.scope)throw invalid();
    return reply;
  }
  private transport(context:CreatorContext,job:CreatorJob,modes:Checked['mode'][]):NativeAccount {
    const native=this.account,accountId=context.association.accountId;
    const action=job.task.kind==='command'?job.task.command:job.task.kind==='read'?job.task.read:job.task;
    const check=()=>{
      context.check();
      if('target' in action)checkVersionSource(this.journal.version(accountId,action.target.versionId),context.association);
    };
    return {...native,request:async(id,path,init,beforeSend)=>{
      if(id!==accountId)throw invalid();check();
      return native.request(id,path,init,async()=>{
        await beforeSend?.();context.check();
        const current=await this.checked(context,job);
        if(!modes.includes(current.mode)||job.task.kind==='command'&&current.mode==='execute'&&job.task.expiresAt<=Date.now())throw invalid();
        check();
      });
    }};
  }

  private async verifyWork(context:CreatorContext,job:CreatorJob,work:CreatorWork){
    if(!work.source)return;
    const {association}=context,prior=this.authoring.history.locator(association.accountId,work.source.preparationId);
    if(!prior||prior.deviceId!==association.deviceId||prior.deviceKey!==association.deviceKey||prior.botId!==association.botId||
      prior.groupId!==work.source.groupId||prior.identity!==work.source.identity)throw invalid();
    await this.checked(context,job);
    const source=expect(await context.rpc({type:'operationSourceIdentity',botId:association.botId,session:context.session,operationId:work.source.preparationId}),'operationSourceIdentity');
    context.check();
    if(source.operationId!==work.source.preparationId||source.groupId!==work.source.groupId||source.identity!==work.source.identity)throw invalid();
    const current=expect(await context.rpc({type:'groupSourceIdentity',botId:association.botId,session:context.session,groupId:work.source.groupId}),'groupSourceIdentity');
    context.check();if(current.identity!==work.source.identity||current.groupId!==work.source.groupId)throw invalid();
  }
  private async workDraft(context:CreatorContext,job:CreatorJob,work:CreatorWork,modes:Checked['mode'][]=['read','execute']){
    await context.settled(work.draftId);context.check();
    await this.verifyWork(context,job,work);
    const account=this.transport(context,job,modes),draft=await creatorDraft(account,context.association.accountId,work.draftId,()=>context.check());
    if(draft.format==='rich-v2'?(draft.sourceIntentId!==work.source?.preparationId):work.source!==null)throw invalid();
    const key=this.metadata.key(context.association.accountId,work.draftId);
    await this.metadata.exclusive(key,async()=>{
      context.check();
      const held=this.metadata.read(key);
      if(!held)return;
      const writer=this.journal.command(context.association.accountId,held.request.requestId);
      if(writer&&(!sameCreatorSource(writer.association,context.association)||writer.association.scope!==context.association.scope||
        !isDeepStrictEqual(writer.request,held.request)||writer.command.kind!=='metadata'||!isDeepStrictEqual(writer.command.work,work)))throw invalid();
      const receipt=held.receipt?verifyMetadataReceipt(held.request,held.receipt):await metadataReceipt(account,held.request);
      context.check();
      if(receipt&&!held.receipt)this.metadata.write(key,{...held,receipt});
      if(!receipt||draft.format!=='rich-v2'||draft.revision<receipt.revision||draft.revision===receipt.revision&&
        creatorSha(Buffer.from(draft.rich.canonical,'base64url'))!==receipt.manifestSha256)throw new Error('这份草稿的保存结果尚未确认。');
      this.metadata.clear(key);
    });
    return {account,draft};
  }
  private async parentContext(account:NativeAccount,accountId:string,draft:RecipeDraft){
    const hash=draft.format==='rich-v2'?creatorSha(Buffer.from(draft.rich.canonical,'base64url')):undefined;
    const query=new URLSearchParams({revision:String(draft.revision)});if(hash)query.set('contentSha256',hash);
    const raw=await creatorJson(account,accountId,`/${hash?'v2':'v1'}/drafts/${draft.draftId}/creator-context?${query}`);
    const result=z.object({draftId:z.string().uuid(),format:z.enum(['rich-v2','role-v1']),revision:z.number().int().positive(),sourceIntentId:z.string().uuid().nullable(),
      parent:z.object({recipeId:z.string().uuid(),versionId:z.string().uuid()}).strict().nullable()}).strict().parse(raw);
    if(result.draftId!==draft.draftId||result.format!==(draft.format??'role-v1')||result.revision!==draft.revision||
      draft.format==='rich-v2'&&result.sourceIntentId!==draft.sourceIntentId||
      result.parent&&result.parent.recipeId!==draft.recipeId)throw invalid();
    return result.parent;
  }
  private async freeze(context:CreatorContext,job:CreatorJob,work:CreatorWork,modes:Checked['mode'][]=['read','execute']){
    const {account,draft}=await this.workDraft(context,job,work,modes);
    const parent=await this.parentContext(account,context.association.accountId,draft);
    const parts=draft.format==='rich-v2'?validateWritableRichRecipeContent(draft.rich.content).content.parts:[];
    const encoded=draft.format==='rich-v2'?draft.rich.canonical:Buffer.from(canonical(draft.config)).toString('base64url');
    const sections=[{title:'配方、来源与版本',text:[draft.public.name+' · '+draft.public.version,draft.public.summary,draft.public.overview,
      draft.public.access==='coded'?'凭分享码获取':'直接获取','草稿修订 '+draft.revision,
      work.source?'来源群的本地配置':'本人账号的旧格式作品',...(parent?['基于已选的历史版本创作']:[])].join('\n')}];
    if(draft.format==='rich-v2'){
      for(const key of ['role','settings','rules','skills','files','tasks','setup','parts','finalLogo'] as const){
        sections.push({title:key,text:JSON.stringify(draft.rich.content[key]??null,null,2)});
      }
      for(const part of parts)if(part.kind==='text'){
        const text=draft.rich.texts[part.objectId];
        if(text===undefined||Buffer.byteLength(text)!==part.bytes||creatorSha(text)!==part.sha256)throw invalid();
        sections.push({title:part.objectId,text});
      }
    }else sections.push({title:'角色与准备',text:JSON.stringify(draft.config,null,2)});
    // Text parts share one bounded section, preserving every byte without exceeding the protocol section limit.
    const collapsed=sections.length<=16?sections:[...sections.slice(0,10),{title:'全部文件正文',text:sections.slice(10).map(s=>s.title+'\n'+s.text).join('\n\n')}];
    const rendered=collapsed.map(section=>pages(section.text));
    const appPreviewUrl=this.previewUrl(draft);
    const snapshot=creatorSnapshotSchema.parse({work,format:draft.format??'role-v1',recipeId:draft.recipeId,parent,revision:draft.revision,public:draft.public,...(appPreviewUrl&&{appPreviewUrl}),
      contentSha256:creatorSha(Buffer.from(encoded,'base64url')),parts,sections:collapsed.map((section,i)=>({title:section.title,pageHashes:rendered[i]!.map(page=>creatorSha(page))}))});
    this.journal.freeze({association:context.association,snapshot,canonical:encoded,pages:rendered});
    return {draft,snapshot};
  }
  private previewUrl(draft:RecipeDraft){
    if(!this.account.recipeLink)return;
    const url=new URL(this.account.recipeLink(draft.draftId,draft.draftId));
    if(url.username||url.password||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw invalid();
    return `${url.origin}/open/draft#${draft.draftId}?revision=${draft.revision}`;
  }
  private sameSnapshot(current:CreatorSnapshot,expected:CreatorSnapshot){
    const {appPreviewUrl:_url,...legacy}=current;
    return isDeepStrictEqual(expected.appPreviewUrl?current:legacy,expected);
  }
  async preview(context:CreatorContext,job:CreatorJob){
    if(job.task.kind!=='command'||job.task.command.kind!=='publish')throw invalid();
    const checked=await this.checked(context,job);
    if(checked.mode!=='preview'&&checked.mode!=='receipt')throw invalid();
    const current=await this.freeze(context,job,job.task.command.snapshot.work,['preview','receipt']);
    const expected=job.task.command.snapshot;
    if(!this.sameSnapshot(current.snapshot,expected)||creatorSnapshotDigest(expected)!==job.task.command.snapshotDigest)throw invalid();
    return {draft:current.draft,snapshot:expected};
  }
  private async backfillVersions(context:CreatorContext,account:NativeAccount,targets:CreatorVersion[]){
    const a=context.association,remaining=new Map(targets.filter(target=>!this.journal.version(a.accountId,target.versionId)).map(target=>[target.versionId,target]));
    if(!remaining.size)return;
    const identities=new Map<string,string|null>(),ids:string[]=[];
    for(const row of this.authoring.history.operations(a)){
      if(!row.groupId)continue;
      if(!identities.has(row.groupId)){
        try{context.check();const reply=expect(await context.rpc({type:'groupSourceIdentity',botId:a.botId,session:context.session,groupId:row.groupId}),'groupSourceIdentity');
          context.check();identities.set(row.groupId,reply.groupId===row.groupId?reply.identity:null);
        }catch{context.check();identities.set(row.groupId,null);}
      }
      if(identities.get(row.groupId)===row.identity)ids.push(row.operationId);
    }
    const signal=this.account.lease?.(a.accountId);if(!signal)throw invalid();
    const cloud=authoringCloud(account,a.accountId,signal,()=>context.check());
    for(let offset=0;offset<ids.length&&remaining.size;offset+=32){
      for(const entry of await cloud.sourceHistory(ids.slice(offset,offset+32))){
        if(entry.state!=='published')continue;
        const target=remaining.get(entry.versionId);
        if(target&&target.recipeId===entry.recipeId){this.journal.rememberVersion(a,entry.versionId);remaining.delete(entry.versionId);}
      }
    }
  }
  async resolveVersion(context:CreatorContext,target:CreatorVersion){
    const account:NativeAccount={...this.account,request:async(id,path,init,beforeSend)=>{
      if(id!==context.association.accountId)throw invalid();context.check();
      return this.account.request(id,path,init,async()=>{await beforeSend?.();context.check();});
    }};
    await this.backfillVersions(context,account,[target]);
    return sameCreatorSource(this.journal.version(context.association.accountId,target.versionId),context.association);
  }
  private async requireVersion(context:CreatorContext,job:CreatorJob,target:CreatorVersion,modes:Checked['mode'][],richOnly=false){
    const account=this.transport(context,job,modes),detail=await communityRequest(account,{type:'detail',accountId:context.association.accountId,...target});
    if(!detail.owned||detail.recipeId!==target.recipeId||detail.versionId!==target.versionId||
      (detail.creator?detail.creator.authorId!==context.association.accountId:detail.format==='rich-v2'))throw invalid();
    if(richOnly&&detail.format!=='rich-v2')throw new UnsupportedLegacyPublication('withdraw');
    return account;
  }
  private async read(context:CreatorContext,job:CreatorJob,read:CreatorRead):Promise<CreatorAnswer>{
    const {accountId}=context.association;
    switch(read.kind){
      case 'works': {
        const account=this.transport(context,job,['read']),cloud=richCommunity(account,accountId,()=>context.check());
        const drafts=await cloud.drafts(),publications=await cloud.publications();
        await this.backfillVersions(context,account,publications.items.map(item=>({recipeId:item.recipeId,versionId:item.versionId})));
        const items:Extract<CreatorAnswer,{kind:'works'}>['items']=[];
        for(const item of drafts.items){
          if(item.format==='rich-v2'){
            const draft=await creatorDraft(account,accountId,item.draftId,()=>context.check());
            if(draft.format!=='rich-v2')throw invalid();
            const source=this.authoring.history.locator(accountId,draft.sourceIntentId),a=context.association;
            if(!source||source.deviceId!==a.deviceId||source.deviceKey!==a.deviceKey||source.botId!==a.botId||!source.groupId)continue;
            items.push({kind:'draft',work:{draftId:item.draftId,source:{preparationId:draft.sourceIntentId,groupId:source.groupId,identity:source.identity}},name:item.public.name,version:item.public.version});
          }else items.push({kind:'draft',work:{draftId:item.draftId,source:null},name:item.public.name,version:item.public.version});
        }
        for(const item of publications.items)if(sameCreatorSource(this.journal.version(accountId,item.versionId),context.association))items.push({kind:'version',target:{recipeId:item.recipeId,versionId:item.versionId},name:item.public.name,version:item.public.version});
        return {kind:'works',items:items.slice(read.offset,read.offset+16),nextOffset:items.length>read.offset+16?read.offset+16:null};
      }
      case 'draft':return {kind:'snapshot',snapshot:(await this.freeze(context,job,read.work)).snapshot};
      case 'page': {
        await this.verifyWork(context,job,read.work);
        const stored=this.journal.snapshot(read.snapshotDigest);
        if(!stored||!isDeepStrictEqual(stored.association,context.association)||!isDeepStrictEqual(stored.snapshot.work,read.work))throw invalid();
        const text=stored.pages[read.section]?.[read.page];if(text===undefined)throw invalid();
        return {kind:'page',snapshotDigest:read.snapshotDigest,section:read.section,page:read.page,text};
      }
      case 'codes': {
        const account=await this.requireVersion(context,job,read.target,['read']),result=await creatorCodes(account,accountId,read.target,read.cursor??undefined);
        return {kind:'codes',target:read.target,items:result.items.map(({codeId,suffix,status})=>({codeId,suffix,status})),nextCursor:result.nextCursor};
      }
      case 'parent':return {kind:'parent',target:read.target,inherited:await inheritedPublication(this.transport(context,job,['read']),accountId,read.target.recipeId,read.target.versionId,()=>context.check())};
      case 'edit': {
        const {account,draft}=await this.workDraft(context,job,read.work);
        if(draft.format!=='rich-v2'||draft.revision!==read.revision||!read.work.source)throw invalid();
        const cloud=richAuthoringCloud(account,accountId,this.account.lease!(accountId)!,()=>context.check()),meta=await cloud.draftMetadata(read.work.draftId,read.revision);
        const bytes=await cloud.readMember(read.work.draftId,meta.sourceManifest);
        return {kind:'edit',work:read.work,revision:read.revision,canonical:draft.rich.canonical,sourceCanonical:bytes.toString('base64url')};
      }
    }
  }
  private async freezeCommand(context:CreatorContext,job:CreatorJob):Promise<CreatorCommandRecord>{
    if(job.task.kind!=='command')throw invalid();
    const command=job.task.command,accountId=context.association.accountId;
    let request:CommunityRequest;
    switch(command.kind){
      case 'publish': {
        const stored=this.journal.snapshot(command.snapshotDigest);
        if(!stored||!isDeepStrictEqual(stored.association,context.association)||!isDeepStrictEqual(stored.snapshot,command.snapshot)||creatorSnapshotDigest(command.snapshot)!==command.snapshotDigest)throw invalid();
        const current=await this.freeze(context,job,command.snapshot.work);
        if(!this.sameSnapshot(current.snapshot,command.snapshot))throw invalid();
        request={type:'publishDraft',accountId,requestId:job.id,draftId:command.snapshot.work.draftId,revision:command.snapshot.revision,
          ...(command.snapshot.format==='rich-v2'&&{format:'rich-v2',canonical:stored.canonical})};break;
      }
      case 'metadata': {
        const {draft}=await this.workDraft(context,job,command.work);
        if(draft.revision!==command.revision)throw invalid();
        const bytes=draft.format==='rich-v2'?Buffer.from(draft.rich.canonical,'base64url'):Buffer.from(canonical(draft.config));
        if(creatorSha(bytes)!==command.baseSha256)throw invalid();
        if(draft.format==='rich-v2'){
          let logo:Extract<CommunityRequest,{type:'saveRichDraftMetadata'}>['logo']={kind:'keep'};
          if(command.change.field==='logo'){
            if(command.change.value==='remove')logo={kind:'remove'};
            else {
              const value=expect(await context.rpc({type:'creatorLogo',botId:context.association.botId,session:context.session,id:job.id}),'creatorLogoBytes');
              context.check();const bytes=Buffer.from(value.base64,'base64');
              if(bytes.toString('base64')!==value.base64||creatorSha(bytes)!==value.sha256||value.sha256!==command.change.sha256)throw invalid();
              logo={kind:'replace',base64:value.base64};
            }
          }
          const publicValue=command.change.field==='logo'?draft.public:recipePublicSchema.parse({...draft.public,[command.change.field]:command.change.value});
          request=richMetadataRequestSchema.parse({type:'saveRichDraftMetadata',accountId,requestId:job.id,draftId:command.work.draftId,
            revision:command.revision,baseManifestSha256:command.baseSha256,public:publicValue,logo});
        }else{
          if(command.change.field==='logo')throw invalid();
          request={type:'saveDraft',accountId,requestId:job.id,target:{kind:'existing',draftId:command.work.draftId,revision:command.revision},
            config:draft.config,public:recipePublicSchema.parse({...draft.public,[command.change.field]:command.change.value})};
        }break;
      }
      case 'discard': {
        const {draft}=await this.workDraft(context,job,command.work);if(draft.revision!==command.revision)throw invalid();
        request={type:'deleteDraft',accountId,requestId:job.id,draftId:command.work.draftId,revision:command.revision};break;
      }
      case 'withdraw':await this.requireVersion(context,job,command.target,['execute'],true);request={type:'withdraw',accountId,versionId:command.target.versionId};break;
      case 'issue':await this.requireVersion(context,job,command.target,['execute']);request={type:'issueCodes',accountId,requestId:job.id,versionId:command.target.versionId,count:command.count};break;
      case 'disable':case 'reveal': {
        const account=await this.requireVersion(context,job,command.target,['execute']);await this.findCodes(account,accountId,command.target,[command.codeId]);
        request={type:command.kind==='disable'?'disableCode':'revealCode',accountId,requestId:job.id,codeId:command.codeId};break;
      }
    }
    const row:CreatorCommandRecord={association:context.association,id:job.id,command,grant:{approval:job.task.approval,expiresAt:job.task.expiresAt,confirmation:job.task.confirmation},request,phase:'frozen'};
    this.journal.save(row);return row;
  }
  private async findCodes(account:NativeAccount,accountId:string,target:CreatorVersion,ids:string[]){
    const found=new Map<string,Awaited<ReturnType<typeof creatorCodes>>['items'][number]>();let cursor:string|undefined;
    const seen=new Set<string>();
    for(let page=0;page<2048;page++){
      const result=await creatorCodes(account,accountId,target,cursor);
      for(const item of result.items)if(ids.includes(item.codeId))found.set(item.codeId,item);
      if(found.size===ids.length)return ids.map(id=>found.get(id)!);
      if(!result.nextCursor||seen.has(result.nextCursor))break;seen.add(result.nextCursor);cursor=result.nextCursor;
    }
    throw invalid();
  }
  private async receipt(context:CreatorContext,job:CreatorJob,row:CreatorCommandRecord):Promise<CreatorAnswer|undefined>{
    const account=this.transport(context,job,['receipt','execute','delivery']),id=row.association.accountId,command=row.command;
    if(command.kind==='publish')return publicationReceipt(account,row);
    if(command.kind==='issue')return issueReceipt(account,row);
    if(command.kind==='metadata'){
      const r=row.request;
      if(r.type!=='saveRichDraftMetadata')return;
      if(r.accountId!==id||r.requestId!==row.id||r.draftId!==command.work.draftId||r.revision!==command.revision||
        r.baseManifestSha256!==command.baseSha256)throw invalid();
      const key=this.metadata.key(id,r.draftId);
      return this.metadata.exclusive(key,async()=>{
        context.check();
        const held=this.metadata.read(key);
        const matching=held?.request.requestId===r.requestId?held:undefined;
        if(matching&&!isDeepStrictEqual(matching.request,r))throw invalid();
        const receipt=matching?.receipt?verifyMetadataReceipt(r,matching.receipt):await metadataReceipt(account,r);
        context.check();
        if(!receipt)return;
        if(matching&&!matching.receipt)this.metadata.write(key,{...matching,receipt});
        return {kind:'saved' as const,work:command.work,revision:receipt.revision};
      });
    }
    if(command.kind==='reveal')return {kind:'reveal',target:command.target,codeId:command.codeId};
    if(command.kind==='withdraw'){
      const detail=await communityRequest(account,{type:'detail',accountId:id,...command.target});
      if(detail.owned&&detail.state==='withdrawn')return {kind:'withdrawn',target:command.target};return;
    }
    if(command.kind==='disable'){
      const [code]=await this.findCodes(account,id,command.target,[command.codeId]);
      if(code?.status==='disabled')return {kind:'disabled',target:command.target,codeId:command.codeId};return;
    }
    if(command.kind==='discard'){
      try{await creatorDraft(account,id,command.work.draftId,()=>context.check());}
      catch(error){if(error instanceof CreatorCloudRejected&&error.code==='not_found')return {kind:'discarded',work:command.work,revision:command.revision};throw error;}
    }
  }
  private async dispatch(context:CreatorContext,job:CreatorJob,row:CreatorCommandRecord):Promise<DispatchResult>{
    const account=this.transport(context,job,['execute']),r=row.request,c=row.command;
    switch(r.type){
      case 'publishDraft':case 'issueCodes':await communityRequest(account,r);return 'awaitingReceipt';
      case 'saveRichDraftMetadata': {
        const outcome=await communityRequest(account,r,this.metadata);
        if(outcome.status==='committed'&&c.kind==='metadata')return {kind:'saved',work:c.work,revision:outcome.receipt.revision};
        if(outcome.status==='rejected')throw new CreatorCloudRejected(outcome.code);return;
      }
      case 'saveDraft': {
        const saved=await communityRequest(account,r);
        if(c.kind!=='metadata'||saved.draftId!==c.work.draftId||saved.revision!==c.revision+1)throw invalid();return {kind:'saved',work:c.work,revision:saved.revision};
      }
      case 'deleteDraft': {
        const result=await communityRequest(account,r);if(c.kind!=='discard'||result.draftId!==c.work.draftId)throw invalid();return {kind:'discarded',work:c.work,revision:c.revision};
      }
      case 'withdraw':if(c.kind!=='withdraw')throw invalid();await this.requireVersion(context,job,c.target,['execute'],true);await communityRequest(account,r);return {kind:'withdrawn',target:c.target};
      case 'disableCode': {
        const result=await communityRequest(account,r);if(c.kind!=='disable'||result.codeId!==c.codeId)throw invalid();return {kind:'disabled',target:c.target,codeId:c.codeId};
      }
      case 'revealCode':if(c.kind!=='reveal')throw invalid();return {kind:'reveal',target:c.target,codeId:c.codeId};
      default:throw invalid();
    }
  }
  async recoverPublication(accountId:string,draftId:string,check:()=>void):Promise<Extract<DesktopAuthoringReply,{kind:'publicationRecovery'}>>{
    check();
    const rows=this.journal.publications(accountId,draftId).filter(row=>row.phase!=='frozen'&&row.result?.kind!=='rejected');
    for(const row of rows){
      check();
      const answer=await publicationReceipt(this.account,row);check();
      if(answer?.kind==='published'){
        this.committed(row,answer);
        return {kind:'publicationRecovery',result:{kind:'published',publication:{accountId,draftId,...answer.target,revision:answer.revision}}};
      }
    }
    return {kind:'publicationRecovery',result:{kind:rows.length?'pending':'absent'}};
  }
  private committed(row:CreatorCommandRecord,result:CreatorAnswer){
    const next={...row,phase:'committed' as const,result};this.journal.save(next);
    if(result.kind==='saved')this.onSaved?.({accountId:row.association.accountId,draftId:result.work.draftId,revision:result.revision});
    if(result.kind==='published'){this.journal.rememberVersion(row.association,result.target.versionId);this.onPublished?.({accountId:row.association.accountId,draftId:result.draftId,...result.target,revision:result.revision});}
    return result;
  }
  private async command(context:CreatorContext,job:CreatorJob):Promise<CreatorAnswer>{
    if(job.task.kind!=='command')throw invalid();
    let row=this.journal.command(context.association.accountId,job.id);
    if(row&&(!isDeepStrictEqual(row.association,context.association)||!isDeepStrictEqual(row.command,job.task.command)))throw invalid();
    if(row?.result)return row.result;
    const checked=await this.checked(context,job);
    if(!row){
      if(checked.mode!=='execute'||job.task.expiresAt<=Date.now())return {kind:'unknown'};
      row=await this.freezeCommand(context,job);
    }
    const wasDispatched=row.phase==='dispatched'||row.phase==='unknown';
    if(wasDispatched||row.phase==='awaitingReceipt'||checked.mode==='receipt'||job.task.expiresAt<=Date.now()){
      const result=await this.receipt(context,job,row);
      if(result)return this.committed(row,result);
      if(row.phase==='awaitingReceipt'||checked.mode!=='execute'||job.task.approval===row.grant.approval||job.task.expiresAt<=Date.now())return {kind:'unknown'};
    }
    if(checked.mode!=='execute')return {kind:'unknown'};
    if(job.task.approval!==row.grant.approval){row={...row,grant:{approval:job.task.approval,expiresAt:job.task.expiresAt,confirmation:job.task.confirmation}};this.journal.save(row);}
    if(!wasDispatched){
      if(row.command.kind==='publish'){
        const snapshot=await this.freeze(context,job,row.command.snapshot.work);
        if(!this.sameSnapshot(snapshot.snapshot,row.command.snapshot))throw invalid();
      }else if(row.command.kind==='metadata'||row.command.kind==='discard'){
        const {draft}=await this.workDraft(context,job,row.command.work);
        if(draft.revision!==row.command.revision)throw invalid();
      }
    }
    const finalCheck=await this.checked(context,job);
    if(finalCheck.mode!=='execute'||job.task.expiresAt<=Date.now())return {kind:'unknown'};
    row={...row,phase:'dispatched'};this.journal.save(row);
    let result:DispatchResult;
    try {
      result=await this.dispatch(context,job,row);
    }catch(error){
      if(error instanceof CreatorCloudRejected||!wasDispatched&&error instanceof CommunityError&&['invalid_input','credential_detected','quota_exceeded','incomplete_setup','conflict','not_found'].includes(error.code))return this.committed(row,{kind:'rejected',reason:error.code==='forbidden'?'forbidden':error.code==='conflict'?'changed':'unavailable'});
    }
    if(result==='awaitingReceipt'){
      row={...row,phase:'awaitingReceipt'};
      this.journal.save(row);
      result=await this.receipt(context,job,row);
      return result?this.committed(row,result):{kind:'unknown'};
    }
    if(result)return this.committed(row,result);
    this.journal.save({...row,phase:'unknown'});return {kind:'unknown'};
  }
  async run(context:CreatorContext,job:CreatorJob){
    const checked=await this.checked(context,job);
    if(checked.mode==='preview')throw invalid();
    if(job.task.kind==='deliverCodes'){
      if(checked.mode!=='delivery')throw invalid();
      const account=await this.requireVersion(context,job,job.task.target,['delivery']);
      const statuses=await this.findCodes(account,context.association.accountId,job.task.target,job.task.codeIds);
      const items:Extract<RecipeAuthoringRequest,{type:'creatorDeliver'}>['items']=[];
      for(const status of statuses){
        if(status.status!=='available'){items.push({codeId:status.codeId,status:status.status});continue;}
        const value=communityResponseSchemas.revealCode.parse(await creatorJson(account,context.association.accountId,`/v1/codes/${status.codeId}/reveal`,{
          method:'POST',headers:{'content-type':'application/json','idempotency-key':job.id},body:'{}'}));
        if(value.codeId!==status.codeId)throw invalid();items.push({codeId:value.codeId,status:'available',code:value.code});
      }
      await this.checked(context,job);
      expect(await context.rpc({type:'creatorDeliver',botId:context.association.botId,session:context.session,id:job.id,items}),'creatorAck');context.check();return;
    }
    let answer:CreatorAnswer;
    try{answer=job.task.kind==='read'?await this.read(context,job,job.task.read):await this.command(context,job);}
    catch(error){context.check();answer=error instanceof UnsupportedLegacyPublication?{kind:'rejected',reason:'invalid'}:job.task.kind==='command'&&this.journal.command(context.association.accountId,job.id)?{kind:'unknown'}:{kind:'rejected',reason:'unavailable'};}
    await this.checked(context,job);
    expect(await context.rpc({type:'creatorAnswer',botId:context.association.botId,session:context.session,id:job.id,answer}),'creatorAck');context.check();
  }
}
