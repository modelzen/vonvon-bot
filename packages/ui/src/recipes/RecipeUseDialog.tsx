import {useState} from 'react';
import {backendLabel, groupIdSchema, type AgentId, type DesktopRecipeReview, type DesktopSnapshot, type RecipeUseReply, type RecipeUseRequest} from '@vonvon/protocol';
import {JoinGroupDialog, type JoinGroupDraft} from '../JoinGroupDialog';
import {SelectJoinBotDialog} from '../SelectJoinBotDialog';
import {Button, FormField, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {usePendingGroups} from '../pending-groups';
import {OPEN_SETTING_EVENT} from '../search';
import type {RecipeUseSession} from './recipe-use-context';

type Props = {
  session: RecipeUseSession; snapshot?: DesktopSnapshot; visible: boolean; reply?: RecipeUseReply; error?: string;
  busy: boolean; paused: boolean; accountChanged: boolean; unavailable: boolean; needsRecovery: boolean; groupId?: string;
  groupName?: string; groupNameError?: string; onRefreshGroupName: () => void;
  acceptedResolution?: Resolution;
  onSelectBot: (id: AgentId) => void; onSelectGroup: (groupId: string) => void; onClose: () => void; onRecover: () => void;
  onRequest: (request: RecipeUseRequest) => Promise<void>;
};
export function RecipeUseDialog(props: Props) {
  const {session, snapshot, visible, reply, busy, paused, needsRecovery, onClose, onRequest} = props;
  const joinDraft = useState<JoinGroupDraft>();
  const [reviewDraft, setReviewDraft] = useState<ReviewDraft>({});
  const [repairing, setRepairing] = useState(false);
  const [dismiss, setDismiss] = useState(false);
  const pending = usePendingGroups(visible && !paused ? snapshot : undefined);
  if (visible && !paused && !needsRecovery && !session.botId && snapshot) return <SelectJoinBotDialog snapshot={snapshot} onClose={onClose} onSelect={props.onSelectBot}/>;
  const agent = snapshot?.agents.find(item => item.id === session.botId);
  const groupName = props.groupName;
  const localName = snapshot?.memberships.find(member => member.agentId === session.botId && member.groupId === props.groupId)?.name;
  const recovery = reply?.kind === 'pending' && reply.phase === 'joining' ? reply.recovery : undefined;
  const bound = recovery?.groupId ? snapshot?.memberships.find(member => member.agentId === session.botId && member.groupId === recovery.groupId) : undefined;
  const repairForm = repairing && recovery && !bound;
  const joining = reply?.kind === 'choose' || repairForm;
  const choosing = visible && !paused && !needsRecovery && !busy && joining && agent;
  const join = !paused && !needsRecovery && joining && reply && 'handle' in reply && agent ? <JoinGroupDialog key={repairForm ? 'repair' : 'join'} open={Boolean(choosing)}
    agent={agent} snapshot={snapshot} tools={snapshot?.tools} pending={pending.find(item => item.agentId === agent.id)}
    recipeDraft={joinDraft} recipe={session.recipe} onClose={repairForm ? () => setRepairing(false) : onClose} onChanged={async () => {}}
    existingOnly={Boolean(repairForm)} initialGroup={repairForm && recovery.groupId ? {chatId: recovery.groupId, name: groupName ?? recovery.name ?? '', addedAt: 0} : undefined}
    onRecipeCancel={repairForm ? () => setRepairing(false) : () => void onRequest({type: 'cancel', handle: reply.handle})}
    onRecipeJoin={async input => {
      if (repairForm) {
        if (!('type' in input)) throw new Error('请从 Bot 已加入的群中选择。');
        await onRequest({type: 'repairJoin', handle: reply.handle, input});
      } else await onRequest({type: 'join', handle: reply.handle, input});
    }} onRecipeGroup={repairForm ? groupId => void onRequest({type: 'repairJoin', handle: reply.handle, input: {type: 'existingBinding', agentId: agent.id, groupId: groupIdSchema.parse(groupId)}}) : props.onSelectGroup}
    onOpenProviders={() => {onClose(); window.dispatchEvent(new CustomEvent(OPEN_SETTING_EVENT, {detail: {page: 'providers'}}));}}
    onOpenDecisionModel={() => {onClose(); window.dispatchEvent(new CustomEvent(OPEN_SETTING_EVENT, {detail: {page: 'secrets'}}));}}/> : null;
  if (!visible || choosing) return <>{join}</>;
  const terminal = reply?.kind === 'applied' || reply?.kind === 'rejected';
  const handle = reply && 'handle' in reply ? reply.handle : undefined;
  const canAct = !paused && !needsRecovery && !busy;
  return <>{join}<Dialog open title="应用配方" size="lg" onClose={onClose} description={props.accountChanged ? '请回到发起操作时的账号。' : <span className="recipe-use-name">{session.recipe.name} · {session.recipe.version} · {session.device.name}</span>}
    footer={<>
      <Button onClick={onClose}>稍后继续</Button>
      {!paused && needsRecovery && <Button variant="primary" loading={busy} onClick={props.onRecover}>恢复原操作</Button>}
      {canAct && handle && !terminal && <Button onClick={() => void onRequest({type: 'cancel', handle})}>取消应用</Button>}
      {canAct && reply?.kind === 'pending' && <Button variant="primary" onClick={() => void onRequest({type: 'resume', handle: reply.handle})}>核对进度</Button>}
      {canAct && reply?.kind === 'pending' && recovery && <Button onClick={() => setDismiss(value => !value)}>结束本次跟踪</Button>}
      {canAct && reply?.kind === 'rejected' && reply.groupId && <Button onClick={() => void onRequest({type: 'retry', handle: reply.handle})}>在这个群重新预览</Button>}
      {canAct && terminal && handle && <Button variant="primary" onClick={() => void onRequest({type: 'finish', handle})}>完成</Button>}
    </>}>
    {paused ? <InlineNotice title="操作已暂停" tone="warning">{props.accountChanged ? '请回到发起操作时的账号，再恢复原操作。' : props.unavailable ? '目标设备暂不可用。连接恢复后，请核对原操作。' : `请切回「${session.device.name}」，再恢复原操作。`}群聊和配方不会改到当前目标。</InlineNotice>
      : needsRecovery ? <InlineNotice title="需要核对原操作" tone="warning">群聊或应用可能已经完成。恢复后会核对同一个群，不会重新创建或连接。</InlineNotice>
      : <>
        <p className="recipe-use-target">设备：{session.device.name}<br/>Bot：{agent?.name ?? session.botId ?? '待选择'}{session.botId && `（${session.botId}）`}<br/>
          群聊：{groupName ?? (props.groupId ? '正在核对群名' : '待选择')}{props.groupId && `（${props.groupId}）`}{localName && <><br/>本地名称：{localName}</>}</p>
        <ol className="recipe-use-stages" aria-label="应用进度">
          <li>已获取配方，保存在账号中</li>
          <li>{reply?.kind === 'pending' && reply.phase === 'joining' ? '群聊连接尚待确认' : props.groupId ? `已连接群聊${agent ? ` · ${agent.name}` : ''}` : '选择 Bot 并连接群聊'}</li>
          <li>{reply?.kind === 'applied' ? '已应用到目标群，云端已确认' : reply?.kind === 'pending' ? pendingText(reply.phase) : reply?.kind === 'rejected' ? '本次应用未完成' : '预览内容，确认后应用'}</li>
        </ol>
        {session.target && (reply?.kind === 'review' || reply?.kind === 'prepared') && <p className="recipe-use-note">沿用现有群聊的 Provider、工作目录和沟通方式。</p>}
        {(reply?.kind === 'review' || reply?.kind === 'prepared' || reply?.kind === 'richReview' || reply?.kind === 'richPrepared') && <p role="status">{props.groupNameError ?? (!groupName ? '正在读取目标群名，核对后才能确认应用。' : '已核对飞书群名。')} <Button disabled={busy} onClick={props.onRefreshGroupName}>刷新群名</Button></p>}
        {(reply?.kind === 'review' || reply?.kind === 'prepared') && <RecipeReview draft={reviewDraft} onChange={setReviewDraft} review={reply.review} prepared={reply.kind === 'prepared'} busy={busy || !groupName}
          acceptedResolution={props.acceptedResolution}
          onResolve={resolution => onRequest({type: 'resolve', handle: reply.handle, reviewToken: reply.review.reviewToken, resolution})}
          onConfirm={() => onRequest({type: 'confirm', handle: reply.handle})}/>}
        {(reply?.kind === 'richReview' || reply?.kind === 'richPrepared') && <RichInstallReview reply={reply} busy={!canAct || !groupName} onRequest={onRequest}/>}
        {reply?.kind === 'pending' && <InlineNotice title="正在核对结果" tone="warning">{pendingDetail(reply.phase)}关闭窗口后仍可从该配方恢复。</InlineNotice>}
        {recovery && reply?.kind === 'pending' && <InlineNotice title={recovery.state === 'createdUnsaved' ? '群已创建，连接尚未保存' : '群聊创建结果尚未确认'} tone="warning"
          actions={canAct && agent ? bound ? <Button onClick={() => void onRequest({type: 'repairJoin', handle: reply.handle, input: {type: 'existingBinding', agentId: agent.id, groupId: bound.groupId}})}>继续使用已连接的群</Button>
            : <Button onClick={() => setRepairing(true)}>{recovery.groupId ? '连接已创建的群' : '从已加入群中选择'}</Button> : undefined}>
          {bound ? `本地名称「${bound.name}」已经连接。沿用 Provider ${backendLabel(bound.backend)}、工作目录 ${bound.directory} 和现有沟通方式。`
            : recovery.groupId ? '继续连接这个群。请核对本地绑定名称和原有入群设置。' : '请先在飞书核对，再从 Bot 已加入的群中明确选择。不会重新创建群聊。'}
        </InlineNotice>}
        {dismiss && recovery && reply?.kind === 'pending' && <InlineNotice title="结束跟踪前，请先核对飞书群" tone="warning" actions={<>
          <Button disabled={!canAct} onClick={() => setDismiss(false)}>返回核对</Button>
          <Button disabled={!canAct} onClick={() => void onRequest({type: 'dismissJoin', handle: reply.handle})}>确认结束跟踪</Button>
        </>}>飞书群可能已经创建。结束跟踪不会删除群聊或改变现有连接，也不表示建群已取消。之后可从 Bot 已加入的群中连接。</InlineNotice>}
        {reply?.kind === 'applied' && <InlineNotice title="配方已应用" tone="success">已更新这个 Bot 在目标群中的所选配置。</InlineNotice>}
        {reply?.kind === 'rejected' && <InlineNotice title="本次未应用" tone="warning">{reply.reason || '本次操作已经结束。'}{reply.groupId && '群聊已保留，可以在这个群重新预览。'}</InlineNotice>}
        {!reply && <p role="status">{session.botId ? '正在读取配方和目标群…' : '正在读取目标设备的 Bot…'}</p>}
        {reply?.kind === 'choose' && !agent && <InlineNotice title="Bot 暂不可用" tone="warning">请在原设备恢复 Bot 后，重新核对原操作。</InlineNotice>}
      </>}
    {busy && <p role="status">正在核对，请稍候…</p>}
    {!props.accountChanged && props.error && <InlineNotice title="操作未完成" tone="warning">{props.error}</InlineNotice>}
  </Dialog></>;
}

function pendingText(phase: 'joining' | 'installing' | 'cancelling') {
  return {joining: '正在核对群聊连接结果', installing: '正在应用，等待设备及云端确认', cancelling: '正在核对取消结果'}[phase];
}
function pendingDetail(phase: 'joining' | 'installing' | 'cancelling') {
  return {joining: '群聊可能已经创建或连接，请先核对进度。', installing: '目标设备与云端尚未确认全部完成，请先核对进度。', cancelling: '取消尚未确认；如果应用已经开始，会继续核对实际结果。'}[phase];
}
type Resolution = Extract<RecipeUseRequest, {type: 'resolve'}>['resolution'];
type ReviewDraft = {role?: 'keep' | 'replace' | 'custom'; text?: string};
function RecipeReview({review, draft, onChange, prepared, busy, acceptedResolution, onResolve, onConfirm}: {draft: ReviewDraft; onChange: (draft: ReviewDraft) => void; review: DesktopRecipeReview; prepared: boolean; busy: boolean; acceptedResolution?: Resolution; onResolve: (resolution: Resolution) => Promise<void>; onConfirm: () => Promise<void>}) {
  const {role, text = review.currentRole} = draft;
  if(review.setupChoiceRequired||review.currentSetup||review.incomingSetup||review.baseSetup)return <InlineNotice title="请更新目标设备" tone="warning">目标设备使用旧版配方安装流程，请更新后重新预览。群内配置保持原样。</InlineNotice>;
  const tooLong = [...text].length > 5000;
  const ready = (!review.roleChoiceRequired || role !== undefined) && !(role === 'custom' && tooLong);
  function resolve() {
    if (!ready) return;
    void onResolve({...(role && {role: role === 'custom' ? {kind: 'custom', text} : {kind: role}})});
  }
  return <div className="recipe-use-review">
    <p>{prepared ? '请核对本次内容，再确认应用。' : '内容存在差异，请选择保留或替换。内容变化后需要重新选择。'}</p>
    {prepared && acceptedResolution && <div className="recipe-use-selection" role="status">
      {acceptedResolution.role && <p>本群角色：{{keep: '保留群内当前', replace: '使用本次配方', custom: '使用手动合并内容'}[acceptedResolution.role.kind]}</p>}
      {acceptedResolution.role?.kind === 'custom' && <CompareText title="合并后将应用" text={acceptedResolution.role.text}/>}
    </div>}
    <section aria-label="角色对比"><h3>本群角色</h3><div className="recipe-use-comparison">
      {review.baseRole !== undefined && <CompareText title="上次配方" text={review.baseRole}/>}
      <CompareText title="群内当前" text={review.currentRole}/><CompareText title="本次配方" text={review.incomingRole}/>
    </div>
      {!prepared && review.roleChoiceRequired && <fieldset className="recipe-use-choices"><legend>选择角色内容</legend>
        {([['keep', '保留群内当前'], ['replace', '使用本次配方'], ['custom', '手动合并']] as const).map(([value, label]) => <label key={value}><input type="radio" name="recipe-role" value={value} checked={role === value} disabled={busy} onChange={() => onChange({...draft, role: value})}/>{label}</label>)}
      </fieldset>}
      {!prepared && role === 'custom' && <FormField label="合并后的本群角色" error={tooLong ? '本群角色最多 5000 字。' : undefined}><textarea aria-label="合并后的本群角色" value={text} disabled={busy} onChange={event => onChange({...draft, text: event.target.value})}/><small>{[...text].length} / 5000 字</small></FormField>}
    </section>
    <div className="recipe-use-review__action"><Button variant="primary" loading={busy} disabled={busy || !prepared && !ready} onClick={() => prepared ? void onConfirm() : resolve()}>{prepared ? '确认应用到这个群' : '预览所选内容'}</Button></div>
  </div>;
}
function CompareText({title, text}: {title: string; text: string}) {return <div className="recipe-use-compare"><h4>{title}</h4><pre>{text || '未设置'}</pre></div>;}

function RichInstallReview({reply,busy,onRequest}:{reply:Extract<RecipeUseReply,{kind:'richReview'|'richPrepared'}>;busy:boolean;onRequest:(request:RecipeUseRequest)=>Promise<void>}) {
  const [choices,setChoices]=useState<Record<string,'local'|'incoming'>>({});
  if(reply.kind==='richPrepared')return <InlineNotice title="完整配置已核对"><p>只应用到所选 Bot 与群，保留其他群与 Bot 的配置。如包含任务，可在群聊设置的「配方任务」中核对并启用。</p><Button variant="primary" disabled={busy} onClick={()=>void onRequest({type:'confirm',handle:reply.handle})}>确认应用此版本</Button></InlineNotice>;
  return <section><h3>核对本群差异</h3>{reply.conflicts.length===0?<p>没有需要决定的冲突项。</p>:reply.conflicts.map(item=><fieldset key={item.itemId}><legend>{item.kind}</legend><div className="community-editor-grid"><div><h4>当前本群</h4><pre>{item.local??'未指定'}</pre></div><div><h4>配方新版</h4><pre>{item.incoming??'移除此项'}</pre></div></div><label><input type="radio" name={item.itemId} checked={choices[item.itemId]==='local'} onChange={()=>setChoices(old=>({...old,[item.itemId]:'local'}))}/>保留本群</label><label><input type="radio" name={item.itemId} checked={choices[item.itemId]==='incoming'} onChange={()=>setChoices(old=>({...old,[item.itemId]:'incoming'}))}/>使用配方</label></fieldset>)}<Button variant="primary" disabled={busy||reply.conflicts.some(item=>!choices[item.itemId])} onClick={()=>void onRequest({type:'richResolve',handle:reply.handle,reviewToken:reply.reviewToken,choices})}>确认这些选择并预览应用</Button></section>;
}
