// Modified for Vonvon Bot: import specifiers point to the local Paseo closure.
import { describe, expect, it } from "vitest";

import { TerminalInputSchema } from "../../../src/agent/paseo/protocol/messages.js";

describe("terminal resize messages", () => {
  it.each(["claim", "update"] as const)("accepts the optional %s intent", (intent) => {
    const result = TerminalInputSchema.safeParse({
      type: "terminal_input",
      terminalId: "terminal-1",
      message: { type: "resize", rows: 24, cols: 80, intent },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        message: { type: "resize", rows: 24, cols: 80, intent },
      },
    });
  });

  it("accepts legacy resize messages without an intent", () => {
    const result = TerminalInputSchema.safeParse({
      type: "terminal_input",
      terminalId: "terminal-1",
      message: { type: "resize", rows: 24, cols: 80 },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        message: { type: "resize", rows: 24, cols: 80 },
      },
    });
  });
});
