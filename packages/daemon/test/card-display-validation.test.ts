import {expect,it} from 'vitest';
import {defaultCardDisplay} from '@vonvon/protocol';
import {assertCardDisplayRender,assertValidCardDisplay} from '../src/card/card-display-validation';

it('checks the default configuration across native running and terminal render states',async()=>{
  const config=defaultCardDisplay();
  expect(await assertValidCardDisplay(config)).toEqual(config);
});
it('checks custom reminder labels in both clickable and confirmed states before saving',async()=>{
  const config=defaultCardDisplay();
  const reminder=config.blocks.find(block=>block.kind==='reminder')!;
  reminder.template='📣 做完叫我';reminder.requestedTemplate='✅ 收到，完成后会通知你';
  expect(await assertValidCardDisplay(config)).toEqual(config);
  reminder.requestedTemplate='{{unknown}}';
  await expect(assertValidCardDisplay(config)).rejects.toThrow('requestedTemplate');
});
it('rejects syntax errors and missing variables before persistence',async()=>{
  const config=defaultCardDisplay();
  config.blocks.push({...config.blocks[0]!,id:'branch',kind:'custom',name:'Git',source:'script',script:'const = ;',sample:'{"branch":"dev"}',template:'{{branch}}',contextRules:undefined});
  await expect(assertValidCardDisplay(config)).rejects.toThrow('脚本检查未通过');
  config.blocks.at(-1)!.script='console.log("{}")';config.blocks.at(-1)!.template='{{not_declared}}';
  await expect(assertValidCardDisplay(config)).rejects.toThrow('not_declared');
  config.blocks.at(-1)!.template='{{branch}}';config.blocks.at(-1)!.sample='{"branch":null}';
  await expect(assertValidCardDisplay(config)).rejects.toThrow('缺少模板字段');
});
it('rejects duplicate native IDs and oversized generated structures',()=>{
  expect(()=>assertCardDisplayRender({schema:'2.0',body:{elements:[{tag:'markdown',element_id:'answer'},{tag:'markdown',element_id:'answer'}]}})).toThrow('重复');
  expect(()=>assertCardDisplayRender({schema:'2.0',body:{elements:Array.from({length:201},()=>({tag:'markdown',content:'x'}))}})).toThrow('过多');
});

it.each(['display-reminder', '1answer', '', 'a'.repeat(21), 42])(
  'rejects invalid CardKit element ID %j before persistence',
  (elementId) => {
    expect(() => assertCardDisplayRender({
      schema:'2.0',
      body:{elements:[{tag:'markdown', element_id:elementId}]},
    })).toThrow('卡片组件 ID 格式无效');
  },
);
