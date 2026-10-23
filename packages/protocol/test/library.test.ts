import { describe, expect, it } from "vitest";
import { libraryReplySchema, libraryRequestSchema } from "../src/library.js";

const workspace = { primary: "/work/pay", additional: [] };

describe("library protocol", () => {
  it("accepts a list and a workspace request, and refuses extra keys, a bad id and a zero revision", () => {
    expect(libraryRequestSchema.parse({ type: "list" })).toEqual({ type: "list" });
    const request = { type: "workspace", projectId: "prj_abc12345", revision: 1, workspace };
    const parsed = libraryRequestSchema.safeParse(request);
    if (!parsed.success) throw new Error("the sample project id no longer matches projectIdSchema");
    expect(libraryRequestSchema.safeParse({ ...request, extra: 1 }).success).toBe(false);
    expect(libraryRequestSchema.safeParse({ ...request, projectId: "nope" }).success).toBe(false);
    expect(libraryRequestSchema.safeParse({ ...request, revision: 0 }).success).toBe(false);
    expect(libraryRequestSchema.safeParse({ ...request, workspace: { ...workspace, primary: "" } }).success).toBe(false);
  });

  it("parses a workspace reply with a failed binding and a list reply", () => {
    const project = { id: "prj_abc12345", name: "支付组", revision: 2, workspace };
    expect(libraryReplySchema.safeParse({ kind: "workspace", project, changed: true,
      rebound: [{ agentId: "cli_a", groupId: "oc_pay", state: "archived" }, { agentId: "cli_b", state: "failed", message: "运行中" }] }).success).toBe(true);
    expect(libraryReplySchema.safeParse({ kind: "list", projects: [{ ...project, bindings: [{ agentId: "cli_a", groupId: "oc_pay", name: "支付组", enabled: true }] }], unlinked: 0 }).success).toBe(true);
    expect(libraryReplySchema.safeParse({ kind: "workspace", project, changed: true, rebound: [{ agentId: "cli_a", state: "maybe" }] }).success).toBe(false);
  });
});
