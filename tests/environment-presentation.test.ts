import assert from "node:assert/strict";
import { test } from "node:test";
import { presentTool, profileTokenLabel } from "../desktop/renderer/management/environmentPresentation";
import type { EnvironmentToolState } from "../desktop/shared/environment";

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
