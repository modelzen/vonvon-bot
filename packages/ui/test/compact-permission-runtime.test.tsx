import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {Editor, NativePermissionEditor, PermissionFields, PermissionSummary, type Section} from '../src/settings/SettingsPanel';
import {ExecutionPermissionSummary} from '../src/settings/GroupSettingsSummary';
import {Dialog} from '../src/reference/components/ui/Dialog';
import {NativePermissionFields} from '../src/settings/NativePermissionFields';
import {SettingChoices} from '../src/settings/SettingChoices';
import {permissionValue} from './permission-fixture';

type Slot = {state: unknown[]; refs: Array<{current: unknown}>; si: number; ri: number};
const h = vi.hoisted(() => ({slots: {} as Record<string, Slot>, guards: {} as Record<string, boolean>, active: ''}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const slot = h.slots[h.active]!; const i = slot.si++; if (!(i in slot.state)) slot.state[i] = typeof initial === 'function' ? initial() : initial; return [slot.state[i], (next: unknown) => {slot.state[i] = typeof next === 'function' ? next(slot.state[i]) : next;}];},
  useRef: (initial: unknown) => {const slot = h.slots[h.active]!; return slot.refs[slot.ri++] ??= {current: initial};},
  useContext: () => [], useEffect: () => {},
}));
vi.mock('../src/settings/DraftGuard', () => ({useDraft: (dirty: boolean) => {h.guards[h.active] = dirty;}}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  if (node.type === Dialog && !node.props.open) return [node];
  if (node.type === ExecutionPermissionSummary) return [node, ...nodes(ExecutionPermissionSummary(node.props as Parameters<typeof ExecutionPermissionSummary>[0]))];
  return [node, ...nodes(node.props.children), ...nodes(node.props.footer), ...nodes(node.props.trailing)];
}
function at(name: string, make: () => ReactNode) {
  const slot = h.slots[name] ??= {state: [], refs: [], si: 0, ri: 0};
  h.active = name; slot.si = slot.ri = 0;
  return nodes(make());
}
const button = (all: Element[], text: string) => all.find(node => node.props.children === text && node.props.onClick)!;
const stored = () => {
  const value = permissionValue('write');
  value.custom = {sandbox: 'workspace-write', network: false};
  value.options.customSummary = '允许改工作区文件，不联网';
  value.options.fields = [{key: 'network', label: '允许联网', native: 'network', kind: 'switch'}];
  value.options.expanded.write = {sandbox: 'workspace-write', network: true};
  return value;
};
function setup(save: ReturnType<typeof vi.fn>, access: Section<ReturnType<typeof stored>>['access'] = {kind: 'writable'}) {
  const value = stored();
  const section = {stored: value, effective: value, revision: 'r1', access, apply: []};
  // AnimatePresence may retain a closed or replaced editor during its exit. Keep
  // those mounted instances, with React's key identity, until the test ends.
  const retainedEditors = new Map<string, Element>();
  function render() {
    const summary = at('summary', () => PermissionSummary({section, provider: 'Codex', save}));
    const editorNode = summary.find(node => node.type === Editor);
    const editorKey = editorNode ? `editor:${editorNode.key ?? 'unkeyed'}` : undefined;
    if (editorNode && editorKey) retainedEditors.set(editorKey, editorNode);
    const renderedEditors = new Map([...retainedEditors].map(([key, retained]) => [key, at(key, () => Editor(retained.props as any))]));
    const editor = editorKey ? renderedEditors.get(editorKey)! : [];
    const dialog = editor.find(node => node.type === Dialog)!;
    const fields = editor.find(node => node.type === PermissionFields);
    const fieldNodes = fields ? nodes(PermissionFields(fields.props as any)) : [];
    return {summary: [...summary, ...editor], dialog, editor, fields, native: fieldNodes.find(node => node.type === NativePermissionFields), choices: fieldNodes.find(node => node.type === SettingChoices)};
  }
  return {section, render};
}
async function flush() {for (let i = 0; i < 12; i++) await Promise.resolve();}
beforeEach(() => {h.slots = {}; h.guards = {}; vi.clearAllMocks();});

it('shows a custom permission summary, edits tiers locally and saves only the chosen mode', async () => {
  const save = vi.fn(); const {section, render} = setup(save);
  save.mockImplementation(async patch => ({kind: 'saved', result: {kind: 'saved', section: {value: {...section, stored: {...section.stored, ...patch, custom: null}, revision: 'r2'}}, effects: []}}));
  let ui = render();
  expect(ui.dialog.props.open).toBe(false); expect(ui.fields).toBeUndefined();
  expect(ui.summary.some(node => node.type === NativePermissionEditor)).toBe(false);
  button(ui.summary, '修改权限').props.onClick(); ui = render();
  ui.fields!.props.onChange({mode: 'full'}); ui = render();
  expect(ui.fields!.props.value).toMatchObject({mode: 'full', custom: null});
  expect(save).not.toHaveBeenCalled();
  expect(section.stored.custom).toEqual({sandbox: 'workspace-write', network: false});
  button(ui.editor, '保存权限').props.onClick(); await flush(); ui = render();
  expect(save.mock.calls).toEqual([[{mode: 'full'}, 'r1']]);
  expect(ui.dialog.props.open).toBe(false);
});

it.each(['cancel', 'dismiss'] as const)('discards an unconfirmed tier on %s without touching native custom settings', action => {
  const save = vi.fn(); const {render} = setup(save);
  let ui = render(); button(ui.summary, '修改权限').props.onClick(); ui = render();
  ui.fields!.props.onChange({mode: 'full'}); ui = render();
  if (action === 'cancel') button(ui.summary, '取消').props.onClick(); else ui.dialog.props.onClose();
  ui = render(); expect(ui.dialog.props.open).toBe(false); expect(save).not.toHaveBeenCalled();
  expect(Object.values(h.guards).some(Boolean)).toBe(false);
  button(ui.summary, '修改权限').props.onClick(); ui = render();
  expect(ui.fields!.props.value).toMatchObject({mode: 'write', custom: {sandbox: 'workspace-write', network: false}});
});

it.each(['cancel', 'dismiss'] as const)('reopens from confirmed permissions immediately after %s while the outgoing editor is retained', action => {
  const save = vi.fn(); const {render} = setup(save);
  let ui = render(); button(ui.summary, '修改权限').props.onClick(); ui = render();
  ui.fields!.props.onChange({mode: 'full'}); ui = render();
  expect(Object.values(h.guards).some(Boolean)).toBe(true);
  if (action === 'cancel') button(ui.summary, '取消').props.onClick(); else ui.dialog.props.onClose();
  // Reopen before rendering a closed frame or allowing the exit animation to end.
  button(ui.summary, '修改权限').props.onClick(); ui = render();
  expect(ui.dialog.props.open).toBe(true);
  expect(ui.fields!.props.value).toMatchObject({mode: 'write', custom: {sandbox: 'workspace-write', network: false}});
  expect(button(ui.editor, '保存权限').props.disabled).toBe(true);
  expect(Object.values(h.guards).some(Boolean)).toBe(false);
  expect(save).not.toHaveBeenCalled();
});

it('retains a failed permission draft for retry and disables dismissal while saving', async () => {
  const save = vi.fn().mockResolvedValueOnce({kind: 'saved', result: {kind: 'rejected', fields: [{field: 'mode', message: '当前权限不可用'}]}});
  const {section, render} = setup(save);
  let ui = render(); button(ui.summary, '修改权限').props.onClick(); ui = render();
  ui.fields!.props.onChange({mode: 'full'}); ui = render();
  button(ui.editor, '保存权限').props.onClick(); await flush(); ui = render();
  expect(ui.dialog.props.open).toBe(true); expect(ui.fields!.props.value.mode).toBe('full');
  expect(ui.editor.find(node => node.props.title === '保存未完成')?.props.children).toContain('mode：当前权限不可用');
  let finish!: (reply: unknown) => void;
  save.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  button(ui.editor, '保存权限').props.onClick(); ui = render();
  expect(ui.dialog.props.onClose).toBeUndefined(); expect(button(ui.summary, '取消').props.disabled).toBe(true);
  expect(button(ui.editor, '保存权限').props.disabled).toBe(true);
  finish({kind: 'saved', result: {kind: 'saved', section: {value: {...section, stored: {...section.stored, mode: 'full', custom: null}, revision: 'r2'}}, effects: []}});
  await flush(); ui = render();
  expect(save.mock.calls).toEqual([[{mode: 'full'}, 'r1'], [{mode: 'full'}, 'r1']]);
  expect(ui.dialog.props.open).toBe(false);
});

it('opens readonly permissions for inspection without permitting a save', () => {
  const save = vi.fn(); const reason = 'Provider 尚未连接，仅可查看当前权限';
  const {render} = setup(save, {kind: 'readonly', reason: 'offline', message: reason});
  let ui = render(); button(ui.summary, '查看权限').props.onClick(); ui = render();
  expect(ui.dialog.props.description).toBe(reason);
  expect(ui.fields!.props.disabled).toBe(true);
  expect(ui.native!.props.disabled).toBe(true);
  expect(button(ui.editor, '保存权限').props.disabled).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

it('selects custom from the draft preset and saves only visible native fields', async () => {
  const save = vi.fn(); const {section, render} = setup(save);
  section.stored.custom = null;
  section.stored.options.fields.push({key: 'domains', label: '允许的网站', native: 'allowedDomains', kind: 'domains', showWhen: {key: 'network', in: [true]}});
  section.stored.options.expanded.full = {network: true, domains: ['example.com'], hidden: 'never send'};
  save.mockResolvedValue({kind: 'saved', result: {kind: 'saved', section: {value: {...section, revision: 'r2'}}, effects: []}});
  let ui = render(); button(ui.summary, '修改权限').props.onClick(); ui = render();
  ui.choices!.props.onChange('full'); ui = render();
  ui.choices!.props.onChange('custom'); ui = render();
  expect(ui.native!.props.value).toEqual({network: true, domains: ['example.com'], hidden: 'never send'});
  expect(ui.choices!.props.value).toBe('custom');
  ui.native!.props.onChange({...ui.native!.props.value, network: false}); ui = render();
  button(ui.editor, '保存权限').props.onClick(); await flush(); ui = render();
  expect(save.mock.calls).toEqual([[{custom: {network: false}}, 'r1']]);
  expect(ui.dialog.props.open).toBe(false);
});

it('saves the full custom selection after a preset round trip restores the original native values', async () => {
  const save = vi.fn().mockResolvedValue({kind: 'refused', message: '保留草稿'});
  const {section, render} = setup(save);
  section.stored.options.fields.unshift({key: 'sandbox', label: '沙箱', native: 'sandbox', kind: 'choice', choices: [
    {value: 'workspace-write', label: '工作区', native: 'workspace-write'},
    {value: 'danger-full-access', label: '完全访问', native: 'danger-full-access'},
  ]});
  section.stored.options.expanded.full = {sandbox: 'danger-full-access', network: true};
  const originalCustom = {...section.stored.custom!};
  let ui = render(); button(ui.summary, '修改权限').props.onClick(); ui = render();
  ui.choices!.props.onChange('full'); ui = render();
  ui.choices!.props.onChange('custom'); ui = render();
  ui.native!.props.onChange(originalCustom); ui = render();
  expect(ui.choices!.props.value).toBe('custom');
  expect(ui.fields!.props.value).toMatchObject({mode: 'full', custom: originalCustom});
  button(ui.editor, '保存权限').props.onClick(); await flush();
  expect(save.mock.calls).toEqual([[{custom: originalCustom}, 'r1']]);
});

it('allows custom initialized from a preset to normalize back to the canonical tier', async () => {
  const save = vi.fn(); const {section, render} = setup(save);
  section.stored.custom = null;
  save.mockImplementation(async () => {
    section.stored = {...section.stored, custom: null};
    section.effective = section.stored; section.revision = 'r2';
    return {kind: 'saved', result: {kind: 'saved', section: {value: section}, effects: []}};
  });
  let ui = render(); button(ui.summary, '修改权限').props.onClick(); ui = render();
  expect(button(ui.editor, '保存权限').props.disabled).toBe(true);
  ui.choices!.props.onChange('custom'); ui = render();
  expect(ui.native!.props.value).toEqual({sandbox: 'workspace-write', network: true});
  expect(button(ui.editor, '保存权限').props.disabled).toBe(false);
  button(ui.editor, '保存权限').props.onClick(); await flush(); ui = render();
  expect(save.mock.calls).toEqual([[{custom: {network: true}}, 'r1']]);
  expect(ui.dialog.props.open).toBe(false);
  expect(ui.summary.some(node => node.props.title === '工作区可写')).toBe(true);
});

it('keeps failed native custom edits open and discards them on cancel', async () => {
  const save = vi.fn().mockResolvedValue({kind: 'refused', message: '原生权限未保存'});
  const {render} = setup(save);
  let ui = render(); button(ui.summary, '修改权限').props.onClick(); ui = render();
  ui.native!.props.onChange({network: true, unknown: 'ignored'}); ui = render();
  button(ui.editor, '保存权限').props.onClick(); await flush(); ui = render();
  expect(ui.dialog.props.open).toBe(true); expect(ui.native!.props.value.network).toBe(true);
  expect(ui.editor.find(node => node.props.title === '保存未完成')?.props.children).toBe('原生权限未保存');
  expect(save).toHaveBeenCalledExactlyOnceWith({custom: {network: true}}, 'r1');
  button(ui.summary, '取消').props.onClick(); ui = render();
  expect(Object.values(h.guards).some(Boolean)).toBe(false);
  button(ui.summary, '修改权限').props.onClick(); ui = render();
  expect(ui.native!.props.value.network).toBe(false);
});

it('has only one bottom action row and no duplicate permission heading', () => {
  const {render} = setup(vi.fn()); let ui = render();
  button(ui.summary, '修改权限').props.onClick(); ui = render();
  expect(nodes(ui.dialog.props.footer).filter(node => node.props.onClick).map(node => node.props.children)).toEqual(['取消', '保存权限']);
  expect(ui.editor.filter(node => node.props.children === '保存权限' && node.props.onClick)).toHaveLength(1);
  expect(ui.editor.some(node => node.props.label === '权限' && node.props.id)).toBe(false);
  expect(ui.editor.some(node => node.props.children === '放弃修改')).toBe(false);
});
