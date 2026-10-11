// Modified from Paseo: remove the internal route server; retain the V2 plugin helpers.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { writeFileAtomic } from "../../paseo/runtime/server/atomic-file.js";
import type { PaseoToolCatalog } from "../../paseo/tools/types.js";

interface OpenCodeSessionBinding {
  env: Record<string, string>;
  tools?: PaseoToolCatalog;
}

interface BindOpenCodeSessionInput extends OpenCodeSessionBinding {
  sessionId: string;
}

interface OpenCodeConfig {
  plugin?: Array<string | [string, Record<string, unknown>]>;
  [key: string]: unknown;
}

export interface OpenCodeBridge {
  bindSession(input: BindOpenCodeSessionInput): () => void;
  decorateV2ServerEnv(env: Record<string, string>): Promise<Record<string, string>>;
}

export async function materializeOpenCodeV2Plugin(paseoHome: string): Promise<string> {
  const artifact = await loadOpenCodeBridgePluginArtifact(import.meta.url, undefined, 2);
  const digest = createHash("sha256").update(artifact).digest("hex");
  // V2 ignores configured file paths; it loads a package directory's server entry point.
  const directory = path.join(paseoHome, "runtime", "opencode", `paseo-v2-${digest}`);
  await writeFileAtomic(path.join(directory, "server.js"), artifact);
  await writeFileAtomic(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "paseo-opencode-bridge",
      private: true,
      type: "module",
      exports: { "./server": "./server.js" },
    }),
  );
  return pathToFileURL(directory).href;
}

export function decorateOpenCodeV2Env(
  env: Record<string, string>,
  pluginUrl: string,
  options: Record<string, string> = {},
): Record<string, string> {
  const config = parseOpenCodeConfig(env.OPENCODE_CONFIG_CONTENT);
  const plugins = config.plugins;
  if (plugins !== undefined && !Array.isArray(plugins))
    throw new Error("OpenCode v2 plugins must be an array");
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      plugins: [
        ...(plugins ?? []).filter(
          (plugin: unknown) =>
            plugin !== pluginUrl &&
            !(
              typeof plugin === "object" &&
              plugin !== null &&
              "package" in plugin &&
              plugin.package === pluginUrl
            ),
        ),
        { package: pluginUrl, options },
      ],
    }),
  };
}

type CompileOpenCodeBridgePlugin = (sourcePath: string) => Promise<Uint8Array>;

export async function loadOpenCodeBridgePluginArtifact(
  moduleUrl: string,
  compileSource: CompileOpenCodeBridgePlugin = compileOpenCodeBridgePlugin,
  version: 1 | 2 = 1,
): Promise<Uint8Array> {
  const directory = version === 2 ? "./v2/" : "./";
  const bundleUrl = new URL(`${directory}bridge-plugin.bundle.mjs`, moduleUrl);
  try {
    return await readFile(bundleUrl);
  } catch (error) {
    if (!fileURLToPath(moduleUrl).endsWith(`${path.sep}bridge.ts`)) {
      throw new Error("Bundled OpenCode bridge plugin artifact is missing", { cause: error });
    }
  }
  return compileSource(fileURLToPath(new URL(`${directory}bridge-plugin.mjs`, moduleUrl)));
}

async function compileOpenCodeBridgePlugin(sourcePath: string): Promise<Uint8Array> {
  const source = await readFile(sourcePath, "utf8");
  const { build } = await import("esbuild");
  const bundled = await build({
    stdin: {
      contents: source,
      resolveDir: path.dirname(sourcePath),
      sourcefile: path.basename(sourcePath),
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
    write: false,
  });
  const artifact = bundled.outputFiles[0]?.contents;
  if (!artifact) throw new Error("Failed to bundle the OpenCode bridge plugin");
  return artifact;
}

function parseOpenCodeConfig(value: string | undefined): OpenCodeConfig {
  if (!value?.trim()) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENCODE_CONFIG_CONTENT must contain a JSON object");
  }
  return parsed as OpenCodeConfig;
}

