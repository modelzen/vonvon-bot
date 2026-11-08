import {describe,expect,it} from 'vitest';
import {cardDisplayConfigSchema,defaultCardDisplayConfig,interpolate,allowedSlots,DEFAULT_REMINDER_REQUESTED_TEMPLATE} from '../src/card-display.js';
import {agentSectionSchemas,projectEditableSchemas} from '../src/settings.js';

describe('card display contract',()=>{
  it('uses a valid default and supports independent chat settings without a Bot card section',()=>{
    const config=defaultCardDisplayConfig();
    expect(cardDisplayConfigSchema.parse(config)).toEqual(config);
    expect(agentSectionSchemas).not.toHaveProperty('cards');
    expect(projectEditableSchemas.presentation.partial().strict().parse({cardDisplay:null})).toEqual({cardDisplay:null});
    expect(projectEditableSchemas.presentation.partial().strict().parse({cardDisplay:config}).cardDisplay).toEqual(config);
  });
  it('rejects unknown fields, duplicate components and incompatible slots before saving',()=>{
    const base=defaultCardDisplayConfig();
    expect(cardDisplayConfigSchema.safeParse({...base,unexpected:true}).success).toBe(false);
    expect(cardDisplayConfigSchema.safeParse({...base,blocks:[...base.blocks,base.blocks[0]]}).success).toBe(false);
    base.blocks[0]!.slot='actions-left';
    expect(cardDisplayConfigSchema.safeParse(base).success).toBe(false);
  });
  it('allows half-line progress and only-completed metadata but never terminal stop/status',()=>{
    const config=defaultCardDisplayConfig();
    Object.assign(config.blocks[0]!,{appearance:'bar',slot:'bottom-right',mode:'done'});
    expect(allowedSlots(config.blocks[0]!)).toContain('bottom-right');
    expect(cardDisplayConfigSchema.safeParse(config).success).toBe(true);
    config.blocks.find(b=>b.kind==='stop')!.mode='done';
    expect(cardDisplayConfigSchema.safeParse(config).success).toBe(false);
  });
  it('lets manual reminders change text and native slots without hiding or fabricating states',()=>{
    const config=defaultCardDisplayConfig();
    const reminder=config.blocks.find(block=>block.kind==='reminder')!;
    expect(reminder).toMatchObject({id:'reminder',mode:'running',appearance:'text',source:'builtin',template:'🔔 完成后提醒我',requestedTemplate:DEFAULT_REMINDER_REQUESTED_TEMPLATE});
    expect(allowedSlots(reminder)).toEqual(allowedSlots(config.blocks.find(block=>block.kind==='stop')!));
    reminder.slot='actions-right';reminder.template='📣 做完叫我';
    expect(cardDisplayConfigSchema.safeParse(config).success).toBe(true);
    for(const mode of ['off','done','always'] as const){reminder.mode=mode;expect(cardDisplayConfigSchema.safeParse(config).success).toBe(false);}
    reminder.mode='running';
    for(const template of ['','   ','a'.repeat(81),'{{status.label}}','第一行\n第二行']){reminder.template=template;expect(cardDisplayConfigSchema.safeParse(config).success).toBe(false);}
  });
  it('validates each manual reminder label while accepting older drafts without the confirmation label',()=>{
    const config=defaultCardDisplayConfig();
    const reminder=config.blocks.find(block=>block.kind==='reminder')!;
    reminder.requestedTemplate='✅ 已订阅，放心去忙';
    expect(cardDisplayConfigSchema.parse(config).blocks.find(block=>block.kind==='reminder')!.requestedTemplate).toBe(reminder.requestedTemplate);
    for(const label of ['','   ','a'.repeat(81),'{{status.label}}','{broken','第一行\n第二行']){
      reminder.requestedTemplate=label;
      expect(cardDisplayConfigSchema.safeParse(config).success).toBe(false);
    }
    delete reminder.requestedTemplate;
    expect(cardDisplayConfigSchema.safeParse(config).success).toBe(true);
    config.blocks[0]!.requestedTemplate='仅提醒组件允许';
    expect(cardDisplayConfigSchema.safeParse(config).success).toBe(false);
  });
  it('preserves intentional spaces in both reminder labels',()=>{
    const config=defaultCardDisplayConfig();
    const reminder=config.blocks.find(block=>block.kind==='reminder')!;
    reminder.template='  🔔 提醒我  ';reminder.requestedTemplate=' ✅ 已开启 ';
    const saved=cardDisplayConfigSchema.parse(config).blocks.find(block=>block.kind==='reminder')!;
    expect(saved.template).toBe('  🔔 提醒我  ');expect(saved.requestedTemplate).toBe(' ✅ 已开启 ');
  });
  it('requires real state labels and well-formed known template variables',()=>{
    for(const template of ['{{context.noSuchValue}}','{{context.percent','{{#if context.percent}}']){
      const config=defaultCardDisplayConfig();config.blocks[0]!.template=template;
      expect(cardDisplayConfigSchema.safeParse(config).success).toBe(false);
    }
    const config=defaultCardDisplayConfig();config.blocks.find(b=>b.kind==='status')!.template='已成功';
    expect(cardDisplayConfigSchema.safeParse(config).success).toBe(false);
  });
  it('allows red-only warnings independently from disabled thresholds',()=>{
    const config=defaultCardDisplayConfig();
    config.blocks[0]!.contextRules={yellowAt:70,orangeAt:85,redAt:80,showFrom:80,enabledColors:['red']};
    expect(cardDisplayConfigSchema.safeParse(config).success).toBe(true);
    config.blocks[0]!.contextRules!.enabledColors=['yellow','orange','red'];
    expect(cardDisplayConfigSchema.safeParse(config).success).toBe(false);
  });
  it('checks script sample variables and prevents prototype-path interpolation',()=>{
    const config=defaultCardDisplayConfig();
    const custom={...config.blocks[0]!,id:'custom-1',kind:'custom' as const,slot:'bottom-left' as const,source:'script' as const,script:'console.log(JSON.stringify({branch:"dev"}))',template:'{{branch}}',sample:'{"branch":"dev"}',contextRules:undefined};
    config.blocks.push(custom);
    expect(cardDisplayConfigSchema.safeParse(config).success).toBe(true);
    custom.template='{{cost}}';expect(cardDisplayConfigSchema.safeParse(config).success).toBe(false);
    custom.template='{{branch}}';custom.sample='{"__proto__":{"branch":"dev"}}';
    expect(cardDisplayConfigSchema.safeParse(config).success).toBe(false);
    expect(interpolate('{{constructor.name}}',{})).toEqual({text:'—',missing:['constructor.name']});
  });
  it('caps config resources and rejects stale recovery ids',()=>{
    const config=defaultCardDisplayConfig();config.reply!.flowModes={missing:'running'};
    expect(cardDisplayConfigSchema.safeParse(config).success).toBe(false);
    delete config.reply!.flowModes;config.blocks[0]!.template='x'.repeat(2001);
    expect(cardDisplayConfigSchema.safeParse(config).success).toBe(false);
  });
  it('never uses example-only fields for a builtin custom widget',()=>{
    const config=defaultCardDisplayConfig();
    const custom={...config.blocks[1]!,id:'custom',kind:'custom' as const,slot:'bottom-left' as const,source:'builtin' as const,template:'{{branch}}',sample:'{"branch":"dev"}'};
    config.blocks.push(custom);
    expect(cardDisplayConfigSchema.safeParse(config).success).toBe(false);
    custom.template='{{context.percent}}%';
    expect(cardDisplayConfigSchema.safeParse(config).success).toBe(true);
  });
});
