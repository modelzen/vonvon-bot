import {useEffect,useRef,useState} from 'react';
import {recipeInstallReplySchema,type AgentId,type GroupId,type RecipeInstallReply,type RecipeInstallRequest,type DesktopSnapshot} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {Button,InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {OPEN_SETTING_EVENT} from '../search';
import {RecipeMarkdown} from '../community/RecipeContent';

type Setup = Extract<RecipeInstallReply,{kind:'richSetup'}>;
export function RichSetupPanel({botId,groupId}:{botId:AgentId;groupId:GroupId}) {
  const client=useClient(); const [snapshot,setSnapshot]=useState<DesktopSnapshot>();
  useEffect(()=>client.watchSnapshots(setSnapshot),[client]);
  const [timeZone,setTimeZone]=useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [confirmTask,setConfirmTask]=useState<string>();
  const [read,setRead]=useState<Setup>();const [error,setError]=useState<string>();const [busy,setBusy]=useState(false);
  const epoch=useRef(0);
  async function request(action:Extract<RecipeInstallRequest,{type:'richSetup'}>['action']) {
    if(!client.recipeInstall) return;
    const current=epoch.current;setBusy(true);setError(undefined);
    try {const reply=recipeInstallReplySchema.parse(await client.recipeInstall({type:'richSetup',botId,groupId,action}));if(current!==epoch.current)return;if(reply.kind!=='richSetup'||reply.groupId!==groupId)throw new Error('使用设置目标已变化，请重新读取。');setRead(reply);setConfirmTask(undefined);
      if(reply.open){const membership=snapshot?.memberships.find(item=>item.agentId===botId&&item.groupId===groupId);if(!membership)throw new Error('群设置入口已变化，请重新打开目标群。');const section={model:'模型设置',modelAccess:'模型设置',permission:'权限',response:'回应谁',conversation:'聊天方式',run:'运行中来了消息',smartRules:'判断规则',presentation:'消息卡片',judge:'决策模型',speed:'模型设置'}[reply.open];window.dispatchEvent(new CustomEvent(OPEN_SETTING_EVENT,{detail:{page:'collaboration',view:'groups',selection:{kind:'membership',id:membership.id},detail:{kind:'membership-settings'},section}}));}
    }catch(e){if(current===epoch.current)setError(e instanceof Error?e.message:'使用设置读取未完成。');}finally{if(current===epoch.current)setBusy(false);}
  }
  useEffect(()=>{++epoch.current;void request({kind:'read'});return()=>{++epoch.current;};},[client,botId,groupId]);
  return <section className="recipe-source-setup"><h3>使用设置</h3>{error&&<InlineNotice title="使用设置尚未完成" tone="warning" actions={<Button disabled={busy} onClick={()=>void request({kind:'read'})}>重新读取</Button>}>{error}</InlineNotice>}{!read&&!error&&<p role="status">正在核对本群安装的准备项目…</p>}
    {read&&<>{!read.steps.length&&!read.tasks.length&&<p>无需额外准备。</p>}<ol className="community-setup">{read.steps.map(step=><li key={step.itemId}><div><strong>{step.title}</strong><span>{step.required?'必需':'可选'}</span></div><RecipeMarkdown text={step.instructions}/>{step.check&&<p>检查方式：{step.check}</p>}<p role="status">{{pending:'尚未核对',acknowledged:'本人已手动确认',observed:'已由当前设备核验'}[step.readiness]}</p><div className="community-actions">{step.action.kind==='nativeSettings'&&<Button disabled={busy} onClick={()=>void request({kind:'openSettings',stepId:step.itemId,token:read.token})}>前往设置</Button>}{step.action.kind==='nativeSettings'&&!step.check&&<Button disabled={busy} onClick={()=>void request({kind:'check',stepId:step.itemId,token:read.token})}>检查当前状态</Button>}<Button disabled={busy} onClick={()=>void request({kind:'acknowledge',stepId:step.itemId,token:read.token})}>我已手动核对</Button></div></li>)}</ol>{Boolean(read.tasks.length)&&<><h3>配方任务</h3><p>任务需单独确认后启用，准备步骤的手动确认不会启用任务。</p>{read.tasks.map(task=><div className="community-list-row" key={task.id}><strong>{task.name}</strong><span>{task.state}</span>{task.state!=='active'&&<Button disabled={busy} onClick={()=>setConfirmTask(task.id)}>核对并启用</Button>}</div>)}</>}</>}
    <Dialog open={Boolean(confirmTask)} title="确认启用本群任务" onClose={busy?undefined:()=>setConfirmTask(undefined)} footer={<><Button disabled={busy} onClick={()=>setConfirmTask(undefined)}>保留暂停</Button><Button variant="primary" disabled={busy||!timeZone.trim()||!read} onClick={()=>{if(read&&confirmTask)void request({kind:'enableTask',taskId:confirmTask,token:read.token,taskToken:read.tasks.find(task=>task.id===confirmTask)!.token,timeZone});}}>启用此任务</Button></>}>{read?.tasks.find(task=>task.id===confirmTask)&&<><h3>{read.tasks.find(task=>task.id===confirmTask)!.name}</h3><RecipeMarkdown text={read.tasks.find(task=>task.id===confirmTask)!.instruction}/><p>{read.tasks.find(task=>task.id===confirmTask)!.schedule} · {read.tasks.find(task=>task.id===confirmTask)!.placement==='follow'?'跟随当前会话':'新话题'}</p></>}<p>按这台设备上此 Bot 的管理员配置运行，仅作用于本群。任务指令、周期、权限或上下文改变后，需要重新确认。</p><label>执行时区<input aria-label="任务执行时区" value={timeZone} onChange={event=>setTimeZone(event.target.value)}/></label></Dialog>
  </section>;
}
