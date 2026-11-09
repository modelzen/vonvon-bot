import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {DEFAULT_COMPLETION_TEMPLATE, renderCompletionTemplate, type SettingsReply} from '@vonvon/protocol';
import {Dialog as NativeDialog} from '@base-ui/react/dialog';
import {Button, SelectControl} from '../src/reference/components/ui';
import {CardDisplayEntry, CardDisplayPage} from '../src/settings/card-display/CardDisplayStudio';
import {FeishuCardPreview} from '../src/settings/card-display/FeishuCardPreview';
import {defaultCardDisplay, type CardDisplayEditorDraft} from '../src/settings/card-display/card-display-model';

type Bank = {state: unknown[]; refs: Array<{current: unknown}>};
const h = vi.hoisted(() => ({banks:{} as Record<string, Bank>, key:'', si:0, ri:0, drafts:new Map<string, any>()}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState:(initial: unknown) => {const bank = h.banks[h.key]!; const i = h.si++; if (!(i in bank.state)) bank.state[i] = typeof initial === 'function' ? initial() : initial; return [bank.state[i], (next: unknown) => {bank.state[i] = typeof next === 'function' ? next(bank.state[i]) : next;}];},
  useRef:(initial: unknown) => h.banks[h.key]!.refs[h.ri++] ??= {current:initial},
  useMemo:(make: () => unknown) => make(), useEffect:() => {}, useLayoutEffect:() => {},
}));
vi.mock('../src/settings/DraftGuard', () => ({useDraft:(active: boolean, draft: any) => {if (active) h.drafts.set(h.key,draft); else h.drafts.delete(h.key);}}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); return isValidElement<Record<string, any>>(node) ? [node,...nodes(node.props.children),...nodes(node.props.trailing)] : [];}
function at<T>(key: string, render: () => T): T {h.key=key; h.banks[key] ??= {state:[],refs:[]}; h.si=h.ri=0; return render();}
function button(tree: ReactNode, text: string) {return nodes(tree).find(node => node.type === Button && nodes(node.props.children).length === 0 && node.props.children === text) ?? nodes(tree).find(node => node.type === Button && Array.isArray(node.props.children) && node.props.children[0] === text);}
const saved = {kind:'saved', result:{kind:'saved'}} as SettingsReply;
function setup(completionMode: 'manual' | 'long' | 'failures' | 'always' = 'manual', completionTemplate: string | null = null) {
  let props = {scopeLabel:'此群聊' as const,saved:null,revision:'r1',completionMode,longTaskMinutes:5,completionTemplate,onSave:vi.fn().mockResolvedValue(saved),onRefresh:vi.fn().mockResolvedValue(undefined)};
  const entry = () => at('entry', () => CardDisplayEntry(props));
  const editorProps = () => (entry() as Element).props;
  const page = () => {const current = editorProps(); return at('page', () => CardDisplayPage(current as Parameters<typeof CardDisplayPage>[0]));};
  button(entry(),'自定义')!.props.onClick();
  const choose = (label: string, value: string) => nodes(page()).find(node => node.type === SelectControl && node.props.label === label)!.props.onChange(value);
  const changed = (): CardDisplayEditorDraft => {entry(); return h.banks.entry!.state[1] as CardDisplayEditorDraft;};
  return {entry,page,choose,changed,editorProps,props,update:(next: Partial<typeof props>) => {props={...props,...next};}};
}
beforeEach(() => {h.banks={}; h.drafts.clear(); vi.clearAllMocks();});

it('saves reminder and card changes together using the original presentation revision', async () => {
  const ui=setup();
  ui.choose('完成提醒','long');
  nodes(ui.page()).find(node => node.type === 'input' && node.props['aria-label'] === '长任务分钟数')!.props.onChange({target:{value:'7'}});
  ui.choose('回复输出方式','final');
  expect(await ui.editorProps().onSave(ui.changed())).toBe(true);
  expect(ui.props.onSave).toHaveBeenCalledOnce();
  const [patch, revision]=ui.props.onSave.mock.calls[0]!;
  expect(revision).toBe('r1'); expect(patch).toMatchObject({completionMode:'long',longTaskMinutes:7,cardDisplay:{reply:{streamText:false}}});
});

it('updates the manual reminder preview immediately and has no process buttons in final-only mode', () => {
  const ui=setup();
  const preview=() => JSON.stringify(nodes(ui.page()).find(node => node.type === FeishuCardPreview)!.props.card);
  expect(preview()).toContain('完成后提醒我');
  ui.choose('完成提醒','always'); expect(preview()).not.toContain('完成后提醒我');
  ui.choose('完成提醒','manual'); expect(preview()).toContain('完成后提醒我');
  ui.choose('回复输出方式','final');
  expect(preview()).not.toContain('完成后提醒我'); expect(preview()).not.toContain('run.stop');
});

it('does not materialize untouched inherited reminder fields when another client changes them', async () => {
  const ui=setup(); ui.choose('回复输出方式','final');
  ui.update({completionMode:'always',longTaskMinutes:9,revision:'r2'});
  await ui.editorProps().onSave(ui.changed());
  const [patch,revision]=ui.props.onSave.mock.calls[0]!;
  expect(revision).toBe('r1'); expect(patch).toHaveProperty('cardDisplay');
  expect(patch).not.toHaveProperty('completionMode'); expect(patch).not.toHaveProperty('longTaskMinutes'); expect(patch).not.toHaveProperty('completionTemplate');
});

it('retains a reminder-only draft after back navigation and saves it through the shared guard', async () => {
  const ui=setup(); ui.choose('完成提醒','always');
  ui.editorProps().onClose(); ui.entry();
  expect(h.drafts.has('entry')).toBe(true);
  expect(await h.drafts.get('entry').save()).toBe(true);
  expect(ui.props.onSave).toHaveBeenCalledExactlyOnceWith({completionMode:'always'},'r1');
});

it('preserves a failed reminder draft and uses conflict values only after explicit discard', async () => {
  const ui=setup(); ui.choose('完成提醒','always');
  ui.props.onSave.mockResolvedValueOnce({kind:'saved',result:{kind:'conflict',current:{value:{stored:{cardDisplay:null},effective:{completionMode:'long',longTaskMinutes:11},revision:'r2'}}}});
  expect(await ui.editorProps().onSave(ui.changed())).toBe(false);
  expect(ui.editorProps().initialReminder.completionMode).toBe('always');
  expect(ui.editorProps().saveError).toContain('草稿已保留');
  ui.editorProps().onDiscardConflict();
  delete h.banks.page;
  button(ui.entry(),'自定义')!.props.onClick();
  expect(ui.editorProps().initialReminder).toMatchObject({completionMode:'long',longTaskMinutes:11});
  ui.choose('完成提醒','manual');
  await ui.editorProps().onSave(ui.changed());
  expect(ui.props.onSave).toHaveBeenLastCalledWith({completionMode:'manual'},'r2');
});

it('undoes reminder edits and restores the real native reminder defaults with the card', async () => {
  const ui=setup(); ui.choose('完成提醒','always');
  button(ui.page(),'撤销')!.props.onClick();
  expect(ui.changed().completionMode).toBe('manual');
  button(ui.page(),'恢复默认')!.props.onClick();
  expect(ui.changed()).toMatchObject({cardDisplay:defaultCardDisplay(),completionMode:'failures',longTaskMinutes:3});
  await ui.editorProps().onSave(ui.changed());
  expect(ui.props.onSave).toHaveBeenCalledExactlyOnceWith({cardDisplay:null,completionMode:'failures',longTaskMinutes:3,completionTemplate:null},'r1');
});


it('edits the reminder format with the shared renderer and retains it after closing and reopening', async () => {
  const ui=setup();
  const content=() => nodes(ui.page()).find(node => node.type === 'button' && node.props.className === 'cds-reminder-content')!;
  const input=() => nodes(ui.page()).find(node => node.type === 'textarea' && node.props.id === 'completion-reminder-template')!;
  content().props.onClick();
  const template='{{icon}} {{task}}，{{status}}！\n花了 {{elapsed}}，快来看看';
  input().props.onChange({target:{value:template}});
  const expected=renderCompletionTemplate(template,{task:'介绍 Vonvon Bot',elapsed:'9 秒',status:'已完成',icon:'✅',durationLabel:'用时',detail:'结果已更新到原任务卡片。'});
  const preview=nodes(ui.page()).find(node => node.props['aria-label'] === '提醒预览')!;
  expect(nodes(preview).some(node => node.props.children === expected)).toBe(true);
  // The first dialog belongs to reminder content; closing its sheet keeps the draft.
  nodes(ui.page()).filter(node => node.type === NativeDialog.Root)[0]!.props.onOpenChange(false);
  content().props.onClick(); expect(input().props.value).toBe(template);
  await ui.editorProps().onSave(ui.changed());
  expect(ui.props.onSave).toHaveBeenCalledExactlyOnceWith({completionTemplate:template},'r1');
});

it('does not save unknown reminder variables or lose the invalid draft', async () => {
  const ui=setup();
  nodes(ui.page()).find(node => node.type === 'textarea' && node.props.id === 'completion-reminder-template')!.props.onChange({target:{value:'完成啦 {{unknown}}'}});
  expect(await ui.editorProps().onSave(ui.changed())).toBe(false);
  expect(ui.props.onSave).not.toHaveBeenCalled();
  expect(ui.editorProps().saveError).toContain('未知提醒变量');
  expect(ui.editorProps().initialReminder.completionTemplate).toBe('完成啦 {{unknown}}');
});

it('keeps an explicit default template after returning to an editor with an older custom prop', () => {
  const ui=setup('manual','旧格式 {{task}}');
  button(ui.page(),'恢复默认内容')!.props.onClick();
  ui.editorProps().onClose(); delete h.banks.page;
  button(ui.entry(),'自定义')!.props.onClick();
  expect(nodes(ui.page()).find(node => node.type === 'textarea' && node.props.id === 'completion-reminder-template')!.props.value).toBe(DEFAULT_COMPLETION_TEMPLATE);
});

it('opens the same reminder settings from the left and the card and saves button and reply text together',async()=>{
  const ui=setup('manual');
  const left=()=>nodes(ui.page()).find(node=>node.type==='button'&&node.props.className==='cds-reminder-content')!;
  expect(nodes(left()).some(node=>node.props.children==='提醒设置')).toBe(true);
  expect(nodes(left()).some(node=>Array.isArray(node.props.children)&&node.props.children.includes('按钮与内容'))).toBe(true);
  left().props.onClick();
  const dialogs=()=>nodes(ui.page()).filter(node=>node.type===NativeDialog.Root);
  expect(dialogs()[0]!.props.open).toBe(true);
  nodes(ui.page()).find(node=>node.props['aria-label']==='提醒按钮文字')!.props.onChange({target:{value:'🎉 做完叫我'}});
  nodes(ui.page()).find(node=>node.props['aria-label']==='提醒按钮点击后文字')!.props.onChange({target:{value:'✅ 好了会通知你'}});
  nodes(ui.page()).find(node=>node.type==='textarea'&&node.props.id==='completion-reminder-template')!.props.onChange({target:{value:'{{statusIcon}} 完成啦，花了 {{elapsed}}'}});
  dialogs()[0]!.props.onOpenChange(false);
  vi.stubGlobal('document',{activeElement:null});
  nodes(ui.page()).find(node=>node.type===FeishuCardPreview)!.props.onSelect('reminder');
  vi.unstubAllGlobals();
  expect(dialogs()[0]!.props.open).toBe(true);
  expect(dialogs()[1]!.props.open).toBe(false);
  expect(nodes(ui.page()).find(node=>node.props['aria-label']==='提醒按钮文字')!.props.value).toBe('🎉 做完叫我');
  await ui.editorProps().onSave(ui.changed());
  const [patch,revision]=ui.props.onSave.mock.calls[0]!;
  expect(revision).toBe('r1');
  expect(patch.completionTemplate).toBe('{{statusIcon}} 完成啦，花了 {{elapsed}}');
  expect(patch.cardDisplay.blocks.find((block:any)=>block.kind==='reminder').template).toBe('🎉 做完叫我');
  expect(patch.cardDisplay.blocks.find((block:any)=>block.kind==='reminder').requestedTemplate).toBe('✅ 好了会通知你');
});
