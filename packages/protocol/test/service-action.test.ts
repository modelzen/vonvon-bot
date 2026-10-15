import { describe, expect, it } from "vitest";
import { desktopSnapshotSchema, machineRequestSchema, SERVICE_BUSY_MESSAGE, SERVICE_REPLACE_RUNNING_MESSAGE, serviceActionMessage, type ServiceActionReport } from "../src/index.js";

const failed = (fields: Partial<ServiceActionReport>): ServiceActionReport => ({ action: "install", phase: "done", ok: false, startedAt: 1, finishedAt: 2, ...fields });

describe("login-time service (s08)", () => {
  it.each([
    [{ reason: "busy" }, SERVICE_BUSY_MESSAGE],
    [{ reason: "turned-off", kind: "install_refused" }, "系统设置里关掉了 Vonvon Bot 的后台运行。到\"系统设置 › 通用 › 登录项与扩展\"的\"允许在后台\"里打开它，再点「重新检测」。"],
    [{ reason: "replace-running", kind: "install_refused" }, SERVICE_REPLACE_RUNNING_MESSAGE],
    [{ reason: "distribution", kind: "install_refused" }, "认不出这份 vonvon 是怎么装的，不能装后台服务。从源码运行的装不了；用 npm 装的，在终端运行 vonvon service install。"],
    [{ reason: "translocated", kind: "install_refused" }, "Vonvon Bot 正从临时位置运行。先把它拖到\"应用程序\"文件夹，从那里打开，再打开这个开关。"],
    [{ reason: "interrupted", kind: "install_refused" }, "上次关闭没有做完。在终端运行 vonvon service uninstall，再试一次。"],
    [{ reason: "other-root", kind: "install_refused", detail: "Registration belongs to /Users/u/.vonvon-other" }, "后台服务属于另一个数据目录：/Users/u/.vonvon-other。"],
    [{ reason: "other", kind: "install_rolled_back", detail: "Daemon readiness timed out" }, "没装上，已经恢复原样：Daemon readiness timed out"],
    [{ reason: "other", kind: "install_incomplete", detail: "Manager did not confirm the loaded job." }, "没装完：Manager did not confirm the loaded job。在终端运行 vonvon service status 查看。"],
    [{ action: "uninstall", reason: "other", kind: "uninstall_incomplete", detail: "stop_unconfirmed: lost" }, "没关掉：stop_unconfirmed: lost。在终端运行 vonvon service uninstall 再试。"],
  ] as const)("says why %j failed", (fields, text) => {
    expect(serviceActionMessage(failed(fields))).toBe(text);
  });
  it("adds whether the bot was started again", () => {
    expect(serviceActionMessage(failed({ reason: "other", kind: "install_rolled_back", detail: "Bootstrap failed", restarted: { pid: 7 } })))
      .toBe("没装上，已经恢复原样：Bootstrap failed。已按原来的端口重新起了 bot（分离运行）。");
    expect(serviceActionMessage({ action: "uninstall", phase: "done", ok: true, kind: "uninstalled", startedAt: 1, restartError: "timed out" }))
      .toBe("bot 现在没在运行：在终端运行 vonvon daemon start。");
  });
  it("carries the service field and the skip request", () => {
    const application = { platform: "macos", version: "1", loginItem: false, dataPath: "/tmp",
      service: { state: "disabled", detail: "d", skipped: true, blocked: "translocated", action: { action: "install", phase: "running", startedAt: 1 } } };
    const snapshot = { revision: 1, observedAt: 1, stale: false, host: { kind: "starting" }, agents: [], groups: [], memberships: [], tools: [], jobs: [], diagnostics: [], application };
    expect(desktopSnapshotSchema.parse(snapshot).application).toEqual(application);
    expect(desktopSnapshotSchema.parse({ ...snapshot, application: { ...application, service: undefined } }).application.service).toBeUndefined();
    expect(machineRequestSchema.parse({ type: "setServiceSkipped", skipped: true })).toEqual({ type: "setServiceSkipped", skipped: true });
    expect(machineRequestSchema.safeParse({ type: "setServiceSkipped" }).success).toBe(false);
  });
});
