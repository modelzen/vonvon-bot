// Modified for Vonvon Bot: local Paseo imports and strict TypeScript payload narrowing.
import { describe, expect, it } from "vitest";
import {
  parseServerInfoStatusPayload,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "../../../src/agent/paseo/protocol/messages.js";

type ParsedOutboundPayload = Record<string, unknown> & {
  project?: { projectDisplayName?: string } | null;
  errorCode?: string | null;
  repositories?: Array<{ name: string }>;
};

function parseOutboundPayload(input: unknown): ParsedOutboundPayload {
  const parsed = SessionOutboundMessageSchema.parse(input);
  if (!("payload" in parsed)) throw new Error("expected outbound payload");
  return parsed.payload as ParsedOutboundPayload;
}

describe("project command-center protocol", () => {
  it("parses the dotted GitHub repository search request and normalized success response", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.github.search_repositories.request",
        query: "paseo",
        limit: 12,
        requestId: "req-search",
      }),
    ).toEqual({
      type: "workspace.github.search_repositories.request",
      query: "paseo",
      limit: 12,
      requestId: "req-search",
    });

    expect(
      parseOutboundPayload({
        type: "workspace.github.search_repositories.response",
        payload: {
          status: "success",
          requestId: "req-search",
          repositories: [
            {
              id: "R_paseo",
              name: "paseo",
              nameWithOwner: "getpaseo/paseo",
              description: "Development environment in your pocket",
              visibility: "public",
              updatedAt: "2026-07-15T10:00:00Z",
              cloneUrl: "git@github.com:getpaseo/paseo.git",
            },
          ],
          available: true,
          error: null,
        },
      }),
    ).toEqual({
      status: "success",
      requestId: "req-search",
      repositories: [
        {
          id: "R_paseo",
          name: "paseo",
          nameWithOwner: "getpaseo/paseo",
          description: "Development environment in your pocket",
          visibility: "public",
          updatedAt: "2026-07-15T10:00:00Z",
          cloneUrl: "git@github.com:getpaseo/paseo.git",
        },
      ],
      available: true,
      error: null,
    });
  });

  it.each([
    { status: "unavailable", reason: "gh_missing", message: "gh is missing" },
    { status: "unauthenticated", message: "sign in" },
    { status: "error", message: "command failed" },
  ])("parses the GitHub $status runtime state", (payload) => {
    expect(
      SessionOutboundMessageSchema.safeParse({
        type: "workspace.github.search_repositories.response",
        payload: {
          requestId: "req-search",
          repositories: [],
          available: payload.status === "error",
          error: payload.message,
          ...payload,
        },
      }).success,
    ).toBe(true);
  });

  it("parses atomic project directory creation request and response", () => {
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "project.create_directory.request",
        parentPath: "/Users/example/dev",
        name: "new-project",
        requestId: "req-create",
      }).success,
    ).toBe(true);

    expect(
      parseOutboundPayload({
        type: "project.create_directory.response",
        payload: {
          requestId: "req-create",
          directoryPath: "/Users/example/dev/new-project",
          project: {
            projectId: "directory:/Users/example/dev/new-project",
            projectDisplayName: "new-project",
            projectCustomName: null,
            projectRootPath: "/Users/example/dev/new-project",
            projectKind: "non_git",
          },
          error: null,
          errorCode: null,
        },
      }).project?.projectDisplayName,
    ).toBe("new-project");

    expect(
      SessionInboundMessageSchema.safeParse({
        type: "project.create_directory.request",
        parentPath: "",
        name: "",
        requestId: "req-invalid-create",
      }).success,
    ).toBe(true);
  });

  it("accepts future project directory error codes without transforming wire values", () => {
    expect(
      parseOutboundPayload({
        type: "project.create_directory.response",
        payload: {
          requestId: "req-create",
          directoryPath: null,
          project: null,
          error: "A newer failure",
          errorCode: "future_failure_reason",
        },
      }).errorCode,
    ).toBe("future_failure_reason");

    expect(
      parseOutboundPayload({
        type: "workspace.github.search_repositories.response",
        payload: {
          status: "success",
          requestId: "req-search",
          repositories: [
            {
              id: "repo",
              name: " paseo ",
              nameWithOwner: " getpaseo/paseo ",
              description: null,
              visibility: "public",
              updatedAt: "2026-07-15T10:00:00Z",
              cloneUrl: " https://github.com/getpaseo/paseo ",
            },
          ],
          available: true,
          error: null,
        },
      }).repositories?.[0]?.name,
    ).toBe(" paseo ");
  });

  it("keeps project command feature flags optional for older server_info payloads", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "server-old",
      features: {},
    });

    expect(parsed).not.toBeNull();
    if (parsed === null) throw new Error("expected parsed server info");
    expect(parsed.features).toBeDefined();
    if (parsed.features === undefined) throw new Error("expected legacy features object");
    expect(parsed.features.workspaceGithubRepositorySearch).toBeUndefined();
    expect(parsed.features.projectGithubClone).toBeUndefined();
    expect(parsed.features.projectCreateDirectory).toBeUndefined();
  });

  it("parses the agent thinking update capability", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "server-new",
      features: { agentThinkingUpdate: true },
    });

    expect(parsed?.features?.agentThinkingUpdate).toBe(true);
  });
});
