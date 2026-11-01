import { describe, expect, it } from "vitest";
import { adminReplySchema, distributionKinds, machineReplySchema } from "../src/index.js";

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
