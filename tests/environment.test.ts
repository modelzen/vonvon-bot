import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  "profile list") echo '[{"name":"demo","appId":"cli_fixture","brand":"feishu","active":true}]' ;;
  "profile add") printf '%s\\n' "$@" > "$HOME/args"; IFS= read -r secret; printf '%s' "$secret" > "$HOME/secret" ;;
  "profile use") printf '%s' "$3" > "$HOME/used" ;;
  "config init") echo 'verification_url: https://open.feishu.cn/example'; exec sleep 20 ;;
esac
`);
    await chmod(cli, 0o700);
    const opened: string[] = [];
    const service = new EnvironmentService({ home, nodePath: "/usr/bin/node", path: home, fetchLatest: async () => null, openExternal: async (url) => { opened.push(url); } });
    const scanned = await service.run({ type: "scan" });
    assert.equal(scanned.kind, "tools");
    if (scanned.kind === "tools") assert.equal(scanned.tools.find((tool) => tool.tool === "lark-cli")?.installation, "external");
    const before = await service.run({ type: "profileList" });
    assert.equal(before.kind, "profiles");
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
      home, nodePath: "/usr/bin/node", path: home, fetchLatest: async () => null,
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
    const service = new EnvironmentService({ home, nodePath: "/usr/bin/node", npmPath: npm, path: home, fetchLatest: async () => "1.2.3" });
    const initial = await service.run({ type: "scan" });
    assert.equal(initial.kind, "tools");
    if (initial.kind === "tools") assert.equal(initial.tools.find((tool) => tool.tool === "codex")?.installation, "missing");
    const installed = await service.run({ type: "install", tool: "codex" });
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
    if (final.kind === "tools") assert.equal(final.tools.find((tool) => tool.tool === "codex")?.installation, "missing");
  } finally { await rm(home, { recursive: true, force: true }); }
});
