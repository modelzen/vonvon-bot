import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {buildRecipeBrowsePreview,recipeBrowsePreviewSchema,recipeBrowseDetailSchema,recipeSkillDescription} from '../src/recipe-browse';
import {recipeRichContentSchema} from '../src/recipe-rich';

it('projects only small display settings and skill frontmatter without role, rule, memory or file bodies',()=>{
  const content=recipeRichContentSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/recipe-rich-v2.content.json',import.meta.url),'utf8')));
  content.role!.text={kind:'inline',value:'ROLE_BODY_SECRET'};
  content.files=[{itemId:'90000000-0000-4000-8000-000000000001',originId:'90000000-0000-4000-8000-000000000002',name:'SKILL.md',use:'skillDescription',text:{kind:'inline',value:'---\nname: help\ndescription: A short explanation\n---\nSKILL_BODY_SECRET'}}];
  content.skills=[{itemId:'90000000-0000-4000-8000-000000000003',originId:'90000000-0000-4000-8000-000000000004',name:'help',entryFileId:content.files[0]!.itemId,fileIds:[content.files[0]!.itemId]}];
  const preview=buildRecipeBrowsePreview(content);
  expect(preview.skills[0]?.description).toBe('A short explanation');
  content.skills[0]!.name='help\nwith details';
  expect(buildRecipeBrowsePreview(content).skills[0]?.name).toBe('help with details');
  expect(JSON.stringify(preview)).not.toMatch(/ROLE_BODY_SECRET|SKILL_BODY_SECRET|objectId|memories|canonical|fileIds/);
  expect(recipeBrowsePreviewSchema.safeParse({...preview,canonical:'LEAK'}).success).toBe(false);
});
it('extracts bounded descriptions only from explicit frontmatter, including folded text',()=>{
  expect(recipeSkillDescription('# Intro\nThis is the entire private skill body')).toBe('');
  expect(recipeSkillDescription('---\ndescription: >\n  One line\n  another line\n---\nPRIVATE BODY')).toBe('One line another line');
  expect(recipeSkillDescription('---\ndescription: '+ 'x'.repeat(600)+'\n---\n')).toHaveLength(400);
});
it('browse detail refuses full source fields and exposes entitlement separately from preview availability',()=>{
  const detail={recipeId:'11111111-1111-4111-8111-111111111111',versionId:'22222222-2222-4222-8222-222222222222',revision:1,format:'rich-v2',public:{name:'Recipe',summary:'',overview:'',version:'1',access:'coded'},creator:{authorId:'33333333-3333-4333-8333-333333333333',displayName:'Author'},owned:false,acquired:true,state:'listed',hasDisplayLogo:false,previewUnavailable:true};
  expect(recipeBrowseDetailSchema.parse(detail).acquired).toBe(true);
  expect(recipeBrowseDetailSchema.safeParse({...detail,acquired:false}).success).toBe(false);
  expect(recipeBrowseDetailSchema.safeParse({...detail,preview:{settings:[],skills:[],ruleCount:0,taskCount:0}}).success).toBe(false);
  for(const field of ['canonical','rich','config','manifest','release'])expect(recipeBrowseDetailSchema.safeParse({...detail,[field]:{}}).success).toBe(false);
});
