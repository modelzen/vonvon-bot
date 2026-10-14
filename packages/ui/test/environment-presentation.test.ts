import assert from "node:assert/strict";
import { test } from "vitest";
import { groupAgentBackends, presentTool, profileTokenLabel } from "../src/management/environmentPresentation";
import type { BackendEntry, EnvironmentToolState } from "@vonvon/protocol";

const installed: EnvironmentToolState = {
  tool: "codex", installation: "external", executable: "/fixture/codex",
  version: "1.0.0", managedVersion: null, latestVersion: "1.1.0",
  updateAvailable: true, canUninstall: false,
};

test("tool actions follow installation, update and authoritative authentication states", () => {
  assert.equal(presentTool({ ...installed, installation: "missing", executable: null }, undefined).action, "install");
  assert.equal(presentTool(installed, { kind: "auth", tool: "codex", state: "signedOut", message: "尚未授权" }).action, "login");
  assert.equal(presentTool(installed, { kind: "auth", tool: "codex", state: "unknown", message: "无法确认" }).action, "update");
  assert.equal(presentTool({ ...installed, updateAvailable: null }, { kind: "auth", tool: "codex", state: "unknown", message: "无法确认" }).status, "授权未确认");
  assert.equal(presentTool({ ...installed, updateAvailable: false }, { kind: "auth", tool: "codex", state: "signedIn", message: "已授权" }).action, "none");
  assert.equal(presentTool({ ...installed, installation: "managed", managedVersion: "1.0.0" }, undefined).action, "update");
  assert.equal(presentTool({ ...installed, installation: "managed", managedVersion: "1.0.0", updateAvailable: null }, undefined).action, "none");
  assert.equal(presentTool({ ...installed, updateAvailable: false }, undefined).action, "none");
});

test("Feishu Profile credential refresh remains actionable when CLI auth is unknown", () => {
  const lark = { ...installed, tool: "lark-cli" } satisfies EnvironmentToolState;
  const profile = { name: "work", appId: "cli_fixture", brand: "feishu", active: true, tokenStatus: "needs_refresh" } as const;
  const result = presentTool(lark, { kind: "auth", tool: "lark-cli", state: "unknown", message: "无法确认" }, profile);
  assert.equal(result.action, "login");
  assert.equal(result.status, "需要刷新凭据");
  assert.equal(profileTokenLabel(undefined), "凭据状态未知");
});

test("update availability does not erase confirmed or unknown authorization", () => {
  const signedIn = presentTool(installed, { kind: "auth", tool: "codex", state: "signedIn", message: "账户可用" });
  assert.deepEqual([signedIn.status, signedIn.tone, signedIn.action], ["已授权", "success", "update"]);
  assert.match(signedIn.summary, /可更新至 1\.1\.0/);

  const unknown = presentTool(installed, { kind: "auth", tool: "codex", state: "unknown", message: "暂时无法检查" });
  assert.deepEqual([unknown.status, unknown.tone, unknown.action], ["授权未确认", "neutral", "update"]);

  const signedOut = presentTool(installed, { kind: "auth", tool: "codex", state: "signedOut", message: "未授权" });
  assert.equal(signedOut.action, "login");
  assert.match(signedOut.summary, /可更新至 1\.1\.0/);
});

test("expired Feishu credentials take action priority over an available update", () => {
  const result = presentTool(
    { ...installed, tool: "lark-cli" },
    { kind: "auth", tool: "lark-cli", state: "signedIn", message: "之前已授权" },
    { name: "work", appId: "cli_fixture", brand: "feishu", active: true, tokenStatus: "expired" },
  );
  assert.deepEqual([result.status, result.tone, result.action], ["凭据已过期", "warning", "login"]);
  assert.match(result.summary, /可更新至 1\.1\.0/);
});

test("only the matching Codex Host is folded into a present CLI row", () => {
  const codexHost: BackendEntry = { id: "codex", displayName: "Codex", depKind: "external-cli", depState: "error", installable: false, version: null, installedVersion: null, canUninstall: false, hint: "连接失败" };
  const sdk: BackendEntry = { id: "claude", displayName: "Claude", depKind: "npm-ondemand", depState: "ready", installable: false, version: "1.0", installedVersion: "1.0", canUninstall: true };
  const future: BackendEntry = { id: "future", displayName: "Future", depKind: "other", depState: "new-state", installable: true, version: null, installedVersion: null, canUninstall: false };
  const entries = [codexHost, sdk, future];
  assert.deepEqual(groupAgentBackends([installed], entries), { codexHost, otherBackends: [sdk, future] });
  assert.deepEqual(groupAgentBackends([], entries), { otherBackends: entries });
  assert.deepEqual(groupAgentBackends([installed], [{ ...codexHost, depKind: "other" }, sdk]).otherBackends.map((entry) => entry.id), ["codex", "claude"]);
});
