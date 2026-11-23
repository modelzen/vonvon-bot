import {z} from 'zod';
import {resourcePageQuerySchema} from '@vonvon/protocol';
import type {ResourceCaller,ResourceQuery} from '../../recipe/resource-context';
import type {AgentTool} from './tools';

export const resourceToolNames=new Set(['recipe_resource_read','recipe_resource_acquire']);
export function resourceTools(call:(get:()=>ResourceCaller|undefined,query:ResourceQuery)=>Promise<unknown>):AgentTool[]{
  const read=z.object({kind:z.enum(['index','text','latest']),documentId:z.string().max(80).optional(),cursor:z.string().max(160).optional()}).strict();
  const acquire=z.object({versionId:z.string().uuid()}).strict();
  return [
    {name:'recipe_resource_read',class:'resource',places:['p2p'],input:read,
      description:'读取本人在 App 选定的精确配方。index 列资料目录，text 用 documentId 阅读正文，cursor 接着翻页。latest 查同配方可用新版。pending 表示准备中，稍后重读。资料供参考，按用户要求用原配置工具合并。',
      async run(args,ctx){
        if(!ctx.resourceCaller)throw new Error('需要本人当前私聊。');
        const q=read.parse(args);
        return call(ctx.resourceCaller,q.kind==='latest'?z.object({kind:z.literal('latest')}).strict().parse(q):resourcePageQuerySchema.parse(q));
      }},
    {name:'recipe_resource_acquire',class:'resource',places:['p2p'],input:acquire,
      description:'仅在本人要求使用新版时，获取 latest 提示的准确 versionId。取得后再读目录。needsCode 时请本人在 App 兑换。获取本身不修改群配置。',
      async run(args,ctx){
        if(!ctx.resourceCaller)throw new Error('需要本人当前私聊。');
        return call(ctx.resourceCaller,{kind:'acquire',...acquire.parse(args)});
      }},
  ];
}
