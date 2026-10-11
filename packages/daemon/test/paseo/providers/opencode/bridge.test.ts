// Modified from Paseo: retain tests for V2 plugin helpers; internal route-server cases were removed.
// Modified from Paseo: type-only edits erased at compile time; see packages/daemon/src/agent/paseo/closure.json.
import type { SessionMessageInfo } from "@opencode/client";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  loadOpenCodeBridgePluginArtifact,
  materializeOpenCodeV2Plugin,
} from "../../../../src/agent/providers/opencode/bridge.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("OpenCodeBridge V2 helpers", () => {
  test("loads packaged bundle bytes without invoking source compilation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-artifact-"));
    temporaryDirectories.push(root);
    const moduleUrl = pathToFileURL(path.join(root, "bridge.js")).href;
    const bundle = Buffer.from("export default async () => ({})");
    await writeFile(path.join(root, "bridge-plugin.bundle.mjs"), bundle);
    const compileSource = vi.fn(async () => {
      throw new Error("packaged runtime must not compile");
    });

    await expect(loadOpenCodeBridgePluginArtifact(moduleUrl, compileSource)).resolves.toEqual(
      bundle,
    );
    expect(compileSource).not.toHaveBeenCalled();

    await rm(path.join(root, "bridge-plugin.bundle.mjs"));
    await expect(loadOpenCodeBridgePluginArtifact(moduleUrl, compileSource)).rejects.toThrow(
      "artifact is missing",
    );
    expect(compileSource).not.toHaveBeenCalled();
  });

  test("allows source modules to compile the development artifact", async () => {
    const artifact = new Uint8Array([1, 2, 3]);
    const compileSource = vi.fn(async () => artifact);
    const moduleUrl = new URL("./bridge.ts", import.meta.url).href;

    await expect(loadOpenCodeBridgePluginArtifact(moduleUrl, compileSource)).resolves.toBe(
      artifact,
    );
    expect(compileSource).toHaveBeenCalledWith(
      fileURLToPath(new URL("./bridge-plugin.mjs", moduleUrl)),
    );
  });

  test("v2 structured output validates values and clears its tool on ordinary turns", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-v2-structured-"));
    temporaryDirectories.push(root);
    const pluginUrl = await materializeOpenCodeV2Plugin(root);
    const module: {
      default: { setup(context: V2TestPluginContext): Promise<() => Promise<void>> };
    } = await import(pathToFileURL(path.join(fileURLToPath(pluginUrl), "server.js")).href);
    const schema = {
      type: "object",
      properties: { answer: { type: "integer" } },
      required: ["answer"],
      additionalProperties: false,
    };
    const history: SessionMessageInfo[] = [
      {
        id: "user",
        type: "user",
        text: "answer",
        time: { created: 1 },
        metadata: { paseoOutputSchema: schema },
      },
    ];
    const tools = new Map<string, V2TestTool>();
    let hook!: (input: V2TestContext) => Promise<void>;
    const dispose = await module.default.setup({
      options: { baseUrl: "", token: "" },
      tool: {
        transform: async (transform) => {
          transform({
            add: (tool) => {
              tools.set(tool.name, tool);
            },
          });
          return { dispose: async () => undefined };
        },
      },
      session: {
        context: async () => history,
        get: async () => ({ parentID: "parent" }),
        hook: async (_name, callback) => {
          hook = callback;
          return { dispose: async () => undefined };
        },
      },
    });
    try {
      const context: V2TestContext = {
        sessionID: "session",
        tools: { paseo_structured_output: {} },
        system: [],
      };
      await hook(context);
      expect(context.tools.paseo_structured_output!.input).toMatchObject({
        properties: { value: schema },
      });
      const tool = tools.get("paseo_structured_output")!;
      await expect(
        tool.execute({ value: { answer: "wrong" } }, { sessionID: "session" }),
      ).rejects.toThrow("Invalid structured output");
      await expect(
        tool.execute({ value: { answer: 42 } }, { sessionID: "session" }),
      ).resolves.toMatchObject({ metadata: { paseoStructuredOutput: { answer: 42 } } });
      history.push({ id: "next", type: "user", text: "ordinary", time: { created: 2 } });
      await hook(context);
      expect(context.tools).toEqual({});
      await expect(
        tool.execute({ value: { answer: 42 } }, { sessionID: "session" }),
      ).rejects.toThrow("no structured-output request");
    } finally {
      await dispose();
    }
  });

});

interface V2TestTool {
  name: string;
  execute(input: unknown, call: { sessionID: string }): Promise<unknown>;
}
interface V2TestContext {
  sessionID: string;
  tools: Record<string, { input?: unknown }>;
  system?: Array<{ type: "text"; text: string }>;
}
interface V2TestPluginContext {
  options: { baseUrl: string; token: string };
  tool: {
    transform(
      callback: (editor: { add(tool: V2TestTool): void }) => void,
    ): Promise<{ dispose(): Promise<void> }>;
  };
  session: {
    context(input: { sessionID: string }): Promise<SessionMessageInfo[]>;
    get(input: { sessionID: string }): Promise<{ parentID: string }>;
    hook(
      name: string,
      callback: (input: V2TestContext) => Promise<void>,
    ): Promise<{ dispose(): Promise<void> }>;
  };
}
