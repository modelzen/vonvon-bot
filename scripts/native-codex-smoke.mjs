import assert from "node:assert/strict";
import { realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(
  process.argv.length,
  4,
  "Expected isolated home and bundled runtime arguments.",
);
const [home, runtime] = process.argv.slice(2);
assert.ok(
  isAbsolute(home) && isAbsolute(runtime),
  "Native Codex paths must be absolute.",
);
assert.equal(home, await realpath(home));
assert.equal(runtime, await realpath(runtime));
assert.equal(home, homedir());
assert.equal(home, process.env.HOME);
assert.equal(home, process.env.USERPROFILE);
assert.equal(home, process.env.VONVON_DESKTOP_TEST_HOME);
assert.equal(process.env.VONVON_DESKTOP_FIXTURE_MODE, "fresh");
assert.match(basename(home), /^vonvon-desktop-native-fresh-[A-Za-z0-9_-]+$/);
assert.equal(dirname(home), await realpath(tmpdir()));
for (const [key, value] of Object.entries({
  CODEX_HOME: join(home, ".codex"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
}))
  assert.equal(process.env[key], value, `${key} must use the isolated home.`);
assert.equal(await realpath(process.env.CODEX_HOME), process.env.CODEX_HOME);
assert.equal((await stat(process.env.CODEX_HOME)).isDirectory(), true);
assert.equal(
  process.env.CODEX_BIN,
  undefined,
  "A Codex override would invalidate this installation check.",
);
assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
assert.ok(
  ["darwin-arm64", "win32-x64"].includes(`${process.platform}-${process.arch}`),
);
const target = process.platform === "darwin" ? "mac-arm64" : "win-x64";
assert.equal(
  runtime,
  await realpath(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "build",
      "runtime",
      target,
    ),
  ),
);
const nodePath = join(
  runtime,
  "node",
  process.platform === "win32" ? "node.exe" : "bin/node",
);
const npmPath = join(
  runtime,
  "node",
  process.platform === "win32"
    ? "node_modules/npm/bin/npm-cli.js"
    : "lib/node_modules/npm/bin/npm-cli.js",
);
const cliPath = join(runtime, "core", "bin", "feishu-codex-bridge.mjs");
const hostPath = join(runtime, "core", "dist", "host.js");
assert.equal(
  await realpath(process.execPath),
  await realpath(nodePath),
  "Run this check with bundled Node.",
);
assert.equal(
  process.env.VONVON_NPM_CLI,
  npmPath,
  "The Host must use bundled npm.",
);
for (const path of [nodePath, npmPath, cliPath, hostPath]) {
  assert.equal((await stat(path)).isFile(), true);
  const local = relative(runtime, await realpath(path));
  assert.ok(
    local && !local.startsWith("..") && !isAbsolute(local),
    `Runtime path escaped its bundle: ${path}`,
  );
}

const { connectHost, inspectHost } = await import(pathToFileURL(hostPath).href);
assert.deepEqual(
  await inspectHost(home),
  { kind: "absent" },
  "Electron must release its Host before the install check.",
);
const report = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  home,
  runtime,
  osServiceQueries: process.env.VONVON_OS_QUERIES,
};
let handle;
let failure;
try {
  const connected = await connectHost({ home, nodePath, cliPath });
  assert.equal(connected.kind, "connected", JSON.stringify(connected));
  handle = connected;
  assert.equal(
    handle.ownership,
    "owned",
    "Never install through an attached Host in this check.",
  );
  const deadline = Date.now() + 6 * 60_000;
  async function request(path, expectedStatus, method = "GET") {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, "Native Codex installation exceeded six minutes.");
    const response = await handle.request(path, {
      method,
      signal: AbortSignal.timeout(Math.min(20_000, remaining)),
    });
    const body = await response.text();
    assert.equal(
      response.status,
      expectedStatus,
      `${method} ${path} returned ${response.status}: ${body.slice(0, 2000)}`,
    );
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(
        `${method} ${path} returned invalid JSON: ${body.slice(0, 500)}`,
        { cause: error },
      );
    }
  }
  const initial = await request("/api/tools/codex/setup", 200);
  assert.equal(initial.installation, "missing", JSON.stringify(initial));
  const started = await request("/api/tools/codex/install", 202, "POST");
  assert.equal(typeof started.id, "string");
  assert.match(started.id, /^[A-Za-z0-9_-]{1,180}$/);
  report.jobId = started.id;
  process.stdout.write(`Native Codex install started: ${started.id}\n`);
  while (true) {
    const job = await request(
      `/api/tools/codex/jobs/${encodeURIComponent(started.id)}`,
      200,
    );
    assert.equal(job.id, started.id);
    assert.equal(job.type, "install");
    assert.ok(
      ["running", "succeeded", "failed", "cancelled"].includes(job.state),
      `Unexpected install state: ${JSON.stringify(job)}`,
    );
    report.job = job;
    if (job.state !== "running") {
      assert.equal(
        job.state,
        "succeeded",
        `Native Codex installation failed: ${JSON.stringify(job)}`,
      );
      break;
    }
    await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
  const setup = await request("/api/tools/codex/setup", 200);
  report.setup = setup;
  assert.equal(setup.installation, "installed", JSON.stringify(setup));
  assert.equal(setup.version, "codex-cli 0.156.1", JSON.stringify(setup));
  assert.equal(setup.authentication, "signedOut", JSON.stringify(setup));
  process.stdout.write(
    `Native Codex setup confirmed: ${setup.version}, ${setup.authentication}\n`,
  );
} catch (error) {
  failure = error;
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  if (handle) {
    try {
      await handle.close();
      const afterClose = await inspectHost(home);
      report.afterClose = afterClose;
      assert.deepEqual(
        afterClose,
        { kind: "absent" },
        "Host remained after native Codex installation cleanup.",
      );
      process.stdout.write(
        "Owned Host absent after native Codex installation.\n",
      );
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            "Native Codex check and Host cleanup failed.",
          )
        : error;
      report.cleanupError =
        error instanceof Error ? error.message : String(error);
    }
  }
  await writeFile(
    join(home, "native-codex-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
if (failure) throw failure;
