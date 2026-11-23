import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import type {RecipeRichContent} from '@vonvon/protocol';
import {conversationSource} from '../src/recipe/authoring-rich-flow';
import {chooseScope,conversationInventory,inventoryPage,scopeReview} from '../src/recipe/conversation-inventory';

vi.mock('../src/recipe/authoring-rich-flow',()=>({conversationSource:vi.fn()}));

it('distinguishes a workspace skill from the same installed name through review and file selection',async()=>{
  const identity=()=>({itemId:randomUUID(),originId:randomUUID()});
  const entries=[0,1].map(()=>({...identity(),name:'SKILL.md',use:'skillDescription' as const,text:{kind:'inline' as const,value:'技能正文'}}));
  const skills=entries.map(file=>({...identity(),name:'feedback',entryFileId:file.itemId,fileIds:[file.itemId]}));
  const fields={name:'工作',summary:'',overview:'',version:'1'};
  const content:RecipeRichContent={format:'rich-v2',schemaVersion:2,
    public:{name:{...identity(),value:'工作'},summary:{...identity(),value:''},overview:{...identity(),value:''},version:{...identity(),value:'1'}},
    skills,files:entries,settings:[],rules:[],tasks:[],setup:[],parts:[],memories:[]};
  const evidence=new Map([...skills,...entries].map((item,index)=>[item.itemId,{kind:index%2?'managed':'native'}]));
  const catalog=[{name:'feedback',source:'workspace',enabled:true,path:'/test/.agents/skills/feedback/SKILL.md'},
    {name:'feedback',source:'workspace',enabled:true,path:'recipe:'+randomUUID()+':'+skills[1]!.itemId}];
  vi.mocked(conversationSource).mockResolvedValue({row:{name:'测试群'},catalog,unavailable:[],inventory:{content,evidence,lease:'source'}} as unknown as Awaited<ReturnType<typeof conversationSource>>);
  const inv=await conversationInventory({} as Parameters<typeof conversationInventory>[0],{scope:'scope',account:'account'},'oc_group');
  const page=inventoryPage(inv,'skills');
  expect(page.items.filter(i=>i.kind==='skill').map(i=>i.source)).toEqual(['groupWorkspace','installedRecipe']);
  expect(page.summary).toContain('feedback（群工作区）、feedback（已安装配方）');
  const review=chooseScope(inv,[skills[0]!.itemId],fields,'direct');
  expect(review.selected.sort()).toEqual([skills[0]!.itemId,entries[0]!.itemId].sort());
  expect(scopeReview(inv.groupName,review,'')).toContain('feedback（群工作区）');
  expect(scopeReview(inv.groupName,chooseScope(inv,[skills[1]!.itemId],fields,'direct'),'')).toContain('feedback（已安装配方）');
});
