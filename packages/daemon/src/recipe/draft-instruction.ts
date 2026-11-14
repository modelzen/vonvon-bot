import { z } from 'zod';
import { freezePayload, blankPublic } from './authoring-payload';
import type { AuthoringChange } from '@vonvon/protocol';

import {safeDraftModelText} from '../../../../services/recipe-api/src/draft-model-text.mjs';

export function checkModelText(text: string) {
  if (!safeDraftModelText(text)) throw new Error('请在 App 编辑。');
  freezePayload({public:blankPublic(), config:{role:text}});
}

const fields = ['name', 'summary', 'overview', 'version'] as const;
export type PublicField = typeof fields[number];
export const fieldLabels: Record<PublicField,string> = {name:'名称',summary:'简介',overview:'概览',version:'版本'};
export interface CandidateCardDetails {revision: number; fields: string[]}
export interface DraftField { field: PublicField; value: string }
export interface DraftFieldRequest {
  accountId: string; scope: string; draftId: string; baseRevision: number; field: PublicField;
}
export type ReadDraftField = (request: DraftFieldRequest) => Promise<(DraftField & {draftId: string; revision: number}) | undefined>;

export class DraftProviderBusy extends Error {}
export interface DraftInstructionParser {
  propose(input: {instruction: string; current?: DraftField}, signal: AbortSignal): Promise<unknown>;
}
export type DraftInterpretation = {kind:'proposal'; changes:AuthoringChange[]} | {kind:'clarify' | 'refuse' | 'unavailable'};
const delta = z.object({
  field:z.enum(fields), action:z.enum(['set','replace']), before:z.string().max(2000), value:z.string().max(2000),
}).strict();
export const draftModelAnswer = z.object({
  kind:z.enum(['proposal','clarify','refuse']), changes:z.array(delta).max(4),
}).strict();
export const modelAnswerFormat = {
  type:'json_schema', name:'draft_instruction', strict:true,
  schema:{type:'object', additionalProperties:false, required:['kind','changes'], properties:{
    kind:{type:'string',enum:['proposal','clarify','refuse']},
    changes:{type:'array',items:{type:'object',additionalProperties:false,required:['field','action','before','value'],
      properties:{field:{type:'string',enum:fields},action:{type:'string',enum:['set','replace']},before:{type:'string'},value:{type:'string'}}}},
  }},
};

const create = /(?:做成|生成|新建|创建|制作|做|建|转成|导出|提取).{0,24}(?:配方|草稿)|(?:配方|草稿).{0,12}(?:新建|创建)|(?:make|turn|create|start|build|draft|extract)\b.{0,100}\b(?:recipe|draft)\b/isu;
const subject = /配方|草稿|\b(?:recipe|draft)\b/iu;
export function draftIntent(text: string): 'create' | 'draft' | undefined {
  if (create.test(text)) return 'create';
  if (subject.test(text) && /(?:改|调|编|修|开|存|继|选|加|删|发布|结束|换|设置|取消|运行|启用|执行|取|提|写|变|保存|编辑|\b(?:edit|update|open|change|resume|publish|run|modify|save|rename|add|remove|delete|set|rewrite)\b)/iu.test(text)) return 'draft';
  return;
}

const fieldNames: Record<PublicField,RegExp> = {
  name:/名称|名字|标题|\b(?:name|title)\b/i, summary:/简介|摘要|\bsummary\b/i,
  overview:/概览|概述|\boverview\b/i, version:/版本|\bversion\b/i,
};
export const relativeEdit = (s: string) => /(?:中的|里面的|里的|内的|追加|附加|前面加|后面加|删掉|去掉|替换|缩短|精简|保留其余|\b(?:replace|append|prepend|shorten|within|inside|remove from)\b)/iu.test(s);
export function requestedField(text: string): PublicField | undefined {
  const matches = fields.filter(field => fieldNames[field].test(text));
  return matches.length === 1 ? matches[0] : undefined;
}

export function interpretDraftAnswer(raw: unknown, input: {instruction: string; current?: DraftField}): DraftInterpretation {
  const answer = draftModelAnswer.parse(raw);
  if (answer.kind !== 'proposal') {
    if (answer.changes.length) throw new Error('Invalid parser response');
    return {kind:answer.kind};
  }
  if (!answer.changes.length) throw new Error('Empty proposal');
  const changes: AuthoringChange[] = [];
  const touched = new Set<PublicField>();
  for (const change of answer.changes) {
    const {field,action,before,value} = change;
    if (touched.has(field)) throw new Error('Duplicate field');
    touched.add(field);
    if (!fieldNames[field].test(input.instruction) || value && !input.instruction.includes(value)) return {kind:'clarify'};
    let next = value;
    if (action === 'replace') {
      const current = input.current;
      if (!before || !input.instruction.includes(before) || current?.field !== field ||
          current.value.split(before).length !== 2) return {kind:'clarify'};
      next = current.value.replace(before, () => value);
    } else if (before || !value || relativeEdit(input.instruction) && requestedField(input.instruction) === field) {
      return {kind:'clarify'};
    }
    changes.push({op:'setPublicText',field,value:next});
  }
  return {kind:'proposal',changes};
}
