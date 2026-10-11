import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { HostSettingsView } from "@vonvon/protocol";
import { createClient } from "../../client/src/client";
import { ClientProvider } from "../src/client-context";
import { HostPanel } from "../src/settings/SettingsPanel";

const client = createClient({
  isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {},
  send: () => {}, close: async () => {},
});
const view: HostSettingsView = {
  scope: {kind: "host"},
  sections: {execution: {stored: {codexBin: "/opt/codex", customAcpCommand: ["agent", "--acp"]}, effective: {codexBin: "/opt/codex", customAcpCommand: null}, revision: "revision-1", access: {kind: "writable"}, apply: [{fields: ["customAcpCommand"], when: "restart", detail: "重启后生效。"}]}},
  runtime: {codexBin: "/opt/codex", fallbackCwd: "/tmp", platform: "darwin"},
};

it("keeps the executable row visible with a browser path dialog or a native chooser", () => {
  const web = renderToStaticMarkup(<ClientProvider client={client}><HostPanel view={view} refresh={async () => {}} /></ClientProvider>);
  const desktop = renderToStaticMarkup(<ClientProvider client={client} shell={{chooseExecutablePath: async () => null}}><HostPanel view={view} refresh={async () => {}} /></ClientProvider>);
  expect(web).toContain("输入 Codex 可执行文件路径");
  expect(web).toContain("/opt/codex");
  expect(web).toContain("恢复自动检测");
  expect(desktop).toContain("选择 Codex 可执行文件");
  expect(desktop).toContain("/opt/codex");
});

it('shows the saved argv in one textarea and the effective restart state', () => {
  const html = renderToStaticMarkup(<ClientProvider client={client}><HostPanel view={view} refresh={async () => {}} /></ClientProvider>);
  expect(html).toContain('aria-label="自定义 ACP 命令"');
  expect(html).toContain('agent\n--acp');
  expect(html).toContain('当前运行：未配置');
  expect(html).toContain('重启 Host 生效');
  expect(html).toContain('重启后生效');
});

it('disables the command editor for a readonly host section', () => {
  const readonlyView: HostSettingsView = { ...view, sections: { execution: {
    ...view.sections.execution, access: {kind: 'readonly', reason: 'preview', message: '只读预览'},
  } } };
  const html = renderToStaticMarkup(<ClientProvider client={client}><HostPanel view={readonlyView} refresh={async () => {}} /></ClientProvider>);
  expect(html).toMatch(/<textarea[^>]*disabled=""[^>]*aria-label="自定义 ACP 命令"|<textarea[^>]*aria-label="自定义 ACP 命令"[^>]*disabled=""/);
});
