import {describe,expect,it} from 'vitest';
import {CARD_DISPLAY_STOP_EID,CARD_DISPLAY_REMINDER_EID,defaultCardDisplay,allowedSlots,compileCardDisplay,DEFAULT_REMINDER_TEMPLATE,DEFAULT_REMINDER_REQUESTED_TEMPLATE} from '@vonvon/protocol';
import {buildRunCard,buildRunCardBase,ANSWER_EID,CONTROLS_EID} from '../src/card/run-card';
import {initialState,type RunState} from '../src/card/run-state';
import {deadRunCardElementIds} from '../src/bot/handle-message';

const nodes = (value:unknown):Record<string,any>[] => {
  const out:Record<string,any>[]=[];
  const visit=(item:unknown):void=>{if(Array.isArray(item))item.forEach(visit);else if(item&&typeof item==='object') {const node=item as Record<string,any>;if(node.tag)out.push(node);for(const child of Object.values(node))visit(child);}};
  visit(value);return out;
};
const actions=(value:unknown)=>nodes(value).filter(node=>node.tag==='button').map(node=>node.behaviors?.[0]?.value).filter(Boolean);
const running:RunState={...initialState,startedAt:0,usage:{used:371000,window:475000},footer:'streaming',blocks:[
  {kind:'reasoning',id:'r',content:'thinking content',streaming:false},
  {kind:'tool',tool:{id:'t',title:'rg --files',kind:'command',status:'done',output:'README.md'}},
  {kind:'text',id:'a',content:'answer content',streaming:true},
]};

describe('native card display compiler',()=>{
  it.each([
    ['actions-right','available'],['actions-right','requested'],
    ['top-right','available'],['top-right','requested'],
  ] as const)('uses valid unique Feishu element IDs with stop at %s and %s reminders across run phases',(stopSlot,completionReminder)=>{
    const config=defaultCardDisplay();
    config.blocks.find(block=>block.kind==='stop')!.slot=stopSlot;
    for(const rs of [initialState,running,{...running,terminal:'done' as const,completedAt:9000}]){
      const card=buildRunCard({rs,cardKey:'om_ids',completionReminder,cardDisplay:config,strictCardDisplay:true});
      const ids=nodes(card).filter(node=>'element_id' in node).map(node=>node.element_id);
      if(rs.terminal==='running')expect(ids).toContain(CARD_DISPLAY_REMINDER_EID);
      for(const id of ids)expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,19}$/);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('uses the same native parts and keeps the streamed answer and controls IDs',()=>{
    const config=defaultCardDisplay();
    const rc={rs:running,cardKey:'om_1',cardDisplay:config,strictCardDisplay:true,completionReminder:'available' as const};
    const base=buildRunCardBase(rc);
    expect(base.parts.processChildKinds).toEqual(['thinking','tool']);
    const card=buildRunCard(rc);
    expect(nodes(card).filter(node=>node.element_id===ANSWER_EID)).toHaveLength(1);
    expect(nodes(card).filter(node=>node.element_id===CONTROLS_EID)).toHaveLength(1);
    expect(actions(card)).toContainEqual({a:'run.stop',m:'om_1'});
    expect(actions(card)).toContainEqual({a:'run.remind',m:'om_1'});
    expect(JSON.stringify(card)).toContain('answer content');
    expect(nodes(card).some(node=>node.icon?.token==='edit_outlined')).toBe(true);
  });

  it('filters process kinds independently and preserves goal action',()=>{
    const config=defaultCardDisplay();
    config.blocks.find(block=>block.kind==='tools')!.mode='off';
    const card=buildRunCard({rs:running,cardKey:'om_2',cardDisplay:config,strictCardDisplay:true,goalControls:true});
    const raw=JSON.stringify(card);
    expect(raw).toContain('thinking content');
    expect(raw).not.toContain('rg --files');
    expect(actions(card)).toContainEqual({a:'goal.end',m:'om_2'});
    expect(actions(card)).toContainEqual({a:'run.stop',m:'om_2'});
  });

  it('hides streaming answer and stop for one-shot mode, then shows final answer',()=>{
    const config=defaultCardDisplay();
    config.reply={streamText:false,collapseAfterRun:true};
    config.blocks.find(block=>block.kind==='thinking')!.mode='off';
    config.blocks.find(block=>block.kind==='tools')!.mode='off';
    const live=buildRunCard({rs:running,cardKey:'om_3',cardDisplay:config,strictCardDisplay:true});
    expect(JSON.stringify(live)).not.toContain('answer content');
    expect(actions(live)).not.toContainEqual({a:'run.stop',m:'om_3'});
    const done=buildRunCard({rs:{...running,terminal:'done',completedAt:9000},cardKey:'om_3',cardDisplay:config,strictCardDisplay:true});
    expect(JSON.stringify(done)).toContain('answer content');
  });

  it('keeps terminal retry and error advice when customized',()=>{
    const config=defaultCardDisplay();
    const card=buildRunCard({rs:{...running,terminal:'idle_timeout',completedAt:9000,idleTimeoutSeconds:60},cardKey:'om_4',retry:'available',cardDisplay:config,strictCardDisplay:true});
    expect(actions(card)).toContainEqual({a:'run.retry',m:'om_4'});
    expect(JSON.stringify(card)).toContain('answer content');
  });

  it('renders a configured terminal model from real metadata even when legacy modelOnTerminal is false',()=>{
    const config=defaultCardDisplay();
    config.blocks.find(block=>block.kind==='model')!.mode='done';
    const card=buildRunCard({rs:{...running,terminal:'done',completedAt:9000},model:'gpt-6.1-sol',effort:'xhigh',modelOnTerminal:false,cardDisplay:config,strictCardDisplay:true});
    const raw=JSON.stringify(card);
    expect(raw).toContain('gpt-6.1-sol');
    expect(raw).toContain('极高');
    expect(raw).toContain("color='purple'");
  });

  it('moves the original stop callback without duplicating it and omits failed script widgets',()=>{
    const config=defaultCardDisplay();
    config.blocks.find(block=>block.kind==='stop')!.slot='top-right';
    config.blocks.push({...config.blocks[0]!,id:'script-1',kind:'custom',source:'script',slot:'bottom-left',template:'{{branch}}',sample:'{"branch":"demo"}'});
    const card=buildRunCard({rs:running,cardKey:'om_5',cardDisplay:config,strictCardDisplay:true});
    expect(actions(card).filter(value=>value?.a==='run.stop')).toEqual([{a:'run.stop',m:'om_5'}]);
    expect(JSON.stringify(card)).not.toContain('demo');
    expect(nodes(card).filter(node=>node.element_id===CONTROLS_EID)).toHaveLength(0);
    expect(nodes(card).filter(node=>node.element_id===CARD_DISPLAY_STOP_EID)).toHaveLength(1);
  });

  it('gives a moved stop its own orphan-healing ID while a reminder keeps controls',()=>{
    const config=defaultCardDisplay();
    config.blocks.find(block=>block.kind==='stop')!.slot='top-right';
    const card=buildRunCard({rs:running,cardKey:'om_7',completionReminder:'available',cardDisplay:config,strictCardDisplay:true});
    const stop=nodes(card).filter(node=>node.element_id===CARD_DISPLAY_STOP_EID);
    const controls=nodes(card).filter(node=>node.element_id===CONTROLS_EID);
    expect(stop).toHaveLength(1);
    expect(stop[0]?.behaviors?.[0]?.value).toEqual({a:'run.stop',m:'om_7'});
    expect(controls).toHaveLength(1);
    expect(actions(controls[0]).map(value=>value?.a)).toEqual(['run.remind']);
    expect(deadRunCardElementIds('run.stop')).toEqual([CONTROLS_EID,CARD_DISPLAY_STOP_EID,CARD_DISPLAY_REMINDER_EID]);
    expect(deadRunCardElementIds('goal.end')).toEqual([CONTROLS_EID,CARD_DISPLAY_STOP_EID,CARD_DISPLAY_REMINDER_EID]);
    expect(deadRunCardElementIds('run.retry')).toEqual([CONTROLS_EID]);
  });

  it('pins the stop to the far right of the native action row with and without other controls',()=>{
    const config=defaultCardDisplay();
    config.blocks.find(block=>block.kind==='stop')!.slot='actions-right';
    for (const extras of [{},{completionReminder:'available' as const},{goalControls:true}]) {
      const card=buildRunCard({rs:running,cardKey:'om_right',cardDisplay:config,strictCardDisplay:true,...extras});
      const controls=nodes(card).find(node=>node.element_id===CONTROLS_EID)!;
      const columns=controls.columns as Record<string,any>[];
      expect(controls.flex_mode).toBe('none');
      expect(columns.at(-2)).toMatchObject({tag:'column',width:'weighted',weight:1});
      expect(columns.at(-1)).toMatchObject({tag:'column',width:'auto'});
      expect(actions(columns.at(-1))).toEqual([{a:'run.stop',m:'om_right'}]);
      expect(actions(card).filter(value=>value?.a==='run.stop')).toHaveLength(1);
      if ('completionReminder' in extras) expect(actions(columns.slice(0,-2))).toContainEqual({a:'run.remind',m:'om_right'});
      if ('goalControls' in extras) expect(actions(columns.slice(0,-2))).toContainEqual({a:'goal.end',m:'om_right'});
    }
  });

  it('keeps the native stop control for a legacy draft without a stop block',()=>{
    const config=defaultCardDisplay();
    config.blocks=config.blocks.filter(block=>block.kind!=='stop');
    const card=buildRunCard({rs:running,cardKey:'om_6',cardDisplay:config,strictCardDisplay:true});
    expect(actions(card).filter(value=>value?.a==='run.stop')).toEqual([{a:'run.stop',m:'om_6'}]);
  });

  it('keeps a requested reminder in the same shape and slot with no repeated callback',()=>{
    const config=defaultCardDisplay();
    const reminder=config.blocks.find(block=>block.kind==='reminder')!;
    reminder.template='  📣 做完叫我  ';
    reminder.requestedTemplate='✅ 已订阅，完成后我会回来';
    for(const slot of allowedSlots(reminder)){
      reminder.slot=slot;
      const rc={rs:{...running,startedAt:undefined},cardKey:'om_remind',cardDisplay:config,strictCardDisplay:true};
      const available=buildRunCard({...rc,completionReminder:'available'});
      const control=nodes(available).find(node=>node.element_id===CARD_DISPLAY_REMINDER_EID)!;
      expect(control).toMatchObject({tag:'button',size:'medium',width:'default',text:{tag:'plain_text',content:'  📣 做完叫我  '}});
      expect(actions(available).filter(value=>value?.a==='run.remind')).toEqual([{a:'run.remind',m:'om_remind'}]);
      const requested=buildRunCard({...rc,completionReminder:'requested'});
      const confirmations=nodes(requested).filter(node=>node.element_id===CARD_DISPLAY_REMINDER_EID);
      expect(confirmations).toHaveLength(1);
      const confirmed=confirmations[0]!;
      expect(confirmed).toMatchObject({tag:'button',disabled:true,text:{tag:'plain_text',content:reminder.requestedTemplate},size:'medium',width:control.width,hover_tips:{tag:'plain_text',content:'本轮结束后会提醒发起人'}});
      expect(confirmed.behaviors).toBeUndefined();
      expect(actions(requested).some(value=>value?.a==='run.remind')).toBe(false);
      // Only the label and interaction metadata change. Slot, width, hierarchy
      // and surrounding controls stay identical even when the labels differ.
      delete confirmed.disabled;delete confirmed.hover_tips;
      confirmed.behaviors=control.behaviors;confirmed.text=control.text;
      expect(requested).toEqual(available);
    }
    expect(deadRunCardElementIds('run.remind')).toContain(CARD_DISPLAY_REMINDER_EID);
  });

  it('uses equal fixed native button sizes and keeps adjacent actions in separate columns',()=>{
    const config=defaultCardDisplay();
    for(const completionReminder of ['available','requested'] as const){
      const rc={rs:running,cardKey:'om_size',completionReminder};
      for(const card of [buildRunCardBase(rc).card,buildRunCard({...rc,cardDisplay:config,strictCardDisplay:true})]){
        const controls=nodes(card).find(node=>node.element_id===CONTROLS_EID)!;
        expect(controls.columns).toHaveLength(2);
        const buttons=nodes(controls).filter(node=>node.tag==='button');
        expect(buttons[0]).toMatchObject({size:'medium',width:'default'});
        expect(buttons[1]).toMatchObject({size:'medium',width:'default'});
      }
    }
  });

  it('never adds reminders without native availability and removes them during one-shot output',()=>{
    const config=defaultCardDisplay();
    for(const extras of [{},{goalControls:true},{rs:{...running,terminal:'done' as const,completedAt:9000}}]){
      const card=buildRunCard({rs:running,cardKey:'om_absent',cardDisplay:config,strictCardDisplay:true,...extras});
      expect(actions(card).some(value=>value?.a==='run.remind')).toBe(false);
      expect(JSON.stringify(card)).not.toContain(CARD_DISPLAY_REMINDER_EID);
    }
    for(const reminder of ['available','requested'] as const)for(const legacy of [false,true]){
      const draft=defaultCardDisplay();draft.reply!.streamText=false;
      if(legacy)draft.blocks=draft.blocks.filter(block=>block.kind!=='reminder');
      const card=buildRunCard({rs:running,cardKey:'om_oneshot',completionReminder:reminder,cardDisplay:draft,strictCardDisplay:true});
      expect(actions(card)).toEqual([]);
      expect(JSON.stringify(card)).not.toContain('本轮结束后会提醒发起人');
    }
  });

  it('keeps native reminder placement for older configs with no reminder block',()=>{
    const config=defaultCardDisplay();config.blocks=config.blocks.filter(block=>block.kind!=='reminder');
    const available=buildRunCard({rs:running,cardKey:'om_legacy',completionReminder:'available',cardDisplay:config,strictCardDisplay:true});
    const controls=nodes(available).find(node=>node.element_id===CONTROLS_EID)!;
    expect(actions(controls)).toContainEqual({a:'run.remind',m:'om_legacy'});
    const requested=buildRunCard({rs:running,cardKey:'om_legacy',completionReminder:'requested',cardDisplay:config,strictCardDisplay:true});
    const requestedControls=nodes(requested).find(node=>node.element_id===CONTROLS_EID)!;
    expect(nodes(requestedControls).filter(node=>node.tag==='button')).toMatchObject([
      {behaviors:[{value:{a:'run.stop'}}]},
      {element_id:CARD_DISPLAY_REMINDER_EID,disabled:true,text:{content:DEFAULT_REMINDER_REQUESTED_TEMPLATE}},
    ]);
    expect(actions(requested).some(value=>value?.a==='run.remind')).toBe(false);
  });

  it('upgrades a legacy requested-note fixture only to a disabled button',()=>{
    const config=defaultCardDisplay();
    const reminder=config.blocks.find(block=>block.kind==='reminder')!;
    reminder.slot='bottom-right';reminder.template='  📣 做完叫我  ';
    delete reminder.requestedTemplate;
    const base=buildRunCardBase({rs:running,cardKey:'om_old'});
    const elements=(base.card.body as any).elements;
    base.parts.reminderIndex=elements.length;
    elements.push({tag:'markdown',content:'_🔔 本轮结束后会提醒发起人_'});
    const card=compileCardDisplay(base.card,config,{phase:'running',parts:base.parts,values:base.values,strict:true});
    expect(nodes(card).filter(node=>node.element_id===CARD_DISPLAY_REMINDER_EID)).toMatchObject([
      {tag:'button',disabled:true,size:'medium',width:'default',text:{content:DEFAULT_REMINDER_REQUESTED_TEMPLATE}},
    ]);
    expect(actions(card).some(value=>value?.a==='run.remind')).toBe(false);
    expect(JSON.stringify(card)).not.toContain('_🔔 本轮结束后会提醒发起人_');
  });

  it('budgets enabled reasoning after filtering many disabled tool blocks',()=>{
    const config=defaultCardDisplay();
    config.blocks.find(block=>block.kind==='tools')!.mode='off';
    const blocks:RunState['blocks']=[...Array.from({length:50},(_,i)=>({kind:'tool' as const,tool:{id:`t${i}`,title:`cmd-${i}-${'x'.repeat(2000)}`,kind:'command' as const,status:'done' as const,output:'y'.repeat(2000)}})),{kind:'reasoning',id:'last',content:'KEEP_REASONING_SENTINEL',streaming:false}];
    const card=buildRunCard({rs:{...running,blocks},cardDisplay:config,strictCardDisplay:true});
    expect(JSON.stringify(card)).toContain('KEEP_REASONING_SENTINEL');
    expect(JSON.stringify(card)).not.toContain('cmd-49-');
  });

  it('keeps the native unknown-context placeholder before first usage arrives',()=>{
    const card=buildRunCard({rs:initialState,cardDisplay:defaultCardDisplay(),strictCardDisplay:true});
    expect(JSON.stringify(card)).toContain('上下文 —');
  });

  it('emits a native context bar row with label, track, and percentage',()=>{
    const config=defaultCardDisplay();
    config.blocks.find(block=>block.kind==='context')!.appearance='bar';
    const card=buildRunCard({rs:running,cardDisplay:config,strictCardDisplay:true});
    const row=nodes(card).find(node=>node.tag==='column_set' && node.columns?.length===3 && nodes(node).some(child=>child.tag==='chart'));
    expect(row).toBeDefined();
    const raw=JSON.stringify(row);
    expect(raw).toContain('上下文');
    expect(raw).toContain('78%');
    const chart=nodes(row).find(node=>node.tag==='chart');
    expect(chart).toMatchObject({height:'20px',preview:false,chart_spec:{direction:'horizontal',xField:'value',yField:'name',progress:{style:{fill:'#F2B50A'}}}});
  });

  it('falls back to the complete native card on a malformed runtime draft',()=>{
    const malformed={...defaultCardDisplay(),blocks:null} as unknown as ReturnType<typeof defaultCardDisplay>;
    const card=buildRunCard({rs:running,cardKey:'om_8',cardDisplay:malformed});
    expect(actions(card)).toContainEqual({a:'run.stop',m:'om_8'});
    expect(JSON.stringify(card)).toContain('answer content');
    expect(()=>buildRunCard({rs:running,cardKey:'om_8',cardDisplay:malformed,strictCardDisplay:true})).toThrow();
  });

  it('treats subagents as tool process in native, shared preview, and one-shot modes',()=>{
    const withSubagents:RunState={...running,subagents:[{id:'sa-1',name:'CHILD_SENTINEL',task:'inspect',status:'running',startedAt:0,stepCount:1,steps:[{stepId:'s',title:'step',status:'done'}],stoppable:true}]};
    const config=defaultCardDisplay();
    const rc={rs:withSubagents,cardKey:'om_sa',cardDisplay:config,strictCardDisplay:true};
    expect(buildRunCardBase(rc).parts.subagentIndices?.length).toBeGreaterThan(0);
    expect(JSON.stringify(buildRunCard(rc))).toContain('CHILD_SENTINEL');
    expect(JSON.stringify(buildRunCard({rs:withSubagents,cardKey:'om_sa',showTools:false}))).not.toContain('CHILD_SENTINEL');
    config.blocks.find(block=>block.kind==='tools')!.mode='off';
    expect(JSON.stringify(buildRunCard(rc))).not.toContain('CHILD_SENTINEL');
    const terminal={...withSubagents,terminal:'done' as const,completedAt:9000};
    expect(JSON.stringify(buildRunCard({...rc,rs:terminal}))).not.toContain('CHILD_SENTINEL');
    config.blocks.find(block=>block.kind==='tools')!.mode='always';
    config.reply={streamText:false,collapseAfterRun:true};
    expect(JSON.stringify(buildRunCard(rc))).not.toContain('CHILD_SENTINEL');
    const done=JSON.stringify(buildRunCard({...rc,rs:terminal}));
    expect(done).not.toContain('CHILD_SENTINEL');
    expect(done).toContain('answer content');
  });
});
