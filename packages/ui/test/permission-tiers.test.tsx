import { expect, it, vi } from "vitest";
import {Children, isValidElement, type ReactElement, type ReactNode} from 'react';
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectSettingsView } from "@vonvon/protocol";
import { createClient } from "../../client/src/client";
import { ClientProvider } from "../src/client-context";
import {PermissionFields, ProjectPanel} from "../src/settings/SettingsPanel";
import {SettingChoices} from '../src/settings/SettingChoices';
import {permissionValue} from './permission-fixture';

const client = createClient({ isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {} });
const REASON = "这台电脑上的 Codex 版本太旧（0.162.0），只读和工作区可写要 0.163.0 以上，升级后就能选。";
const section = <T,>(stored: T) => ({ stored, effective: stored, revision: "r", access: { kind: "writable" as const }, apply: [] });
const view = (permission = permissionValue('qa'), fullOnly?: string): ProjectSettingsView => ({
  scope: { kind: "project", botId: "cli_fixture" as ProjectSettingsView["scope"]["botId"], projectName: "demo" },
  sections: {
    permission: section(permission),
    response: section({ noMention: false }),
    model: section({ selection: { kind: "default" as const } }),
  } as unknown as ProjectSettingsView["sections"],
  identity: { chatId: "oc_demo", backend: "codex-appserver", cwd: "/tmp/demo", kind: "multi", ...(fullOnly ? { fullOnly } : {}) },
  members: { openIds: [], revision: "m" },
});
const renderPanel = (permission = permissionValue('qa'), fullOnly?: string) => renderToStaticMarkup(
  <ClientProvider client={client}><ProjectPanel view={view(permission, fullOnly)} refresh={async () => {}} /></ClientProvider>,
);
const render = (permission = permissionValue('qa')) => renderToStaticMarkup(<PermissionFields value={permission} disabled={false} onChange={() => {}}/>);
const radio = (html: string, value: string) => [...html.matchAll(/<input\b[^>]*type="radio"[^>]*\/>/g)]
  .map(([input]) => input).find(input => input.includes(`value="${value}"`)) ?? '';

it("uses tier availability from the view and keeps an unavailable stored tier selected", () => {
  const permission = permissionValue('qa');
  for (const tier of permission.options.tiers) if (tier.tier !== 'full') tier.unavailable = REASON;
  const html = render(permission);
  expect(radio(html, 'qa')).toContain('disabled=""');
  expect(radio(html, 'qa')).toContain('checked=""');
  expect(radio(html, 'write')).toContain('disabled=""');
  expect(radio(html, 'full')).not.toContain('disabled=""');
  expect(html).toContain(REASON);
});

it("shows provider names and summaries in one tier group, with no network switch", () => {
  const permission = permissionValue('qa');
  permission.options.tiers[1]!.name = '提供的档名';
  const html = render(permission);
  for (const tier of permission.options.tiers) {
    expect(html).toContain(tier.name); expect(html).toContain(tier.summary); expect(html).toContain(tier.native);
  }
  expect(html).toContain(`能挡到什么：${permission.options.strength}`);
  expect(html).not.toContain('允许网络访问');
  expect(html.match(/role="radiogroup" aria-label="[^"]*权限[^"]*"/g)).toEqual(['role="radiogroup" aria-label="权限"']);
  expect(html).not.toContain("普通成员权限");
  expect(html).not.toContain("管理员权限");
});

it('omits custom when its sole native choice only repeats the three presets', () => {
  const permission = permissionValue('write');
  permission.options.fields = [{key: 'sandbox', label: '沙箱', native: 'sandbox', kind: 'choice', choices: [
    {value: 'read-only', label: '只读', native: 'read-only'},
    {value: 'workspace-write', label: '工作区可写', native: 'workspace-write'},
    {value: 'danger-full-access', label: '完全访问', native: 'danger-full-access'},
  ]}];
  permission.options.expanded = {
    qa: {sandbox: 'read-only'}, write: {sandbox: 'workspace-write'}, full: {sandbox: 'danger-full-access'},
  };
  expect(radio(render(permission), 'custom')).toBe('');

  permission.custom = {sandbox: 'workspace-write'};
  expect(radio(render(permission), 'custom')).toContain('checked=""');
  permission.custom = null;
  permission.options.invalid = true;
  expect(radio(render(permission), 'custom')).not.toBe('');
});

it('keeps custom for independent fields, extra native values and conditional choices', () => {
  const permission = permissionValue('write');
  permission.options.fields = [{key: 'sandbox', label: '沙箱', native: 'sandbox', kind: 'choice', choices: [
    {value: 'read-only', label: '只读', native: 'read-only'},
    {value: 'workspace-write', label: '工作区可写', native: 'workspace-write'},
    {value: 'danger-full-access', label: '完全访问', native: 'danger-full-access'},
  ]}];
  permission.options.expanded = {
    qa: {sandbox: 'read-only'}, write: {sandbox: 'workspace-write'}, full: {sandbox: 'danger-full-access'},
  };
  permission.options.fields.push({key: 'network', label: '网络', native: 'network', kind: 'switch'});
  expect(radio(render(permission), 'custom')).not.toBe('');
  permission.options.fields.pop();
  permission.options.fields[0]!.choices!.push({value: 'limited', label: '受限', native: 'limited'});
  expect(radio(render(permission), 'custom')).not.toBe('');
  permission.options.fields[0]!.choices!.pop();
  permission.options.fields[0]!.showWhen = {key: 'network', in: [true]};
  expect(radio(render(permission), 'custom')).not.toBe('');
});

it("ignores the deprecated identity.fullOnly field when the table offers every tier", () => {
  const html = renderPanel(permissionValue('qa'), REASON);
  expect(html).toContain('只读');
  expect(html).not.toContain(REASON);
  expect(html).toContain('修改权限');
  expect(html).not.toContain('<summary>高级设置</summary>');
});

it.each([false, true])('leaves all tiers unselected for a custom permission, legacy=%s', legacy => {
  const permission = permissionValue('write');
  permission.custom = {sandbox: 'workspace-write', network: false};
  permission.options.customSummary = '沙箱模式：工作区可写（workspace-write）；网络：关';
  permission.options.legacy = legacy;
  const html = render(permission);
  expect(html).toContain(`自定义：${permission.options.customSummary}`);
  expect(html.includes('从旧版的联网开关转来')).toBe(legacy);
  for (const value of ['qa', 'write', 'full']) expect(radio(html, value)).not.toContain('checked=""');
  expect(radio(html, 'custom')).toContain('checked=""');
});

it('shows invalid custom settings as read-only fallback without preselecting a tier', () => {
  const permission = permissionValue('qa'); permission.options.invalid = true;
  const html = render(permission);
  expect(html).toContain('自定义设置读不出来，现在按只读跑。选择预设重新设置。');
  for (const value of ['qa', 'write', 'full']) expect(radio(html, value)).not.toContain('checked=""');
});

it('selecting a tier submits only mode, including when replacing custom settings', () => {
  const permission = permissionValue(); permission.custom = {sandbox: 'read-only', network: true};
  const onChange = vi.fn();
  const root = PermissionFields({value: permission, disabled: false, onChange});
  function nodes(node: ReactNode): ReactElement<Record<string, any>>[] {
    return Children.toArray(node).flatMap(child => isValidElement<Record<string, any>>(child) ? [child, ...nodes(child.props.children), ...nodes(child.props.trailing)] : []);
  }
  const choices = nodes(root).find(node => node.type === SettingChoices)!;
  choices.props.onChange('write');
  expect(onChange).toHaveBeenCalledExactlyOnceWith({mode: 'write'});
});
