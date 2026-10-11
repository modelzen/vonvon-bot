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
  sections: {execution: {stored: {codexBin: "/opt/codex"}, effective: {codexBin: "/opt/codex"}, revision: "revision-1", access: {kind: "writable"}, apply: []}},
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
