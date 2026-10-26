import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {NativePermissionFields, nativePermissionPatch, visibleNativeFields, type NativeField} from '../src/settings/NativePermissionFields';
import {NativePermissionEditor, Editor} from '../src/settings/SettingsPanel';
import {permissionValue} from './permission-fixture';

export const fields: NativeField[] = [
  {key: 'permissionMode', label: '权限模式', native: 'permission mode', kind: 'choice', choices: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].map(value => ({value, label: value === 'plan' ? '先出方案' : value, native: value, hint: value === 'plan' ? '每一轮先出方案' : undefined}))},
  {key: 'sandbox', label: '命令沙箱', native: 'sandbox', kind: 'switch'},
  {key: 'network', label: '网络', native: 'network', kind: 'choice', choices: ['off', 'all', 'domains'].map(value => ({value, label: value, native: value})), showWhen: {key: 'permissionMode', in: ['default', 'acceptEdits', 'plan', 'auto']}},
  {key: 'domains', label: '允许的网站', native: 'allowedDomains', kind: 'domains', showWhen: {key: 'network', in: ['domains']}},
];
const value = {permissionMode: 'acceptEdits', sandbox: true, network: 'domains', domains: ['github.com']};
const section = (stored = permissionValue('write')) => ({stored, effective: stored, revision: 'r', access: {kind: 'writable' as const}, apply: []});
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); return isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children)] : [];}

it('renders native choices, switches and one-domain-per-line input from the view', () => {
  const html = renderToStaticMarkup(<NativePermissionFields fields={fields} value={value} disabled={false} onChange={() => {}}/>);
  for (const text of ['权限模式（permission mode）', '先出方案（plan）', '每一轮先出方案', 'auto（auto）', '命令沙箱（sandbox）', '允许的网站（allowedDomains）', 'github.com']) expect(html).toContain(text);
  expect(html).toContain('role="switch"'); expect(html).toContain('<textarea');
});
it('hides dependent domains recursively and excludes every hidden value from the submitted custom object', () => {
  expect(visibleNativeFields(fields, {...value, permissionMode: 'bypassPermissions'}).map(field => field.key)).toEqual(['permissionMode', 'sandbox']);
  expect(nativePermissionPatch(fields, {...value, permissionMode: 'bypassPermissions', unknown: true})).toEqual({permissionMode: 'bypassPermissions', sandbox: true});
  expect(nativePermissionPatch(fields, {...value, network: 'off'})).not.toHaveProperty('domains');
  expect(nativePermissionPatch(fields, value)).toEqual(value);
  expect(visibleNativeFields([{...fields[0]!, showWhen: {key: 'missing', in: ['x']}}], value)).toEqual([]);
});
it('prefills custom or expanded settings, sends only visible custom fields and describes a folded tier', async () => {
  const stored = permissionValue('write'); stored.options.fields = fields; stored.options.expanded.write = value;
  const save = vi.fn(async () => ({kind: 'refused' as const, message: '原生设置有误'}));
  const editor = nodes(NativePermissionEditor({section: section(stored), provider: 'Claude', save})).find(node => node.type === Editor)!;
  const set = vi.fn();
  const form = nodes(editor.props.render(stored, set, false)).find(node => node.type === NativePermissionFields)!;
  expect(form.props.value).toEqual(value);
  form.props.onChange({...value, network: 'off'}); expect(set.mock.lastCall?.[0].custom.network).toBe('off');
  form.props.onChange(value); expect(set.mock.lastCall?.[0].custom).toBeNull();
  await editor.props.save({custom: {...value, permissionMode: 'bypassPermissions'}}, 'r');
  expect(save).toHaveBeenCalledWith({custom: {permissionMode: 'bypassPermissions', sandbox: true}}, 'r');
  expect(editor.props.savedNotice(stored)).toBe('和「工作区可写」一样，已存成这一档。');
  stored.custom = {...value, permissionMode: 'plan'};
  expect(nodes(editor.props.render(stored, set, false)).find(node => node.type === NativePermissionFields)!.props.value.permissionMode).toBe('plan');
});
it('has no advanced disclosure for providers without fields and disables unchanged saves', () => {
  expect(NativePermissionEditor({section: section(), provider: 'Other', save: async () => ({kind: 'refused', message: ''})})).toBeNull();
  const stored = permissionValue('write'); stored.options.fields = fields; stored.options.expanded.write = value;
  const html = renderToStaticMarkup(<NativePermissionEditor section={section(stored)} provider="Claude" save={async () => ({kind: 'refused', message: ''})}/>);
  expect(html).toContain('<summary>高级设置</summary>');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*><span>保存<\/span>/);
});
