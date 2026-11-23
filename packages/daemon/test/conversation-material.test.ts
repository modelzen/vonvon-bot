import {z} from 'zod';
import {recipeCreationTools} from '../src/agent/entry/recipe-creation-tools';
import {expect,it} from 'vitest';
import {materialContent,materialInputSchema,materialReview} from '../src/recipe/conversation-material';

const publicFields={name:'资料周报',summary:'按教程整理',overview:'资料来源：作者提供的正文。',version:''};
it('builds portable complete skills with independent shared filenames and optional settings/tasks',()=>{
  const input=materialInputSchema.parse({public:publicFields,skills:[
    {name:'周报',body:'---\nname: weekly\ndescription: Weekly report\n---\nRead references/report.md',references:[{name:'references/report.md',text:'核对数据来源'}]},
    {name:'复盘',body:'---\nname: review\ndescription: Review\n---\nRead references/report.md',references:[{name:'references/report.md',text:'比较预期与实际'}]},
  ],settings:[{field:'presentation.voiceEnabled',value:true}],tasks:[{name:'周报',instruction:{kind:'inline',value:'整理本周进展'},
    spec:{kind:'weekly',days:[5],time:'17:00'},timeZone:{kind:'recommended',iana:'Asia/Shanghai'},placement:'newTopic'}]});
  const content=materialContent(input);
  expect(content.parts).toEqual([]);expect(content.files.map(file=>file.name)).toEqual(['SKILL.md','references/report.md','SKILL.md','references/report.md']);
  expect(new Set(content.files.map(file=>file.itemId)).size).toBe(4);
  expect(content.skills[0]!.fileIds).toEqual(content.files.slice(0,2).map(file=>file.itemId));
  expect(content.settings[0]).toMatchObject({field:'presentation.voiceEnabled',value:true});
  expect(content.tasks[0]).toMatchObject({spec:{kind:'weekly',days:[5],time:'17:00'}});
  const review=materialReview(input);for(const text of ['references/report.md','核对数据来源','比较预期与实际','presentation.voiceEnabled','17:00','Asia/Shanghai'])expect(review).toContain(text);
});
it('keeps omitted settings unspecified and rejects empty, nonportable or oversized material',()=>{
  const content=materialContent(materialInputSchema.parse({public:publicFields,role:'根据资料核实后回答'}));
  expect(content.settings).toEqual([]);expect(content.tasks).toEqual([]);
  expect(materialInputSchema.safeParse({public:publicFields}).success).toBe(false);
  expect(materialInputSchema.safeParse({public:publicFields,skills:[{name:'x',body:'x',references:[{name:'../secret',text:'x'}]}]}).success).toBe(false);
  expect(materialInputSchema.safeParse({public:publicFields,rules:['x'.repeat(32768),'x'.repeat(32768)]}).success).toBe(false);
});

it('advertises material tools to normal providers as JSON schemas',()=>{for(const tool of recipeCreationTools(async()=>({})))expect(()=>z.toJSONSchema(tool.input)).not.toThrow();});
