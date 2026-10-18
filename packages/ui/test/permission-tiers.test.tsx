import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectSettingsView } from "@vonvon/protocol";
import { createClient } from "../../client/src/client";
import { ClientProvider } from "../src/client-context";
import { ProjectPanel } from "../src/settings/SettingsPanel";

const client = createClient({ isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {} });
const REASON = "Linux 上 Codex 的沙箱只挡写、不限制读，只能选完全访问。";
const section = <T,>(stored: T) => ({ stored, effective: stored, revision: "r", access: { kind: "writable" as const }, apply: [] });
const view = (fullOnly?: string): ProjectSettingsView => ({
  scope: { kind: "project", botId: "cli_fixture" as ProjectSettingsView["scope"]["botId"], projectName: "demo" },
  sections: {
    // guestMode: the view's deprecated mirror of the one tier (s15c), never shown.
    permission: section({ mode: "qa" as const, guestMode: "qa" as const, network: false }),
    response: section({ noMention: false }),
    model: section({ selection: { kind: "default" as const } }),
  } as unknown as ProjectSettingsView["sections"],
  identity: { chatId: "oc_demo", backend: "codex-appserver", cwd: "/tmp/demo", kind: "multi", ...(fullOnly ? { fullOnly } : {}) },
  members: { openIds: [], revision: "m" },
});
const render = (fullOnly?: string) => renderToStaticMarkup(
  <ClientProvider client={client}><ProjectPanel view={view(fullOnly)} refresh={async () => {}} /></ClientProvider>,
);
const select = (html: string, label: string) => html.match(new RegExp(`<select aria-label="${label}"[^>]*>(.*?)</select>`))?.[1] ?? "";

it("greys out 只读 and 读写 when the backend is full-only, keeps the stored 只读 selected, and says why", () => {
  const html = render(REASON);
  const options = select(html, "权限档");
  expect(options).toContain('<option value="qa" disabled="" selected="">只读</option>');
  expect(options).toContain('<option value="write" disabled="">读写</option>');
  expect(options).toContain('<option value="full">完全访问</option>');
  expect(html.indexOf(REASON)).toBeGreaterThan(html.indexOf("权限档"));
});

it("has one tier for the whole group (s15c)", () => {
  const html = render();
  expect(html.match(/<select aria-label="[^"]*权限[^"]*"/g)).toEqual(['<select aria-label="权限档"']);
  expect(html).not.toContain("普通成员权限");
  expect(html).not.toContain("管理员权限");
});

it("offers every tier when the backend can confine reads", () => {
  const html = render();
  expect(html).not.toContain("disabled=\"\">只读");
  expect(select(html, "权限档")).toContain('<option value="qa" selected="">只读</option>');
  expect(html).not.toContain(REASON);
});
