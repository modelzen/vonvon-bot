import { describe, expect, it } from "vitest";
import { adminReplySchema, distributionKinds, machineReplySchema, machineRequestSchema } from "../src/index.js";

const status = (kind: string) => ({ kind: "daemonStatus", status: { distribution: { kind, cliPath: "/x/bin/vonvon.mjs" }, installed: true, running: true, selfHosted: false, version: "0.9.0", supported: true } });
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
