import {cardDisplayConfigSchema,type CardDisplayConfig} from '@vonvon/protocol';
import {buildRunCard,type RunCardState} from './run-card';
import {initialState,type RunState} from './run-state';
import {checkCardDisplayScriptSyntax} from './card-display-scripts';

/** Validate the generated structure, including stable native streaming anchors. */
export function assertCardDisplayRender(card:Record<string,unknown>):void {
  const body=card.body as {elements?:unknown[]} | undefined;
  if(card.schema!=='2.0'||!Array.isArray(body?.elements))throw new Error('卡片缺少有效的飞书 2.0 正文');
  const ids=new Set<string>();let count=0;
  const visit=(value:unknown):void=>{
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){value.forEach(visit);return;}
    const item=value as Record<string,unknown>;
    if(typeof item.tag==='string')count++;
    if('element_id' in item){
      if(typeof item.element_id!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(item.element_id))throw new Error('卡片组件 ID 格式无效：必须以字母开头，仅含字母、数字和下划线，且最多 20 字符');
      if(ids.has(item.element_id))throw new Error(`卡片组件 ID 重复：${item.element_id}`);
      ids.add(item.element_id);
    }
    if(Object.keys(item).some(key=>key.startsWith('__preview')||key.startsWith('__widget')))throw new Error('卡片含有预览专用字段');
    Object.values(item).forEach(visit);
  };
  visit(body.elements);
  if(count>200)throw new Error('卡片组件过多，请减少自定义组件或缩短模板');
  // Check the small, representative save-time sample, not a user's long answer.
  if(Buffer.byteLength(JSON.stringify(card))>28_000)throw new Error('卡片模板过大，请缩短自定义内容');
}

/** Lint before persistence. Scripts are parsed only; samples supply render data. */
export async function assertValidCardDisplay(input:unknown,signal?:AbortSignal):Promise<CardDisplayConfig> {
  if(signal?.aborted)throw new Error('脚本已取消');
  const parsed=cardDisplayConfigSchema.safeParse(input);
  if(!parsed.success)throw new Error(parsed.error.issues.map(issue=>`${issue.path.join('.')}：${issue.message}`).join('\n'));
  const config=parsed.data;
  const syntaxChecks=await Promise.allSettled(config.blocks.map(block=>checkCardDisplayScriptSyntax(block,signal)));
  const syntaxFailure=syntaxChecks.find((result):result is PromiseRejectedResult=>result.status==='rejected');
  if(syntaxFailure)throw syntaxFailure.reason;
  if(signal?.aborted)throw new Error('脚本已取消');
  const samples=Object.fromEntries(config.blocks.filter(block=>block.kind==='custom'&&block.source==='script').map(block=>[block.id,JSON.parse(block.sample) as Record<string,unknown>]));
  const phases:Array<{terminal:RunState['terminal'];footer:RunState['footer']}>= [
    {terminal:'running',footer:'thinking'},{terminal:'running',footer:'tool_running'},
    {terminal:'running',footer:'streaming'},{terminal:'running',footer:'retrying'},
    {terminal:'done',footer:null},{terminal:'error',footer:null},
    {terminal:'interrupted',footer:null},{terminal:'idle_timeout',footer:null},
  ];
  for(const phase of phases)for(const percent of [0,69,80,90,100]){
    if(signal?.aborted)throw new Error('脚本已取消');
    const rs:RunState={...initialState,...phase,startedAt:1_000,completedAt:10_000,
      usage:{used:percent*1_000,window:100_000},
      blocks:[{kind:'reasoning',id:'thought',content:'检查当前设置。',streaming:false},
        {kind:'tool',tool:{id:'tool',title:'检查配置',status:phase.terminal==='running'?'running':'done',kind:'command',output:'配置有效'}},
        {kind:'text',id:'reply',content:'已完成检查，保留真实的回复正文。',streaming:phase.terminal==='running'}],
      errorMsg:phase.terminal==='error'?'示例错误':undefined,idleTimeoutSeconds:60};
    const rc:RunCardState & {cardDisplay:CardDisplayConfig;cardDisplayValues:typeof samples;strictCardDisplay:true}={
      rs,model:'gpt-6.1-sol',effort:'high',cardKey:'card-display-check',
      completionReminder:'available',cardDisplay:config,cardDisplayValues:samples,strictCardDisplay:true,
    };
    assertCardDisplayRender(buildRunCard(rc));
    if (config.blocks.some(block=>block.kind==='reminder') && phase.terminal==='running') {
      assertCardDisplayRender(buildRunCard({...rc,completionReminder:'requested'}));
    }
  }
  return config;
}
