import { describe, expect, it } from "vitest";

import { ACPProviderOptionsSchema } from "../src/agent/providers/acp-options.js";

describe("ACPProviderOptionsSchema", () => {
  it("accepts optional ACP capabilities and preserves provider-specific options", () => {
    expect(
      ACPProviderOptionsSchema.parse({
        supportsMcpServers: true,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: false },
          terminal: true,
        },
        providerCommand: "custom-acp",
      }),
    ).toEqual({
      supportsMcpServers: true,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: true,
      },
      providerCommand: "custom-acp",
    });
  });

  it("rejects invalid capability values", () => {
    expect(
      ACPProviderOptionsSchema.safeParse({
        clientCapabilities: { fs: { writeTextFile: "yes" } },
      }).success,
    ).toBe(false);
  });
});
