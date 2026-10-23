import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {Editor, NativePermissionEditor} from '../src/settings/SettingsPanel';
import {NativePermissionFields} from '../src/settings/NativePermissionFields';
import {permissionValue} from './permission-fixture';

const h = vi.hoisted(() => ({state: [] as unknown[], refs: [] as Array<{current: unknown}>, si: 0, ri: 0}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = typeof initial === 'function' ? initial() : initial; return [h.state[i], (next: unknown) => {h.state[i] = typeof next === 'function' ? next(h.state[i]) : next;}];},
  useRef: (initial: unknown) => h.refs[h.ri++] ??= {current: initial}, useContext: () => [], useEffect: () => {},
}));
vi.mock('../src/settings/DraftGuard', () => ({useDraft: () => {}}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); return isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children)] : [];}
const stored = permissionValue('write');
stored.options.fields = [{key: 'permissionMode', label: '权限模式', native: 'permission mode', kind: 'choice', choices: [{value: 'acceptEdits', label: '自动编辑', native: 'acceptEdits'}, {value: 'plan', label: '先出方案', native: 'plan'}]}];
stored.options.expanded.write = {permissionMode: 'acceptEdits'};
const section = {stored, effective: stored, revision: 'r', access: {kind: 'writable' as const}, apply: []};
beforeEach(() => {h.state = []; h.refs = []; h.si = h.ri = 0;});

it('keeps a failed draft editable, retries only custom and reports an equivalent saved tier', async () => {
  const save = vi.fn().mockResolvedValueOnce({kind: 'saved', result: {kind: 'rejected', fields: [{field: 'settings', message: '中文服务端错误'}]}})
    .mockResolvedValueOnce({kind: 'saved', result: {kind: 'saved', section: {value: section}, effects: []}});
  function render() {
    h.si = h.ri = 0;
    const editor = nodes(NativePermissionEditor({section, provider: 'Claude', save})).find(node => node.type === Editor)!;
    const all = nodes(Editor(editor.props as any));
    return {all, fields: all.find(node => node.type === NativePermissionFields)!, button: all.find(node => node.props.children === '保存' && node.props.onClick)!};
  }
  async function flush() {for (let i = 0; i < 8; i++) await Promise.resolve();}
  let ui = render(); expect(ui.button.props.disabled).toBe(true);
  ui.fields.props.onChange({permissionMode: 'plan'});
  ui = render(); expect(ui.button.props.disabled).toBe(false); ui.button.props.onClick(); await flush();
  ui = render(); expect(ui.fields.props.value.permissionMode).toBe('plan'); expect(ui.fields.props.disabled).toBe(false);
  expect(ui.all.find(node => node.props.title === '保存未完成')?.props.children).toBe('settings：中文服务端错误');
  ui.button.props.onClick(); await flush(); ui = render();
  expect(save.mock.calls).toEqual([[{custom: {permissionMode: 'plan'}}, 'r'], [{custom: {permissionMode: 'plan'}}, 'r']]);
  expect(ui.all.find(node => node.props.title === '本次修改已保存')?.props.children).toContain('和「工作区可写」一样，已存成这一档。');
  expect(ui.button.props.disabled).toBe(true);
});
