import { describe, expect, it } from "vitest";
import {
  adminReplySchema, adminRequestSchema, coreUpdateStatusText, DESKTOP_SELF_UPDATE_CAPABILITY, distributionKinds, eventSchema, machineReplySchema, machineRequestSchema,
} from "../src/index.js";

const status = (kind: string) => ({ kind: "daemonStatus", status: { distribution: { kind, cliPath: "/x/bin/vonvon.mjs" }, installed: true, running: true, selfHosted: false, version: "0.9.0", supported: true, startedAt: 1 } });
const coreUpdate = (kind: string) => ({ type: "coreUpdate", distribution: { kind, cliPath: "/x/bin/vonvon.mjs" }, current: "0.9.0", latest: null, hasUpdate: false, dev: false });

describe("distribution kind (devices 7.1)", () => {
  it("lists standalone among the known kinds", () => {
    expect(distributionKinds).toContain("standalone");
  });

  it.each(["standalone", "a-kind-from-a-newer-daemon"])("daemonStatus and coreUpdate accept %s", kind => {
    expect(adminReplySchema.parse(status(kind))).toMatchObject({ status: { distribution: { kind } } });
    expect(machineReplySchema.parse(coreUpdate(kind))).toMatchObject({ distribution: { kind } });
  });

  it("still requires a kind", () => {
    expect(adminReplySchema.safeParse(status("")).success).toBe(false);
    expect(machineReplySchema.safeParse(coreUpdate("")).success).toBe(false);
  });
});

// main 必败: the update status took only four phases and no step, and applyCoreUpdate took no version (server-3 4.5, 4.9)
describe("core update (server-3)", () => {
  it("reads a status phase or step it does not know, with progress and rollback", () => {
    const status = { phase: "a-phase-from-a-newer-daemon", at: 1, detail: "draining", previous: "1.0.0", progress: { transferred: 1, total: 2 }, rolledBack: true };
    expect(machineReplySchema.parse({ type: "coreUpdateStatus", status })).toEqual({ type: "coreUpdateStatus", status });
  });

  it("takes a version to go to, and nothing that is not one", () => {
    expect(machineRequestSchema.parse({ type: "applyCoreUpdate", version: "0.9.0", allowDowngrade: true })).toEqual({ type: "applyCoreUpdate", version: "0.9.0", allowDowngrade: true });
    expect(machineRequestSchema.safeParse({ type: "applyCoreUpdate", version: "latest" }).success).toBe(false);
    expect(machineRequestSchema.parse({ type: "checkCoreUpdate", fresh: false })).toEqual({ type: "checkCoreUpdate", fresh: false });
  });

  it("carries the channel and a refused manifest in the check reply", () => {
    const reply = { type: "coreUpdate", distribution: { kind: "standalone", cliPath: "/x" }, current: "1.0.0", latest: null, hasUpdate: false, dev: false, channel: "stable", refused: "signature" };
    expect(machineReplySchema.parse(reply)).toEqual(reply);
  });
});

// devices-ui-4: the daemon a desktop app carries asks the app to update itself, and the app reports back.
describe("desktop update through the shell (devices-ui-4)", () => {
  it("declares a capability negotiate takes", () => {
    expect(adminRequestSchema.safeParse({ type: "negotiate", capabilities: [DESKTOP_SELF_UPDATE_CAPABILITY] }).success).toBe(true);
    expect(adminRequestSchema.safeParse({ type: "negotiate", capabilities: ["desktop.selfUpdate"] }).success).toBe(false);
  });

  it("takes the shell's report, and nothing it does not know", () => {
    const report = { type: "desktopUpdateReport", requestId: "dur_0123456789abcdef", state: "downloading", latest: "0.9.1", message: "正在下载", progress: { transferred: 1, total: 2 } };
    expect(machineRequestSchema.parse(report)).toEqual(report);
    expect(machineRequestSchema.safeParse({ ...report, requestId: "req_0123456789abcdef" }).success).toBe(false);
    expect(machineRequestSchema.safeParse({ ...report, state: "installed" }).success).toBe(false);
    expect(machineRequestSchema.safeParse({ ...report, message: "x".repeat(1025) }).success).toBe(false);
    expect(machineRequestSchema.safeParse({ ...report, path: "/Users/x" }).success).toBe(false);
  });

  it("asks the shell with an event", () => {
    const event = { type: "event", event: "desktopUpdateRequest", payload: { requestId: "dur_0123456789abcdef", action: "apply", by: "「笔记本」" } };
    expect(eventSchema.parse(event)).toEqual(event);
    expect(eventSchema.safeParse({ ...event, payload: { ...event.payload, action: "install" } }).success).toBe(false);
  });

  it("says in the check reply whether the desktop app is open, and shows its steps", () => {
    const reply = { type: "coreUpdate", distribution: { kind: "bundled", cliPath: "/x" }, current: "0.9.0", latest: null, hasUpdate: false, dev: false, desktopShell: false, message: "那台电脑上的桌面端没有打开" };
    expect(machineReplySchema.parse(reply)).toEqual(reply);
    expect(coreUpdateStatusText({ phase: "installing", at: 1, detail: "desktop-downloading", via: "desktop", progress: { transferred: 45, total: 100 } })).toBe("正在下载桌面端更新 45%");
    expect(coreUpdateStatusText({ phase: "installing", at: 1, detail: "desktop-checking", via: "desktop" })).toBe("正在检查桌面端更新");
  });
});
