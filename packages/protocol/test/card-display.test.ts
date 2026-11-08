import {describe,expect,it} from 'vitest';
import {cardDisplayConfigSchema,defaultCardDisplayConfig,interpolate,allowedSlots} from '../src/card-display.js';
import {agentSectionSchemas,projectEditableSchemas} from '../src/settings.js';

describe('card display contract',()=>{
  it('uses a valid default and supports clearing overrides through either settings route',()=>{
    const config=defaultCardDisplayConfig();
    expect(cardDisplayConfigSchema.parse(config)).toEqual(config);
    expect(agentSectionSchemas.cards.partial().strict().parse({cardDisplay:null})).toEqual({cardDisplay:null});
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
