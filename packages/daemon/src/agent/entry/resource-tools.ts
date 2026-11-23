import {z} from 'zod';
import type {ResourceCaller,ResourceQuery} from '../../recipe/resource-context';
import type {AgentTool} from './tools';

/** Bump when persisted Codex sessions need new resource tool names or input schemas. */
export const RESOURCE_TOOL_CATALOG_VERSION = 2;
export const resourceToolNames=new Set(['recipe_resource_read','recipe_resource_acquire','recipe_resource_prepare']);
export function resourceTools(call:(get:()=>ResourceCaller|undefined,query:ResourceQuery)=>Promise<unknown>):AgentTool[]{
  const groupId=z.string().regex(/^oc_[A-Za-z0-9_-]{1,200}$/);
  const read=z.object({kind:z.enum(['index','text','latest']),documentId:z.string().max(80).optional(),cursor:z.string().max(160).optional(),groupId:groupId.optional()}).strict();
  const acquire=z.object({versionId:z.string().uuid()}).strict();
  const prepare=z.object({groupId}).strict();
  return [
    {name:'recipe_resource_read',class:'resource',places:['p2p'],input:read,
      description:'读取本人在 App 选定配方的轻量摘要。index 列展示资料，text 读对应说明，latest 查新版。不会下载技能文件或规则正文。只有本人明确要求应用到某群、且 recipe_resource_prepare 已准备成功后，才带同一个 groupId 读取完整资料并用原配置工具按要求应用；不得为了浏览而准备完整内容。',
      async run(args,ctx){
        if(!ctx.resourceCaller)throw new Error('需要本人当前私聊。');
        const q=read.parse(args);
        if(q.kind==='latest')return call(ctx.resourceCaller,z.object({kind:z.literal('latest')}).strict().parse(q));
        if(q.kind==='index'&&q.documentId!==undefined)throw new Error('目录不接受正文编号。');
        return call(ctx.resourceCaller,q.kind==='index'?{kind:'index',cursor:q.cursor,...(q.groupId&&{groupId:q.groupId})}:
          {kind:'text',documentId:z.string().regex(/^d[0-9a-f]{64}-[0-9]{1,3}$/).parse(q.documentId),cursor:q.cursor,...(q.groupId&&{groupId:q.groupId})});
      }},
    {name:'recipe_resource_prepare',class:'resource',places:['p2p'],input:prepare,
      description:'仅在本人明确选择一个已绑定群并要求应用配方时调用。先重新校验当前账号对准确版本的领取/作者权限及目标群绑定，再为这个群拉取并校验完整内容。不能用于浏览、介绍、列技能或仅仅交给 Bot。ready 后，用 recipe_resource_read 携带同一个 groupId 阅读完整资料；准备本身不修改群配置。',
      async run(args,ctx){
        if(!ctx.resourceCaller)throw new Error('需要本人当前私聊。');
        return call(ctx.resourceCaller,{kind:'prepare',...prepare.parse(args),wait:{signal:ctx.signal,notAfter:ctx.notAfter-1_000}});
      }},
    {name:'recipe_resource_acquire',class:'resource',places:['p2p'],input:acquire,
      description:'仅在本人要求使用新版时，获取 latest 提示的准确 versionId。取得后再读目录。needsCode 时请本人在 App 兑换。获取本身不修改群配置。',
      async run(args,ctx){
        if(!ctx.resourceCaller)throw new Error('需要本人当前私聊。');
        return call(ctx.resourceCaller,{kind:'acquire',...acquire.parse(args)});
      }},
  ];
}
