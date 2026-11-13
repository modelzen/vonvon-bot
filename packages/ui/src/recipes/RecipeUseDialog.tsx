import {useState} from 'react';
import type {AgentId, DesktopRecipeReview, DesktopSnapshot, RecipeSetup, RecipeUseReply, RecipeUseRequest} from '@vonvon/protocol';
import {JoinGroupDialog} from '../JoinGroupDialog';
import {SelectJoinBotDialog} from '../SelectJoinBotDialog';
import {Button, FormField, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {usePendingGroups} from '../pending-groups';
import {OPEN_SETTING_EVENT} from '../search';
import type {RecipeUseSession} from './recipe-use-context';

type Props = {
  session: RecipeUseSession; snapshot?: DesktopSnapshot; visible: boolean; reply?: RecipeUseReply; error?: string;
  busy: boolean; paused: boolean; accountChanged: boolean; needsRecovery: boolean; reviewEpoch: number; groupId?: string;
  acceptedResolution?: Resolution;
  onSelectBot: (id: AgentId) => void; onSelectGroup: (groupId: string) => void; onClose: () => void; onRecover: () => void;
  onRequest: (request: RecipeUseRequest) => Promise<void>;
};
export function RecipeUseDialog(props: Props) {
  const {session, snapshot, visible, reply, busy, paused, needsRecovery, onClose, onRequest} = props;
  const pending = usePendingGroups(visible && !paused ? snapshot : undefined);
  if (visible && !paused && !needsRecovery && !session.botId && snapshot) return <SelectJoinBotDialog snapshot={snapshot} onClose={onClose} onSelect={props.onSelectBot}/>;
  const agent = snapshot?.agents.find(item => item.id === session.botId);
  const choosing = visible && !paused && !needsRecovery && !busy && reply?.kind === 'choose' && agent;
  const join = !props.accountChanged && reply?.kind === 'choose' && agent ? <JoinGroupDialog open={Boolean(choosing)}
    agent={agent} snapshot={snapshot} tools={snapshot?.tools} pending={pending.find(item => item.agentId === agent.id)}
    recipe={session.recipe} onClose={onClose} onChanged={async () => {}}
    onRecipeJoin={input => onRequest({type: 'join', handle: reply.handle, input})} onRecipeGroup={props.onSelectGroup}
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
      {canAct && reply?.kind === 'rejected' && reply.groupId && <Button onClick={() => void onRequest({type: 'retry', handle: reply.handle})}>在这个群重新预览</Button>}
      {canAct && terminal && handle && <Button variant="primary" onClick={() => void onRequest({type: 'finish', handle})}>完成</Button>}
    </>}>
    {paused ? <InlineNotice title="操作已暂停" tone="warning">{props.accountChanged ? '请回到发起操作时的账号，再恢复原操作。' : `请切回「${session.device.name}」，再恢复原操作。`}群聊和配方不会改到当前目标。</InlineNotice>
      : needsRecovery ? <InlineNotice title="需要核对原操作" tone="warning">群聊或应用可能已经完成。恢复后会核对同一个群，不会重新创建或连接。</InlineNotice>
      : <>
        <ol className="recipe-use-stages" aria-label="应用进度">
          <li>已获取配方，保存在账号中</li>
          <li>{props.groupId ? `已连接群聊${agent ? ` · ${agent.name}` : ''}` : '选择 Bot 并连接群聊'}</li>
          <li>{reply?.kind === 'applied' ? '已应用到目标群，云端已确认' : reply?.kind === 'pending' ? pendingText(reply.phase) : reply?.kind === 'rejected' ? '本次应用未完成' : '预览内容，确认后应用'}</li>
        </ol>
        {session.target && (reply?.kind === 'review' || reply?.kind === 'prepared') && <p className="recipe-use-note">沿用现有群聊的 Provider、工作目录和沟通方式。</p>}
        {(reply?.kind === 'review' || reply?.kind === 'prepared') && <RecipeReview key={`${reply.review.reviewToken}:${props.reviewEpoch}`} review={reply.review} prepared={reply.kind === 'prepared'} busy={busy}
          acceptedResolution={props.acceptedResolution}
          onResolve={resolution => onRequest({type: 'resolve', handle: reply.handle, reviewToken: reply.review.reviewToken, resolution})}
          onConfirm={() => onRequest({type: 'confirm', handle: reply.handle})}/>}
        {reply?.kind === 'pending' && <InlineNotice title="正在核对结果" tone="warning">{pendingDetail(reply.phase)}关闭窗口后仍可从该配方恢复。</InlineNotice>}
        {reply?.kind === 'applied' && <InlineNotice title="配方已应用" tone="success">只更新了这个 Bot 在目标群中的角色和使用准备。使用准备保留为说明，请按需逐项处理。</InlineNotice>}
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
function RecipeReview({review, prepared, busy, acceptedResolution, onResolve, onConfirm}: {review: DesktopRecipeReview; prepared: boolean; busy: boolean; acceptedResolution?: Resolution; onResolve: (resolution: Resolution) => Promise<void>; onConfirm: () => Promise<void>}) {
  const [role, setRole] = useState<'keep' | 'replace' | 'custom'>();
  const [text, setText] = useState(review.currentRole);
  const [setup, setSetup] = useState<'keep' | 'replace'>();
  const tooLong = [...text].length > 5000;
  const ready = (!review.roleChoiceRequired || role !== undefined) && (!review.setupChoiceRequired || setup !== undefined) && !(role === 'custom' && tooLong);
  function resolve() {
    if (!ready) return;
    void onResolve({...(role && {role: role === 'custom' ? {kind: 'custom', text} : {kind: role}}), ...(setup && {setup})});
  }
  return <div className="recipe-use-review">
    <p>{prepared ? '请核对本次内容，再确认应用。' : '内容存在差异，请选择保留或替换。内容变化后需要重新选择。'}</p>
    {prepared && acceptedResolution && <div className="recipe-use-selection" role="status">
      {acceptedResolution.role && <p>本群角色：{{keep: '保留群内当前', replace: '使用本次配方', custom: '使用手动合并内容'}[acceptedResolution.role.kind]}</p>}
      {acceptedResolution.role?.kind === 'custom' && <CompareText title="合并后将应用" text={acceptedResolution.role.text}/>}
      {acceptedResolution.setup && <p>使用准备：{acceptedResolution.setup === 'keep' ? '保留群内当前' : '使用本次配方'}</p>}
    </div>}
    <section aria-label="角色对比"><h3>本群角色</h3><div className="recipe-use-comparison">
      {review.baseRole !== undefined && <CompareText title="上次配方" text={review.baseRole}/>}
      <CompareText title="群内当前" text={review.currentRole}/><CompareText title="本次配方" text={review.incomingRole}/>
    </div>
      {!prepared && review.roleChoiceRequired && <fieldset className="recipe-use-choices"><legend>选择角色内容</legend>
        {([['keep', '保留群内当前'], ['replace', '使用本次配方'], ['custom', '手动合并']] as const).map(([value, label]) => <label key={value}><input type="radio" name="recipe-role" value={value} checked={role === value} disabled={busy} onChange={() => setRole(value)}/>{label}</label>)}
      </fieldset>}
      {!prepared && role === 'custom' && <FormField label="合并后的本群角色" error={tooLong ? '本群角色最多 5000 字。' : undefined}><textarea aria-label="合并后的本群角色" value={text} disabled={busy} onChange={event => setText(event.target.value)}/><small>{[...text].length} / 5000 字</small></FormField>}
    </section>
    {(review.currentSetup || review.incomingSetup || review.baseSetup) && <section aria-label="使用准备对比"><h3>使用准备</h3><div className="recipe-use-comparison">
      {review.baseSetup && <CompareSetup title="上次配方" setup={review.baseSetup}/>}
      <CompareSetup title="群内当前" setup={review.currentSetup}/><CompareSetup title="本次配方" setup={review.incomingSetup}/>
    </div><p className="recipe-use-note">这些是使用说明。获取或应用配方不会自动执行其中的步骤。</p>
      {!prepared && review.setupChoiceRequired && <fieldset className="recipe-use-choices"><legend>选择使用准备</legend>{([['keep', '保留群内当前'], ['replace', '使用本次配方']] as const).map(([value, label]) => <label key={value}><input type="radio" name="recipe-setup" checked={setup === value} disabled={busy} onChange={() => setSetup(value)}/>{label}</label>)}</fieldset>}
    </section>}
    <div className="recipe-use-review__action"><Button variant="primary" loading={busy} disabled={busy || !prepared && !ready} onClick={() => prepared ? void onConfirm() : resolve()}>{prepared ? '确认应用到这个群' : '预览所选内容'}</Button></div>
  </div>;
}
function CompareText({title, text}: {title: string; text: string}) {return <div className="recipe-use-compare"><h4>{title}</h4><pre>{text || '未设置'}</pre></div>;}
function CompareSetup({title, setup}: {title: string; setup?: RecipeSetup}) {
  return <div className="recipe-use-compare"><h4>{title}</h4>{setup ? <ol>{setup.steps.map((step, index) => <li key={index}><strong>{step.title}{step.required ? ' · 必需' : ' · 可选'}</strong><p>{step.instructions}</p>{step.check && <small>检查方式：{step.check}</small>}</li>)}</ol> : <p>未设置</p>}</div>;
}
