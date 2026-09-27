import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createNativeFixture } from "./native-fixtures.mjs";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--os-service-fixture=absent"))
  throw new Error(
    "Only --os-service-fixture=absent is supported. Fresh and existing fixtures are generated automatically.",
  );
const fixtureServiceQueries = args.includes("--os-service-fixture=absent");
if (fixtureServiceQueries && (process.env.CI || process.platform !== "darwin"))
  throw new Error(
    "The explicit absent-service fixture is only supported on a local macOS development host. CI must query the real OS.",
  );
if (
  !["darwin-arm64", "win32-x64"].includes(`${process.platform}-${process.arch}`)
)
  throw new Error("Native validation requires macOS arm64 or Windows x64.");
const target = process.platform === "darwin" ? "mac-arm64" : "win-x64";
const runtime = resolve("build", "runtime", target);
const node = join(
  runtime,
  "node",
  process.platform === "win32" ? "node.exe" : "bin/node",
);
for (const mode of ["fresh", "existing"]) {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), `vonvon-desktop-native-${mode}-`)),
  );
  const originalFiles = await createNativeFixture(home, mode);
  if (fixtureServiceQueries) {
    await mkdir(join(home, "probe-bin"));
    await writeFile(
      join(home, "probe-bin", "launchctl"),
      '#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = list ]; then exit 0; fi\nprintf "Fixture refused launchctl mutation\\n" >&2\nexit 99\n',
      { mode: 0o755 },
    );
  }
  if (fixtureServiceQueries)
    await writeFile(
      join(home, "probe-bin", "ps"),
      '#!/bin/sh\nif [ "$1" = -axo ]; then exit 0; fi\nexec /bin/ps "$@"\n',
      { mode: 0o755 },
    );
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    VONVON_NPM_CLI: join(
      runtime,
      "node",
      process.platform === "win32"
        ? "node_modules/npm/bin/npm-cli.js"
        : "lib/node_modules/npm/bin/npm-cli.js",
    ),
    VONVON_DESKTOP_TEST_HOME: home,
    VONVON_DESKTOP_FIXTURE_MODE: mode,
    VONVON_OS_QUERIES: fixtureServiceQueries
      ? "explicit-development-fixture"
      : "real",
    PATH:
      process.platform === "win32"
        ? `${join(runtime, "node")};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`
        : `${join(runtime, "node", "bin")}:${fixtureServiceQueries ? join(home, "probe-bin") + ":" : ""}/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  delete env.CODEX_BIN;
  delete env.CLAUDE_BIN;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CHATGPT_AUTH_TOKEN;
  const run = (file, commandArgs) =>
    new Promise((accept, reject) => {
      const child = spawn(file, commandArgs, { env, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? accept()
          : reject(
              new Error(
                `Native ${mode} command exited ${code}. Evidence remains at ${home}.`,
              ),
            ),
      );
    });
  await run(require("electron"), ["scripts/native-smoke.cjs"]);
  const report = JSON.parse(
    await readFile(join(home, "native-smoke.json"), "utf8"),
  );
  assert.equal(report.snapshot.host.kind, "connected");
  for (const [path, value] of originalFiles)
    assert.equal(
      await readFile(path, "utf8"),
      value,
      `Existing configuration changed at ${path}`,
    );
  const inspector = join(home, "inspect.mjs");
  await writeFile(
    inspector,
    `import {inspectHost} from ${JSON.stringify(pathToFileURL(join(runtime, "core", "dist", "host.js")).href)};const result=await inspectHost(${JSON.stringify(home)});if(result.kind!=='absent')throw new Error(JSON.stringify(result));process.stdout.write('Owned Host absent after native quit.\\n');`,
  );
  await run(node, [inspector]);
  if (mode === "fresh")
    await run(node, ["scripts/native-codex-smoke.mjs", home, runtime]);
  process.stdout.write(
    `Native ${mode} smoke evidence: ${home}; OS service queries: ${env.VONVON_OS_QUERIES}\n`,
  );
}
