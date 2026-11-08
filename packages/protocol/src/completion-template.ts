import {z} from 'zod';

export const DEFAULT_COMPLETION_TEMPLATE = '{{statusIcon}}「{{task}}」{{status}} · 用时 {{elapsed}}\n结果在上方卡片。';
// Keep the original names valid for already-saved templates and CLI clients.
export const completionTemplateVariables = ['task','elapsed','status','statusIcon','icon','durationLabel','detail'] as const;
export type CompletionTemplateVariable = typeof completionTemplateVariables[number];
export type CompletionTemplateValues = Record<Exclude<CompletionTemplateVariable,'statusIcon'>,string>;
const allowed = new Set<string>(completionTemplateVariables);
const placeholder = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Plain-text post template. Only named substitutions and line breaks are accepted. */
export const completionTemplateSchema = z.string().min(1,'提醒内容不能为空').max(500,'提醒内容最多 500 字').superRefine((template,ctx)=>{
  if (!template.trim()) {ctx.addIssue({code:z.ZodIssueCode.custom,message:'提醒内容不能为空'});return;}
  const names=[...template.matchAll(placeholder)].map(match=>match[1]!);
  for (const name of names) if (!allowed.has(name)) ctx.addIssue({code:z.ZodIssueCode.custom,message:`未知提醒变量：${name || '空变量'}`});
  const residue=template.replace(placeholder,'');
  if (residue.includes('{') || residue.includes('}')) ctx.addIssue({code:z.ZodIssueCode.custom,message:'提醒变量格式不完整'});
});

/** Expose editable copy while retaining the original outcome-specific defaults. */
export function defaultCompletionTemplate(values:Pick<CompletionTemplateValues,'durationLabel'|'detail'>):string {
  return DEFAULT_COMPLETION_TEMPLATE.replace('用时',()=>values.durationLabel).replace('结果在上方卡片。',()=>values.detail);
}

export function renderCompletionTemplate(template:string|null|undefined, values:CompletionTemplateValues):string {
  const valid=completionTemplateSchema.parse(template ?? defaultCompletionTemplate(values));
  return valid.replace(placeholder,(_match,name:string)=>name==='statusIcon' ? values.icon : values[name as keyof CompletionTemplateValues]);
}
