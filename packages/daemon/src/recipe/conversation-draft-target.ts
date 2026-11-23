import {creatorWorkSchema,type CreatorWork} from '@vonvon/protocol';
import {linkKey,sameRecipient,type AuthoringLedger,type Link} from './authoring-journal';

type RenameTarget='draft'|'proposal'|'unspecified';
export type RenameIntent={target:RenameTarget;bare:boolean;checking:boolean;originalName?:string};
export function renameIntent(text:string,previous?:RenameIntent):RenameIntent|undefined {
  if(/(?:新建|创建|创作)(?:一|另|个|份|新|的|本地|私人|配方|草稿){0,8}(?:配方|草稿)/u.test(text))return;
  const draft=/(?:原稿|原(?:来)?那份|原草稿|已(?:经)?保存|已有|App.{0,8}(?:草稿|那份|这份|原来|旧的)|旧草稿|现有|本地草稿|私人配方草稿)/iu.test(text);
  const proposal=/(?:未保存|待建|新建提案|新提案|候选|提案|待确认方案)/u.test(text);
  const rename=/(?:改(?:个|一下|下)?(?:名(?:称|字)?|标题)|重命名|(?:名称|名字|标题).{0,7}(?:改|换)|把\s*[「“"]?[\w.-]+[」”"]?\s*改(?:成|为)|^(?:please )?rename\b)/iu.test(text);
  const reply=previous&&(draft||proposal||/^(?:就叫|改成|改为|新名称|新名字|叫做)|^[\w.-]{1,120}$/u.test(text));
  if(!rename&&!reply)return;
  const target=draft&&proposal?'unspecified':draft?'draft':proposal?'proposal':previous?.target??'unspecified';
  const named=text.match(/(?:把|将|给)\s*(?:(?:已有|原有|已保存)?(?:配方|草稿)\s*)?(?:[「“"]([^」”"]{1,120})[」”"]|([\w.-]{1,120}))\s*(?:重命名|改名|改成|改为)/u);
  const originalName=named?.[1]??named?.[2];
  return {target,originalName,checking:/(?:进度|结果|成功|完成|保存了|改好|生效|是否|了[吗么]|怎么样|好了没|status)/iu.test(text),bare:/^(?:(?:请|帮我|我要|我想|给它|直接|现在|就)\s*)*(?:改(?:个|一下|下)?(?:名|名字|名称)|重命名)[吧。！!？?\s]*$/u.test(text)};
}
export function draftTargets(db:AuthoringLedger,key:string,link:Link,now:number){
  const drafts=new Map<string,{work:CreatorWork;lastVerifiedName?:string;nameAtCreation?:string}>();
  const creator=link.creator;
  for(const [draftId,source] of Object.entries(creator?.sources??{}))drafts.set(draftId,{work:{draftId,source}});
  for(const op of Object.values(db.operations)){
    const receipt=op.view.receipt,group=op.originalGroup;
    if(!op.conversation||op.revoked||op.binding!==link.binding||op.bot!==link.bot||linkKey(op.scope,op.accountId)!==key||
      !sameRecipient(op.recipient,link.recipient)||!op.localDraftAcknowledged||receipt?.status!=='accepted'||!group)continue;
    const handoff=db.handoffs?.[op.instructionId??''];
    drafts.set(receipt.draftId,{work:creatorWorkSchema.parse({draftId:receipt.draftId,source:{preparationId:op.view.operationId,groupId:group.groupId,identity:group.identity}}),
      ...(handoff?.capture&&handoff.binding===link.binding&&sameRecipient(handoff.recipient,link.recipient)&&{nameAtCreation:handoff.capture.public.name})});
  }
  if(creator?.current?.kind==='draft'){
    const snapshot=creator.current.snapshot;
    drafts.set(snapshot.work.draftId,{...drafts.get(snapshot.work.draftId),work:snapshot.work,lastVerifiedName:snapshot.public.name});
  }
  for(const row of Object.values(creator?.jobs??{})){
    if(row.expiresAt<=now||row.job.binding!==link.binding)continue;
    if(row.conversationList?.order===(link.selectionOrder??0)&&row.result?.kind==='works')
      for(const item of row.result.items)if(item.kind==='draft')drafts.set(item.work.draftId,{work:item.work,lastVerifiedName:item.name});
    if(row.inspected&&row.conversationRead?.order===(link.selectionOrder??0)&&row.originWork)
      drafts.set(row.originWork.draftId,{work:row.originWork,lastVerifiedName:row.inspected.name});
    const task=row.job.task;
    if(row.result?.kind==='saved'&&task.kind==='command'&&task.command.kind==='metadata'&&task.command.change.field==='name')
      drafts.set(row.result.work.draftId,{work:row.result.work,lastVerifiedName:task.command.change.value});
  }
  return drafts;
}
export function renameReceipt(link:Link,threadId:string|undefined,now:number){
  const row=Object.values(link.creator?.jobs??{}).reverse().find(r=>{
    if(r.job.binding!==link.binding)return false;
    if(r.rename)return r.rename.order===(link.selectionOrder??0)&&r.rename.threadId===threadId&&
      (r.state==='finished'||r.state==='unknown'||r.expiresAt>now);
    const read=r.conversationRead;
    return (r.state==='active'||r.result?.kind==='rejected')&&r.expiresAt>now&&read?.order===(link.selectionOrder??0)&&read.threadId===threadId&&read.change?.field==='name';
  });
  if(row?.conversationRead?.change?.field==='name'&&row.originWork)return {operation:'renameDraft' as const,
    state:row.result?.kind==='rejected'?'needsReview':'reading',draftId:row.originWork.draftId,proposedName:row.conversationRead.change.value,verified:row.inspected,
    message:row.result?.kind==='rejected'?'请核对 App 中的实际草稿和名称。':'App 正在读取这份草稿的当前名称和修订。'};
  const task=row?.job.task;
  if(!row?.rename||task?.kind!=='command'||task.command.kind!=='metadata'||task.command.change.field!=='name')return;
  const c=task.command,info={operation:'renameDraft' as const,draftId:c.work.draftId,previousName:row.rename.previousName,proposedName:c.change.value};
  if(row.result?.kind==='saved')return {...info,state:'saved',savedName:c.change.value,revision:row.result.revision};
  if(row.result?.kind==='rejected')return {...info,state:'needsReview',revision:c.revision};
  if(row.state==='finished')return;
  return {...info,state:row.state==='offer'?'awaitingConfirmation':'preparing',revision:c.revision,
    message:row.state==='offer'?'等待本人点击“采用修改”保存到原草稿。':'App 正在核对这次改名的本地保存回执。'};
}
