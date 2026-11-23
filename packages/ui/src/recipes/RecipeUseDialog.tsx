import {useEffect, useRef, useState} from 'react';
import {backendLabel, groupIdSchema, type AgentId, type DesktopRecipeReview, type DesktopSnapshot, type RecipeUseReply, type RecipeUseRequest} from '@vonvon/protocol';
import {JoinGroupDialog, type JoinGroupDraft} from '../JoinGroupDialog';
import {SelectJoinBotDialog} from '../SelectJoinBotDialog';
import {Button, FormField, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {usePendingGroups} from '../pending-groups';
import {OPEN_SETTING_EVENT} from '../search';
import {RecipeDetails} from '../community/RecipeContent';
import {SettingValue, recipeSettingNames} from '../community/RichConfiguration';
import type {CommunityShell, RecipeDetail} from '@vonvon/protocol';
import type {RecipeUseSession} from './recipe-use-context';

type Props = {
  session: RecipeUseSession; snapshot?: DesktopSnapshot; visible: boolean; reply?: RecipeUseReply; error?: string;
  busy: boolean; paused: boolean; accountChanged: boolean; unavailable: boolean; needsRecovery: boolean; groupId?: string;
  groupName?: string; groupNameError?: string; onRefreshGroupName: () => void;
  community?: CommunityShell;
  acceptedResolution?: Resolution;
  retainedSettings?: {kind: string; local: string | null; base?: string | null; incoming?: string | null}[];
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
        <div className="recipe-use-target recipe-use-target--compact"><strong>{groupName ?? (props.groupId ? '正在读取群名…' : '待选择群聊')}</strong><span>{agent?.name ?? session.summary?.botName ?? '待选择 Bot'} · {session.device.name}</span>{localName && localName !== groupName && <small>本地名称：{localName}</small>}</div>
        {session.target && (reply?.kind === 'review' || reply?.kind === 'prepared') && <p className="recipe-use-note">沿用现有群聊的 Provider、工作目录和沟通方式。</p>}
        {(reply?.kind === 'review' || reply?.kind === 'prepared' || reply?.kind === 'richReview' || reply?.kind === 'richPrepared') && !groupName && <InlineNotice title="核对目标群聊" tone="warning">{props.groupNameError ?? '正在读取目标群名，核对后才能确认应用。'}{props.groupNameError && <Button disabled={busy} onClick={props.onRefreshGroupName}>重新读取群名</Button>}</InlineNotice>}
        {(reply?.kind === 'review' || reply?.kind === 'prepared') && <RecipeReview draft={reviewDraft} onChange={setReviewDraft} review={reply.review} prepared={reply.kind === 'prepared'} busy={busy || !groupName}
          acceptedResolution={props.acceptedResolution}
          onResolve={resolution => onRequest({type: 'resolve', handle: reply.handle, reviewToken: reply.review.reviewToken, resolution})}
          onConfirm={() => onRequest({type: 'confirm', handle: reply.handle})}/>}
        {(reply?.kind === 'richReview' || reply?.kind === 'richPrepared') && <RichInstallReview key={JSON.stringify([session.accountId, session.device.id, session.recipe.recipeId, session.recipe.versionId, reply.handle, reply.reviewToken])} session={session} community={props.community} reply={reply} busy={!canAct || !groupName || !visible} retainedSettings={props.retainedSettings} onRequest={onRequest}/>}
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
        {reply?.kind === 'applied' && <InlineNotice title="配方已应用" tone="success">已应用到目标群，云端已确认。已更新这个 Bot 在目标群中的所选配置。</InlineNotice>}
        {reply?.kind === 'rejected' && <InlineNotice title="本次未应用" tone="warning">{reply.reason || '本次操作已经结束。'}{reply.groupId && '群聊已保留，可以在这个群重新预览。'}</InlineNotice>}
        {!reply && <p role="status">{session.botId ? '正在读取配方和目标群…' : '正在读取目标设备的 Bot…'}</p>}
        {reply?.kind === 'choose' && !agent && <InlineNotice title="Bot 暂不可用" tone="warning">请在原设备恢复 Bot 后，重新核对原操作。</InlineNotice>}
      </>}
    {busy && <p role="status">正在核对，请稍候…</p>}
    {!props.accountChanged && props.error && <InlineNotice title="操作未完成" tone="warning">{props.error}</InlineNotice>}
  </Dialog></>;
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

function RichInstallReview({session, community, reply, busy, retainedSettings, onRequest}: {
  session: RecipeUseSession;
  community?: CommunityShell;
  reply: Extract<RecipeUseReply, {kind: 'richReview' | 'richPrepared'}>;
  busy: boolean;
  retainedSettings?: Props['retainedSettings'];
  onRequest: Props['onRequest'];
}) {
  const [choices, setChoices] = useState<Record<string, 'local' | 'incoming'>>({});
  const [detail, setDetail] = useState<RecipeDetail>();
  const [readError, setReadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const preparedToken = useRef<string | undefined>(undefined);
  const needsCompatiblePreview = reply.kind === 'richReview' && reply.conflicts.some(item => item.kind === 'memories') || retainedSettings?.some(item => item.kind === 'memories');
  useEffect(() => {
    if (needsCompatiblePreview || reply.kind !== 'richReview' || reply.conflicts.length || busy || preparedToken.current === reply.reviewToken) return;
    preparedToken.current = reply.reviewToken;
    void onRequest({type: 'richResolve', handle: reply.handle, reviewToken: reply.reviewToken, choices: {}});
  }, [reply, busy, needsCompatiblePreview, onRequest]);
  useEffect(() => {
    if (needsCompatiblePreview || reply.kind !== 'richPrepared' || busy || detail) return;
    let current = true;
    setReadError(false);
    void community?.request({type: 'detail', accountId: session.accountId, recipeId: session.recipe.recipeId, versionId: session.recipe.versionId}).then(result => {
      if (!current) return;
      if (result.recipeId !== session.recipe.recipeId || result.versionId !== session.recipe.versionId || !result.rich && !result.config) {setReadError(true); return;}
      setDetail(result);
    }, () => {if (current) setReadError(true);});
    if (!community) setReadError(true);
    return () => {current = false;};
  }, [reply.kind, session.accountId, session.recipe.recipeId, session.recipe.versionId, community, attempt, busy, detail, needsCompatiblePreview]);
  if (needsCompatiblePreview) return <InlineNotice title="需要重新预览配方" tone="warning">目标设备返回了包含记忆的旧版预览。配方不再携带记忆，请更新目标设备，取消本次应用后重新预览。</InlineNotice>;
  if (reply.kind === 'richPrepared') return <section className="recipe-use-preview">
    <div><h3>配方内容</h3><p className="recipe-use-note">以下是配方原文。本次冲突中选择保留的内容列在下方；未变更的项目可能沿用本群现有设置。</p></div>
    {detail ? <RecipeDetails recipe={detail} heading={<></>}/> : readError ? <InlineNotice title="暂时无法读取配方内容" tone="warning">读取后再确认应用。<Button disabled={busy} onClick={() => setAttempt(value => value + 1)}>重新读取配方</Button></InlineNotice> : <p role="status">正在读取配方内容…</p>}
    {retainedSettings?.length ? <section className="recipe-use-retained"><h3>保留本群设置</h3>{retainedSettings.map((item, index) => <ConflictValue key={index} title={conflictLabel(item.kind)} kind={item.kind} text={item.local} blockLabels={cardBlockLabels(item)}/>)}</section> : retainedSettings === undefined ? <p className="recipe-use-note">恢复原操作，沿用先前确认的冲突选择。</p> : null}
    <div className="recipe-use-review__action"><Button className="recipe-use-confirm" variant="primary" disabled={busy || !detail} onClick={() => void onRequest({type: 'confirm', handle: reply.handle})}>确认应用到这个群</Button></div>
  </section>;
  if (!reply.conflicts.length) return <p role="status">正在准备配方预览…</p>;
  return <section className="recipe-use-review">
    <div><h3>选择要使用的设置</h3><p className="recipe-use-note">这些内容与本群不同。选择后查看配方内容，再确认应用。</p></div>
    {reply.conflicts.map(item => <fieldset className="recipe-use-conflict" key={item.itemId}>
      <legend>{conflictLabel(item.kind)}</legend>
      <div className="recipe-use-comparison"><ConflictValue title="当前本群" kind={item.kind} text={item.local} blockLabels={cardBlockLabels(item)}/><ConflictValue title="本次配方" kind={item.kind} text={item.incoming} blockLabels={cardBlockLabels(item)} removal/></div>
      <div className="recipe-use-choices">
        <label><input type="radio" disabled={busy} name={item.itemId} checked={choices[item.itemId] === 'local'} onChange={() => setChoices(old => ({...old, [item.itemId]: 'local'}))}/>保留本群</label>
        <label><input type="radio" disabled={busy} name={item.itemId} checked={choices[item.itemId] === 'incoming'} onChange={() => setChoices(old => ({...old, [item.itemId]: 'incoming'}))}/>使用配方</label>
      </div>
    </fieldset>)}
    <div className="recipe-use-review__action"><Button className="recipe-use-confirm" variant="primary" disabled={busy || reply.conflicts.some(item => !choices[item.itemId])}
      onClick={() => void onRequest({type: 'richResolve', handle: reply.handle, reviewToken: reply.reviewToken, choices})}>预览所选内容</Button></div>
  </section>;
}

const conflictNames: Record<string, string> = {role: '角色', settings: '群聊设置', rules: '规则', skills: '技能', files: '文档', tasks: '任务', setup: '补充说明', cardBlock: '消息卡片'};
function conflictLabel(kind: string) {return Object.hasOwn(conflictNames, kind) ? conflictNames[kind] ?? '配置项目' : '配置项目';}
const conflictFields = new Map<string, string[]>([
  ['role', ['text']], ['rules', ['purpose', 'text']], ['files', ['name', 'use', 'text']],
  ['skills', ['name']], ['tasks', ['name', 'instruction', 'spec', 'timeZone', 'placement']],
  ['setup', ['kind', 'title', 'instructions', 'check', 'required', 'action']],
  ['cardBlock', ['kind', 'name', 'slot', 'mode', 'appearance', 'template', 'requestedTemplate', 'size', 'color', 'warning', 'warningAt', 'contextRules']],
  ['settings', ['field', 'value']],
]);
const nestedFields = new Map<string, string[]>([
  ['spec', ['kind', 'at', 'minutes', 'time', 'days', 'expr']], ['timeZone', ['kind', 'iana']],
  ['action', ['kind', 'entry']], ['contextRules', ['yellowAt', 'orangeAt', 'redAt', 'showFrom', 'enabledColors']],
  ['value', ['version', 'reply', 'backend', 'selection', 'models', 'efforts', 'modelEfforts', 'modelServiceTiers', 'defaultModel', 'defaultEffort', 'tier', 'provider', 'mode', 'sandbox', 'network', 'permissionMode']],
  ['reply', ['streamText', 'collapseAfterRun']], ['selection', ['kind', 'model', 'effort', 'custom', 'backend', 'provider']],
]);
function readableFields(value: unknown, fields: string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => {
    const item: unknown = Reflect.get(value, key);
    const nested = nestedFields.get(key);
    return [key, nested ? readableFields(item, nested) : item];
  }));
}
function cardBlockOrder(text: string | null | undefined): string[] | undefined {
  if (!text) return;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || !('field' in value) || value.field !== 'presentation.cardDisplay' || !('value' in value)) return;
    const setting = value.value;
    if (!setting || typeof setting !== 'object' || !('blocks' in setting) || !Array.isArray(setting.blocks) || !setting.blocks.every(id => typeof id === 'string')) return;
    return setting.blocks;
  } catch {return;}
}
function cardBlockLabels(item: {base?: string | null; local: string | null; incoming?: string | null}) {
  const ids = new Set([...(cardBlockOrder(item.base) ?? []), ...(cardBlockOrder(item.local) ?? []), ...(cardBlockOrder(item.incoming) ?? [])]);
  return new Map([...ids].map((id, index) => [id, `卡片块${index + 1}`]));
}
function ConflictValue({title, kind, text, blockLabels, removal = false}: {title: string; kind: string; text: string | null; blockLabels: ReadonlyMap<string, string>; removal?: boolean}) {
  let value: unknown = text;
  if (text) {try {value = JSON.parse(text);} catch {value = text;}}
  const fields = conflictFields.get(kind) ?? [];
  const readable = readableFields(value, fields);
  const settingField = kind === 'settings' && value !== null && typeof value === 'object' && 'field' in value && typeof value.field === 'string' ? value.field : undefined;
  const knownSetting = settingField && Object.hasOwn(recipeSettingNames, settingField) ? Object.entries(recipeSettingNames).find(([field]) => field === settingField)?.[1] : undefined;
  const cardSetting = kind === 'settings' && value !== null && typeof value === 'object' && 'field' in value && value.field === 'presentation.cardDisplay';
  const blockOrder = cardSetting ? cardBlockOrder(text) : undefined;
  return <div className="recipe-use-compare"><h4>{title}</h4>{text === null ? <p>{removal ? '移除此项' : '本群没有此项'}</p> : <>
    {kind === 'settings' ? knownSetting ? <><p>{knownSetting}</p><SettingValue value={readable !== null && typeof readable === 'object' && 'value' in readable ? readable.value : null} literal={settingField === 'presentation.completionTemplate'}/></> : <p>此设置暂不支持预览。</p> : <SettingValue value={readable} literal={typeof readable === 'string'}/>}
    {cardSetting && <><p>卡片块顺序（相同编号代表同一卡片块）</p>{blockOrder ? <p>{blockOrder.map(id => blockLabels.get(id)).join(' → ') || '没有卡片块'}</p> : <p>暂时无法读取卡片块顺序。</p>}</>}
  </>}</div>;
}
