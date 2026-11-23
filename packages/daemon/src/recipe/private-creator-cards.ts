import {randomUUID} from 'node:crypto';
import type {CreatorAnswer,CreatorCommand,CreatorRead,CreatorSelection,CreatorWork,InheritedPublication} from '@vonvon/protocol';
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
  | {kind:'offer';command:CreatorCommand}
  | {kind:'codePage';answer:Extract<CreatorAnswer,{kind:'codes'}>;offset:number}
  | {kind:'detailPage';id:string;page:number}
  | {kind:'logo';work:CreatorWork}
  | {kind:'edit';id:string};
export type Option={label:string;choice:Choice};
export type Card={
  ref:string;generation:number;session:string;sendId:string;expiresAt:number;title:string;text:string;
  options:Option[];needsUpdate?:true;retryId?:string;cardId?:string;messageId?:string;url?:string;workId?:string;
};
export const layout=(c:Card)=>card([
  {tag:'div',text:{tag:'plain_text',content:c.text}},
  ...c.options.map((o,index)=>button(o.label,{a:'recipe.authoring',verb:'creator',ref:c.ref,generation:c.generation,index},o.choice.kind==='approve'?'primary':'default')),
  ...(c.url?[linkButton('打开社区版本',c.url)]:[]),
],{header:{title:c.title},forward:false,summary:c.title});

export class CreatorCards {
  constructor(private readonly now:()=>number) {}
  newCard(s:CreatorLedger,p:Presence,title:string,text:string,buttons:Option[],workId?:string,url?:string){
    const ref=randomUUID();
    const row:Card={ref,sendId:randomUUID(),generation:1,session:p.session,expiresAt:this.now()+30*60_000,title,text,options:buttons,workId,url};
    if(Buffer.byteLength(JSON.stringify({data:JSON.stringify(layout(row))}))>28_000)throw new Error('内容过长，请分段核对。');
    if(Object.keys(s.cards).length>=128)throw new Error('本次配方卡片已满。');
    s.cards[ref]=row;return row;
  }
  approvalCard(p:Presence,s:CreatorLedger,row:JobRecord,retry:boolean){
    const task=row.job.task;if(task.kind!=='command')throw new Error('需要具体的已选操作。');
    const c=task.command,work=c.kind==='publish'?c.snapshot.work:'work'in c?c.work:undefined,target='target'in c?c.target:undefined;
    const choices:Option[]=[];
    let title:string, text:string, label:string;
    if(c.kind==='publish'){
      const snap=c.snapshot,pub=snap.public;
      title='预览发布';label='确认发布 '+pub.version;
      const longOverview=[...pub.overview].length>1500;
      if(longOverview)choices.push({label:'查看完整公开概览',choice:{kind:'detailPage',id:row.job.id,page:0}});
      text=[pub.name+' · '+pub.version,pub.summary,longOverview?'公开概览可分段查看。':pub.overview,pub.access==='coded'?'凭分享码获取':'直接获取',
        '草稿 '+snap.work.draftId+' · 修订 '+snap.revision,
        snap.work.source?'来源 '+snap.work.source.groupId:'本人账号的旧格式作品',
        ...(snap.parent?['父版本 '+snap.parent.versionId]:[]),'可按节查看完整发布内容。修改公开信息可发送 /recipe name、version、summary 或 overview，后面加新值。获取方式可发送 /recipe access 直接获取 或 /recipe access 凭码获取。'].join('\n');
      snap.sections.forEach((part,section)=>choices.push({label:part.title,choice:{kind:'read',read:{kind:'page',work:snap.work,snapshotDigest:c.snapshotDigest,section,page:0}}}));
      if(!retry){
        choices.push({label:'继续修改内容',choice:{kind:'edit',id:row.job.id}});
        if(snap.format==='rich-v2')choices.push({label:'更换 Logo',choice:{kind:'logo',work:snap.work}});
        choices.push({label:'删除创作中作品',choice:{kind:'offer',command:{kind:'discard',work:snap.work,revision:snap.revision}}});
      }
    }else if(c.kind==='metadata'){
      title='采用公开信息修改';label='采用修改';
      const field={name:'名称',summary:'简介',overview:'概览',version:'显示版本',access:'获取方式',logo:'Logo'}[c.change.field];
      text='草稿 '+c.work.draftId+' · 修订 '+c.revision+'\n'+field+' → '+(c.change.field==='logo'?(c.change.value==='attachment'?'原私聊图片 · '+c.change.sha256:'移除 Logo'):c.change.value);
    }else if(c.kind==='discard'){
      title='删除创作中的作品';label='确认删除';text='将删除草稿 '+c.work.draftId+' 的修订 '+c.revision+'。已发布版本会保留。';
    }else{
      title='版本管理';label={withdraw:'确认撤下',issue:'确认生成',disable:'确认停用',reveal:'在本人私聊显示'}[c.kind];
      text='配方 '+target!.recipeId+'\n版本 '+target!.versionId+'\n'+
        (c.kind==='withdraw'?'撤下这个版本并停用剩余可用码，已取得的授权保留。':c.kind==='issue'?'生成 '+c.count+' 枚分享码。':(c.kind==='disable'?'停用分享码 ':'重显分享码 ')+c.codeId);
    }
    if(c.kind==='metadata'&&[...text].length>1800){
      text='草稿 '+c.work.draftId+' · 修订 '+c.revision+'。请分段查看本次输入的完整新值。';
      choices.push({label:'查看完整新值',choice:{kind:'detailPage',id:row.job.id,page:0}});
    }
    if(retry){title='核对原请求';text+='\n原请求 '+row.job.id+' 的结果尚未确定。重试将沿用原参数与请求键。';label='重新确认并重试';}
    choices.unshift({label,choice:{kind:'approve',id:row.job.id,retry}});
    const card=this.newCard(s,p,title,text,choices,work?.draftId);
    row.offerRef=card.ref;return card;
  }
  codePage(s:CreatorLedger,p:Presence,a:Extract<CreatorAnswer,{kind:'codes'}>,offset:number){
    const items=a.items.slice(offset,offset+6);
    const buttons:Option[]=[];
    const lines=items.map(item=>item.codeId+' · '+item.suffix+' · '+{available:'可用',redeemed:'已兑换',disabled:'已停用'}[item.status]);
    for(const item of items)if(item.status==='available'){
      for(const kind of ['reveal','disable'] as const)buttons.push({label:(kind==='reveal'?'重显 ':'停用 ')+item.suffix+' · '+item.codeId.slice(-8),choice:{kind:'offer',command:{kind,target:a.target,codeId:item.codeId}}});
    }
    if(offset>0)buttons.push({label:'上一页',choice:{kind:'codePage',answer:a,offset:offset-6}});
    if(offset+6<a.items.length)buttons.push({label:'下一页',choice:{kind:'codePage',answer:a,offset:offset+6}});
    else if(a.nextCursor)buttons.push({label:'下一页',choice:{kind:'read',read:{kind:'codes',target:a.target,cursor:a.nextCursor}}});
    return this.newCard(s,p,'版本分享码',lines.join('\n')||'暂无分享码。',buttons);
  }
  versionCard(s:CreatorLedger,p:Presence,v:VersionSelection,url?:string){
    const {target}=v;
    return this.newCard(s,p,v.name+' · '+v.version,(url?'已发布版本 ':'版本 ')+target.versionId+'\n可发送 /recipe issue 3 指定分享码数量。',[
      {label:'管理分享码',choice:{kind:'read',read:{kind:'codes',target,cursor:null}}},
      {label:'生成一枚分享码',choice:{kind:'offer',command:{kind:'issue',target,count:1}}},
      {label:'准备新版',choice:{kind:'read',read:{kind:'parent',target}}},
      {label:'撤下版本',choice:{kind:'offer',command:{kind:'withdraw',target}}},
    ],undefined,url);
  }
}
