import { describe, expect, it } from "vitest";
import { contextPreviewReplySchema, requestSchema, responseSchema } from "../src/index.js";

const reply = {
  kind: "preview", running: true,
  next: { sections: [{ key: "role", version: "a1b2c3", chars: 12 }], items: { bot: 1, trusted: 2, untrusted: 0 }, tools: ["memory_add"] },
  session: { threadId: "t", updatedAt: 1, backend: "codex-appserver", legacy: false, redeliverDue: false, sections: [{ key: "role", version: "a1b2c3", stale: false }], lastTurn: { at: 2, injected: 3, items: { bot: 1, trusted: 2, untrusted: 0 }, used: [{ id: "b:9p1x", text: "x" }, { id: "gone" }] } },
  judge: { via: "local", roleChars: 4, memoryItems: 0, memoryChars: 0 },
};

describe("contextPreview over the wire", () => {
  it("is a request method and a response method", () => {
    const payload = { type: "get", agentId: "cli_a", place: { kind: "group", groupId: "oc_here" } };
    expect(requestSchema.safeParse({ type: "request", id: "1", method: "contextPreview", payload }).success).toBe(true);
    expect(requestSchema.safeParse({ type: "request", id: "1", method: "contextPreview", payload: { ...payload, path: "/x" } }).success).toBe(false);
    expect(responseSchema.safeParse({ type: "response", id: "1", method: "contextPreview", payload: reply }).success).toBe(true);
  });
  it("has no field for a project file or a path", () => {
    expect(contextPreviewReplySchema.safeParse(reply).success).toBe(true);
    expect(contextPreviewReplySchema.safeParse({ ...reply, files: [{ path: "AGENTS.md" }] }).success).toBe(false);
    expect(contextPreviewReplySchema.safeParse({ ...reply, next: { ...reply.next, sources: ["CLAUDE.md"] } }).success).toBe(false);
  });
});
