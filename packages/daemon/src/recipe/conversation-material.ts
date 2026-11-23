import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {recipePublicSchema,recipeRichContentSchema,type RecipeRichContent} from '@vonvon/protocol';

const text=z.string().min(1).max(32768);
const settings=z.object({field:z.string().min(1).max(100),value:z.unknown()}).strict().superRefine((value,ctx)=>{
  if(!recipeRichContentSchema.shape.settings.element.safeParse({...identity(),...value}).success)ctx.addIssue({code:'custom',message:'可移植设置无效。'});
});
const task=z.object({name:z.string().min(1).max(40),instruction:z.object({kind:z.literal('inline'),value:text}).strict(),
  spec:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('once'),at:z.number().int().nonnegative()}),z.object({kind:z.literal('every'),minutes:z.number().int().positive()}),
    z.object({kind:z.literal('daily'),time:z.string()}),z.object({kind:z.literal('weekly'),days:z.array(z.number().int()),time:z.string()}),
    z.object({kind:z.literal('cron'),expr:z.string()}),
  ]),timeZone:z.union([z.object({kind:z.literal('targetChoice')}).strict(),z.object({kind:z.literal('recommended'),iana:z.string()}).strict()]),
  placement:z.enum(['follow','newTopic'])}).strict().superRefine((value,ctx)=>{
    if(!recipeRichContentSchema.shape.tasks.element.safeParse({...identity(),...value}).success)ctx.addIssue({code:'custom',message:'任务计划或时区无效。'});
  });
export const materialInputSchema=z.object({
  public:z.object({name:z.string().max(60),summary:z.string().max(240),overview:z.string().max(32768),version:z.string().max(40)}).strict().superRefine((value,ctx)=>{if(!recipePublicSchema.safeParse({...value,access:'direct'}).success)ctx.addIssue({code:'custom',message:'配方介绍无效。'});}),access:z.enum(['direct','coded']).default('direct'),
  role:text.optional(),settings:z.array(settings).max(32).default([]),tasks:z.array(task).max(32).default([]),rules:z.array(text).max(32).default([]),
  skills:z.array(z.object({name:z.string().min(1).max(80),body:text,
    references:z.array(z.object({name:z.string().min(1).max(240).refine(value=>recipeRichContentSchema.shape.files.element.shape.name.safeParse(value).success),text}).strict()).max(16).default([]),
  }).strict()).max(16).default([]),
}).strict().refine(v=>!!v.role||v.rules.length>0||v.skills.length>0||v.settings.length>0||v.tasks.length>0,'请提供实际角色、规则或技能内容。')
  .refine(v=>v.skills.every(skill=>new Set(['SKILL.md',...skill.references.map(ref=>ref.name)]).size===skill.references.length+1),'同一技能内的文件名不能重复。')
  .refine(v=>Buffer.byteLength(JSON.stringify(v))<=65536,'生成内容合计不能超过 64 KiB。');
export type MaterialInput=z.infer<typeof materialInputSchema>;
export type MaterialProposal={id:string;draftId:string;input:MaterialInput;content:RecipeRichContent;binding:string;order:number;
  threadId?:string;handoffId?:string;from:string;expiresAt:number;shownAt?:number;acceptedBy?:string;jobId?:string};
const identity=()=>({itemId:randomUUID(),originId:randomUUID()});
const inline=(value:string)=>({kind:'inline' as const,value});
export function materialContent(input:MaterialInput):RecipeRichContent {
  const files:RecipeRichContent['files']=[],skills:RecipeRichContent['skills']=[];
  for(const skill of input.skills){
    const entry={...identity(),name:'SKILL.md',use:'skillDescription' as const,text:inline(skill.body)};
    const refs=skill.references.map(ref=>({...identity(),name:ref.name,use:'reference' as const,text:inline(ref.text)}));
    files.push(entry,...refs);skills.push({...identity(),name:skill.name,entryFileId:entry.itemId,fileIds:[entry.itemId,...refs.map(f=>f.itemId)]});
  }
  return recipeRichContentSchema.parse({format:'rich-v2',schemaVersion:2,
    public:Object.fromEntries(Object.entries(input.public).map(([key,value])=>[key,{...identity(),value}])),
    ...(input.role&&{role:{...identity(),text:inline(input.role)}}),
    settings:input.settings.map(setting=>({...identity(),...setting})),rules:input.rules.map(value=>({...identity(),purpose:'work',text:inline(value)})),skills,files,tasks:input.tasks.map(task=>({...identity(),...task})),memories:[],setup:[],parts:[]});
}
export function materialReview(input:MaterialInput){
  return ['资料创作 · 保存范围','名称：'+input.public.name,'简介：'+input.public.summary,'版本：'+(input.public.version||'未指定'),
    '获取方式：'+(input.access==='coded'?'凭码获取':'直接获取'),'概览：\n'+input.public.overview,
    ...(input.role?['角色：\n'+input.role]:[]),...input.rules.map((rule,i)=>`规则 ${i+1}：\n${rule}`),
    ...input.skills.flatMap(skill=>['技能：'+skill.name,'SKILL.md：\n'+skill.body,...skill.references.map(ref=>ref.name+'：\n'+ref.text)]),
    ...input.settings.map(setting=>'设置建议：\n'+JSON.stringify(setting,null,2)),...input.tasks.map(task=>'任务：\n'+JSON.stringify(task,null,2)),
    '以上为实际保存内容；保存为私人草稿，不会修改任何群或正式发布。请在下一条消息回复“确认这个范围，保存草稿”。'].join('\n\n');
}
