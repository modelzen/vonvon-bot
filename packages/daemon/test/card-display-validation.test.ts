import {expect,it} from 'vitest';
import {defaultCardDisplay} from '@vonvon/protocol';
import {assertCardDisplayRender,assertValidCardDisplay} from '../src/card/card-display-validation';

it('checks the default configuration across native running and terminal render states',async()=>{
  const config=defaultCardDisplay();
  expect(await assertValidCardDisplay(config)).toEqual(config);
});
it('rejects syntax errors and missing variables before persistence',async()=>{
  const config=defaultCardDisplay();
  config.blocks.push({...config.blocks[0]!,id:'branch',kind:'custom',name:'Git',source:'script',script:'const = ;',sample:'{"branch":"dev"}',template:'{{branch}}',contextRules:undefined});
  await expect(assertValidCardDisplay(config)).rejects.toThrow('脚本检查未通过');
  config.blocks.at(-1)!.script='console.log("{}")';config.blocks.at(-1)!.template='{{not_declared}}';
  await expect(assertValidCardDisplay(config)).rejects.toThrow('not_declared');
});
it('rejects duplicate native IDs and oversized generated structures',()=>{
  expect(()=>assertCardDisplayRender({schema:'2.0',body:{elements:[{tag:'markdown',element_id:'answer'},{tag:'markdown',element_id:'answer'}]}})).toThrow('重复');
  expect(()=>assertCardDisplayRender({schema:'2.0',body:{elements:Array.from({length:201},()=>({tag:'markdown',content:'x'}))}})).toThrow('过多');
});
