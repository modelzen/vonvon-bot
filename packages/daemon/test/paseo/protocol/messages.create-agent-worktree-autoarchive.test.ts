// Modified for Vonvon Bot: import specifiers point to the local Paseo closure.
import { describe, expect, test } from "vitest";

import { SessionInboundMessageSchema } from "../../../src/agent/paseo/protocol/messages.js";

describe("create_agent_request worktree and autoArchive fields", () => {
  test("accepts optional worktree branch-off target and autoArchive", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      requestId: "create-agent-worktree",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      worktree: {
        mode: "branch-off",
        newBranch: "agent-lifecycle-dispatch",
        base: "main",
      },
      autoArchive: true,
    });

    expect(parsed).toEqual({
      type: "create_agent_request",
      requestId: "create-agent-worktree",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      worktree: {
        mode: "branch-off",
        newBranch: "agent-lifecycle-dispatch",
        base: "main",
      },
      autoArchive: true,
      labels: {},
    });
  });

  test("keeps legacy create_agent_request defaults unchanged", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      requestId: "legacy-create-agent",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
    });

    expect(parsed).toEqual({
      type: "create_agent_request",
      requestId: "legacy-create-agent",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      labels: {},
    });
  });
});
