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
const REASON = "Linux 上的 Codex 暂时只能用完全访问，没有沙箱。";
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
const render = (permission = permissionValue('qa'), fullOnly?: string) => renderToStaticMarkup(
  <ClientProvider client={client}><ProjectPanel view={view(permission, fullOnly)} refresh={async () => {}} /></ClientProvider>,
);
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

it("ignores the deprecated identity.fullOnly field when the table offers every tier", () => {
  const html = render(permissionValue('qa'), REASON);
  for (const value of ['qa', 'write', 'full']) expect(radio(html, value)).not.toContain('disabled=""');
  expect(radio(html, 'qa')).toContain('checked=""');
  expect(html).not.toContain(REASON);
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
});

it('shows invalid custom settings as read-only fallback without preselecting a tier', () => {
  const permission = permissionValue('qa'); permission.options.invalid = true;
  const html = render(permission);
  expect(html).toContain('高级设置读不出来，现在按只读跑。选一档重新设置。');
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
