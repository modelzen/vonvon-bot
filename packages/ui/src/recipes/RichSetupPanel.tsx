import {useEffect,useRef,useState} from 'react';
import {type AgentId,type GroupId,type RecipeInstallReply,type RecipeInstallRequest} from '@vonvon/protocol';
import {useClient,useShellCapabilities,useActiveDevice} from '../client-context';
import {Button,InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {RecipeMarkdown} from '../community/RecipeContent';
import {knownZone} from '../schedule-model';
import {localInput} from '../ScheduleForm';

type Setup = Extract<RecipeInstallReply,{kind:'richSetup'}>;
export function RichSetupPanel({botId,groupId,sourceToken}:{botId:AgentId;groupId:GroupId;sourceToken:string}) {
  const shell=useShellCapabilities()?.recipeSource;const device=useActiveDevice();
  const client=useClient();
  const scope=JSON.stringify([device.id,botId,groupId,sourceToken]);
  const [selection,setSelection]=useState<{scope:string;read:Setup;task:Setup['tasks'][number];timeZone:string}>();
  const [read,setRead]=useState<Setup>();const [error,setError]=useState<string>();const [busy,setBusy]=useState(false);
  const epoch=useRef(0);
  const selected=selection?.scope===scope&&selection.read===read?selection:undefined;
  const timeZone=selected?.timeZone.trim()??'';
  const validZone=knownZone(timeZone);
  async function request(action:Extract<RecipeInstallRequest,{type:'richSetup'}>['action']) {
    if(!shell) return;
    const current=epoch.current;setBusy(true);setError(undefined);setSelection(undefined);
    if(action.kind==='read')setRead(undefined);
    try {const result=await shell.request({type:'setup',viewId:device.id,botId,groupId,sourceToken,action});
      const reply=result.setup;if(!reply)throw new Error('此设备暂不支持配方任务，请更新后重试。');if(current!==epoch.current)return;if(reply.kind!=='richSetup'||reply.groupId!==groupId)throw new Error('任务目标已变化，请重新读取。');setRead(reply);setSelection(undefined);
    }catch(e){if(current===epoch.current)setError(e instanceof Error?e.message:'配方任务读取未完成。');}finally{if(current===epoch.current)setBusy(false);}
  }
  useEffect(()=>{++epoch.current;void request({kind:'read'});return()=>{++epoch.current;};},[client,device.id,shell,botId,groupId,sourceToken]);
  if(read&&!read.tasks.length&&!error)return null;
  return <section className="recipe-source-setup"><h3>配方任务</h3>{error&&<InlineNotice title="配方任务暂未读取" tone="warning" actions={<Button disabled={busy} onClick={()=>void request({kind:'read'})}>重新读取</Button>}>{error}</InlineNotice>}{!read&&!error&&<p role="status">正在读取本群配方任务…</p>}
    {read&&<><p>任务保持暂停，核对执行内容和时区后再启用。</p>{read.tasks.map(task=><div className="community-list-row" key={task.id}><strong>{task.name}</strong><span>{task.state}</span>{task.state!=='active'&&<Button disabled={busy} onClick={()=>setSelection({scope,read,task,timeZone:task.timeZone})}>核对并启用</Button>}</div>)}</>}
    {selected&&<Dialog open title="确认启用本群任务" onClose={busy?undefined:()=>setSelection(undefined)} footer={<><Button disabled={busy} onClick={()=>setSelection(undefined)}>保留暂停</Button><Button variant="primary" disabled={busy||!validZone} onClick={()=>{void request({kind:'enableTask',taskId:selected.task.id,token:selected.read.token,taskToken:selected.task.token,timeZone});}}>启用此任务</Button></>}>
      <h3>{selected.task.name}</h3><RecipeMarkdown text={selected.task.instruction}/><p>原任务：{selected.task.schedule}（{selected.task.timeZone}） · {selected.task.placement==='follow'?'跟随当前会话':'新话题'}</p>
        {validZone&&<p>启用后：{selected.task.spec?.kind==='once'?`${localInput(selected.task.spec.at,timeZone).replace('T',' ')} 一次`:selected.task.schedule}（{timeZone}）</p>}
        {selected.task.spec?.kind==='once'&&<p>一次性任务的执行时刻固定，修改时区只改变显示时间。</p>}
        <p>按目标设备上此 Bot 的管理员配置运行，仅作用于本群。任务指令、周期、权限或上下文改变后，需要重新确认。</p><label>执行时区<input aria-label="任务执行时区" value={selected.timeZone} disabled={!selected.task.spec} onChange={event=>setSelection({...selected,timeZone:event.target.value})}/></label>
        {!validZone&&<p role="alert">不认识这个时区，请填写有效的 IANA 时区。</p>}
        {!selected.task.spec&&<p>此设备尚未提供完整周期信息，按原任务时区启用。</p>}
    </Dialog>}
  </section>;
}
