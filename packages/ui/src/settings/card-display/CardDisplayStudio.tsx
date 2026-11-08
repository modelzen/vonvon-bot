import {useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent} from 'react';
import {flushSync} from 'react-dom';
import {Check, ChevronLeft, ChevronRight, Code2, Minus, Plus, Pointer, RotateCcw, Undo2, X} from 'lucide-react';
import {Dialog as NativeDialog} from '@base-ui/react/dialog';
import {Button, FormField, SelectControl, Toggle} from '../../reference/components/ui';
import {SettingsGroup, SettingsRow} from '../../reference/components/system-settings';
import {useDraft} from '../DraftGuard';
import {cardDisplayConfigSchema, type SettingsReply} from '@vonvon/protocol';
import {settingAnchor} from '../../search';
import {FeishuCardPreview, FeishuContentSample, type CardNode} from './FeishuCardPreview';
import {previewFrames, toolPreviewFrames, streamingPreviewFrames, toolPreviewFramesNonManual, streamingPreviewFramesNonManual, previewLayoutInputs, toolPreviewLayoutInputs, toolPreviewLayoutInputsNonManual, streamingLayoutInputs, streamingLayoutInputsNonManual} from './card-preview-frames';
import {allowedSlots, composeCard, contextRulesFor, currentCardDisplaySnapshot, customBlock, customScriptCount, defaultCardDisplay, interpolate, revisionOnOpen, safeComposeCard, variableData, variablesFor, type CardBlock, type CardDisplayConflictSnapshot, type CardDisplayDraft, type CardSlot, type ContextRules, type DisplayMode, type PreviewFrame} from './card-display-model';
import './card-display-studio.css';

type Props = {botName?: string; groupName?: string; showTools?: boolean; showModel?: string; completionMode?: 'manual' | 'long' | 'failures' | 'always'};
type EntryProps = Props & {level: 'bot' | 'group'; saved: CardDisplayDraft | null | undefined; effective?: CardDisplayDraft | null | undefined;
  revision: string; readonly?: boolean; readonlyMessage?: string; onSave: (value: CardDisplayDraft | null, revision: string) => Promise<SettingsReply>; onRefresh?: () => Promise<void>};
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
  const [draft, setDraft] = useState<CardDisplayDraft>();
  const [editRevision, setEditRevision] = useState(props.revision);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string>();
  const [conflictCurrent, setConflictCurrent] = useState<CardDisplayConflictSnapshot>();
  const [conflicted, setConflicted] = useState(false);
  const working = currentCardDisplaySnapshot(props, conflictCurrent);
  const inherited = working.saved == null;
  const baseline = working.saved ?? working.effective ?? (() => {
    const value = defaultCardDisplay();
    value.blocks.find(block => block.kind === 'tools')!.mode = props.showTools === false ? 'off' : 'always';
    value.blocks.find(block => block.kind === 'model')!.mode = props.showModel === 'off' ? 'off' : props.showModel === 'always' ? 'always' : 'running';
    return value;
  })();
  function noteConflict(reply: SettingsReply) {
    if (reply.kind !== 'saved' || reply.result.kind !== 'conflict') return;
    const current = reply.result.current.value;
    const stored = current.stored as {cardDisplay?: CardDisplayDraft | null};
    const effective = current.effective as {cardDisplay?: CardDisplayDraft | null};
    setConflictCurrent({saved: stored.cardDisplay, effective: effective.cardDisplay, revision: current.revision, parentRevisionAtConflict: props.revision});
    setConflicted(true);
  }
  async function refreshAfterConflict(reply: SettingsReply) {
    if (reply.kind !== 'saved' || reply.result.kind !== 'conflict') return;
    try {await props.onRefresh?.();} catch { /* The parent settings page reports read failures. */ }
  }
  async function save(value: CardDisplayDraft): Promise<boolean> {
    if (JSON.stringify(value) === JSON.stringify(baseline)) {setDraft(undefined); setOpen(false); setError(undefined); setConflictCurrent(undefined); setConflicted(false); return true;}
    const parsed = cardDisplayConfigSchema.safeParse(value);
    if (!parsed.success) {setError(parsed.error.issues.map(issue => `${issue.path.join('.')}：${issue.message}`).join('；')); return false;}
    try {
      const reply = await props.onSave(parsed.data, editRevision);
      noteConflict(reply);
      await refreshAfterConflict(reply);
      const failure = saveError(reply);
      if (failure) {setError(failure); return false;}
      setDraft(undefined); setOpen(false); setError(undefined); setConflictCurrent(undefined); setConflicted(false); return true;
    } catch (failure) {setError(failure instanceof Error ? failure.message : '保存失败，请重试。'); return false;}
  }
  async function reset() {
    setResetting(true); setError(undefined);
    try {
      const reply = await props.onSave(null, working.revision);
      noteConflict(reply);
      await refreshAfterConflict(reply);
      const failure = saveError(reply);
      if (failure) {setError(failure); return;}
      setDraft(undefined); setConflictCurrent(undefined); setConflicted(false);
    } catch (failure) {setError(failure instanceof Error ? failure.message : '恢复失败，请重试。');}
    finally {setResetting(false);}
  }
  function discardConflictedDraft() {
    setDraft(undefined); setOpen(false); setError(undefined); setConflicted(false);
    setEditRevision(working.revision);
    void props.onRefresh?.().catch(() => {});
  }
  useDraft(Boolean(draft), {title: '消息卡片', save: async () => draft ? save(draft) : true, discard: discardConflictedDraft});
  if (open) return <CardDisplayPage {...props} initial={draft ?? baseline} onDraftChange={setDraft} onSave={save} onClose={() => setOpen(false)} saveError={error} onDiscardConflict={conflicted ? discardConflictedDraft : undefined}/>;
  return <>
    <SettingsGroup label="消息卡片" id={settingAnchor('消息卡片')} footer={props.readonlyMessage}>
      <SettingsRow title="回复卡片样式" description={inherited ? props.level === 'group' ? '沿用 Bot 默认样式' : '使用默认样式' : '已自定义；点选卡片里的内容可继续调整'} trailing={<Button size="sm" disabled={props.readonly || Boolean(props.readonlyMessage)} onClick={() => {setError(undefined); setEditRevision(revisionOnOpen(Boolean(draft), editRevision, working.revision)); setOpen(true);}}>自定义<ChevronRight size={13}/></Button>}/>
      {!inherited && <SettingsRow title={props.level === 'group' ? '改回 Bot 设置' : '恢复默认样式'} description="此操作会移除当前样式覆盖" trailing={<Button size="sm" variant="ghost" loading={resetting} disabled={resetting || props.readonly || Boolean(props.readonlyMessage)} onClick={() => void reset()}>{props.level === 'group' ? '继承 Bot' : '恢复默认'}</Button>}/>}
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
  const stage = currentFrame ?? (block.kind === 'tools' || block.kind === 'thinking' ? 'tool' : block.kind === 'status' || block.kind === 'model' || block.kind === 'stop' ? 'streaming' : 'done');
  const base = stage === 'tool' ? toolPreviewFrames.tool : previewFrames[stage];
  const layout = stage === 'tool' ? toolPreviewLayoutInputs.tool : previewLayoutInputs[stage];
  const sampleBlock = block.kind === 'context' ? {...block, contextRules: {...contextRulesFor(block), showFrom: 0}} : block;
  try {
    const card = composeCard(base, {version: 1, blocks: [{...sampleBlock, mode: block.kind === 'status' || block.kind === 'stop' ? 'running' : 'always'}]}, stage, false, usage, layout);
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

export function CardDisplayPage({initial, onDraftChange, onSave, onClose, saveError: error, onDiscardConflict, botName = 'Bot', groupName = '本群', showTools = true, showModel = 'running', completionMode = 'manual'}: Props & {initial?: CardDisplayDraft; onDraftChange?: (value: CardDisplayDraft) => void; onSave: (value: CardDisplayDraft) => Promise<boolean>; onClose: () => void; saveError?: string; onDiscardConflict?: () => void}) {
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
  const makeInitial = () => {
    if (initial) return structuredClone(initial);
    const value = defaultCardDisplay();
    value.blocks.find(block => block.kind === 'tools')!.mode = showTools ? 'always' : 'off';
    value.blocks.find(block => block.kind === 'model')!.mode = showModel === 'off' ? 'off' : showModel === 'always' ? 'always' : 'running';
    return value;
  };
  const [draft, setDraft] = useState(makeInitial);
  const [past, setPast] = useState<CardDisplayDraft[]>([]);
  const [selected, setSelected] = useState<string>();
  const [previewUsage, setPreviewUsage] = useState<number>();
  const [tick, setTick] = useState(0);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const [dragged, setDragged] = useState<string>();
  const [dragOrigin, setDragOrigin] = useState<'pool' | 'card'>();
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
    {frame: 'thinking' as PreviewFrame}, {frame: 'tool' as PreviewFrame}, {frame: 'tool' as PreviewFrame},
    ...streamingPreviewFrames.map((_, streamIndex) => ({frame: 'streaming' as PreviewFrame, streamIndex})),
    {frame: 'done' as PreviewFrame}, {frame: 'done' as PreviewFrame}, {frame: 'done' as PreviewFrame},
  ], []);
  const scene = scenes[tick % scenes.length]!;
  const frame = draft.reply?.streamText === false ? 'done' : scene.frame;
  const manualReminder = completionMode === 'manual';
  const exampleFrames = manualReminder ? toolPreviewFrames : toolPreviewFramesNonManual;
  const streamFrames = manualReminder ? streamingPreviewFrames : streamingPreviewFramesNonManual;
  const exampleInputs = manualReminder ? toolPreviewLayoutInputs : toolPreviewLayoutInputsNonManual;
  const streamInputs = manualReminder ? streamingLayoutInputs : streamingLayoutInputsNonManual;
  const streamIndex = frame === 'streaming' && 'streamIndex' in scene ? scene.streamIndex : undefined;
  const cycle = Math.floor(tick / scenes.length) % 3;
  const cycleUsage = cycle === 0 ? undefined : (cycle === 1 ? 96 : 3) + (frame === 'done' ? 1 : 0);
  // A slider adjustment belongs to the whole preview session, including after
  // closing the component sheet or selecting another component.
  const usage = previewUsage ?? cycleUsage;
  const contextPercent = Number((variableData(frame, usage).context as {percent: number}).percent);
  const advancing = !pointerInside && !focusInside && !selected && !dragged;
  advanceAllowed.current = advancing;
  const base = frame === 'streaming' ? streamFrames[streamIndex ?? 0]! : exampleFrames[frame];
  const layout = frame === 'streaming' ? streamInputs[streamIndex ?? 0]! : exampleInputs[frame];
  const lastValidCard = useRef(base);
  const preview = useMemo(() => {
    const result = safeComposeCard(base, draft, frame, usage, layout, lastValidCard.current);
    if (!result.error) lastValidCard.current = result.card;
    return result;
  }, [base, layout, draft, frame, streamIndex, usage, dragged]);
  const card = preview.card;
  const movable = draft.blocks.filter(item => item.kind !== 'tools' && item.kind !== 'thinking');
  const samples = useMemo(() => draft.blocks.filter(item => item.kind !== 'tools' && item.kind !== 'thinking').map(item => ({block: item, node: exampleNode(item)})), [draft]);
  const sample = useMemo(() => {
    let extra: object = {};
    if (block?.kind === 'custom' && block.source === 'script') {try {extra = JSON.parse(block.sample);} catch {}}
    return {...variableData(frame, usage), ...extra};
  }, [block?.kind, block?.sample, frame, usage]);
  const templateResult = block ? interpolate(block.template, sample) : {text: '', missing: []};


  useEffect(() => {
    if (!advancing) return;
    const timer = setInterval(() => {if (!document.hidden && advanceAllowed.current) setTick(value => value + 1);}, 1400);
    return () => clearInterval(timer);
  }, [advancing]);
  useEffect(() => () => pointerCleanup.current(), []);

  function pauseAtPointer() {
    advanceAllowed.current = false;
    setPointerInside(true);
    const element = canvas.current;
    element?.scrollTo({top: element.scrollTop, behavior: 'instant'});
  }
  function showRunning() {
    if (frame === 'done' && draft.reply?.streamText !== false) setTick(value => Math.floor(value / scenes.length) * scenes.length + 3);
  }

  function edit(next: CardDisplayDraft) {
    if (JSON.stringify(next) === JSON.stringify(draft)) return;
    setPast(items => [...items.slice(-29), structuredClone(draft)]);
    setDraft(next); onDraftChange?.(next); setNotice('');
  }
  function patch(id: string, value: Partial<CardBlock>) {
    edit({...draft, blocks: draft.blocks.map(item => item.id === id ? {...item, ...value} : item)});
  }
  function setReply(field: 'streamText' | 'collapseAfterRun', value: boolean) {
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
    setSelected(id); setNotice('');
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
    if (!id) return;
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
  function finishDrag() {setDragged(undefined); setDragOrigin(undefined);}
  function drop(id: string, slot: string) {
    if (dragCommitted.current) return;
    const target = draft.blocks.find(item => item.id === id);
    if (!target || !allowedSlots(target).includes(slot as CardSlot)) return;
    dragCommitted.current = true;
    const mode = target.mode === 'off' ? defaultCardDisplay().blocks.find(item => item.kind === target.kind)?.mode ?? 'always' : target.mode;
    patch(id, {slot: slot as CardSlot, mode}); finishDrag(); setNotice('已放到这个位置，点组件可以继续设置。');
    if (mode === 'running') showRunning();
  }
  function startPointerDrag(event: ReactPointerEvent<HTMLElement>, id: string, origin: 'pool' | 'card') {
    if (event.button !== 0) return;
    try {event.currentTarget.setPointerCapture?.(event.pointerId);} catch { /* A synthetic pointer may not be active. */ }
    pointerCleanup.current();
    dragCommitted.current = false;
    suppressClick.current = false;
    const startX = event.clientX, startY = event.clientY, pointerId = event.pointerId;
    let moved = false;
    let pointerX = startX, pointerY = startY, scrollAnimation = 0;
    const scrollAtEdge = () => {
      const stage = canvas.current;
      if (stage) {
        const bounds = stage.getBoundingClientRect();
        if (pointerX >= bounds.left && pointerX <= bounds.right && pointerY >= bounds.top - 40 && pointerY <= bounds.bottom + 40) {
          const delta = pointerY < bounds.top + 40 ? -Math.min(14, (bounds.top + 40 - pointerY) / 3) : pointerY > bounds.bottom - 40 ? Math.min(14, (pointerY - bounds.bottom + 40) / 3) : 0;
          if (delta) stage.scrollTop += delta;
        }
      }
      scrollAnimation = requestAnimationFrame(scrollAtEdge);
    };
    const cleanup = () => {cancelAnimationFrame(scrollAnimation);window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', cancel); pointerCleanup.current = () => {};};
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      pointerX = next.clientX; pointerY = next.clientY;
      if (!moved && Math.hypot(next.clientX - startX, next.clientY - startY) < 6) return;
      if (!moved) {moved = true; suppressClick.current = true; advanceAllowed.current = false; flushSync(() => {setDragged(id); setDragOrigin(origin);});scrollAnimation = requestAnimationFrame(scrollAtEdge);}
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
    const cancel = (next: PointerEvent) => {if (next.pointerId === pointerId) {cleanup(); finishDrag();}};
    window.addEventListener('pointermove', move, {passive:false});
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    pointerCleanup.current = cleanup;
  }

  const contextHidden = block?.kind === 'context' && !findComponent(card.body.elements, block.id);
  const component = block ? findComponent(card.body.elements, block.id) ?? exampleNode(block, block.kind === 'context' ? frame : undefined, usage) : undefined;
  const draggedBlock = draft.blocks.find(item => item.id === dragged);
  return <main className="cds-page" ref={page} aria-label="消息卡片设置">
        <header className="cds-page-header"><Button size="sm" variant="ghost" icon={<ChevronLeft size={16}/>} aria-label="返回设置" title="返回设置" disabled={saving} onClick={onClose}/><h2>消息卡片</h2><p>{groupName} · {botName}</p></header>
        <div className="cds-page-content"><div className="card-display-studio"><div className="cds-workbench">
          <aside className="cds-pool" aria-label="组件池" data-return-target={Boolean(dragged && dragOrigin === 'card')}><div className="cds-pool-title">卡片组件</div><p>拖到右侧，拖回这里隐藏</p>
            {dragged && dragOrigin === 'card' && <div className="cds-return-cue">放回这里即可隐藏</div>}
            <div className="cds-pool-items">{samples.map(({block: item, node}) => <button type="button" key={item.id} aria-label={item.kind === 'stop' ? '终止按钮' : undefined} onPointerDown={event => startPointerDrag(event,item.id,'pool')} className="cds-pool-item" disabled={(item.kind === 'stop' || item.kind === 'status') && draft.reply?.streamText === false} title={item.kind === 'stop' && draft.reply?.streamText === false ? '终止按钮在流式输出时使用' : undefined} data-shown={item.mode !== 'off'} data-pool-component={item.id} onClick={() => {if (!suppressClick.current) add(item.id);}}>
              {node && <FeishuContentSample node={node}/>}<span className="cds-pool-mark" aria-hidden="true">{item.mode !== 'off' ? <Check size={12}/> : <Plus size={13}/>}</span>
            </button>)}</div>
            <Button size="sm" variant="ghost" icon={<Plus size={14}/>} disabled={scriptCount >= 4} title={scriptCount >= 4 ? '最多四个脚本组件，删除一个后可继续添加' : undefined} onClick={addCustom}>自定义组件 {scriptCount}/4</Button>
            <div className="cds-process-settings"><div className="cds-pool-title">回复行为</div><FormField label="输出方式"><SelectControl label="回复输出方式" value={draft.reply?.streamText === false ? 'final' : 'stream'} options={[{value: 'stream', label: '流式输出'}, {value: 'final', label: '完成后输出'}]} onChange={value => setReply('streamText', value === 'stream')}/></FormField>{draft.blocks.filter(item => item.kind === 'tools' || item.kind === 'thinking').map(item => <Toggle key={item.id} label={item.kind === 'tools' ? '显示工具调用' : '显示思考内容'} checked={item.mode !== 'off'} disabled={draft.reply?.streamText === false} onChange={event => patch(item.id, {mode: event.target.checked ? 'always' : 'off'})}/>)}<details className="cds-reply-more"><summary>更多</summary><Toggle label="完成后收起过程" checked={draft.reply?.collapseAfterRun !== false} onChange={event => setReply('collapseAfterRun', event.target.checked)}/><p className="cds-reminder-note">{manualReminder ? '完成提醒：手动。预览中的「完成后提醒我」是实际卡片按钮。' : '完成提醒由外层设置决定；当前策略下，卡片不显示手动提醒按钮。'}</p></details></div>
          </aside>
          <div className="cds-stage" ref={canvas} data-advancing={advancing}>
            <div className="cds-chat"><div className="cds-bot-label"><img src="./vonvon-logo.png" alt=""/><span>{botName}</span><span className="cds-feishu-bot-tag">机器人</span></div>
              <div className="cds-preview-card" onPointerEnter={pauseAtPointer} onPointerLeave={() => setPointerInside(false)} onPointerDownCapture={() => {pauseAtPointer();setFocusInside(false);}} onKeyDownCapture={() => {advanceAllowed.current=false;setFocusInside(true);}} onFocusCapture={event => {const visible=(event.target as HTMLElement).matches(':focus-visible');if(visible)advanceAllowed.current=false;setFocusInside(visible);}} onBlurCapture={event => {if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusInside(false);}}>
              <FeishuCardPreview key={`${frame}:${streamIndex ?? 0}:${draft.reply?.collapseAfterRun !== false}`} card={card} editing showSlots={Boolean(dragged)} editableComponents={movable.map(item => item.id)} allowedDropSlots={draggedBlock ? allowedSlots(draggedBlock) : undefined} onPointerDragStart={(id,event) => startPointerDrag(event,id,'card')} onSelect={id => {if (!suppressClick.current) select(id);}} onRemove={id => hide(id)}/></div>
            </div>
            <div className="cds-hint"><p className="cds-edit-hint"><Pointer size={18} strokeWidth={1.7} aria-hidden="true"/><span>点击卡片内容进行设置，拖动组件调整位置</span></p><p className="cds-preview-status" role="status">{notice || (dragged ? dragOrigin === 'card' ? '拖动换位置，拖回左侧隐藏。' : '松开放入指定位置。' : pointerInside || focusInside ? '演示已暂停 · 移出卡片后继续' : draft.reply?.streamText === false ? '完成后输出 · 预览最终回复' : '自动演示 · 移入卡片时暂停')}{previewUsage !== undefined && <button type="button" className="cds-usage-reset" onClick={() => setPreviewUsage(undefined)}>恢复自动用量</button>}</p>{preview.error && <p className="cds-preview-error" role="alert">当前草稿暂时无法预览：{preview.error}</p>}</div>
          </div>
        </div></div></div>
        <footer className="cds-page-footer"><div className="cds-footer-actions"><Button size="sm" variant="ghost" icon={<Undo2 size={13}/>} title={past.length ? '撤销上一步修改' : '还没有可撤销的修改'} disabled={!past.length || saving} onClick={() => {const prior = past.at(-1); if (prior) {setDraft(prior); onDraftChange?.(prior); setPast(items => items.slice(0, -1)); setNotice('已撤销上一步修改。');}}}>撤销</Button><Button size="sm" variant="ghost" icon={<RotateCcw size={13}/>} disabled={saving} onClick={() => {edit(defaultCardDisplay()); setTick(0);}}>恢复默认</Button></div>{error && <span className="cds-dialog-save-error" role="alert">{error}{onDiscardConflict && <button type="button" disabled={saving} onClick={onDiscardConflict}>使用最新设置并放弃草稿</button>}</span>}<Button size="sm" variant="primary" loading={saving} disabled={saving} onClick={() => {setSaving(true); void onSave(structuredClone(draft)).finally(() => setSaving(false));}}>保存并完成</Button></footer>
        <NativeDialog.Root open={Boolean(block)} onOpenChange={open => {if (!open) back();}}>
          <NativeDialog.Portal><NativeDialog.Backdrop forceRender className="cds-widget-scrim"/><NativeDialog.Viewport className="cds-widget-viewport"><NativeDialog.Popup className="cds-widget-popup" initialFocus={doneButton} finalFocus={restoreFocus}>
            {block && <><header className="cds-widget-header"><NativeDialog.Title render={<div/>} className="cds-widget-title">{contextHidden ? <span className="cds-context-hidden">{contextPercent}% · {contextPercent < contextRulesFor(block).showFrom ? '未达到显示用量' : '当前阶段不显示'}</span> : component ? <FeishuContentSample node={component}/> : '自定义内容'}</NativeDialog.Title>{block.kind === 'context' && <input className="cds-preview-usage" aria-label="预览上下文用量" title={`预览用量 ${contextPercent}%`} type="range" min={0} max={100} step={1} value={contextPercent} onChange={event => setPreviewUsage(Number(event.target.value))}/>}<NativeDialog.Close ref={doneButton} className="cds-widget-done">完成</NativeDialog.Close></header>
              <div className="cds-component-settings" aria-label="组件设置">
          <div className="cds-controls-main">
            {block.kind === 'status' && <p className="cds-process-note">跟随实际执行状态变化，任务结束后隐藏。</p>}
            {block.kind === 'stop' && <><p className="cds-process-note">仅在流式任务执行时显示。</p><FormField label="样式"><SelectControl label="终止按钮样式" value={block.appearance === 'icon' ? 'icon' : 'text'} options={[{value:'icon',label:'仅图标'},{value:'text',label:'图标与文字'}]} onChange={value => patch(block.id, {appearance:value})}/></FormField>{block.appearance === 'text' && <FormField label="按钮文字"><input aria-label="终止按钮文字" className="cds-button-label" value={block.template} onChange={event => patch(block.id, {template:event.target.value})}/></FormField>}</>}
            {block.kind !== 'status' && block.kind !== 'stop' && <FormField label="显示阶段"><SelectControl label="所选内容的显示时机" value={block.mode} options={[{value: 'always' as DisplayMode, label: '全程显示'}, {value: 'running' as DisplayMode, label: '仅执行中'}, {value: 'done' as DisplayMode, label: '仅完成后'}]} onChange={mode => patch(block.id, {mode})}/></FormField>}
            {block.kind === 'context' && <FormField label="样式" className="cds-style-field"><div className="cds-style-options" role="group" aria-label="所选内容的样式">{(['text', 'percent', 'bar'] as const).map(value => {
              const option = {...block, appearance: value, contextRules: {...contextRulesFor(block), showFrom: 0}};
              const optionCard = safeComposeCard(base, {version: 1, blocks: [{...option, mode: 'always'}]}, frame, usage, layout);
              const node = optionCard.error ? undefined : findComponent(optionCard.card.body.elements, block.id);
              return <button type="button" key={value} aria-pressed={block.appearance === value} aria-label={value === 'text' ? '完整用量文字' : value === 'percent' ? '仅百分比' : '用量进度条'} onClick={() => appearance(value)}>{node && <FeishuContentSample node={node}/>}</button>;
            })}</div></FormField>}
          </div>
          {block.kind === 'stop' ? null : (block.kind === 'tools' || block.kind === 'thinking') ? <p className="cds-process-note">在执行过程内显示，完成后折叠。</p> : <>
            <details className="cds-more"><summary>更多设置</summary><div className="cds-more-fields">
              <FormField label="字号"><SelectControl label="所选内容的字号" value={block.size} options={[{value: 'notation', label: '小号'}, {value: 'normal', label: '正常'}]} onChange={size => patch(block.id, {size})}/></FormField>
              <FormField label="颜色"><SelectControl label="所选内容的颜色" value={block.color} options={[{value: 'auto', label: block.kind === 'context' ? '按用量变色' : '默认'}, {value: 'grey', label: '固定灰色'}, {value: 'blue', label: '固定蓝色'}]} onChange={color => patch(block.id, {color})}/></FormField>
            </div>
            {block.kind === 'context' && <ContextSettings block={block} onChange={contextRules => patch(block.id, {contextRules})}/>}
            {block.appearance === 'text' && block.kind !== 'status' && <div className="cds-template"><label htmlFor="card-block-template">显示文字</label><textarea id="card-block-template" ref={templateInput} spellCheck={false} value={block.template} onChange={event => patch(block.id, {template: event.target.value})}/><div className="cds-variable-chips" aria-label="可用变量">{variablesFor(block.kind).map(name => <button type="button" key={name} onClick={() => insertVariable(name)}>{name}</button>)}</div>{templateResult.missing.length > 0 && <p className="cds-error" role="status">缺少变量：{templateResult.missing.join('、')}</p>}</div>}
            </details>
            {block.kind === 'custom' && <details className="cds-more"><summary><Code2 size={13}/>自定义脚本</summary><div className="cds-more-fields"><FormField label="脚本类型"><SelectControl presentation="dropdown" label="自定义脚本类型" value={block.language} options={[{value: 'node', label: 'Node.js'}, {value: 'shell', label: 'Shell'}, {value: 'powershell', label: 'PowerShell'}]} onChange={language => patch(block.id, {language})}/></FormField></div><label className="cds-script-label">脚本<textarea aria-label="自定义脚本" spellCheck={false} value={block.script} onChange={event => patch(block.id, {script: event.target.value})}/></label><label className="cds-script-label">样例输出 JSON<textarea aria-label="脚本样例输出" spellCheck={false} value={block.sample} onChange={event => patch(block.id, {sample: event.target.value})}/></label><p className="cds-process-note">界面试用使用样例输出，尚未执行脚本。</p></details>}
          </>}
              </div><footer className="cds-widget-footer"><Button size="sm" variant="ghost" icon={<Minus size={14}/>} onClick={() => hide()}>隐藏组件</Button>{block.kind === 'custom' && <Button size="sm" variant="ghost" icon={<X size={14}/>} onClick={() => removeCustom()}>删除组件</Button>}</footer></>}
          </NativeDialog.Popup></NativeDialog.Viewport></NativeDialog.Portal>
        </NativeDialog.Root>
  </main>;
}
