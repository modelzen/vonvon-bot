import {describe,expect,it} from 'vitest';
import {completionTemplateSchema,DEFAULT_COMPLETION_TEMPLATE,renderCompletionTemplate} from '../src/completion-template';

const values={task:'整理资料',elapsed:'12 秒',status:'已完成',icon:'✅',durationLabel:'用时',detail:'结果在上方卡片。'};
describe('plain-text completion reminder template',()=>{
  it('renders the original two-line copy from real named values',()=>{
    expect(renderCompletionTemplate(null,values)).toBe('✅「整理资料」已完成 · 用时 12 秒\n结果在上方卡片。');
    expect(renderCompletionTemplate(undefined,values)).toBe(renderCompletionTemplate(DEFAULT_COMPLETION_TEMPLATE,values));
  });
  it.each(['','   ','x'.repeat(501),'{{unknown}}','{{task}','{task}}','{{ task }} {{','{{}}'])('rejects invalid template %s',template=>{
    expect(completionTemplateSchema.safeParse(template).success).toBe(false);
  });
  it('allows a compact custom layout and line breaks',()=>{
    expect(renderCompletionTemplate('{{icon}} {{task}}：{{status}}\n{{elapsed}}｜{{detail}}',values)).toBe('✅ 整理资料：已完成\n12 秒｜结果在上方卡片。');
  });
  it('allows editable Chinese copy and an outcome-prefixed icon variable',()=>{
    expect(renderCompletionTemplate('{{statusIcon}} {{task}}\n花了 {{elapsed}}，成果请看上面的消息。',values)).toBe('✅ 整理资料\n花了 12 秒，成果请看上面的消息。');
    expect(renderCompletionTemplate(null,{...values,icon:'⏱',status:'响应超时',durationLabel:'等待',detail:'详情在上方卡片。'})).toBe('⏱「整理资料」响应超时 · 等待 12 秒\n详情在上方卡片。');
  });
});
