import {useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent} from 'react';
import {createPortal, flushSync} from 'react-dom';
import {ArrowLeft, Bot, Check, ChevronRight, Code2, Minus, Plus, Pointer, RotateCcw, Undo2, X} from 'lucide-react';
import {Dialog as NativeDialog} from '@base-ui/react/dialog';
import {Button, FormField, SelectControl, Toggle} from '../../reference/components/ui';
import {SettingsGroup, SettingsRow} from '../../reference/components/system-settings';
import {useDraft} from '../DraftGuard';
import {cardDisplayConfigSchema, completionTemplateSchema, defaultCompletionTemplate, renderCompletionTemplate, DEFAULT_REMINDER_REQUESTED_TEMPLATE, type Agent, type SettingsReply} from '@vonvon/protocol';
import {AgentAvatar} from '../../AgentAvatar';
import {settingAnchor} from '../../search';
import {FeishuCardPreview, FeishuContentSample, type CardNode} from './FeishuCardPreview';
import {previewFrames, toolPreviewFrames, streamingPreviewFrames, toolPreviewFramesNonManual, streamingPreviewFramesNonManual, previewLayoutInputs, toolPreviewLayoutInputs, toolPreviewLayoutInputsNonManual, streamingLayoutInputs, streamingLayoutInputsNonManual, toolPreviewFramesRequested, toolPreviewLayoutInputsRequested, streamingPreviewFramesRequested, streamingLayoutInputsRequested, subagentPreviewFrames, subagentPreviewFramesNonManual, subagentPreviewFramesRequested, subagentPreviewLayoutInputs, subagentPreviewLayoutInputsNonManual, subagentPreviewLayoutInputsRequested} from './card-preview-frames';
import {allowedSlots, streamPreviewCard, streamPreviewLength, withReminderBlock, cardDisplayEditorBaseline, cardDisplayEditorPatch, composeCard, defaultCompletionReminder, contextRulesFor, currentCardDisplaySnapshot, customBlock, customScriptCount, defaultCardDisplay, interpolate, revisionOnOpen, safeComposeCard, variableData, variablesFor, type CardBlock, type CardDisplayConflictSnapshot, type CardDisplayDraft, type CardDisplayEditorDraft, type CardDisplayEditorPatch, type CompletionReminderDraft, type CardSlot, type ContextRules, type DisplayMode, type PreviewFrame} from './card-display-model';
import './card-display-studio.css';
import {completionPreviewText} from './completion-preview';

type Props = {agent?: Agent; botName?: string; groupName?: string; scopeLabel?: '此群聊' | '此私聊'} & Partial<CompletionReminderDraft>;
type EntryProps = Props & {scopeLabel: '此群聊' | '此私聊'; saved: CardDisplayDraft | null | undefined;
  revision: string; readonly?: boolean; readonlyMessage?: string; onSave: (value: CardDisplayEditorPatch, revision: string) => Promise<SettingsReply>; onRefresh?: () => Promise<void>};
function saveError(reply: SettingsReply): string | undefined {
  if (reply.kind === 'refused') return reply.message;
  if (reply.kind !== 'saved') return '未收到保存确认，请重试。';
  if (reply.result.kind === 'rejected') return reply.result.fields.map(item => `${item.field}：${item.message}`).join('；');
  if (reply.result.kind === 'conflict') return '设置已在别处更改，当前草稿已保留。可放弃草稿，改用最新设置。';
  if (reply.result.kind === 'unavailable') return reply.result.reason.kind === 'readonly' ? reply.result.reason.message : '当前不可编辑。';
}

// Intent: recognize the reply as it appears in Feishu, then change the thing clicked.
// Hierarchy: widget samples and fixed switches serve a flowing reply on a dedicated settings page.
// Palette/depth: native card colors and pale corner badges, with only component details floating above the canvas.
// Typography/spacing: system type, 12px controls, 4px rhythm, 16px settings padding.
export function CardDisplayEntry(props: EntryProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CardDisplayEditorDraft>();
  const editBaseline = useRef(cardDisplayEditorBaseline(props));
  const [editRevision, setEditRevision] = useState(props.revision);
  const [error, setError] = useState<string>();
  const [conflictCurrent, setConflictCurrent] = useState<CardDisplayConflictSnapshot>();
  const [conflicted, setConflicted] = useState(false);
  const working = currentCardDisplaySnapshot(props, conflictCurrent);
  const baseline = cardDisplayEditorBaseline(working);
  const defaults = defaultCompletionReminder();
  const isDefault = working.saved == null && baseline.completionMode === defaults.completionMode && baseline.longTaskMinutes === defaults.longTaskMinutes && baseline.completionTemplate === null;
  function noteConflict(reply: SettingsReply) {
    if (reply.kind !== 'saved' || reply.result.kind !== 'conflict') return;
    const current = reply.result.current.value;
    const stored = current.stored as {cardDisplay?: CardDisplayDraft | null};
    const effective = current.effective as Partial<CompletionReminderDraft>;
    setConflictCurrent({saved: stored.cardDisplay, completionMode:effective.completionMode, longTaskMinutes:effective.longTaskMinutes, completionTemplate:effective.completionTemplate, revision: current.revision, parentRevisionAtConflict: props.revision});
    setConflicted(true);
  }
  async function refreshAfterConflict(reply: SettingsReply) {
    if (reply.kind !== 'saved' || reply.result.kind !== 'conflict') return;
    try {await props.onRefresh?.();} catch { /* The parent settings page reports read failures. */ }
  }
  async function save(value: CardDisplayEditorDraft): Promise<boolean> {
    const patch = cardDisplayEditorPatch(value, editBaseline.current);
    if (!Object.keys(patch).length) {setDraft(undefined); setOpen(false); setError(undefined); setConflictCurrent(undefined); setConflicted(false); return true;}
    const parsed = cardDisplayConfigSchema.safeParse(value.cardDisplay);
    if (!parsed.success) {setError(parsed.error.issues.map(issue => `${issue.path.join('.')}：${issue.message}`).join('；')); return false;}
    if (!Number.isInteger(value.longTaskMinutes) || value.longTaskMinutes < 1 || value.longTaskMinutes > 1440) {setError('长任务分钟数请填写 1 到 1440 的整数。'); return false;}
    const template = completionTemplateSchema.nullable().safeParse(value.completionTemplate);
    if (!template.success) {setError(template.error.issues.map(issue => issue.message).join('；')); return false;}
    try {
      const reply = await props.onSave({...patch, ...(patch.cardDisplay ? {cardDisplay:parsed.data} : {})}, editRevision);
      noteConflict(reply);
      await refreshAfterConflict(reply);
      const failure = saveError(reply);
      if (failure) {setError(failure); return false;}
      setDraft(undefined); setOpen(false); setError(undefined); setConflictCurrent(undefined); setConflicted(false); return true;
    } catch (failure) {setError(failure instanceof Error ? failure.message : '保存失败，请重试。'); return false;}
  }
  function discardConflictedDraft() {
    setDraft(undefined); setOpen(false); setError(undefined); setConflicted(false);
    setEditRevision(working.revision);
    void props.onRefresh?.().catch(() => {});
  }
  useDraft(Boolean(draft), {title: '消息卡片', save: async () => draft ? save(draft) : true, discard: discardConflictedDraft});
  if (open) return <CardDisplayPage {...props} initial={(draft ?? editBaseline.current).cardDisplay} initialReminder={draft ?? editBaseline.current} onDraftChange={setDraft} onSave={save} onClose={() => setOpen(false)} saveError={error} onDiscardConflict={conflicted ? discardConflictedDraft : undefined}/>;
  return <>
    <SettingsGroup label="回复样式" id={settingAnchor('回复样式')} footer={props.readonlyMessage}>
      <SettingsRow title="回复卡片样式" description={isDefault ? `${props.scopeLabel}使用旧版默认展示与完成提醒` : `${props.scopeLabel}已自定义；可调整卡片样式与完成提醒`} trailing={<Button className="cds-entry-button" size="sm" disabled={props.readonly || Boolean(props.readonlyMessage)} onClick={() => {setError(undefined); if (!draft) editBaseline.current = structuredClone(baseline); setEditRevision(revisionOnOpen(Boolean(draft), editRevision, working.revision)); setOpen(true);}}>自定义<ChevronRight size={13}/></Button>}/>
      {error && <p className="cds-save-error" role="alert">{error}</p>}
      {conflicted && <div className="cds-conflict-recovery"><Button size="sm" onClick={discardConflictedDraft}>使用最新设置并放弃草稿</Button></div>}
    </SettingsGroup>
  </>;
}

function findComponent(nodes: CardNode[], id: string): CardNode | undefined {
  for (const node of nodes) {
    if (node.preview_component === id) return node;
    const title = (node.header as {title?: CardNode} | undefined)?.title;
    if (title?.preview_component === id) return title;
    const found = findComponent([...(Array.isArray(node.elements) ? node.elements as CardNode[] : []), ...(Array.isArray(node.columns) ? node.columns as CardNode[] : [])], id);
    if (found) return found;
  }
  return undefined;
}
function exampleNode(block: CardBlock, currentFrame?: PreviewFrame, usage?: number) {
  const stage = currentFrame ?? (block.kind === 'tools' || block.kind === 'thinking' ? 'tool' : block.kind === 'status' || block.kind === 'model' || block.kind === 'stop' || block.kind === 'reminder' ? 'streaming' : 'done');
  const base = stage === 'tool' ? toolPreviewFrames.tool : previewFrames[stage];
  const layout = stage === 'tool' ? toolPreviewLayoutInputs.tool : previewLayoutInputs[stage];
  const sampleBlock = block.kind === 'context' ? {...block, contextRules: {...contextRulesFor(block), showFrom: 0}} : block;
  try {
    const card = composeCard(base, {version: 1, blocks: [{...sampleBlock, mode: block.kind === 'status' || block.kind === 'stop' || block.kind === 'reminder' ? 'running' : 'always'}]}, stage, false, usage, layout);
    return findComponent(card.body.elements, block.id);
  } catch {return undefined;}
}

function ContextSettings({block, onChange}: {block: CardBlock; onChange: (rules: ContextRules) => void}) {
  const rules = contextRulesFor(block);
  const enabled = rules.enabledColors!;
  const colorRows = [
    {key: 'yellowAt', label: '黄色', color: 'yellow'},
    {key: 'orangeAt', label: '橙色', color: 'orange'},
    {key: 'redAt', label: '红色', color: 'red'},
  ] as const;
  function bounds(index: number, colors = enabled) {
    const before = colorRows.slice(0, index).filter(row => colors.includes(row.color)).at(-1);
    const after = colorRows.slice(index + 1).find(row => colors.includes(row.color));
    return {min: before ? rules[before.key] + 1 : 0, max: after ? rules[after.key] - 1 : 100};
  }
  function toggleColor(index: number, checked: boolean) {
    const row = colorRows[index]!;
    const enabledColors = checked ? [...enabled, row.color] : enabled.filter(color => color !== row.color);
    const next = {...rules, enabledColors};
    if (checked) {
      const {min, max} = bounds(index, enabledColors);
      if (min <= max) next[row.key] = Math.max(min, Math.min(max, next[row.key]));
      else {
        const active = colorRows.filter(item => enabledColors.includes(item.color));
        active.forEach((item, i) => {next[item.key] = Math.max(i, Math.min(100 - active.length + 1 + i, next[item.key]));});
        for (let i = active.length - 2; i >= 0; i--) next[active[i]!.key] = Math.min(next[active[i]!.key], next[active[i + 1]!.key] - 1);
      }
    }
    onChange(next);
  }
  return <div className="cds-context-rules">
    {block.color === 'auto' && <section aria-label="用量颜色"><h4>用量颜色</h4><div className="cds-context-colors">{colorRows.map((row, index) => {
      const active = enabled.includes(row.color);
      const {min, max} = bounds(index);
      return <div className="cds-context-color-row" key={row.key} data-context-color={row.color} data-enabled={active}><label className="cds-context-color-threshold">达到<input aria-label={`变为${row.label}的用量`} type="number" min={min} max={max} disabled={!active} value={rules[row.key]} onChange={event => onChange({...rules, [row.key]: Math.max(min, Math.min(max, Math.trunc(Number(event.target.value) || 0)))})}/>% ，变为<strong data-color={row.color}>{row.label}</strong></label><Toggle className="cds-context-color-toggle" label="" aria-label={`使用${row.label}`} checked={active} onChange={event => toggleColor(index, event.target.checked)}/></div>;
    })}</div><p>{enabled.length ? '关闭的颜色会跳过，沿用上一档颜色；最初使用灰色。' : '未启用颜色，统一使用灰色。'}</p></section>}
    <section aria-label="上下文出现条件"><h4>显示条件</h4><SelectControl label="上下文出现条件" value={rules.showFrom > 0 ? 'usage' : 'always'} options={[{value: 'always', label: '不限用量'}, {value: 'usage', label: '达到指定用量'}]} onChange={value => onChange({...rules, showFrom: value === 'always' ? 0 : 80})}/>{rules.showFrom > 0 && <><label className="cds-context-visible">用量达到<input aria-label="上下文出现的用量" type="number" min={1} max={100} value={rules.showFrom} onChange={event => onChange({...rules, showFrom: Math.max(1, Math.min(100, Math.trunc(Number(event.target.value) || 1)))})}/>% 时出现</label><p>低于 {rules.showFrom}% 时隐藏，达到 {rules.showFrom}% 后显示。</p></>}</section>
  </div>;
}

export function CardDisplayPage({initial, initialReminder, onDraftChange, onSave, onClose, saveError: error, onDiscardConflict, agent, botName = 'Bot', groupName = '本群', scopeLabel, completionMode, longTaskMinutes, completionTemplate}: Props & {initial?: CardDisplayDraft; initialReminder?: CompletionReminderDraft & {resetReminder?: true}; onDraftChange?: (value: CardDisplayEditorDraft) => void; onSave: (value: CardDisplayEditorDraft) => Promise<boolean>; onClose: () => void; saveError?: string; onDiscardConflict?: () => void}) {
  const page = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = page.current;
    const host = element?.closest<HTMLElement>('#main-content');
    if (!element || !host) return;
    host.scrollTo({top:0,behavior:'instant'});
    const measure = () => element.style.setProperty('--cds-page-height', `${Math.max(320, host.getBoundingClientRect().bottom - element.getBoundingClientRect().top)}px`);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  const makeInitial = () => structuredClone(withReminderBlock(initial ?? defaultCardDisplay()));
  const [draft, setDraft] = useState(makeInitial);
  const [reminder, setReminder] = useState<CompletionReminderDraft & {resetReminder?: true}>(() => ({completionMode:initialReminder?.completionMode ?? completionMode ?? defaultCompletionReminder().completionMode, longTaskMinutes:initialReminder?.longTaskMinutes ?? longTaskMinutes ?? defaultCompletionReminder().longTaskMinutes, completionTemplate:initialReminder ? initialReminder.completionTemplate : completionTemplate ?? null, ...initialReminder?.resetReminder && {resetReminder:true}}));
  const [past, setPast] = useState<CardDisplayEditorDraft[]>([]);
  const [selected, setSelected] = useState<string>();
  const [reminderOpen, setReminderOpen] = useState(false);
  const reminderInput = useRef<HTMLTextAreaElement>(null);
  const [previewUsage, setPreviewUsage] = useState<number>();
  const [tick, setTick] = useState(0);
  const [reminderRequestedCycle, setReminderRequestedCycle] = useState<number>();
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const [dragged, setDragged] = useState<string>();
  const [dragOrigin, setDragOrigin] = useState<'pool' | 'card'>();
  const [dragPreview, setDragPreview] = useState<{x: number; y: number; width: number}>();
  const [dropSlot, setDropSlot] = useState<string>();
  const [landed, setLanded] = useState<string>();
  const dragGhost = useRef<HTMLDivElement>(null);
  const landingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragCommitted = useRef(false);
  const suppressClick = useRef(false);
  const pointerCleanup = useRef<() => void>(() => {});
  const canvas = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const templateInput = useRef<HTMLTextAreaElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  const sourceFocus = useRef<HTMLElement | null>(null);
  const lastSelected = useRef<string | undefined>(undefined);
  const advanceAllowed = useRef(false);
  const block = draft.blocks.find(item => item.id === selected);
  const scriptCount = customScriptCount(draft);
  const scenes = useMemo(() => [
    {frame: 'thinking' as PreviewFrame}, {frame: 'tool' as PreviewFrame},
    {frame: 'tool' as PreviewFrame, agentIndex:0}, {frame: 'tool' as PreviewFrame, agentIndex:1},
    ...Array.from({length:Math.ceil(streamPreviewLength(streamingPreviewFrames.at(-1)!,streamingLayoutInputs.at(-1)!.parts)/2)}, (_,index) => ({frame:'streaming' as PreviewFrame,streamIndex:(index+1)*2})),
    {frame:'done' as PreviewFrame}, {frame:'done' as PreviewFrame}, {frame:'done' as PreviewFrame}, {frame:'done' as PreviewFrame},
  ], []);
  const scene = scenes[tick % scenes.length]!;
  const frame = draft.reply?.streamText === false ? 'done' : scene.frame;
  const manualReminder = reminder.completionMode === 'manual';
  const reminderBlock = draft.blocks.find(item => item.kind === 'reminder');
  const previewCycle = Math.floor(tick / scenes.length);
  const reminderRequested = manualReminder && reminderRequestedCycle === previewCycle;
  const reminderMessage = completionPreviewText(reminder, {done:frame === 'done',requested:reminderRequested,streamText:draft.reply?.streamText !== false});
  const reminderFailure = reminder.completionMode === 'failures';
  const reminderValues = {task:'介绍 Vonvon Bot', elapsed:'9 秒', status:reminderFailure ? '执行失败' : '已完成', icon:reminderFailure ? '⚠️' : '✅', durationLabel:'用时', detail:reminderFailure ? '详情在上方卡片。' : '结果在上方卡片。'};
  const reminderDefault = defaultCompletionTemplate(reminderValues);
  const reminderTemplate = reminder.completionTemplate ?? reminderDefault;
  const reminderValidation = completionTemplateSchema.safeParse(reminderTemplate);
  const reminderExample = reminderValidation.success ? renderCompletionTemplate(reminderTemplate, reminderValues) : undefined;
  const exampleFrames = manualReminder ? reminderRequested ? toolPreviewFramesRequested : toolPreviewFrames : toolPreviewFramesNonManual;
  const streamFrames = manualReminder ? reminderRequested ? streamingPreviewFramesRequested : streamingPreviewFrames : streamingPreviewFramesNonManual;
  const exampleInputs = manualReminder ? reminderRequested ? toolPreviewLayoutInputsRequested : toolPreviewLayoutInputs : toolPreviewLayoutInputsNonManual;
  const streamInputs = manualReminder ? reminderRequested ? streamingLayoutInputsRequested : streamingLayoutInputs : streamingLayoutInputsNonManual;
  const agentFrames = manualReminder ? reminderRequested ? subagentPreviewFramesRequested : subagentPreviewFrames : subagentPreviewFramesNonManual;
  const agentInputs = manualReminder ? reminderRequested ? subagentPreviewLayoutInputsRequested : subagentPreviewLayoutInputs : subagentPreviewLayoutInputsNonManual;
  const agentIndex = frame === 'tool' && 'agentIndex' in scene ? scene.agentIndex : undefined;
  const streamIndex = frame === 'streaming' && 'streamIndex' in scene ? scene.streamIndex : undefined;
  const cycle = Math.floor(tick / scenes.length) % 3;
  const cycleUsage = cycle === 0 ? undefined : (cycle === 1 ? 96 : 3) + (frame === 'done' ? 1 : 0);
  // A slider adjustment belongs to the whole preview session, including after
  // closing the component sheet or selecting another component.
  const usage = previewUsage ?? cycleUsage;
  const contextPercent = Number((variableData(frame, usage).context as {percent: number}).percent);
  const advancing = !pointerInside && !focusInside && !selected && !dragged && !reminderOpen;
  advanceAllowed.current = advancing;
  const layout = frame === 'streaming' ? streamInputs.at(-1)! : agentIndex !== undefined ? agentInputs[agentIndex]! : exampleInputs[frame];
  const base = frame === 'streaming' ? streamPreviewCard(streamFrames.at(-1)!,layout.parts,streamIndex ?? 0) : agentIndex !== undefined ? agentFrames[agentIndex]! : exampleFrames[frame];
  const lastValidCard = useRef(base);
  const preview = useMemo(() => {
    const result = safeComposeCard(base, draft, frame, usage, layout, lastValidCard.current);
    if (!result.error) lastValidCard.current = result.card;
    return result;
  }, [base, layout, draft, frame, streamIndex, usage, dragged]);
  const card = preview.card;
  const movable = draft.blocks.filter(item => item.kind !== 'tools' && item.kind !== 'thinking' && (item.kind !== 'reminder' || manualReminder));
  const samples = useMemo(() => draft.blocks.filter(item => item.kind !== 'tools' && item.kind !== 'thinking' && (item.kind !== 'reminder' || manualReminder)).map(item => ({block: item, node: exampleNode(item)})), [draft,manualReminder]);
  const sample = useMemo(() => {
    let extra: object = {};
    if (block?.kind === 'custom' && block.source === 'script') {try {extra = JSON.parse(block.sample);} catch {}}
    return {...variableData(frame, usage), ...extra};
  }, [block?.kind, block?.sample, frame, usage]);
  const templateResult = block ? interpolate(block.template, sample) : {text: '', missing: []};


  useEffect(() => {
    if (!advancing) return;
    const timer = setInterval(() => {if (!document.hidden && advanceAllowed.current) setTick(value => value + 1);}, frame === 'streaming' ? 45 : 1400);
    return () => clearInterval(timer);
  }, [advancing,frame]);
  useEffect(() => () => {pointerCleanup.current(); clearTimeout(landingTimer.current);}, []);

  function pauseAtPointer() {
    advanceAllowed.current = false;
    setPointerInside(true);
    const element = canvas.current;
    element?.scrollTo({top: element.scrollTop, behavior: 'instant'});
  }
  function showRunning() {
    if (frame === 'done' && draft.reply?.streamText !== false) setTick(value => Math.floor(value / scenes.length) * scenes.length + 3);
  }

  function edit(next: CardDisplayDraft, nextReminder = reminder) {
    if (JSON.stringify(next) === JSON.stringify(draft) && JSON.stringify(nextReminder) === JSON.stringify(reminder)) return;
    setPast(items => [...items.slice(-29), structuredClone({cardDisplay:draft, ...reminder})]);
    setDraft(next); setReminder(nextReminder); onDraftChange?.({cardDisplay:next, ...nextReminder}); setNotice('');
  }
  function setReminderTemplate(text: string) {
    edit(draft, {...reminder, completionTemplate:text === reminderDefault ? null : text});
  }
  function insertReminderVariable(name: string) {
    const input = reminderInput.current;
    const start = input?.selectionStart ?? reminderTemplate.length;
    const end = input?.selectionEnd ?? start;
    const insertion = `{{${name}}}`;
    setReminderTemplate(reminderTemplate.slice(0, start) + insertion + reminderTemplate.slice(end));
    requestAnimationFrame(() => {input?.focus(); input?.setSelectionRange(start + insertion.length, start + insertion.length);});
  }
  function patch(id: string, value: Partial<CardBlock>) {
    edit({...draft, blocks: draft.blocks.map(item => item.id === id ? {...item, ...value} : item)});
  }
  function setReply(field: 'streamText' | 'collapseAfterRun', value: boolean) {
    if (field === 'streamText') setReminderRequestedCycle(undefined);
    const reply = {streamText: true, collapseAfterRun: true, ...draft.reply, [field]: value};
    let blocks = draft.blocks;
    const processKinds = new Set(['tools', 'thinking', 'time', 'status', 'stop']);
    if (field === 'streamText' && !value && draft.reply?.streamText !== false) {
      reply.flowModes = Object.fromEntries(blocks.filter(item => processKinds.has(item.kind)).map(item => [item.id, item.mode]));
      blocks = blocks.map(item => processKinds.has(item.kind) ? {...item, mode: 'off' as const} : item);
    } else if (field === 'streamText' && value && draft.reply?.streamText === false) {
      const stored = draft.reply.flowModes;
      blocks = blocks.map(item => processKinds.has(item.kind) && stored?.[item.id] ? {...item, mode: stored[item.id]!} : item);
    }
    edit({...draft, blocks, reply});
  }
  function select(id: string) {
    const target = draft.blocks.find(item => item.id === id);
    if (!target) return;
    advanceAllowed.current = false;
    sourceFocus.current = document.activeElement as HTMLElement | null; lastSelected.current = id;
    if (target.kind === 'reminder') setReminderOpen(true);
    else setSelected(id);
    setNotice('');
  }
  function addCustom() {
    if (scriptCount >= 4) {setNotice('最多可添加四个脚本组件。删除一个后可继续添加。'); return;}
    let index = 1;
    while (draft.blocks.some(item => item.id === `custom-${index}`)) index++;
    const next = customBlock(index);
    sourceFocus.current = document.activeElement as HTMLElement | null; lastSelected.current = next.id;
    edit({...draft, blocks: [...draft.blocks, next]}); setSelected(next.id);
  }
  function appearance(value: CardBlock['appearance']) {
    if (!block) return;
    patch(block.id, {appearance: value});
  }
  function insertVariable(name: string) {
    if (!block) return;
    const input = templateInput.current;
    const start = input?.selectionStart ?? block.template.length;
    const end = input?.selectionEnd ?? start;
    const insertion = `{{${name}}}`;
    patch(block.id, {template: block.template.slice(0, start) + insertion + block.template.slice(end)});
    requestAnimationFrame(() => {input?.focus(); input?.setSelectionRange(start + insertion.length, start + insertion.length);});
  }
  function back() {setSelected(undefined); setFocusInside(false);}
  function restoreFocus() {
    if (sourceFocus.current?.isConnected) return sourceFocus.current;
    return [...document.querySelectorAll<HTMLElement>('[data-pool-component]')].find(item => item.dataset.poolComponent === lastSelected.current) ?? true;
  }
  function hide(id = block?.id) {
    if (!id || draft.blocks.some(item => item.id === id && item.kind === 'reminder')) return;
    patch(id, {mode: 'off'}); setSelected(undefined); setFocusInside(false); setNotice('已移回左侧，点一下即可添加。');
  }
  function removeCustom(id = block?.id) {
    if (!id || !draft.blocks.some(item => item.id === id && item.kind === 'custom')) return;
    edit({...draft, blocks: draft.blocks.filter(item => item.id !== id)});
    setSelected(undefined); setFocusInside(false);
    setNotice('已删除自定义组件，可撤销。');
  }
  function add(id: string) {
    const target = draft.blocks.find(item => item.id === id);
    if (!target) return;
    if (target.mode !== 'off') {select(id); return;}
    const mode = defaultCardDisplay().blocks.find(item => item.kind === target.kind)?.mode ?? 'always';
    patch(id, {mode});
    if (mode === 'running') showRunning();
    setNotice('已添加，点卡片中的组件可以设置。');
  }
  function finishDrag() {setDragged(undefined); setDragOrigin(undefined); setDragPreview(undefined); setDropSlot(undefined);}
  function drop(id: string, slot: string) {
    if (dragCommitted.current) return;
    const target = draft.blocks.find(item => item.id === id);
    if (!target || !allowedSlots(target).includes(slot as CardSlot)) return;
    dragCommitted.current = true;
    const mode = target.mode === 'off' ? defaultCardDisplay().blocks.find(item => item.kind === target.kind)?.mode ?? 'always' : target.mode;
    patch(id, {slot: slot as CardSlot, mode}); finishDrag(); setNotice('已放到这个位置，点组件可以继续设置。');
    setLanded(id); clearTimeout(landingTimer.current); landingTimer.current = setTimeout(() => setLanded(undefined), 220);
    if (mode === 'running') showRunning();
  }
  function startPointerDrag(event: ReactPointerEvent<HTMLElement>, id: string, origin: 'pool' | 'card') {
    if (event.button !== 0) return;
    try {event.currentTarget.setPointerCapture?.(event.pointerId);} catch { /* A synthetic pointer may not be active. */ }
    pointerCleanup.current();
    dragCommitted.current = false;
    suppressClick.current = false;
    const startX = event.clientX, startY = event.clientY, pointerId = event.pointerId;
    const pickup = event.currentTarget.getBoundingClientRect();
    const offsetX = startX - pickup.left + 6, offsetY = startY - pickup.top + 6;
    const width = Math.max(52, Math.min(pickup.width + 12, window.innerWidth - 24));
    let moved = false;
    let pointerX = startX, pointerY = startY, scrollAnimation = 0;
    let hoveredSlot: string | undefined;
    const markDrop = () => {
      const slot = document.elementFromPoint(pointerX, pointerY)?.closest('.vcr-drop-zone')?.getAttribute('data-card-slot') ?? undefined;
      if (slot !== hoveredSlot) {hoveredSlot = slot; setDropSlot(slot);}
    };
    const scrollAtEdge = () => {
      const stage = canvas.current;
      if (stage) {
        const bounds = stage.getBoundingClientRect();
        if (pointerX >= bounds.left && pointerX <= bounds.right && pointerY >= bounds.top - 40 && pointerY <= bounds.bottom + 40) {
          const delta = pointerY < bounds.top + 40 ? -Math.min(14, (bounds.top + 40 - pointerY) / 3) : pointerY > bounds.bottom - 40 ? Math.min(14, (pointerY - bounds.bottom + 40) / 3) : 0;
          if (delta) {stage.scrollTop += delta; markDrop();}
        }
      }
      scrollAnimation = requestAnimationFrame(scrollAtEdge);
    };
    const cleanup = () => {cancelAnimationFrame(scrollAnimation);window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', cancel); pointerCleanup.current = () => {};};
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      pointerX = next.clientX; pointerY = next.clientY;
      if (!moved && Math.hypot(next.clientX - startX, next.clientY - startY) < 6) return;
      if (!moved) {moved = true; suppressClick.current = true; advanceAllowed.current = false; flushSync(() => {setDragged(id); setDragOrigin(origin); setLanded(undefined); setDragPreview({x:pointerX-offsetX,y:pointerY-offsetY,width});});scrollAnimation = requestAnimationFrame(scrollAtEdge);}
      if (dragGhost.current) dragGhost.current.style.transform = `translate3d(${pointerX-offsetX}px,${pointerY-offsetY}px,0)`;
      markDrop();
      next.preventDefault();
    };
    const end = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      cleanup();
      if (moved && !dragCommitted.current) {
        const point = document.elementFromPoint(next.clientX, next.clientY);
        const slot = point?.closest('[data-card-slot]')?.getAttribute('data-card-slot');
        if (slot) drop(id, slot);
        else if (origin === 'card' && point?.closest('.cds-pool')) {dragCommitted.current = true; hide(id);}
      }
      finishDrag();
      window.setTimeout(() => {suppressClick.current = false;}, 0);
    };
    const cancel = (next: PointerEvent) => {if (next.pointerId === pointerId) {cleanup(); finishDrag(); suppressClick.current = false;}};
    window.addEventListener('pointermove', move, {passive:false});
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    pointerCleanup.current = cleanup;
  }

  const contextHidden = block?.kind === 'context' && !findComponent(card.body.elements, block.id);
  const component = block ? findComponent(card.body.elements, block.id) ?? exampleNode(block, block.kind === 'context' ? frame : undefined, usage) : undefined;
  const draggedBlock = draft.blocks.find(item => item.id === dragged);
  const draggedNode = draggedBlock ? findComponent(card.body.elements, draggedBlock.id) ?? exampleNode(draggedBlock, undefined, usage) : undefined;
  return <main className="cds-page" ref={page} aria-label="消息卡片设置">
        <header className="cds-page-header today-back"><button type="button" aria-label="返回设置" title="返回设置" disabled={saving} onClick={onClose}><ArrowLeft size={14} aria-hidden="true"/><span>{scopeLabel === '此私聊' ? botName : groupName}</span></button></header>
        <div className="cds-page-content"><div className="card-display-studio"><div className="cds-workbench">
          <aside className="cds-pool" aria-label="组件池" data-return-target={Boolean(dragged && dragOrigin === 'card' && draggedBlock?.kind !== 'reminder')}><div className="cds-pool-title">卡片组件</div><p>拖到右侧，拖回这里隐藏</p>
            {dragged && dragOrigin === 'card' && draggedBlock?.kind !== 'reminder' && <div className="cds-return-cue">放回这里即可隐藏</div>}
            <div className="cds-pool-items">{samples.map(({block: item, node}) => <button type="button" key={item.id} aria-label={item.kind === 'stop' ? '终止按钮' : undefined} onPointerDown={event => startPointerDrag(event,item.id,'pool')} className="cds-pool-item" disabled={(item.kind === 'stop' || item.kind === 'status' || item.kind === 'reminder') && draft.reply?.streamText === false} title={item.kind === 'stop' && draft.reply?.streamText === false ? '终止按钮在流式输出时使用' : undefined} data-shown={item.mode !== 'off'} data-pool-component={item.id} data-dragging={dragged === item.id && dragOrigin === 'pool'} onClick={() => {if (!suppressClick.current) add(item.id);}}>
              {node && <FeishuContentSample node={node}/>}<span className="cds-pool-mark" aria-hidden="true">{item.mode !== 'off' ? <Check size={12}/> : <Plus size={13}/>}</span>
            </button>)}</div>
            <Button size="sm" variant="ghost" icon={<Plus size={14}/>} disabled={scriptCount >= 4} title={scriptCount >= 4 ? '最多四个脚本组件，删除一个后可继续添加' : undefined} onClick={addCustom}>自定义组件 {scriptCount}/4</Button>
            <div className="cds-process-settings"><div className="cds-pool-title">回复行为</div><FormField label="输出方式"><SelectControl label="回复输出方式" value={draft.reply?.streamText === false ? 'final' : 'stream'} options={[{value: 'stream', label: '流式输出'}, {value: 'final', label: '完成后输出'}]} onChange={value => setReply('streamText', value === 'stream')}/></FormField>{draft.blocks.filter(item => item.kind === 'tools' || item.kind === 'thinking').map(item => <Toggle key={item.id} label={item.kind === 'tools' ? '显示工具调用' : '显示思考内容'} checked={item.mode !== 'off'} disabled={draft.reply?.streamText === false} onChange={event => patch(item.id, {mode: event.target.checked ? 'always' : 'off'})}/>)}
              <Toggle label="完成后收起过程" checked={draft.reply?.collapseAfterRun !== false} disabled={draft.reply?.streamText === false} onChange={event => setReply('collapseAfterRun', event.target.checked)}/>
              <FormField label="完成提醒"><SelectControl label="完成提醒" value={reminder.completionMode} options={[{value:'manual',label:'手动'},{value:'long',label:'长任务'},{value:'failures',label:'失败时'},{value:'always',label:'每次'}]} onChange={completionMode => {edit(draft, {...reminder, completionMode});setReminderRequestedCycle(undefined);if(completionMode === 'manual')setTick(0);}}/></FormField>
              {reminder.completionMode === 'long' && <label className="cds-reminder-threshold">超过<input className="settings-field" type="number" aria-label="长任务分钟数" min={1} max={1440} step={1} value={reminder.longTaskMinutes} onChange={event => edit(draft, {...reminder, longTaskMinutes:Number(event.target.value)})}/>分钟提醒</label>}
              <button type="button" className="cds-reminder-content" onClick={() => setReminderOpen(true)}><span>提醒设置</span><span>{manualReminder ? '按钮与内容' : reminder.completionTemplate === null ? '默认' : '自定义'}<ChevronRight size={13}/></span></button>
              <p className="cds-reminder-note">{manualReminder ? draft.reply?.streamText === false ? '完成后输出时不显示手动提醒按钮。' : '点击按钮后，本轮任务结束时会 @ 提问者发送提醒。' : reminder.completionMode === 'long' ? '达到指定时长的任务结束时，会 @ 提问者发送提醒。' : reminder.completionMode === 'always' ? '每次任务结束时，都会 @ 提问者发送提醒。' : '任务失败或超时时，会 @ 提问者发送提醒。'}</p>
            </div>
          </aside>
          <div className="cds-stage" ref={canvas} data-advancing={advancing}>
            <div className="cds-chat"><div className="cds-bot-avatar">{agent ? <AgentAvatar agent={agent}/> : <span className="collaboration-avatar agent" aria-hidden="true"><Bot size={16}/></span>}</div><div className="cds-bot-label"><span>{botName}</span><span className="cds-feishu-bot-tag">智能体</span></div>
              <div className="cds-preview-card" onPointerEnter={pauseAtPointer} onPointerLeave={() => setPointerInside(false)} onPointerDownCapture={() => {pauseAtPointer();setFocusInside(false);}} onKeyDownCapture={() => {advanceAllowed.current=false;setFocusInside(true);}} onFocusCapture={event => {const visible=(event.target as HTMLElement).matches(':focus-visible');if(visible)advanceAllowed.current=false;setFocusInside(visible);}} onBlurCapture={event => {if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusInside(false);}}>
              <FeishuCardPreview key={`${frame}:${draft.reply?.collapseAfterRun !== false}`} card={card} editing showSlots={Boolean(dragged)} draggedComponent={dragOrigin === 'card' ? dragged : undefined} landedComponent={landed} activeDropSlot={dropSlot} editableComponents={movable.map(item => item.id)} allowedDropSlots={draggedBlock ? allowedSlots(draggedBlock) : undefined} onPointerDragStart={(id,event) => startPointerDrag(event,id,'card')} onSelect={id => {if (!suppressClick.current) select(id);}} onRemove={id => hide(id)} nonRemovableComponents={draft.blocks.filter(item => item.kind === 'reminder').map(item => item.id)} onRequestReminder={() => {if (!suppressClick.current) setReminderRequestedCycle(previewCycle);}}/></div>
              {reminderMessage && <div className="cds-completion-message" aria-label="完成提醒消息"><span className="cds-reminder-mention">@提问者</span><span>{reminderMessage}</span></div>}
            </div>
            <div className="cds-hint"><p className="cds-edit-hint"><Pointer size={18} strokeWidth={1.7} aria-hidden="true"/><span>点击卡片内容进行设置，拖动组件调整位置</span></p><p className="cds-preview-status" role="status">{notice || (dragged ? dragOrigin === 'card' && draggedBlock?.kind !== 'reminder' ? '拖动换位置，拖回左侧隐藏。' : '松开放入指定位置。' : pointerInside || focusInside ? '演示已暂停 · 移出卡片后继续' : draft.reply?.streamText === false ? '完成后输出 · 预览最终回复' : '自动演示 · 移入卡片时暂停')}{previewUsage !== undefined && <button type="button" className="cds-usage-reset" onClick={() => setPreviewUsage(undefined)}>恢复自动用量</button>}</p>{preview.error && <p className="cds-preview-error" role="alert">当前草稿暂时无法预览：{preview.error}</p>}</div>
          </div>
        </div></div></div>
        <footer className="cds-page-footer"><div className="cds-footer-actions"><Button size="sm" variant="ghost" icon={<Undo2 size={13}/>} title={past.length ? '撤销上一步修改' : '还没有可撤销的修改'} disabled={!past.length || saving} onClick={() => {const prior = past.at(-1); if (prior) {setDraft(prior.cardDisplay); setReminder({completionMode:prior.completionMode,longTaskMinutes:prior.longTaskMinutes,completionTemplate:prior.completionTemplate,...prior.resetReminder && {resetReminder:true}}); onDraftChange?.(prior); setPast(items => items.slice(0, -1)); setNotice('已撤销上一步修改。');}}}>撤销</Button><Button size="sm" variant="ghost" icon={<RotateCcw size={13}/>} disabled={saving} onClick={() => {edit(defaultCardDisplay(), {...defaultCompletionReminder(),resetReminder:true}); setTick(0);}}>恢复默认</Button></div>{error && <span className="cds-dialog-save-error" role="alert">{error}{onDiscardConflict && <button type="button" disabled={saving} onClick={onDiscardConflict}>使用最新设置并放弃草稿</button>}</span>}<Button size="sm" variant="primary" loading={saving} disabled={saving} onClick={() => {setSaving(true); void onSave(structuredClone({cardDisplay:draft, ...reminder})).finally(() => setSaving(false));}}>保存并完成</Button></footer>
        {dragPreview && draggedNode && createPortal(<div ref={dragGhost} className="cds-drag-ghost" aria-hidden="true" style={{width:"max-content",maxWidth:dragPreview.width,transform:`translate3d(${dragPreview.x}px,${dragPreview.y}px,0)`}}><FeishuContentSample node={draggedNode}/></div>, document.body)}
        <NativeDialog.Root open={reminderOpen} onOpenChange={setReminderOpen}>
          <NativeDialog.Portal><NativeDialog.Backdrop forceRender className="cds-widget-scrim"/><NativeDialog.Viewport className="cds-widget-viewport"><NativeDialog.Popup className="cds-widget-popup">
            <header className="cds-widget-header"><NativeDialog.Title className="cds-widget-title">提醒设置</NativeDialog.Title><NativeDialog.Close className="cds-widget-done">完成</NativeDialog.Close></header>
            <div className="cds-component-settings cds-reminder-editor">
              {manualReminder && reminderBlock && <div className="cds-reminder-button-settings"><h3>卡片中的提醒按钮</h3><p className="cds-process-note">点击卡片中的按钮开启提醒后，本轮任务结束时会 @ 提问者发送提醒。</p><div className="cds-controls-main"><FormField label="未开启提醒时"><input aria-label="提醒按钮文字" className="cds-button-label" maxLength={80} value={reminderBlock.template} onChange={event => patch(reminderBlock.id, {template:event.target.value})}/></FormField><FormField label="已开启提醒时"><input aria-label="提醒按钮点击后文字" className="cds-button-label" maxLength={80} value={reminderBlock.requestedTemplate ?? DEFAULT_REMINDER_REQUESTED_TEMPLATE} onChange={event => patch(reminderBlock.id, {requestedTemplate:event.target.value})}/></FormField></div><p className="cds-process-note">支持 emoji，可在卡片上拖动按钮调整位置。</p></div>}
              <div className="cds-reminder-preview" aria-label="提醒预览"><span className="cds-reminder-mention">@提问者</span><div>{reminderExample ?? '修正下方格式后，即可预览提醒。'}</div></div>
              <div className="cds-template"><label htmlFor="completion-reminder-template">提醒消息内容</label><textarea id="completion-reminder-template" ref={reminderInput} spellCheck={false} value={reminderTemplate} onChange={event => setReminderTemplate(event.target.value)} placeholder="输入提醒内容，可插入下方变量"/><div className="cds-variable-chips" aria-label="提醒内容变量">{[{name:'task',label:'任务名称'},{name:'elapsed',label:'耗时数值'},{name:'status',label:'完成状态'},{name:'statusIcon',label:'状态图标'}].map(variable => <button type="button" key={variable.name} title={`{{${variable.name}}}`} onClick={() => insertReminderVariable(variable.name)}>{variable.label}</button>)}</div></div>
              {!reminderValidation.success && <p className="cds-error" role="alert">{reminderValidation.error.issues.map(issue => issue.message).join('；')}</p>}
              <p className="cds-process-note">「用时」和下方说明可直接改写。变量会自动替换；状态图标对应成功 ✅、失败 ⚠️、超时 ⏱。</p>
            </div>
            <footer className="cds-widget-footer"><Button size="sm" variant="ghost" onClick={() => setReminderTemplate(reminderDefault)}>恢复默认内容</Button></footer>
          </NativeDialog.Popup></NativeDialog.Viewport></NativeDialog.Portal>
        </NativeDialog.Root>
        <NativeDialog.Root open={Boolean(block)} onOpenChange={open => {if (!open) back();}}>
          <NativeDialog.Portal><NativeDialog.Backdrop forceRender className="cds-widget-scrim"/><NativeDialog.Viewport className="cds-widget-viewport"><NativeDialog.Popup className="cds-widget-popup" initialFocus={doneButton} finalFocus={restoreFocus}>
            {block && <><header className="cds-widget-header"><NativeDialog.Title render={<div/>} className="cds-widget-title">{contextHidden ? <span className="cds-context-hidden">{contextPercent}% · {contextPercent < contextRulesFor(block).showFrom ? '未达到显示用量' : '当前阶段不显示'}</span> : component ? <FeishuContentSample node={component}/> : '自定义内容'}</NativeDialog.Title>{block.kind === 'context' && <input className="cds-preview-usage" aria-label="预览上下文用量" title={`预览用量 ${contextPercent}%`} type="range" min={0} max={100} step={1} value={contextPercent} onChange={event => setPreviewUsage(Number(event.target.value))}/>}<NativeDialog.Close ref={doneButton} className="cds-widget-done">完成</NativeDialog.Close></header>
              <div className="cds-component-settings" aria-label="组件设置">
          <div className="cds-controls-main">
            {block.kind === 'status' && <p className="cds-process-note">跟随实际执行状态变化，任务结束后隐藏。</p>}
            {block.kind === 'reminder' && <><FormField label="按钮文字"><input aria-label="提醒按钮文字" className="cds-button-label" maxLength={80} value={block.template} onChange={event => patch(block.id, {template:event.target.value})}/></FormField><p className="cds-process-note">支持 emoji，例如「🔔 完成后提醒我」。拖动按钮调整位置；手动提醒模式下不能隐藏。</p></>}
            {block.kind === 'stop' && <><p className="cds-process-note">仅在流式任务执行时显示。</p><FormField label="样式"><SelectControl label="终止按钮样式" value={block.appearance === 'icon' ? 'icon' : 'text'} options={[{value:'icon',label:'仅图标'},{value:'text',label:'图标与文字'}]} onChange={value => patch(block.id, {appearance:value})}/></FormField>{block.appearance === 'text' && <FormField label="按钮文字"><input aria-label="终止按钮文字" className="cds-button-label" value={block.template} onChange={event => patch(block.id, {template:event.target.value})}/></FormField>}</>}
            {block.kind !== 'status' && block.kind !== 'stop' && block.kind !== 'reminder' && <FormField label="显示阶段"><SelectControl label="所选内容的显示时机" value={block.mode} options={[{value: 'always' as DisplayMode, label: '全程显示'}, {value: 'running' as DisplayMode, label: '仅执行中'}, {value: 'done' as DisplayMode, label: '仅完成后'}]} onChange={mode => patch(block.id, {mode})}/></FormField>}
            {block.kind === 'context' && <FormField label="样式" className="cds-style-field"><div className="cds-style-options" role="group" aria-label="所选内容的样式">{(['text', 'percent', 'bar'] as const).map(value => {
              const option = {...block, appearance: value, contextRules: {...contextRulesFor(block), showFrom: 0}};
              const optionCard = safeComposeCard(base, {version: 1, blocks: [{...option, mode: 'always'}]}, frame, usage, layout);
              const node = optionCard.error ? undefined : findComponent(optionCard.card.body.elements, block.id);
              return <button type="button" key={value} aria-pressed={block.appearance === value} aria-label={value === 'text' ? '完整用量文字' : value === 'percent' ? '仅百分比' : '用量进度条'} onClick={() => appearance(value)}>{node && <FeishuContentSample node={node}/>}</button>;
            })}</div></FormField>}
          </div>
          {block.kind === 'stop' || block.kind === 'reminder' ? null : (block.kind === 'tools' || block.kind === 'thinking') ? <p className="cds-process-note">在执行过程内显示，完成后折叠。</p> : <>
            <details className="cds-more"><summary>更多设置</summary><div className="cds-more-fields">
              <FormField label="字号"><SelectControl label="所选内容的字号" value={block.size} options={[{value: 'notation', label: '小号'}, {value: 'normal', label: '正常'}]} onChange={size => patch(block.id, {size})}/></FormField>
              <FormField label="颜色"><SelectControl label="所选内容的颜色" value={block.color} options={[{value: 'auto', label: block.kind === 'context' ? '按用量变色' : '默认'}, {value: 'grey', label: '固定灰色'}, {value: 'blue', label: '固定蓝色'}]} onChange={color => patch(block.id, {color})}/></FormField>
            </div>
            {block.kind === 'context' && <ContextSettings block={block} onChange={contextRules => patch(block.id, {contextRules})}/>}
            {block.appearance === 'text' && block.kind !== 'status' && <div className="cds-template"><label htmlFor="card-block-template">显示文字</label><textarea id="card-block-template" ref={templateInput} spellCheck={false} value={block.template} onChange={event => patch(block.id, {template: event.target.value})}/><div className="cds-variable-chips" aria-label="可用变量">{variablesFor(block.kind).map(name => <button type="button" key={name} onClick={() => insertVariable(name)}>{name}</button>)}</div>{templateResult.missing.length > 0 && <p className="cds-error" role="status">缺少变量：{templateResult.missing.join('、')}</p>}</div>}
            </details>
            {block.kind === 'custom' && <details className="cds-more"><summary><Code2 size={13}/>自定义脚本</summary><div className="cds-more-fields"><FormField label="脚本类型"><SelectControl presentation="dropdown" label="自定义脚本类型" value={block.language} options={[{value: 'node', label: 'Node.js'}, {value: 'shell', label: 'Shell'}, {value: 'powershell', label: 'PowerShell'}]} onChange={language => patch(block.id, {language})}/></FormField></div><label className="cds-script-label">脚本<textarea aria-label="自定义脚本" spellCheck={false} value={block.script} onChange={event => patch(block.id, {script: event.target.value})}/></label><label className="cds-script-label">样例输出 JSON<textarea aria-label="脚本样例输出" spellCheck={false} value={block.sample} onChange={event => patch(block.id, {sample: event.target.value})}/></label><p className="cds-process-note">界面试用使用样例输出，尚未执行脚本。</p></details>}
          </>}
              </div>{block.kind !== 'reminder' && <footer className="cds-widget-footer"><Button size="sm" variant="ghost" icon={<Minus size={14}/>} onClick={() => hide()}>隐藏组件</Button>{block.kind === 'custom' && <Button size="sm" variant="ghost" icon={<X size={14}/>} onClick={() => removeCustom()}>删除组件</Button>}</footer>}</>}
          </NativeDialog.Popup></NativeDialog.Viewport></NativeDialog.Portal>
        </NativeDialog.Root>
  </main>;
}
