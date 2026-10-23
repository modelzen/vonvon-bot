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
const radio = (html: string, value: string) => [...html.matchAll(/<input\b[^>]*type="radio"[^>]*\/>/g)]
  .map(([input]) => input).find(input => input.includes(`value="${value}"`)) ?? '';

it("greys out 只读 and 读写 when the backend is full-only, keeps the stored 只读 selected, and says why", () => {
  const html = render(REASON);
  expect(radio(html, 'qa')).toContain('disabled=""');
  expect(radio(html, 'qa')).toContain('checked=""');
  expect(radio(html, 'write')).toContain('disabled=""');
  expect(radio(html, 'full')).not.toContain('disabled=""');
  expect(html.indexOf(REASON)).toBeGreaterThan(html.indexOf("权限档"));
});

it("has one tier for the whole group (s15c)", () => {
  const html = render();
  expect(html.match(/role="radiogroup" aria-label="[^"]*权限[^"]*"/g)).toEqual(['role="radiogroup" aria-label="权限档"']);
  expect(html).not.toContain("普通成员权限");
  expect(html).not.toContain("管理员权限");
});

it("offers every tier when the backend can confine reads", () => {
  const html = render();
  for (const value of ['qa', 'write', 'full']) expect(radio(html, value)).not.toContain('disabled=""');
  expect(radio(html, 'qa')).toContain('checked=""');
  expect(html).not.toContain(REASON);
});
