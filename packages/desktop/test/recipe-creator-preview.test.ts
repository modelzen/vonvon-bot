import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {recipeRichContentSchema,type RecipeRichContent} from '@vonvon/protocol';
import {richCreatorPreview,legacyCreatorPreview} from '../src/recipe-creator-preview.js';

const identity=()=>({itemId:randomUUID(),originId:randomUUID()});
const publicText=(value:string)=>({...identity(),value});
const base=()=>({format:'rich-v2',schemaVersion:2,public:{name:publicText('研究助手'),summary:publicText(''),overview:publicText(''),version:publicText('1.0')},
  settings:[],rules:[],skills:[],files:[],tasks:[],memories:[],setup:[],parts:[]});

it('shows every setting and nested functional value while preserving literal model and provider names',()=>{
  const settings:Array<{field:string;value:unknown}>=[
    {field:'sessionMode',value:'smart'},
    {field:'response.noMention',value:false},
    {field:'run.pendingPolicy',value:'steer'},
    {field:'presentation.voiceEnabled',value:true},
    {field:'presentation.showToolCalls',value:false},
    {field:'presentation.showModel',value:'running'},
    {field:'presentation.completionMode',value:'long'},
    {field:'presentation.longTaskMinutes',value:19},
    {field:'presentation.completionTemplate',value:null},
    {field:'presentation.cardDisplay',value:{version:1,blocks:[{...identity(),id:'opaque-block-id',kind:'context',name:'用量提醒',
      slot:'top',mode:'always',appearance:'percent',template:'status: {{status.label}}',
      size:'notation',color:'blue',warning:true,warningAt:88,contextRules:{yellowAt:51,orangeAt:62,redAt:73,showFrom:14,enabledColors:['yellow','red']}},
      {...identity(),id:'opaque-reminder-id',kind:'reminder',name:'完成提醒',slot:'actions-left',mode:'running',appearance:'text',
        template:'完成后提醒',requestedTemplate:'requested-template',size:'normal',color:'auto',warning:false,warningAt:80}],
      reply:{streamText:true,collapseAfterRun:false}}},
    {field:'model.recommendation',value:{backend:'default',selection:{kind:'explicit',model:'model',effort:'high',custom:true}}},
    {field:'modelAccess.recommendation',value:{backend:'provider',models:['default','model'],efforts:['standard','fast'],
      modelEfforts:{default:['standard'],model:['fast']},modelServiceTiers:{default:['fast'],model:['ultrafast']},defaultModel:'default',defaultEffort:'standard'}},
    {field:'speed.recommendation',value:{tier:'ultrafast'}},
    {field:'judge.recommendation',value:{kind:'default'}},
    {field:'permission.requirement',value:{mode:'write'}},
    {field:'permission.codex.requirement',value:{sandbox:'workspace-write',network:false}},
    {field:'permission.claude.requirement',value:{permissionMode:'acceptEdits',sandbox:true,network:'all'}},
  ];
  const content=recipeRichContentSchema.parse({...base(),settings:settings.map(setting=>({...identity(),...setting}))});
  const text=richCreatorPreview(content,{}).find(section=>section.title==='配置')!.text;
  for(const expected of ['会话模式\n智能会话','无需提及 Bot\n关闭','引导当前执行','语音回复\n开启','展示工具调用\n关闭',
    '模型标记\n运行时展示','完成通知\n仅长任务','长任务分钟数\n19','完成通知模板\n未指定','配置版本：1','用量提醒',
    '操作区左侧','始终','百分比','status: {{status.label}}','requested-template','小字','蓝色','阈值提醒：开启','提醒阈值：88',
    '黄色阈值：51','橙色阈值：62','红色阈值：73','开始显示阈值：14','启用颜色：黄色、红色','流式回复：开启','完成后折叠：关闭',
    '执行工具：default','模型：model','思考强度：high','自定义：开启','执行工具：provider','可用模型：default、model',
    '可用思考强度：standard、fast','default：standard','model：fast','default：快速','model：极速','默认模型：default',
    '默认思考强度：standard','速度：极速','判断模型建议\n类型：默认','允许写入','工作区可写','网络访问：关闭','自动接受编辑','文件访问范围：开启','网络访问：全部'])expect(text).toContain(expected);
  expect(text).not.toContain('opaque-block-id');
  for(const item of content.settings){expect(text).not.toContain(item.itemId);expect(text).not.toContain(item.originId);}
});

it.each<RecipeRichContent['tasks'][number]['spec']>([
  {kind:'once',at:1794787200000},{kind:'every',minutes:37},{kind:'daily',time:'08:12'},
  {kind:'weekly',days:[0,2,6],time:'17:29'},{kind:'cron',expr:'15 9 * * 1-5'},
])('keeps task timing and instructions visible for $kind tasks',spec=>{
  const instruction='保留字面内容 itemId、objectId、sha256、default，不要自动发送。';
  const content=recipeRichContentSchema.parse({...base(),tasks:[{...identity(),name:'任务核对',instruction:{kind:'inline',value:instruction},
    spec,timeZone:{kind:'targetChoice'},placement:'follow'}]});
  const text=richCreatorPreview(content,{}).find(section=>section.title==='任务')!.text;
  expect(text).toContain(instruction);
  expect(text).toContain('安装时选择时区');
  expect(text).toContain('跟随当前会话');
  expect(text).toContain('安装后暂停');
  if(spec.kind==='once')expect(text).toContain(String(spec.at));
  if(spec.kind==='every')expect(text).toContain('每 37 分钟');
  if(spec.kind==='daily')expect(text).toContain('每天 08:12');
  if(spec.kind==='weekly')expect(text).toContain('每周日、二、六 17:29');
  if(spec.kind==='cron')expect(text).toContain(spec.expr);
});

it('treats legacy setup as readable supplementary instructions and keeps role text exact',()=>{
  const role='  角色原文\n\n原样保留。\n';
  const sections=legacyCreatorPreview({role,setup:{steps:[{kind:'tool',title:'可选工具',instructions:'仅在需要时使用。',required:false,check:'查看帮助'}]}});
  expect(sections[0]).toEqual({title:'角色',text:role});
  expect(sections[1]!.title).toBe('补充说明');
  for(const text of ['工具','可选工具','仅在需要时使用。','必需：关闭','查看帮助'])expect(sections[1]!.text).toContain(text);
});

it('keeps a hosted provider name literal and shows native settings guidance without a setup workflow',()=>{
  const content=recipeRichContentSchema.parse({...base(),settings:[{...identity(),field:'judge.recommendation',value:{kind:'decision',provider:'custom',model:'default'}}],
    setup:[{...identity(),kind:'config',title:'权限说明',instructions:'按实际任务调整。',required:true,action:{kind:'nativeSettings',entry:'permission'}}]});
  const sections=richCreatorPreview(content,{});
  expect(sections.find(section=>section.title==='配置')!.text).toContain('判断服务：custom\n模型：default');
  const text=sections.find(section=>section.title==='补充说明')!.text;
  for(const expected of ['权限说明','按实际任务调整。','必需：开启','打开设置','设置入口：权限'])expect(text).toContain(expected);
  expect(text).not.toContain('准备步骤');
});
