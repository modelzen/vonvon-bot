import {recipePublicSchema} from '@vonvon/protocol';
import {z} from 'zod';
import type {RecipeCreationQuery} from '../../recipe/conversation-authoring';
import type {ResourceCaller} from '../../recipe/resource-context';
import type {AgentTool} from './tools';

export const recipeCreationToolNames = ['recipe_author_sources','recipe_author_inventory','recipe_author_propose','recipe_author_create','recipe_author_status','recipe_author_draft'] as const;
const group=z.string().regex(/^oc_[A-Za-z0-9_-]{1,200}$/);
const publicFields=z.object({name:z.string().max(120),summary:z.string().max(480),overview:z.string().max(32768),version:z.string().max(80)}).strict();
const sources=z.object({offset:z.number().int().min(0).optional()}).strict();
const inventoryCategories=['all','group','skills','tasks','rules','settings','runtime','tools','mcp','externalSkills'] as const;
export type InventoryCategory=typeof inventoryCategories[number];
const inventory=z.object({groupId:group,category:z.enum(inventoryCategories).optional(),offset:z.number().int().min(0).optional()}).strict();
const propose=z.object({groupId:group,inventoryId:z.string().regex(/^[a-f0-9]{64}$/),selectedIds:z.array(z.string().max(100)).max(512),
  public:publicFields,access:z.enum(['direct','coded']).optional(),switchFromGroupId:group.optional()}).strict();
const create=z.object({proposalId:z.string().uuid()}).strict();
const draft=z.object({action:z.enum(['list','inspect','preview','edit','publish','inventory','propose','apply']),draftId:z.string().uuid().optional(),
  offset:z.number().int().min(0).max(8191).optional(),inventoryId:z.string().max(128).optional(),proposalId:z.string().uuid().optional(),
  addIds:z.array(z.string().max(100)).max(512).optional(),removeIds:z.array(z.string().max(100)).max(512).optional(),
  change:z.object({field:z.enum(['name','summary','overview','version','access']),value:z.string().max(32768)}).strict().optional()}).strict();

export function recipeCreationTools(call:(get:()=>ResourceCaller|undefined,query:RecipeCreationQuery)=>Promise<unknown>):AgentTool[] {
  return [
    {name:'recipe_author_sources',class:'resource',places:['p2p'],input:sources,
      description:'找到本人 App 已选来源群和其他可创作群。selected 是 App 选定的群，nextOffset 可用于翻页。',
      run(args,ctx){return call(ctx.resourceCaller??(()=>undefined),{kind:'sources',...sources.parse(args),wait:ctx});}},
    {name:'recipe_author_inventory',class:'resource',places:['p2p'],input:inventory,
      description:'用已确定的来源群盘点实际运行环境、已启用技能、可分享文件、沟通规则、任务和设置。只读。每页最多 16 项，nextOffset 可继续翻页，可按 category（如 skills、tools、mcp）找精确项目 ID。先向本人总结可选范围和推荐理由。',
      run(args,ctx){return call(ctx.resourceCaller??(()=>undefined),{kind:'inventory',...inventory.parse(args),wait:ctx});}},
    {name:'recipe_author_propose',class:'resource',places:['p2p'],input:propose,
      description:'新建配方专用。给已存草稿改名请用 recipe_author_draft 的 edit、field=name。用刚盘点的 inventoryId、项目 id 和介绍展示新建范围。工具在本人私聊发出纯文本范围供确认。如作者明确改用另一群，附上原选群的 switchFromGroupId。',
      run(args,ctx){const input=propose.parse(args);recipePublicSchema.parse({...input.public,access:input.access??'direct'});
        return call(ctx.resourceCaller??(()=>undefined),{kind:'propose',...input,wait:ctx});}},
    {name:'recipe_author_create',class:'resource',places:['p2p'],input:create,
      description:'作者在后续独立私聊消息中明确确认已展示的保存范围时，保存那个 proposalId 的私人草稿。saved 才代表已落盘，preparing 用 status 查回执。',
      run(args,ctx){return call(ctx.resourceCaller??(()=>undefined),{kind:'create',...create.parse(args),wait:ctx});}},
    {name:'recipe_author_status',class:'resource',places:['p2p'],input:z.object({}).strict(),
      description:'查本人的私聊创建、修改、保存或正式发布回执。询问刚才的配方保存好了吗、发出的版本时直接调用，不需要用户给草稿 ID。published 的 name、version 来自已完成的发布回执。新一轮确认提案按 nextTool/nextAction 使用 proposalId。',
      run(_args,ctx){return call(ctx.resourceCaller??(()=>undefined),{kind:'status',wait:ctx});}},
    {name:'recipe_author_draft',class:'resource',places:['p2p'],input:draft,
      description:'在本人私聊继续已保存的本地草稿。list 读取当前账号的本地草稿名称和编号，可传 offset 翻页；inspect 按原 draftId 读取本地名称和修订。改名用 edit、change.field=name，等待本地保存回执。inventory 盘点当前草稿及可选配置，propose 用 inventoryId、addIds、removeIds 展示增删范围。作者另发确认修改后，直接用 apply。可传 status 找回的 proposalId，也可省略以使用本轮唯一的已展示修改提案。preview/publish 请求当前版本的预览和正式确认卡；只有作者本人确认才正式发布。',
      run(args,ctx){const input=draft.parse(args);
        const invoke=(query:RecipeCreationQuery)=>call(ctx.resourceCaller??(()=>undefined),{...query,wait:ctx});
        const {action,draftId,change}=input;
        if(action==='propose'){
          const {inventoryId,addIds=[],removeIds=[]}=input;
          if(!inventoryId||!(addIds.length+removeIds.length))throw new Error('请传入本次草稿盘点编号和需要增减的实际项目。');
          return invoke({kind:'draft',action,draftId,inventoryId,addIds,removeIds});
        }
        if(action==='apply'){
          return invoke({kind:'draft',action,draftId,proposalId:input.proposalId});
        }
        if(action==='list')return invoke({kind:'draft',action,offset:input.offset});
        if(action==='inventory')return invoke({kind:'draft',action,draftId});
        if(change){if(action!=='edit')throw new Error('请为编辑动作指定修改。');recipePublicSchema.shape[change.field].parse(change.value);}
        return invoke({kind:'draft',action,draftId,change});}},

  ];
}
