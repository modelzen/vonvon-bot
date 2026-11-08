import {describe,expect,it} from 'vitest';
import {CARD_DISPLAY_STOP_EID,defaultCardDisplay} from '@vonvon/protocol';
import {buildRunCard,buildRunCardBase,ANSWER_EID,CONTROLS_EID} from '../src/card/run-card';
import {initialState,type RunState} from '../src/card/run-state';
import {deadRunCardElementIds} from '../src/bot/handle-message';

const nodes = (value:unknown):Record<string,any>[] => {
  const out:Record<string,any>[]=[];
  const visit=(item:unknown):void=>{if(Array.isArray(item))item.forEach(visit);else if(item&&typeof item==='object') {const node=item as Record<string,any>;if(node.tag)out.push(node);for(const child of Object.values(node))visit(child);}};
  visit(value);return out;
};
const actions=(value:unknown)=>nodes(value).filter(node=>node.tag==='button').map(node=>node.behaviors?.[0]?.value);
const running:RunState={...initialState,startedAt:0,usage:{used:371000,window:475000},footer:'streaming',blocks:[
  {kind:'reasoning',id:'r',content:'thinking content',streaming:false},
  {kind:'tool',tool:{id:'t',title:'rg --files',kind:'command',status:'done',output:'README.md'}},
  {kind:'text',id:'a',content:'answer content',streaming:true},
]};

describe('native card display compiler',()=>{
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
    expect(deadRunCardElementIds('run.stop')).toEqual([CONTROLS_EID,CARD_DISPLAY_STOP_EID]);
    expect(deadRunCardElementIds('goal.end')).toEqual([CONTROLS_EID,CARD_DISPLAY_STOP_EID]);
    expect(deadRunCardElementIds('run.retry')).toEqual([CONTROLS_EID]);
  });

  it('keeps the native stop control for a legacy draft without a stop block',()=>{
    const config=defaultCardDisplay();
    config.blocks=config.blocks.filter(block=>block.kind!=='stop');
    const card=buildRunCard({rs:running,cardKey:'om_6',cardDisplay:config,strictCardDisplay:true});
    expect(actions(card).filter(value=>value?.a==='run.stop')).toEqual([{a:'run.stop',m:'om_6'}]);
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

  it('falls back to the complete native card on a malformed runtime draft',()=>{
    const malformed={...defaultCardDisplay(),blocks:null} as unknown as ReturnType<typeof defaultCardDisplay>;
    const card=buildRunCard({rs:running,cardKey:'om_8',cardDisplay:malformed});
    expect(actions(card)).toContainEqual({a:'run.stop',m:'om_8'});
    expect(JSON.stringify(card)).toContain('answer content');
    expect(()=>buildRunCard({rs:running,cardKey:'om_8',cardDisplay:malformed,strictCardDisplay:true})).toThrow();
  });
});
