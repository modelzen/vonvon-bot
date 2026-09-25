import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvironmentService } from "../desktop/main/environment";
import { environmentRequestSchema } from "../desktop/shared/environment";

test("Profile operations use fixed arguments, secret stdin and isolated CLI state", async () => {
  const home = await mkdtemp(join(tmpdir(), "vonvon-environment-"));
  const cli = join(home, "lark-cli");
  try {
    await writeFile(cli, `#!/bin/sh
case "$1 $2" in
  "--version ") echo 'lark-cli version 1.2.3' ;;
  "profile list") echo '[{"name":"demo","appId":"cli_fixture","brand":"feishu","active":true,"effective":true,"effectiveSource":"active","futureField":"ignored"}]' ;;
  "profile add") printf '%s\\n' "$@" > "$HOME/args"; IFS= read -r secret; printf '%s' "$secret" > "$HOME/secret" ;;
  "profile use") printf '%s' "$3" > "$HOME/used" ;;
  "config init") echo 'verification_url: https://open.feishu.cn/example'; exec sleep 20 ;;
esac
`);
    await chmod(cli, 0o700);
    const opened: string[] = [];
    const service = new EnvironmentService({ home, ...resolution(home), nodePath: "/usr/bin/node", path: home, fetchLatest: async () => null, openExternal: async (url) => { opened.push(url); } });
    const scanned = await service.run({ type: "scan" });
    assert.equal(scanned.kind, "tools");
    if (scanned.kind === "tools") assert.equal(scanned.tools.find((tool) => tool.tool === "lark-cli")?.installation, "external");
    const before = await service.run({ type: "profileList" });
    assert.equal(before.kind, "profiles");
    if (before.kind === "profiles") assert.deepEqual(before.profiles[0], { name: "demo", appId: "cli_fixture", brand: "feishu", active: true, effective: true, effectiveSource: "active" });
    const added = await service.run(environmentRequestSchema.parse({ type: "profileAdd", name: "demo", appId: "cli_fixture", appSecret: "test-secret", brand: "feishu", use: true }));
    assert.equal(added.kind, "profiles");
    assert.equal(await readFile(join(home, "secret"), "utf8"), "test-secret");
    assert.doesNotMatch(await readFile(join(home, "args"), "utf8"), /test-secret/);
    const switched = await service.run({ type: "profileUse", name: "demo" });
    assert.equal(switched.kind, "profiles");
    assert.equal(await readFile(join(home, "used"), "utf8"), "demo");
    const init = await service.run({ type: "profileInit", name: "new-profile" });
    assert.equal(init.kind, "operation");
    if (init.kind !== "operation" || init.operation?.kind !== "running") return;
    const id = init.operation.id;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const inProgress = await service.run({ type: "profileInitStatus" });
    assert.equal(inProgress.kind, "operation");
    if (inProgress.kind === "operation" && inProgress.operation?.kind === "running") assert.equal(inProgress.operation.url, "https://open.feishu.cn/example");
    const openedReply = await service.run({ type: "openVerification", operationId: id });
    assert.equal(openedReply.kind, "applied");
    assert.deepEqual(opened, ["https://open.feishu.cn/example"]);
    const cancelled = await service.run({ type: "profileInitCancel", operationId: id });
    assert.deepEqual(cancelled, { kind: "operation", operation: { kind: "cancelled", id, message: "已取消。" } });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Only an eligible managed backend can invoke the authenticated Core installer", async () => {
  const home = await mkdtemp(join(tmpdir(), "vonvon-backend-"));
  const calls: string[] = [];
  try {
    const service = new EnvironmentService({
      home, ...resolution(home), nodePath: "/usr/bin/node", path: home, fetchLatest: async () => null,
      hostRequest: async (path, init) => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/api/backends") return Response.json({ entries: [
          { id: "claude-agent", displayName: "Claude Agent SDK", depKind: "npm-ondemand", depState: "not-installed", installable: true, version: null, installedVersion: null, canUninstall: false },
          { id: "codex-appserver", displayName: "Codex", depKind: "external-cli", depState: "installed", installable: false, version: "1.0.0", installedVersion: null, canUninstall: false },
        ] });
        if (path === "/api/backends/claude-agent/install") return new Response("data: {\"type\":\"log\",\"chunk\":\"safe\"}\n\ndata: {\"type\":\"done\"}\n\n", { headers: { "content-type": "text/event-stream" } });
        throw new Error("Unexpected request");
      },
    });
    const blocked = await service.run({ type: "backendInstall", id: "codex-appserver", update: false });
    assert.equal(blocked.kind, "refused");
    const installed = await service.run({ type: "backendInstall", id: "claude-agent", update: false });
    assert.equal(installed.kind, "applied");
    assert.deepEqual(calls, ["GET /api/backends", "GET /api/backends", "POST /api/backends/claude-agent/install"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Tool installation and removal stay in the Vonvon managed directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "vonvon-tool-"));
  const npm = join(home, "npm");
  const root = join(home, ".feishu-codex-bridge");
  await mkdir(root);
  await writeFile(join(home, "codex"), "#!/bin/sh\necho codex-cli 1.0.0\n", { mode: 0o700 });
  try {
    await writeFile(npm, `#!/bin/sh
prefix="$4"
printf '%s\\n' "$@" > "$HOME/npm-args"
if [ "$1" = install ]; then
  mkdir -p "$prefix/lib/node_modules/@openai/codex" "$prefix/bin"
  printf '{"name":"@openai/codex","version":"1.2.3"}' > "$prefix/lib/node_modules/@openai/codex/package.json"
  printf '#!/bin/sh\\necho codex-cli 1.2.3\\n' > "$prefix/bin/codex"
  chmod +x "$prefix/bin/codex"
else
  rm -f "$prefix/lib/node_modules/@openai/codex/package.json" "$prefix/bin/codex"
fi
`);
    await chmod(npm, 0o700);
    const service = new EnvironmentService({ home, ...resolution(home, root), nodePath: "/usr/bin/node", npmPath: npm, path: home, fetchLatest: async () => "1.2.3" });
    const initial = await service.run({ type: "scan" });
    assert.equal(initial.kind, "tools");
    if (initial.kind === "tools") assert.equal(initial.tools.find((tool) => tool.tool === "codex")?.installation, "external");
    const installed = await service.run({ type: "update", tool: "codex" });
    assert.equal(installed.kind, "applied");
    const after = await service.run({ type: "scan" });
    assert.equal(after.kind, "tools");
    if (after.kind === "tools") {
      const codex = after.tools.find((tool) => tool.tool === "codex");
      assert.equal(codex?.installation, "managed");
      assert.equal(codex?.version, "1.2.3");
      assert.equal(codex?.canUninstall, true);
    }
    assert.match(await readFile(join(home, "npm-args"), "utf8"), /@openai\/codex@latest/);
    const removed = await service.run({ type: "uninstall", tool: "codex" });
    assert.equal(removed.kind, "applied");
    const final = await service.run({ type: "scan" });
    if (final.kind === "tools") assert.equal(final.tools.find((tool) => tool.tool === "codex")?.installation, "external");
    assert.equal(existsSync(join(home, ".vonvon-bridge")), false);
    assert.match(await readFile(join(home, "codex"), "utf8"), /1.0.0/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

function resolution(home: string, root = join(home, ".vonvon-bridge")) {
  return {
    getDataRoot: () => root,
    resolveCodex: () => {
      const managed = join(root, "managed-tools", "bin", "codex");
      const external = join(home, "codex");
      return existsSync(managed) ? managed : existsSync(external) ? external : null;
    },
  };
}

test("Authorization reads Codex stderr and structured Claude and effective Lark identity status", async () => {
  const home = await mkdtemp(join(tmpdir(), "vonvon-auth-"));
  try {
    await writeFile(join(home, "codex"), '#!/bin/sh\necho "Logged in using ChatGPT" >&2\n', { mode: 0o700 });
    await writeFile(join(home, "claude"), '#!/bin/sh\necho \'{"loggedIn":false,"authMethod":"none"}\'\n', { mode: 0o700 });
    await writeFile(join(home, "lark-cli"), '#!/bin/sh\necho \'{"defaultAs":"user","identities":{"user":{"available":true,"status":"valid"},"bot":{"available":false}},"note":"test"}\'\n', { mode: 0o700 });
    const service = new EnvironmentService({ home, ...resolution(home), nodePath: "/usr/bin/node", path: home, fetchLatest: async () => null });
    assert.deepEqual(await service.run({ type: "authStatus", tool: "codex" }), { kind: "auth", tool: "codex", state: "signedIn", message: "已授权" });
    assert.deepEqual(await service.run({ type: "authStatus", tool: "claude" }), { kind: "auth", tool: "claude", state: "signedOut", message: "尚未授权" });
    assert.deepEqual(await service.run({ type: "authStatus", tool: "lark-cli" }), { kind: "auth", tool: "lark-cli", state: "signedIn", message: "已授权" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Close drains login and its subprocess before refusing further requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "vonvon-close-login-"));
  const cli = join(home, "codex");
  const service = new EnvironmentService({ home, ...resolution(home), nodePath: process.execPath, path: home });
  try {
    await writeFile(cli, '#!/bin/sh\nsleep 120 &\necho "$!" > "$HOME/child-pid"\nwait\n', { mode: 0o700 });
    const started = await service.run({ type: "startLogin", tool: "codex" });
    assert.equal(started.kind, "operation");
    const pid = await fixturePid(join(home, "child-pid"));
    await service.close();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.deepEqual(await service.run({ type: "startLogin", tool: "codex" }), { kind: "refused", code: "environment-closed", message: "本机环境正在退出。" });
    await service.close();
  } finally { await service.close(); await rm(home, { recursive: true, force: true }); }
});

test("Close drains an npm install instead of allowing it to survive the desktop", async () => {
  const home = await mkdtemp(join(tmpdir(), "vonvon-close-install-"));
  const npm = join(home, "npm");
  const service = new EnvironmentService({ home, ...resolution(home), nodePath: process.execPath, npmPath: npm, path: home });
  try {
    await writeFile(npm, '#!/bin/sh\ntrap "" TERM\necho "$$" > "$HOME/npm-pid"\nwhile :; do sleep 1; done\n', { mode: 0o700 });
    const install = service.run({ type: "install", tool: "codex" });
    const pid = await fixturePid(join(home, "npm-pid"));
    await service.close();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal((await install).kind, "refused");
  } finally { await service.close(); await rm(home, { recursive: true, force: true }); }
});

test("Close prevents a delayed asynchronous resolver from launching a new login", async () => {
  const home = await mkdtemp(join(tmpdir(), "vonvon-close-resolver-"));
  let release: (value: string | null) => void = () => { throw new Error("Resolver not initialized"); };
  const selected = new Promise<string | null>((resolve) => { release = resolve; });
  const service = new EnvironmentService({ home, getDataRoot: () => home, resolveCodex: () => selected, nodePath: process.execPath });
  try {
    const pending = service.run({ type: "startLogin", tool: "codex" });
    const close = service.close();
    release(process.execPath);
    await close;
    assert.equal((await pending).kind, "refused");
  } finally { await service.close(); await rm(home, { recursive: true, force: true }); }
});

async function fixturePid(file: string): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const text = await readFile(file, "utf8").catch(() => "");
    const pid = Number(text.trim());
    if (Number.isInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Fixture did not start");
}

test("Close refuses to confirm completion while an environment request is still running", async () => {
  const home = await mkdtemp(join(tmpdir(), "vonvon-close-pending-"));
  let release: (value: Response) => void = () => { throw new Error("Request not initialized"); };
  const response = new Promise<Response>((resolve) => { release = resolve; });
  const service = new EnvironmentService({ home, ...resolution(home), nodePath: process.execPath, hostRequest: () => response });
  try {
    const request = service.run({ type: "backendCatalog" });
    await assert.rejects(service.close(), /尚未退出/);
    assert.equal((await service.run({ type: "backendCatalog" })).kind, "refused");
    release(Response.json({ entries: [] }));
    await request;
    await service.close();
  } finally { release(Response.json({ entries: [] })); await service.close(); await rm(home, { recursive: true, force: true }); }
});
