import {randomUUID} from 'node:crypto';
import type {CreatorAnswer,CreatorCommand,CreatorRead,CreatorSelection,CreatorSnapshot,CreatorWork,InheritedPublication} from '@vonvon/protocol';
import {button,card,linkButton} from '../card/cards';
import type {Presence} from './authoring-service';
import type {CreatorLedger,JobRecord,VersionSelection} from './private-creator';

type Group={groupId:string;name:string;identity:string};
type Choice =
  | {kind:'select';selection:CreatorSelection}
  | {kind:'group';group:Group;inherited?:InheritedPublication}
  | {kind:'resumeHandoff';id:string}
  | {kind:'groups';offset:number;inherited?:InheritedPublication}
  | {kind:'read';read:CreatorRead}
  | {kind:'approve';id:string;retry:boolean}
  | {kind:'offer';command:CreatorCommand;codeLabel?:string}
  | {kind:'codePage';answer:Extract<CreatorAnswer,{kind:'codes'}>;offset:number}
  | {kind:'detailPage';id:string;page:number}
  | {kind:'logo';work:CreatorWork}
  | {kind:'edit';id:string};
export type Option={label:string;choice:Choice};
export type Card={
  ref:string;generation:number;session:string;sendId:string;expiresAt:number;title:string;text:string;
  options:Option[];previewOwner?:string;previewApproval?:string;version?:VersionSelection;needsUpdate?:true;retryId?:string;cardId?:string;messageId?:string;url?:string;appPreviewUrl?:string;workId?:string;
};
export const layout=(c:Card)=>card([
  {tag:'div',text:{tag:'plain_text',content:c.text}},
  ...(c.appPreviewUrl?[linkButton('在 App 中预览',c.appPreviewUrl)]:[]),
  ...c.options.map((o,index)=>button(o.label,{a:'recipe.authoring',verb:'creator',ref:c.ref,generation:c.generation,index},o.choice.kind==='approve'?'primary':'default')),
  ...(c.url?[linkButton('打开社区版本',c.url)]:[]),
],{header:{title:c.title},forward:false,summary:c.title});

function checkSize(row:Card){
  if(Buffer.byteLength(JSON.stringify({data:JSON.stringify(layout(row))}))>28_000)throw new Error('内容过长，请分段核对。');
}
export function sectionName(snapshot:CreatorSnapshot,index:number){
  const title=snapshot.sections[index]!.title;
  const labels:Record<string,string>={role:'群角色',settings:'群设置',rules:'规则',skills:'技能',files:'文件',tasks:'任务',setup:'准备步骤',parts:'附件清单',finalLogo:'配方 Logo'};
  const part=snapshot.parts.findIndex(item=>item.kind==='text'&&item.objectId===title);
  return part>=0?'附件正文 '+(part+1):Object.hasOwn(labels,title)?labels[title]!:title;
}
export class CreatorCards {
  constructor(private readonly now:()=>number) {}
  newCard(s:CreatorLedger,p:Presence,title:string,text:string,buttons:Option[],workId?:string,url?:string){
    const ref=randomUUID();
    const row:Card={ref,sendId:randomUUID(),generation:1,session:p.session,expiresAt:this.now()+30*60_000,title,text,options:buttons,workId,url};
    checkSize(row);
    if(Object.keys(s.cards).length>=128)throw new Error('本次配方卡片已满。');
    s.cards[ref]=row;return row;
  }
  previewCard(s:CreatorLedger,p:Presence,owner:JobRecord,title:string,text:string,options:Option[],draftId:string){
    const preview=owner.preview??={};
    const existing=preview.ref&&s.cards[preview.ref];
    if(existing){
      existing.title=title;existing.text=text;existing.options=options;existing.generation++;
      existing.needsUpdate=true;existing.session=p.session;existing.previewApproval=owner.offerRef;
      checkSize(existing);
      existing.expiresAt=s.cards[owner.offerRef!]!.expiresAt;
      return existing;
    }
    const result=this.newCard(s,p,title,text,options,draftId);
    result.expiresAt=s.cards[owner.offerRef!]!.expiresAt;
    result.previewOwner=owner.job.id;result.previewApproval=owner.offerRef;preview.ref=result.ref;
    return result;
  }
  approvalCard(p:Presence,s:CreatorLedger,row:JobRecord,retry:boolean){
    const task=row.job.task;if(task.kind!=='command')throw new Error('需要具体的已选操作。');
    const c=task.command,work=c.kind==='publish'?c.snapshot.work:'work'in c?c.work:undefined;
    const choices:Option[]=[];
    const workName=row.workName??'所选草稿',versionName=row.version?row.version.name+' · '+row.version.version:'所选版本';
    let title:string, text:string, label:string;
    if(c.kind==='publish'){
      const snap=c.snapshot,pub=snap.public;
      title='预览发布';label='确认发布 '+pub.version;
      text=[pub.name+' · '+pub.version,pub.access==='coded'?'凭分享码获取':'直接获取','草稿修订 '+snap.revision,
        ...(!p.nativePreview&&!snap.appPreviewUrl?['请打开 App 的「我的配方」查看完整内容。']:[])].join('\n');
      if(!retry)choices.push({label:'继续修改内容',choice:{kind:'edit',id:row.job.id}});
    }else if(c.kind==='metadata'){
      title='采用公开信息修改';label='采用修改';
      const field={name:'名称',summary:'简介',overview:'概览',version:'显示版本',access:'获取方式',logo:'Logo'}[c.change.field];
      const value=c.change.field==='access'?(c.change.value==='coded'?'凭分享码获取':'直接获取'):
        c.change.field==='logo'?(c.change.value==='attachment'?'本次发送的私聊图片':'移除 Logo'):c.change.value;
      text=workName+' · 修订 '+c.revision+'\n'+field+' → '+value;
    }else if(c.kind==='discard'){
      title='删除创作中的作品';label='确认删除';text='将删除「'+workName+'」的草稿修订 '+c.revision+'。已发布版本会保留。';
    }else{
      title='版本管理';label={withdraw:'确认撤下',issue:'确认生成',disable:'确认停用',reveal:'在本人私聊显示'}[c.kind];
      text=versionName+'\n'+
        (c.kind==='withdraw'?'撤下这个版本并停用剩余可用码，已取得的授权保留。':c.kind==='issue'?'生成 '+c.count+' 枚分享码。':(c.kind==='disable'?'停用':'重显')+(row.codeLabel??'所选分享码'));
    }
    if(c.kind==='metadata'&&[...text].length>1800){
      text=workName+' · 修订 '+c.revision+'。请分段查看本次输入的完整新值。';
      choices.push({label:'查看完整新值',choice:{kind:'detailPage',id:row.job.id,page:0}});
    }
    if(retry){title='核对原请求';text+='\n上次操作的结果尚未确定。重新确认后会核验同一次请求。';label='重新确认并重试';}
    choices.unshift({label,choice:{kind:'approve',id:row.job.id,retry}});
    if(c.kind==='publish'&&p.nativePreview)choices.unshift({label:'在 App 中预览',choice:{kind:'read',read:{kind:'openPreview',work:c.snapshot.work,snapshotDigest:c.snapshotDigest}}});
    const card=this.newCard(s,p,title,text,choices,work?.draftId);
    if(c.kind==='publish'&&!p.nativePreview&&c.snapshot.appPreviewUrl)card.appPreviewUrl=c.snapshot.appPreviewUrl;
    if(row.preview?.readId){delete s.jobs[row.preview.readId];delete row.preview.readId;}
    if(row.preview){
      delete row.preview.position;
      const prior=row.preview.ref&&s.cards[row.preview.ref];
      if(prior){prior.session=p.session;prior.expiresAt=card.expiresAt;}
    }
    row.offerRef=card.ref;return card;
  }
  codePage(s:CreatorLedger,p:Presence,a:Extract<CreatorAnswer,{kind:'codes'}>,offset:number,version?:VersionSelection){
    const items=a.items.slice(offset,offset+6);
    const buttons:Option[]=[];
    const lines=items.map((item,index)=>{
      const label='分享码 '+(offset+index+1)+(item.suffix?' · 尾号 '+item.suffix:'');
      if(item.status==='available'){
        for(const kind of ['reveal','disable'] as const)buttons.push({label:(kind==='reveal'?'重显':'停用')+label,choice:{kind:'offer',command:{kind,target:a.target,codeId:item.codeId},codeLabel:label}});
      }
      return label+' · '+{available:'可用',redeemed:'已兑换',disabled:'已停用'}[item.status];
    });
    if(offset>0)buttons.push({label:'上一页',choice:{kind:'codePage',answer:a,offset:offset-6}});
    if(offset+6<a.items.length)buttons.push({label:'下一页',choice:{kind:'codePage',answer:a,offset:offset+6}});
    else if(a.nextCursor)buttons.push({label:'下一页',choice:{kind:'read',read:{kind:'codes',target:a.target,cursor:a.nextCursor}}});
    const c=this.newCard(s,p,version?version.name+' · '+version.version+' 的分享码':'版本分享码',lines.join('\n')||'暂无分享码。',buttons);
    c.version=version;return c;
  }
  versionCard(s:CreatorLedger,p:Presence,v:VersionSelection,url?:string){
    const {target}=v;
    const c=this.newCard(s,p,v.name+' · '+v.version,(url?'已发布。':'管理这个版本的分享码或准备新版。')+'\n可发送 /recipe issue 3 指定分享码数量。',[
      {label:'管理分享码',choice:{kind:'read',read:{kind:'codes',target,cursor:null}}},
      {label:'生成一枚分享码',choice:{kind:'offer',command:{kind:'issue',target,count:1}}},
      {label:'准备新版',choice:{kind:'read',read:{kind:'parent',target}}},
      {label:'撤下版本',choice:{kind:'offer',command:{kind:'withdraw',target}}},
    ],undefined,url);
    c.version=v;return c;
  }
}
