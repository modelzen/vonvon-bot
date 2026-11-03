import { describe, expect, it } from "vitest";
import { memoryReplySchema, memoryRequestSchema, replyEnvelopeSchema, requestSchema } from "../src/index";

describe("memory requests", () => {
  const project = { kind: "project", projectId: "prj_0a1b2c3d" };
  it("accepts every request of the design's RPC list, branchRename and branchMerge included", () => {
    for (const payload of [
      { type: "list", scope: project },
      { type: "add", scope: project, text: "周四发版", branch: "决定" },
      { type: "edit", scope: project, itemId: "p_prj_0a1b2c3d:abcdef", revision: 2, text: "周五发版" },
      { type: "archive", scope: project, itemId: "x", revision: 1 },
      { type: "restore", scope: { kind: "bot", botId: "cli_a" }, itemId: "x", revision: 1 },
      { type: "promote", scope: project, itemId: "x", revision: 1, botId: "cli_a", branch: "合作方式" },
      { type: "move", scope: { kind: "bot", botId: "cli_a" }, itemId: "x", revision: 1, to: { projectId: "prj_0a1b2c3d" } },
      { type: "branchRename", scope: project, from: "发版", to: "上线" },
      { type: "branchMerge", scope: project, from: "发版", into: "决定" },
      { type: "branchDelete", scope: project, name: "发版" },
      { type: "branchDelete", scope: project, name: "发版", expected: 0 },
      { type: "confirm", scope: project, itemId: "x", revision: 1 },
      { type: "purge", scope: project, itemId: "x" },
      { type: "undo", scope: project, eventId: "e" },
      { type: "export", scope: { kind: "dm", botId: "cli_a", openId: "ou_x" } },
      { type: "events", scope: project, itemId: "x" },
    ]) expect(memoryRequestSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(true);
  });

  it("rejects an empty or over-long text, an unknown key and a missing scope", () => {
    expect(memoryRequestSchema.safeParse({ type: "add", scope: project, text: "  " }).success).toBe(false);
    expect(memoryRequestSchema.safeParse({ type: "add", scope: project, text: "字".repeat(501) }).success).toBe(false);
    expect(memoryRequestSchema.safeParse({ type: "add", scope: project, text: "字".repeat(500) }).success).toBe(true);
    expect(memoryRequestSchema.safeParse({ type: "add", scope: project, text: "x", extra: 1 }).success).toBe(false);
    expect(memoryRequestSchema.safeParse({ type: "list" }).success).toBe(false);
    expect(memoryRequestSchema.safeParse({ type: "branchMerge", scope: project, from: "a" }).success).toBe(false);
    // C5: a count is a whole number, and a branch has a name
    expect(memoryRequestSchema.safeParse({ type: "branchDelete", scope: project, name: "a", expected: -1 }).success).toBe(false);
    expect(memoryRequestSchema.safeParse({ type: "branchDelete", scope: project, name: "" }).success).toBe(false);
  });

  it("travels inside the request and reply envelopes", () => {
    expect(requestSchema.safeParse({ type: "request", id: "1", method: "memory", payload: { type: "list", scope: project } }).success).toBe(true);
    const reply = { kind: "purged" };
    expect(memoryReplySchema.safeParse(reply).success).toBe(true);
    expect(replyEnvelopeSchema.safeParse({ type: "response", id: "1", method: "memory", payload: reply }).success).toBe(true);
    expect(replyEnvelopeSchema.safeParse({ type: "response", id: "1", method: "memory", payload: { kind: "nope" } }).success).toBe(false);
  });
});
