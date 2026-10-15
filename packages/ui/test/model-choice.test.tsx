import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelCatalog } from "@vonvon/protocol";
import { ModelChoice } from "../src/settings/SettingsPanel";

const catalog: ModelCatalog = {
  backend: "claude-agent",
  state: "fallback",
  source: "backend-provided",
  observedAt: "2026-10-15T00:00:00.000Z",
  titleEfforts: ["low", "medium", "high", "xhigh", "max"],
  models: [{ id: "opus", displayName: "Opus", description: "", supportedEfforts: ["low", "high"], defaultEffort: "high", isDefault: true, hidden: false }],
};
const render = (value: Parameters<typeof ModelChoice>[0]["value"], allowCustom?: boolean) =>
  renderToStaticMarkup(<ModelChoice value={value} onChange={() => {}} catalog={catalog} disabled={false} allowCustom={allowCustom} />);

it("shows a saved hand-typed id in its own field, with the protocol's efforts", () => {
  const html = render({ kind: "explicit", model: "kimi-k2", effort: "max", custom: true }, true);
  expect(html).toContain('<option value="__custom__" selected="">自定义模型 ID…</option>');
  expect(html).toContain('aria-label="自定义模型 ID"');
  expect(html).toContain('value="kimi-k2"');
  expect(html).toContain('<option value="max" selected="">max</option>');
  expect(html).not.toContain("当前目录不可用");
});

it("offers the custom option only where allowed, and keeps listed models as before", () => {
  const listed = render({ kind: "explicit", model: "opus", effort: "high" }, true);
  expect(listed).toContain("自定义模型 ID…");
  expect(listed).not.toContain('aria-label="自定义模型 ID"');
  expect(listed).not.toContain('value="max"'); // opus only lists low/high
  const comments = render({ kind: "explicit", model: "opus", effort: "high" });
  expect(comments).not.toContain("自定义模型 ID");
  const stale = render({ kind: "explicit", model: "gone", effort: "high" });
  expect(stale).toContain("gone（已保存，当前目录不可用）");
});
