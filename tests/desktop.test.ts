import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import {
  commandSchema,
  agentIdSchema,
  jobIdSchema,
  type DesktopSnapshot,
} from "../desktop/shared/bridge";
import {
  FolderCapabilities,
  ExecutableCapabilities,
  authorizationUrl,
  registrationUrl,
  trustedSender,
} from "../desktop/main/capabilities";
import {
  acquireHost,
  type HostHandle,
  type HostModule,
} from "../desktop/main/host";
import { DesktopController } from "../desktop/main/controller";
import { projectState, stateSchema } from "../desktop/main/projection";
import {settingsRequestSchema} from "../desktop/shared/settings";

const agentId = agentIdSchema.parse("cli_test");
const registrationSession = "12345678-1234-4234-8234-123456789012";
function registrationStream(body: ReadableStream<Uint8Array>) {
  return new Response(body, {
    headers: { "X-Registration-Session-Id": registrationSession },
  });
}
const project = {
  name: "Workspace",
  chatId: "oc_group",
  cwd: "/tmp/work",
  kind: "multi",
  noMention: false,
  mode: "write",
  guestMode: "qa",
  network: false,
  backend: "codex-appserver",
};
const coreState = (projects = [project]) => ({
  version: "0.6.13",
  generatedAt: Date.now(),
  bots: [
    {
      appId: agentId,
      name: "Agent",
      active: true,
      running: true,
      connection: "connected",
      projects,
    },
  ],
});
const application = {
  platform: "macos",
  version: "0.1.0",
  loginItem: false,
  dataPath: "/tmp/isolated/.vonvon-bridge",
} satisfies DesktopSnapshot["application"];
const runtime = {
  home: "/tmp/isolated",
  nodePath: "/test/node",
  cliPath: "/test/cli",
};
function fixture(ownership: "owned" | "attached" = "owned") {
  let state = coreState();
  let restarts = 0;
  let closes = 0;
  const requests: { path: string; init?: RequestInit }[] = [];
  let intercept:
    | ((path: string, init?: RequestInit) => Promise<Response> | undefined)
    | undefined;
  const handle: HostHandle = {
    kind: "connected",
    ownership,
    pid: 123,
    async request(path, init) {
      requests.push({ path, init });
      const result = intercept?.(path, init);
      if (result) return result;
      if (
        path === `/api/bots/register-qr?sessionId=${registrationSession}` &&
        init?.method === "DELETE"
      )
        return new Response(null, { status: 204 });
      if (path === "/api/state") return Response.json(state);
      if (path === "/api/tools/codex/setup")
        return Response.json({
          installation: "installed",
          authentication: "signedOut",
          version: "0.156.1",
        });
      if (path === "/api/backends") return Response.json({ entries: [] });
      if (path.includes("/no-mention")) {
        state = {
          ...state,
          bots: state.bots.map((bot) => ({
            ...bot,
            projects: bot.projects.map((project) => ({
              ...project,
              noMention: true,
            })),
          })),
        };
      }
      return Response.json({ ok: true });
    },
    async restart() {
      restarts++;
    },
    async close() {
      closes++;
    },
  };
  const module: HostModule = {
    inspectHost: async () => ({ kind: "attached", pid: 123 }),
    connectHost: async () => handle,
    migrateHostDataOffline: async () => {
      throw new Error("Must attach before migration");
    },
  };
  const controller = new DesktopController(module, runtime, application);
  return {
    controller,
    module,
    handle,
    requests,
    setIntercept: (value: typeof intercept) => {
      intercept = value;
    },
    setState: (value: typeof state) => {
      state = value;
    },
    counts: () => ({ restarts, closes }),
  };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Condition did not become true");
}

test("IPC denies foreign documents, subframes, arbitrary capabilities and malformed values", () => {
  assert.equal(
    trustedSender(
      { id: 1, url: "file:///app/index.html", isMainFrame: true },
      { id: 1, url: "file:///app/index.html" },
    ),
    true,
  );
  for (const sender of [
    { id: 2, url: "file:///app/index.html", isMainFrame: true },
    { id: 1, url: "file:///app/index.html", isMainFrame: false },
    { id: 1, url: "https://attacker.test", isMainFrame: true },
  ])
    assert.equal(
      trustedSender(sender, { id: 1, url: "file:///app/index.html" }),
      false,
    );
  for (const command of [
    { type: "refresh", url: "https://attacker.test" },
    { type: "exec", command: "touch /tmp/x" },
    { type: "setAgentEnabled", agentId: "../../path", enabled: true },
    {
      type: "setPermission",
      membershipId: "m",
      administrator: "root",
      member: "qa",
      network: true,
    },
    { type: "openJobAuthorization", jobId: "../../path" },
    { type: "copyJobAuthorization", jobId: "../../path" },
    { type: "copyJobAuthorization", jobId: "job_valid", url: "https://accounts.feishu.cn/register" },
    { type: "openJobAuthorization", jobId: "job_valid", url: "https://auth.openai.com/codex/device" },
  ])
    assert.equal(commandSchema.safeParse(command).success, false);
});
test("settings IPC rejects raw config access and oversized or malformed section edits", () => {
  const scope = { kind: "agent", botId: agentId };
  for (const request of [
    { type: "read", scope: { kind: "agent", botId: "../../config.json" } },
    {
      type: "save",
      edit: {
        scope,
        section: "config",
        revision: "r1",
        patch: { secret: "x" },
      },
    },
    {
      type: "save",
      edit: {
        scope,
        section: "run",
        revision: "r1",
        patch: { maxConcurrentRuns: "50" },
      },
    },
    {
      type: "save",
      edit: {
        scope,
        section: "cards",
        revision: "r1",
        patch: { showModel: "running", secret: "x" },
      },
    },
    {
      type: "act",
      action: {
        kind: "commentInstructions",
        botId: agentId,
        revision: "r1",
        content: { kind: "custom", text: "x".repeat(30001) },
      },
    },
    { type: "saveExecutable", token: "/usr/bin/codex", revision: "r1" },
  ])
    assert.equal(settingsRequestSchema.safeParse(request).success, false);
  assert.equal(
    settingsRequestSchema.safeParse({
      type: "act",
      action: {
        kind: "commentInstructions",
        botId: agentId,
        revision: "r1",
        content: { kind: "custom", text: "x".repeat(30000) },
      },
    }).success,
    true,
  );
  assert.equal(agentIdSchema.safeParse(`cli_${"a".repeat(200)}`).success, true);
  assert.equal(
    agentIdSchema.safeParse(`cli_${"a".repeat(201)}`).success,
    false,
  );
});
test("settings reads stay scoped and section saves carry core revisions", async () => {
  const f = fixture();
  const hostView = {
    scope: { kind: "host" },
    sections: {
      execution: {
        stored: { codexBin: null },
        effective: { codexBin: null },
        revision: "host-r1",
        access: { kind: "writable" },
        apply: [],
      },
    },
    runtime: { codexBin: null, fallbackCwd: "/tmp", platform: "darwin" },
  };
  f.setIntercept((path, init) => {
    if (path === "/api/settings/host" && init?.method === "PATCH")
      return Promise.resolve(
        Response.json({
          kind: "saved",
          section: {
            scope: { kind: "host" },
            section: "execution",
            value: {
              ...hostView.sections.execution,
              revision: "host-r2",
              stored: { codexBin: null },
            },
          },
          effects: [
            { fields: ["codexBin"], when: "restart", detail: "下次启动生效" },
          ],
        }),
      );
    if (path === "/api/settings/host")
      return Promise.resolve(Response.json(hostView));
    if (
      path ===
      "/api/bots/cli_test/models?backend=codex-appserver&purpose=project"
    )
      return Promise.resolve(
        Response.json({
          backend: "codex-appserver",
          models: [],
          state: "unavailable",
          source: "backend-provided",
          observedAt: "2026-09-25T00:00:00Z",
          error: "backend offline",
          titleEfforts: [],
        }),
      );
    return undefined;
  });
  await f.controller.start();
  try {
    const read = await f.controller.settings(
      settingsRequestSchema.parse({ type: "read", scope: { kind: "host" } }),
    );
    assert.equal(read.kind, "view");
    const models = await f.controller.settings(
      settingsRequestSchema.parse({
        type: "models",
        query: {
          botId: agentId,
          backend: "codex-appserver",
          purpose: "project",
        },
      }),
    );
    assert.equal(models.kind, "models");
    const saved = await f.controller.settings(
      settingsRequestSchema.parse({
        type: "save",
        edit: {
          scope: { kind: "host" },
          section: "execution",
          revision: "host-r1",
          patch: { codexBin: null },
        },
      }),
    );
    assert.equal(saved.kind, "saved");
    const write = f.requests.find(
      (item) =>
        item.path === "/api/settings/host" && item.init?.method === "PATCH",
    );
    assert.deepEqual(JSON.parse(String(write?.init?.body)), {
      section: "execution",
      revision: "host-r1",
      patch: { codexBin: null },
    });
  } finally {
    await f.controller.quit();
  }
});
test("old Host returns an explicit unsupported result", async () => {
  const f = fixture();
  f.setIntercept((path) =>
    path === "/api/bots/cli_test/settings"
      ? Promise.resolve(Response.json({ message: "missing" }, { status: 404 }))
      : undefined,
  );
  await f.controller.start();
  try {
    const result = await f.controller.settings(
      settingsRequestSchema.parse({
        type: "read",
        scope: { kind: "agent", botId: agentId },
      }),
    );
    assert.deepEqual(result, {
      kind: "refused",
      code: "unsupported-host",
      message: "当前 Bridge 版本不支持桌面设置，请更新后重试。",
    });
  } finally {
    await f.controller.quit();
  }
});
test("settings save rejects mismatched returned scope", async () => {
  const f = fixture();
  f.setIntercept((path, init) =>
    path === "/api/settings/host" && init?.method === "PATCH"
      ? Promise.resolve(
          Response.json({
            kind: "saved",
            section: {
              scope: { kind: "agent", botId: agentId },
              section: "execution",
              value: {
                stored: { codexBin: null },
                effective: { codexBin: null },
                revision: "r2",
                access: { kind: "writable" },
                apply: [],
              },
            },
            effects: [],
          }),
        )
      : undefined,
  );
  await f.controller.start();
  try {
    const result = await f.controller.settings(
      settingsRequestSchema.parse({
        type: "save",
        edit: {
          scope: { kind: "host" },
          section: "execution",
          revision: "r1",
          patch: { codexBin: null },
        },
      }),
    );
    assert.equal(result.kind, "refused");
    if (result.kind === "refused") assert.equal(result.code, "scope-mismatch");
  } finally {
    await f.controller.quit();
  }
});
test("section conflict preserves the authoritative current revision", async () => {
  const f = fixture();
  f.setIntercept((path, init) =>
    path === "/api/settings/host" && init?.method === "PATCH"
      ? Promise.resolve(
          Response.json(
            {
              kind: "conflict",
              current: {
                scope: { kind: "host" },
                section: "execution",
                value: {
                  stored: { codexBin: "/new/codex" },
                  effective: { codexBin: "/old/codex" },
                  revision: "new-r2",
                  access: { kind: "writable" },
                  apply: [],
                },
              },
            },
            { status: 409 },
          ),
        )
      : undefined,
  );
  await f.controller.start();
  try {
    const result = await f.controller.settings(
      settingsRequestSchema.parse({
        type: "save",
        edit: {
          scope: { kind: "host" },
          section: "execution",
          revision: "old-r1",
          patch: { codexBin: null },
        },
      }),
    );
    assert.equal(result.kind, "saved");
    if (result.kind === "saved") {
      assert.equal(result.result.kind, "conflict");
      if (result.result.kind === "conflict")
        assert.equal(result.result.current.value.revision, "new-r2");
    }
  } finally {
    await f.controller.quit();
  }
});
test("Codex executable file tokens stay within the requesting window", async () => {
  const home = await mkdtemp(join(tmpdir(), "vonvon-executable-"));
  const path = join(home, "codex");
  await writeFile(path, "binary");
  try {
    const caps = new ExecutableCapabilities();
    const choice = await caps.grant(path, 10);
    assert.equal(await caps.resolve(choice.token, 10), await realpath(path));
    await assert.rejects(caps.resolve(choice.token, 11));
    caps.clear();
    await assert.rejects(caps.resolve(choice.token, 10));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("generic IPC cannot save a Codex path while a granted file can", async () => {
  const home = await mkdtemp(join(tmpdir(), "vonvon-codex-picker-"));
  const path = join(home, "codex");
  await writeFile(path, "binary");
  const f = fixture();
  f.setIntercept((route, init) =>
    route === "/api/settings/host" && init?.method === "PATCH"
      ? Promise.resolve(
          Response.json({
            kind: "saved",
            section: {
              scope: { kind: "host" },
              section: "execution",
              value: {
                stored: { codexBin: path },
                effective: { codexBin: null },
                revision: "r2",
                access: { kind: "writable" },
                apply: [],
              },
            },
            effects: [],
          }),
        )
      : undefined,
  );
  await f.controller.start();
  try {
    const direct = await f.controller.settings(
      settingsRequestSchema.parse({
        type: "save",
        edit: {
          scope: { kind: "host" },
          section: "execution",
          revision: "r1",
          patch: { codexBin: path },
        },
      }),
    );
    assert.equal(direct.kind, "refused");
    if (direct.kind === "refused")
      assert.equal(direct.code, "file-picker-required");
    assert.equal(
      f.requests.some(
        (item) =>
          item.path === "/api/settings/host" && item.init?.method === "PATCH",
      ),
      false,
    );
    const caps = new ExecutableCapabilities();
    const chosen = await caps.grant(path, 12);
    const resolved = await caps.resolve(chosen.token, 12);
    const saved = await f.controller.saveExecutable(resolved, "r1");
    assert.equal(saved.kind, "saved");
    const write = f.requests.find(
      (item) =>
        item.path === "/api/settings/host" && item.init?.method === "PATCH",
    );
    assert.deepEqual(JSON.parse(String(write?.init?.body)), {
      section: "execution",
      revision: "r1",
      patch: { codexBin: await realpath(path) },
    });
  } finally {
    await f.controller.quit();
    await rm(home, { recursive: true, force: true });
  }
});
test("Agent removal rechecks stopped state before using the delete route", async () => {
  const f = fixture();
  await f.controller.start();
  try {
    const blocked = await f.controller.run(
      { type: "deleteAgent", agentId },
      async () => "/tmp",
    );
    assert.equal(blocked.kind, "refused");
    assert.equal(
      f.requests.some((item) => item.init?.method === "DELETE"),
      false,
    );
    f.setState({
      ...coreState(),
      bots: coreState().bots.map((bot) => ({
        ...bot,
        active: false,
        running: false,
        connection: "disconnected",
      })),
    });
    const removed = await f.controller.run(
      { type: "deleteAgent", agentId },
      async () => "/tmp",
    );
    assert.equal(removed.kind, "applied");
    assert.equal(
      f.requests.some(
        (item) =>
          item.path === "/api/bots/cli_test" && item.init?.method === "DELETE",
      ),
      true,
    );
  } finally {
    await f.controller.quit();
  }
});
test("Agent removal preserves its list entry when core rejects deletion", async () => {
  const f = fixture();
  f.setState({
    ...coreState(),
    bots: coreState().bots.map((bot) => ({
      ...bot,
      active: false,
      running: false,
      connection: "disconnected",
    })),
  });
  f.setIntercept((path, init) =>
    path === "/api/bots/cli_test" && init?.method === "DELETE"
      ? Promise.resolve(
          Response.json({ message: "Agent 仍有运行中会话" }, { status: 409 }),
        )
      : undefined,
  );
  await f.controller.start();
  try {
    const result = await f.controller.run(
      { type: "deleteAgent", agentId },
      async () => "/tmp",
    );
    assert.equal(result.kind, "refused");
    assert.equal(
      f.controller.current().agents.some((agent) => agent.id === agentId),
      true,
    );
  } finally {
    await f.controller.quit();
  }
});
test("authorization browser capability only permits exact official HTTPS host", () => {
  assert.equal(
    authorizationUrl("https://auth.openai.com/codex/device"),
    "https://auth.openai.com/codex/device",
  );
  for (const url of [
    "http://auth.openai.com",
    "https://auth.openai.com.evil.test",
    "https://user:pass@auth.openai.com",
    "https://auth.openai.com:444",
    "https://accounts.feishu.cn/register",
    "https://open.larksuite.com/register",
  ])
    assert.throws(() => authorizationUrl(url));
});
test("registration URLs allow exact Feishu and Lark hosts without credentials or ports", () => {
  for (const host of ["accounts.feishu.cn", "accounts.larksuite.com", "open.feishu.cn", "open.larksuite.com"])
    assert.equal(registrationUrl(`https://${host}/register?token=sample%2Fvalue`), `https://${host}/register?token=sample%2Fvalue`);
  for (const url of [
    "http://accounts.feishu.cn/register",
    "https://accounts.feishu.cn.evil.test/register",
    "https://evil.test/accounts.feishu.cn/register",
    "https://sub.accounts.feishu.cn/register",
    "https://accounts.feishu.cn@evil.test/register",
    "https://user:pass@accounts.feishu.cn/register",
    "https://accounts.feishu.cn:444/register",
    "https://accounts.feishu.cn:443/register",
    " https://accounts.feishu.cn:443/register",
    "https://accounts.feishu.cn./register",
    "https://auth.openai.com/codex/device",
    "file:///accounts.feishu.cn/register",
    "javascript:alert(1)",
  ]) assert.throws(() => registrationUrl(url), url);
  assert.equal(commandSchema.safeParse({type: "copyJobAuthorization", jobId: "job_valid"}).success, true);
});
test("folder tokens are scoped, canonical and rechecked at commit", async () => {
  const home = await mkdtemp(join(tmpdir(), "vonvon-folder-"));
  const directory = join(home, "workspace");
  await mkdir(directory);
  try {
    const capabilities = new FolderCapabilities();
    const folder = await capabilities.grant(directory, 1);
    assert.equal(
      await capabilities.resolve(folder.token, 1),
      await realpath(directory),
    );
    await assert.rejects(capabilities.resolve(folder.token, 2));
    await rm(directory, { recursive: true });
    await assert.rejects(capabilities.resolve(folder.token, 1));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("validated running Host attaches before migration and recovery never starts", async () => {
  const f = fixture("attached");
  assert.equal(await acquireHost(f.module, runtime), f.handle);
  let connects = 0;
  const blocked: HostModule = {
    ...f.module,
    inspectHost: async () => ({ kind: "absent" }),
    migrateHostDataOffline: async () => ({
      kind: "recovery-required",
      message: "Recovery required",
    }),
    connectHost: async () => {
      connects++;
      return f.handle;
    },
  };
  assert.equal((await acquireHost(blocked, runtime)).kind, "blocked");
  assert.equal(connects, 0);
});
test("state read failures and per-Agent errors retain last good memberships", async () => {
  const f = fixture();
  await f.controller.start();
  try {
    const previous = f.controller.current();
    assert.equal(previous.memberships.length, 1);
    const value = stateSchema.parse({
      ...coreState([]),
      bots: [
        {
          ...coreState().bots[0],
          projects: [],
          projectsError: "Registry unavailable",
        },
      ],
    });
    const projected = projectState(value, previous, new Set());
    assert.equal(projected.memberships.length, 1);
    assert.equal(projected.memberships[0]?.stale, true);
    assert.equal(projected.agents[0]?.readError, "Registry unavailable");
    f.setIntercept((path) =>
      path === "/api/state"
        ? Promise.resolve(new Response("not json"))
        : undefined,
    );
    await f.controller.refresh();
    assert.equal(f.controller.current().memberships.length, 1);
    assert.equal(f.controller.current().stale, true);
  } finally {
    await f.controller.quit();
  }
});
test("group identity aggregates chat across Agents and unknown saved backend survives", async () => {
  const f = fixture();
  await f.controller.start();
  try {
    const state = stateSchema.parse({
      ...coreState(),
      bots: [
        coreState().bots[0],
        {
          ...coreState().bots[0],
          appId: "cli_other",
          projects: [{ ...project, backend: "future-runner" }],
        },
      ],
    });
    const projected = projectState(state, f.controller.current(), new Set());
    assert.equal(projected.groups.length, 1);
    assert.equal(projected.memberships.length, 2);
    assert.notEqual(projected.memberships[0]?.id, projected.memberships[1]?.id);
    assert.equal(projected.memberships[1]?.backend, "future-runner");
  } finally {
    await f.controller.quit();
  }
});
test("reads begun before completed writes cannot regress the projection", async () => {
  const f = fixture();
  await f.controller.start();
  try {
    let release: ((response: Response) => void) | undefined;
    let interceptNext = true;
    f.setIntercept((path) => {
      if (path === "/api/state" && interceptNext) {
        interceptNext = false;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return undefined;
    });
    const stale = f.controller.refresh();
    await until(() => !!release);
    const member = f.controller.current().memberships[0];
    assert.ok(member);
    const result = await f.controller.run(
      { type: "setResponse", membershipId: member.id, response: "all" },
      async () => "/tmp/work",
    );
    assert.equal(result.kind, "applied");
    assert.equal(f.controller.current().memberships[0]?.response, "all");
    release?.(Response.json(coreState()));
    await stale;
    assert.equal(f.controller.current().memberships[0]?.response, "all");
  } finally {
    await f.controller.quit();
  }
});
test("owned changes restart while attached changes only report pending activation", async () => {
  for (const ownership of ["owned", "attached"] as const) {
    const f = fixture(ownership);
    await f.controller.start();
    const result = await f.controller.run(
      { type: "setAgentEnabled", agentId, enabled: true },
      async () => "/tmp/work",
    );
    assert.equal(
      result.kind,
      ownership === "owned" ? "applied" : "activationPending",
    );
    assert.equal(f.counts().restarts, ownership === "owned" ? 1 : 0);
    if (ownership === "attached") {
      const restart = await f.controller.run(
        { type: "restartHost" },
        async () => "/tmp/work",
      );
      assert.equal(restart.kind, "refused");
    }
    await f.controller.quit();
    assert.equal(f.counts().closes, 1);
    assert.equal(
      f.requests.some((request) => request.path.includes("/daemon/")),
      false,
    );
  }
});
test("rejected QR request is terminal and never blocks quit or sends cancellation", async () => {
  const f = fixture();
  await f.controller.start();
  f.setIntercept((path) => path.includes("register-qr/stream")
    ? Promise.resolve(Response.json({ message: "Registration unavailable" }, { status: 501 }))
    : undefined);
  const result = await f.controller.run({ type: "registerAgent" }, async () => "/tmp/work");
  assert.equal(result.kind, "started");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.controller.current().jobs[0]?.phase, "failed");
  await f.controller.quit();
  assert.equal(f.requests.some((request) => request.path.includes("register-qr?")), false);
});
test("older core unsupported response is not an empty joined group list", async () => {
  const f = fixture();
  await f.controller.start();
  try {
    f.setIntercept((path) =>
      path.includes("joined-groups")
        ? Promise.resolve(
            Response.json(
              { message: "Unsupported on this core" },
              { status: 501 },
            ),
          )
        : undefined,
    );
    const result = await f.controller.run(
      { type: "listJoinedGroups", agentId },
      async () => "/tmp/work",
    );
    assert.deepEqual(result, {
      kind: "refused",
      code: "unsupported",
      message: "Unsupported on this core",
    });
  } finally {
    await f.controller.quit();
  }
});
test("tool jobs show provider errors and never turn failed setup into signed-in", async () => {
  const f = fixture();
  await f.controller.start();
  try {
    f.setIntercept((path) =>
      path === "/api/tools/codex/login"
        ? Promise.resolve(Response.json({ id: "job_1" }))
        : path === "/api/tools/codex/jobs/job_1"
          ? Promise.resolve(
              Response.json({
                id: "job_1",
                type: "login",
                state: "failed",
                message: "Explicit override does not support login",
              }),
            )
          : undefined,
    );
    const result = await f.controller.run(
      { type: "startCodexLogin" },
      async () => "/tmp/work",
    );
    assert.equal(result.kind, "started");
    await until(() =>
      f.controller.current().jobs.some((job) => job.phase === "failed"),
    );
    assert.equal(f.controller.current().tools[0]?.authentication, "signedOut");
    assert.equal(f.controller.current().jobs[0]?.phase, "failed");
  } finally {
    await f.controller.quit();
  }
});
test("QR done commits activation exactly once and subsequent cancel cannot undo it", async () => {
  const f = fixture();
  await f.controller.start();
  try {
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    f.setIntercept((path) =>
      path.includes("register-qr/stream")
        ? Promise.resolve(
            registrationStream(
              new ReadableStream({
                start(controller) {
                  streamController = controller;
                },
              }),
            ),
          )
        : undefined,
    );
    const result = await f.controller.run(
      { type: "registerAgent" },
      async () => "/tmp/work",
    );
    assert.equal(result.kind, "started");
    await until(() => !!streamController);
    streamController?.enqueue(
      new TextEncoder().encode('event: done\ndata: {"appId":"cli_test"}\n\n'),
    );
    streamController?.close();
    await until(() =>
      f.controller.current().jobs.some((job) => job.phase === "succeeded"),
    );
    if (result.kind === "started") await f.controller.cancel(result.jobId);
    assert.equal(f.counts().restarts, 1);
    assert.equal(f.controller.current().jobs[0]?.phase, "succeeded");
    assert.equal(
      f.requests.some(
        (request) =>
          request.init?.method === "DELETE" &&
          request.path === "/api/bots/register-qr",
      ),
      false,
    );
  } finally {
    await f.controller.quit();
  }
});
test("failed owned cleanup rejects quit and retains visible failure", async () => {
  const f = fixture();
  await f.controller.start();
  f.handle.close = async () => {
    throw new Error("Child remains alive");
  };
  await assert.rejects(f.controller.quit(), /Child remains alive/);
  assert.equal(
    f.controller
      .current()
      .diagnostics.some((d) => d.message.includes("Child remains alive")),
    true,
  );
  f.handle.close = async () => undefined;
  await f.controller.quit();
});

test("watch subscribes before initial snapshot and rejects late older revisions", async () => {
  const { watchSnapshots } = await import("../desktop/shared/watch");
  const f = fixture();
  const base = f.controller.current();
  const revisions: number[] = [];
  let receive: ((snapshot: DesktopSnapshot) => void) | undefined;
  let resolve: ((snapshot: DesktopSnapshot) => void) | undefined;
  let removed = false;
  const stop = watchSnapshots({
    listener: (snapshot) => revisions.push(snapshot.revision),
    listen(callback) {
      receive = callback;
      return () => {
        removed = true;
      };
    },
    initial() {
      assert.ok(receive);
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  receive?.({ ...base, revision: 2 });
  resolve?.({ ...base, revision: 1 });
  await Promise.resolve();
  receive?.({ ...base, revision: 2 });
  receive?.({ ...base, revision: 3 });
  stop();
  receive?.({ ...base, revision: 4 });
  assert.deepEqual(revisions, [2, 3]);
  assert.equal(removed, true);
});

test("bind command maps the picked directory and does not change local state on refusal", async () => {
  const f = fixture();
  await f.controller.start();
  try {
    f.setIntercept((path) =>
      path.includes("/bind-group")
        ? Promise.resolve(
            Response.json({ message: "Bot is inactive" }, { status: 409 }),
          )
        : undefined,
    );
    const command = commandSchema.parse({
      type: "bindGroup",
      agentId,
      groupId: "oc_new",
      projectName: "New",
      folderToken: "12345678-1234-4234-8234-123456789012",
      tool: "claude",
      conversation: "shared",
    });
    const result = await f.controller.run(
      command,
      async () => "/chosen/folder",
    );
    assert.equal(result.kind, "refused");
    assert.equal(f.controller.current().memberships.length, 1);
    const request = f.requests.find((request) =>
      request.path.includes("/bind-group"),
    );
    assert.ok(request);
    assert.equal(typeof request.init?.body, "string");
    assert.deepEqual(JSON.parse(String(request.init?.body)), {
      chatId: "oc_new",
      projectName: "New",
      directory: "/chosen/folder",
      backend: "claude-agent",
      kind: "single",
    });
  } finally {
    await f.controller.quit();
  }
});

test("late QR commit after cancel still activates and reports committed outcome", async () => {
  const f = fixture();
  await f.controller.start();
  try {
    f.setIntercept((path, init) =>
      path.includes("register-qr/stream")
        ? Promise.resolve(
            registrationStream(
              new ReadableStream({
                start(controller) {
                  init?.signal?.addEventListener(
                    "abort",
                    () => {
                      controller.enqueue(
                        new TextEncoder().encode(
                          'event: done\ndata: {"appId":"cli_test"}\n\n',
                        ),
                      );
                      controller.close();
                    },
                    { once: true },
                  );
                },
              }),
            ),
          )
        : undefined,
    );
    const result = await f.controller.run(
      { type: "registerAgent" },
      async () => "/tmp/work",
    );
    assert.equal(result.kind, "started");
    if (result.kind === "started") {
      const cancel = await f.controller.cancel(result.jobId);
      assert.equal(cancel.kind, "applied");
    }
    assert.equal(f.controller.current().jobs[0]?.phase, "succeeded");
    assert.equal(f.counts().restarts, 1);
  } finally {
    await f.controller.quit();
  }
});

test("quit drains acquisition before closing without publishing a late Host", async () => {
  const f = fixture();
  let release!: (handle: HostHandle) => void;
  f.module.connectHost = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const starting = f.controller.start();
  await until(() => !!release);
  let quitFinished = false;
  const quitting = f.controller.quit().then(() => {
    quitFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const closedTooSoon = quitFinished;
  release(f.handle);
  await Promise.all([starting, quitting]);
  const counts = f.counts();
  const state = f.controller.current().host;
  await f.controller.quit();
  assert.equal(closedTooSoon, false);
  assert.equal(counts.closes, 1);
  assert.notEqual(state.kind, "connected");
});

test("quit refuses commands queued before close intent and drains admitted jobs", async () => {
  const f = fixture("attached");
  await f.controller.start();
  let release!: (response: Response) => void;
  let state = "running";
  f.setIntercept((path, init) => {
    if (path === "/api/tools/codex/login")
      return new Promise((resolve) => {
        release = resolve;
      });
    if (path === "/api/tools/codex/jobs/job_owned") {
      if (init?.method === "DELETE") state = "cancelled";
      return Promise.resolve(
        Response.json({ id: "job_owned", type: "login", state }),
      );
    }
    return undefined;
  });
  const admitted = f.controller.run(
    { type: "startCodexLogin" },
    async () => "/tmp/work",
  );
  await until(() => !!release);
  const queued = f.controller.run(
    { type: "installCodex" },
    async () => "/tmp/work",
  );
  const quitting = f.controller.quit();
  release(Response.json({ id: "job_owned" }));
  await admitted;
  const result = await queued;
  await quitting;
  const requests = [...f.requests];
  await f.controller.cancel(jobIdSchema.parse("job_owned"));
  assert.equal(result.kind, "refused");
  assert.equal(
    requests.some((request) => request.path === "/api/tools/codex/install"),
    false,
  );
  assert.equal(
    requests.filter((request) => request.init?.method === "DELETE").length,
    1,
  );
  assert.equal(f.counts().closes, 1);
});

test("uncertain job read retains ownership so quit cancels the exact job", async () => {
  const f = fixture("attached");
  await f.controller.start();
  let cancelled = false;
  f.setIntercept((path, init) => {
    if (path === "/api/tools/codex/login")
      return Promise.resolve(Response.json({ id: "job_uncertain" }));
    if (path === "/api/tools/codex/jobs/job_uncertain") {
      if (init?.method === "DELETE") cancelled = true;
      return cancelled
        ? Promise.resolve(
            Response.json({
              id: "job_uncertain",
              type: "login",
              state: "cancelled",
            }),
          )
        : Promise.reject(new Error("Temporary connection loss"));
    }
    return undefined;
  });
  await f.controller.run({ type: "startCodexLogin" }, async () => "/tmp/work");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const phase = f.controller.current().jobs[0]?.phase;
  await f.controller.quit();
  assert.equal(phase, "unresolved");
  assert.equal(cancelled, true);
  assert.equal(f.controller.current().jobs[0]?.phase, "cancelled");
});

test("aborted QR stream reconciles persisted Agent without a done frame", async () => {
  for (const ownership of ["owned", "attached"] as const) {
    const f = fixture(ownership);
    await f.controller.start();
    f.setIntercept((path, init) =>
      path.includes("register-qr/stream")
        ? Promise.resolve(
            registrationStream(
              new ReadableStream({
                start(controller) {
                  init?.signal?.addEventListener(
                    "abort",
                    () => {
                      f.setState({
                        ...coreState(),
                        bots: [
                          ...coreState().bots,
                          {
                            ...coreState().bots[0]!,
                            appId: agentIdSchema.parse("cli_saved"),
                          },
                        ],
                      });
                      controller.error(
                        new DOMException("Aborted", "AbortError"),
                      );
                    },
                    { once: true },
                  );
                },
              }),
            ),
          )
        : undefined,
    );
    const result = await f.controller.run(
      { type: "registerAgent" },
      async () => "/tmp/work",
    );
    assert.equal(result.kind, "started");
    if (result.kind === "started") await f.controller.cancel(result.jobId);
    const job = f.controller.current().jobs[0];
    const saved = f.controller
      .current()
      .agents.find((agent) => agent.id === "cli_saved");
    await f.controller.quit();
    assert.equal(job?.phase, "succeeded");
    assert.equal(f.counts().restarts, ownership === "owned" ? 1 : 0);
    assert.equal(
      saved?.activation,
      ownership === "owned" ? "active" : "restartRequired",
    );
  }
});

test("quit waits for committed QR reconciliation after activation returns", async () => {
  const f = fixture();
  await f.controller.start();
  let release!: (response: Response) => void;
  let readsAfterRestart = 0;
  f.setIntercept((path) => {
    if (path.includes("register-qr/stream"))
      return Promise.resolve(
        new Response('event: done\ndata: {"appId":"cli_test"}\n\n'),
      );
    if (
      path === "/api/state" &&
      f.counts().restarts &&
      ++readsAfterRestart === 2
    )
      return new Promise((resolve) => {
        release = resolve;
      });
    return undefined;
  });
  await f.controller.run({ type: "registerAgent" }, async () => "/tmp/work");
  await until(() => !!release);
  let quitFinished = false;
  const quitting = f.controller.quit().then(() => {
    quitFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const closedBeforeReconciliation = f.counts().closes;
  const finishedBeforeReconciliation = quitFinished;
  release(Response.json(coreState()));
  await quitting;
  assert.equal(closedBeforeReconciliation, 0);
  assert.equal(finishedBeforeReconciliation, false);
  assert.equal(f.controller.current().jobs[0]?.phase, "succeeded");
  assert.equal(f.counts().closes, 1);
});

test("unconfirmed cancellation blocks quit and retains the job for retry", async () => {
  const f = fixture("attached");
  await f.controller.start();
  let restored = false;
  f.setIntercept((path, init) => {
    if (path === "/api/tools/codex/install")
      return Promise.resolve(Response.json({ id: "job_retained" }));
    if (path === "/api/tools/codex/jobs/job_retained") {
      if (!restored) return Promise.reject(new Error("Host unavailable"));
      return Promise.resolve(
        Response.json({
          id: "job_retained",
          type: "install",
          state: "cancelled",
        }),
      );
    }
    return undefined;
  });
  await f.controller.run({ type: "installCodex" }, async () => "/tmp/work");
  await assert.rejects(f.controller.quit(), /Host unavailable/);
  assert.equal(f.counts().closes, 0);
  assert.equal(f.controller.current().jobs[0]?.phase, "unresolved");
  restored = true;
  await f.controller.quit();
  assert.equal(f.counts().closes, 1);
  assert.equal(f.controller.current().jobs[0]?.phase, "cancelled");
});

test("temporary poll failure recovers to the confirmed terminal snapshot", async () => {
  const f = fixture();
  await f.controller.start();
  let reads = 0;
  f.setIntercept((path) => {
    if (path === "/api/tools/codex/login")
      return Promise.resolve(Response.json({ id: "job_retry" }));
    if (path === "/api/tools/codex/jobs/job_retry")
      return ++reads === 1
        ? Promise.reject(new Error("Temporary timeout"))
        : Promise.resolve(
            Response.json({
              id: "job_retry",
              type: "login",
              state: "succeeded",
            }),
          );
    return undefined;
  });
  await f.controller.run({ type: "startCodexLogin" }, async () => "/tmp/work");
  await until(() => f.controller.current().jobs[0]?.phase === "unresolved");
  await new Promise((resolve) => setTimeout(resolve, 1250));
  const phase = f.controller.current().jobs[0]?.phase;
  await f.controller.quit();
  assert.equal(phase, "succeeded");
  assert.equal(
    f.requests.some((request) => request.init?.method === "DELETE"),
    false,
  );
});

test("QR cancellation waits for exact session persistence before reconciliation", async () => {
  const f = fixture();
  await f.controller.start();
  let releasePersistence!: () => void;
  let cancelAcknowledged = false;
  let requestSession: unknown;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  f.setIntercept((path, init) => {
    if (path.includes("register-qr/stream"))
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              stream = controller;
              controller.enqueue(
                new TextEncoder().encode(
                  'event: qr\ndata: {"qrUrl":"https://accounts.feishu.cn/register","expireIn":120,"sessionId":"12345678-1234-4234-8234-123456789012"}\n\n',
                ),
              );
              init?.signal?.addEventListener(
                "abort",
                () =>
                  controller.error(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            },
          }),
        ),
      );
    if (
      path === `/api/bots/register-qr?sessionId=${registrationSession}` &&
      init?.method === "DELETE"
    ) {
      requestSession = new URL(path, "http://localhost").searchParams.get(
        "sessionId",
      );
      return new Promise((resolve) => {
        releasePersistence = () => {
          f.setState({
            ...coreState(),
            bots: [
              ...coreState().bots,
              {
                ...coreState().bots[0]!,
                appId: agentIdSchema.parse("cli_delayed"),
              },
            ],
          });
          cancelAcknowledged = true;
          resolve(new Response(null, { status: 204 }));
        };
      });
    }
    return undefined;
  });
  const started = await f.controller.run(
    { type: "registerAgent" },
    async () => "/tmp/work",
  );
  assert.equal(started.kind, "started");
  await until(() => f.controller.current().jobs[0]?.phase === "qr");
  if (started.kind !== "started") throw new Error("No registration job");
  let returned = false;
  const cancel = f.controller.cancel(started.jobId).then((result) => {
    returned = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const prematureReturn = returned;
  if (releasePersistence) releasePersistence();
  else {
    f.setState({
      ...coreState(),
      bots: [
        ...coreState().bots,
        { ...coreState().bots[0]!, appId: agentIdSchema.parse("cli_delayed") },
      ],
    });
  }
  await cancel;
  const finalJob = f.controller.current().jobs[0];
  await f.controller.quit();
  assert.equal(prematureReturn, false);
  assert.equal(cancelAcknowledged, true);
  assert.equal(requestSession, registrationSession);
  assert.equal(finalJob?.phase, "succeeded");
  assert.equal(f.counts().restarts, 1);
});

test("QR cancellation before headers waits for the exact session without global abort", async () => {
  const f = fixture();
  await f.controller.start();
  let releaseHeaders!: () => void;
  let aborted = false;
  f.setIntercept((path, init) => {
    if (path.includes("register-qr/stream"))
      return new Promise((resolve) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                controller.close();
              },
              { once: true },
            );
          },
        });
        releaseHeaders = () => resolve(registrationStream(body));
      });
    return undefined;
  });
  const result = await f.controller.run(
    { type: "registerAgent" },
    async () => "/tmp/work",
  );
  if (result.kind !== "started") throw new Error("No registration job");
  let finished = false;
  const cancelling = f.controller.cancel(result.jobId).then((value) => {
    finished = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(finished, false);
  assert.equal(aborted, false);
  releaseHeaders();
  assert.equal((await cancelling).kind, "cancelled");
  assert.equal(aborted, true);
  assert.equal(
    f.requests.filter((request) => request.init?.method === "DELETE").length,
    1,
  );
  assert.equal(
    f.requests.find((request) => request.init?.method === "DELETE")?.path,
    `/api/bots/register-qr?sessionId=${registrationSession}`,
  );
  await f.controller.quit();
});

test("failed exact QR cancellation acknowledgment remains unresolved and retryable", async () => {
  const f = fixture("attached");
  await f.controller.start();
  let available = false;
  let aborted = false;
  f.setIntercept((path, init) => {
    if (path.includes("register-qr/stream"))
      return Promise.resolve(
        registrationStream(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  controller.close();
                },
                { once: true },
              );
            },
          }),
        ),
      );
    if (path.startsWith("/api/bots/register-qr?") && init?.method === "DELETE")
      return Promise.resolve(
        available
          ? new Response(null, { status: 204 })
          : Response.json(
              { message: "Registration completion unavailable" },
              { status: 503 },
            ),
      );
    return undefined;
  });
  await f.controller.run({ type: "registerAgent" }, async () => "/tmp/work");
  await assert.rejects(
    f.controller.quit(),
    /Registration completion unavailable/,
  );
  assert.equal(f.counts().closes, 0);
  assert.equal(aborted, false);
  assert.equal(f.controller.current().jobs[0]?.phase, "unresolved");
  available = true;
  await f.controller.quit();
  assert.equal(aborted, true);
  assert.equal(f.counts().closes, 1);
  assert.equal(f.controller.current().jobs[0]?.phase, "cancelled");
});

async function waitingRegistration(qrUrl: string, expireIn = 120) {
  const f = fixture();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const emit = (name: string, payload: unknown) => stream?.enqueue(
    new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`),
  );
  f.setIntercept((path, init) => {
    if (path.includes('register-qr/stream')) return Promise.resolve(registrationStream(new ReadableStream({
      start(controller) {
        stream = controller;
        emit('qr', {qrUrl, expireIn, sessionId: registrationSession});
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), {once: true});
      },
    })));
    return undefined;
  });
  await f.controller.start();
  const started = await f.controller.run({type: 'registerAgent'}, async () => '/tmp/work');
  if (started.kind !== 'started') throw new Error('Registration did not start');
  return {...f, id: started.jobId, emit, end: () => stream?.close()};
}

test('registration exposes the exact QR URL through its job capability and invalidates it on cancel', async () => {
  const url = 'https://accounts.feishu.cn/register?token=sample%2Fvalue&next=%2Fconsole';
  const f = await waitingRegistration(url);
  try {
    await until(() => f.controller.current().jobs[0]?.phase === 'qr');
    assert.equal(f.controller.authorization(f.id), url);
    const job = f.controller.current().jobs[0];
    if (job?.phase !== 'qr') throw new Error('Missing QR');
    assert.equal(job.url, url);
    assert.equal(job.image, await QRCode.toDataURL(job.url, {width: 256, margin: 2}));
    assert.throws(() => f.controller.authorization(jobIdSchema.parse('other_job')));
    await f.controller.cancel(f.id);
    assert.throws(() => f.controller.authorization(f.id));
    assert.equal(f.controller.current().jobs[0]?.phase, 'cancelled');
  } finally { await f.controller.quit(); }
});

test('registration authorization expires at its deadline', async (t) => {
  const f = await waitingRegistration('https://open.feishu.cn/register');
  try {
    await until(() => f.controller.current().jobs[0]?.phase === 'qr');
    const job = f.controller.current().jobs[0];
    if (job?.phase !== 'qr') throw new Error('Missing QR');
    assert.equal(f.controller.authorization(f.id), 'https://open.feishu.cn/register');
    t.mock.method(Date, 'now', () => job.expiresAt);
    assert.throws(() => f.controller.authorization(f.id), /已过期/);
  } finally { t.mock.restoreAll(); await f.controller.quit(); }
});

test('ended or failed registration streams invalidate their authorization', async () => {
  for (const event of ['end', 'error', 'done']) {
    const f = await waitingRegistration('https://accounts.larksuite.com/register');
    try {
      await until(() => f.controller.current().jobs[0]?.phase === 'qr');
      assert.equal(f.controller.authorization(f.id), 'https://accounts.larksuite.com/register');
      if (event === 'end') f.end();
      else f.emit(event, event === 'done' ? {appId: 'cli_new'} : {message: 'Rejected'});
      await until(() => ['failed', 'succeeded'].includes(f.controller.current().jobs[0]?.phase ?? ''));
      assert.throws(() => f.controller.authorization(f.id));
    } finally { await f.controller.quit(); }
  }
});

test('registration rejects hostile QR URLs before exposing an image or authorization', async () => {
  for (const url of ['https://accounts.feishu.cn.evil.test/register', 'https://auth.openai.com/codex/device', 'https://user:pass@open.feishu.cn/register']) {
    const f = await waitingRegistration(url);
    try {
      await until(() => f.controller.current().jobs[0]?.phase === 'failed');
      assert.throws(() => f.controller.authorization(f.id));
      assert.equal(f.controller.current().jobs.some(job => job.phase === 'qr'), false);
    } finally { await f.controller.quit(); }
  }
});

test('cancelling registration invalidates the link before acknowledgment and rejects late QR frames', async () => {
  const f = await waitingRegistration('https://open.larksuite.com/register');
  let release: ((response: Response) => void) | undefined;
  try {
    await until(() => f.controller.current().jobs[0]?.phase === 'qr');
    f.setIntercept((path, init) => path.includes('register-qr?sessionId=') && init?.method === 'DELETE'
      ? new Promise(resolve => { release = resolve; }) : undefined);
    const cancelling = f.controller.cancel(f.id);
    await until(() => release !== undefined);
    assert.throws(() => f.controller.authorization(f.id));
    f.emit('qr', {qrUrl: 'https://accounts.feishu.cn/new', expireIn: 120, sessionId: registrationSession});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.notEqual(f.controller.current().jobs[0]?.phase, 'qr');
    assert.throws(() => f.controller.authorization(f.id));
    release?.(Response.json({error: 'Try again'}, {status: 503}));
    assert.equal((await cancelling).kind, 'refused');
    assert.equal(f.controller.current().jobs[0]?.phase, 'unresolved');
    assert.throws(() => f.controller.authorization(f.id));
  } finally {
    release?.(new Response(null, {status: 204}));
    f.setIntercept(undefined);
    await f.controller.quit();
  }
});

test('ended registration invalidates the link while exact-session closure remains pending', async () => {
  const f = await waitingRegistration('https://open.feishu.cn/register');
  let release: ((response: Response) => void) | undefined;
  try {
    await until(() => f.controller.current().jobs[0]?.phase === 'qr');
    f.setIntercept((path, init) => path.includes('register-qr?sessionId=') && init?.method === 'DELETE'
      ? new Promise(resolve => { release = resolve; }) : undefined);
    f.end();
    await until(() => release !== undefined);
    assert.throws(() => f.controller.authorization(f.id));
    assert.equal(f.controller.current().jobs[0]?.phase, 'running');
    release?.(new Response(null, {status: 204}));
    await until(() => f.controller.current().jobs[0]?.phase === 'failed');
  } finally {
    release?.(new Response(null, {status: 204}));
    f.setIntercept(undefined);
    await f.controller.quit();
  }
});

test('only a current Codex login authorizing phase exposes an OpenAI URL', async () => {
  for (const scenario of [
    {type: 'login', url: 'https://auth.openai.com/codex/device', allowed: true},
    {type: 'login', url: 'https://accounts.feishu.cn/register', allowed: false},
    {type: 'install', url: 'https://auth.openai.com/codex/device', allowed: false},
  ] as const) {
    const f = fixture();
    let cancelled = false;
    const id = jobIdSchema.parse('job_auth');
    f.setIntercept((path, init) => {
      if (path === `/api/tools/codex/${scenario.type}`) return Promise.resolve(Response.json({id}));
      if (path === `/api/tools/codex/jobs/${id}`) {
        if (init?.method === 'DELETE') cancelled = true;
        return Promise.resolve(Response.json({id, type: scenario.type, state: cancelled ? 'cancelled' : 'authorizing', userCode: 'SAMPLE', verificationUrl: scenario.url}));
      }
      return undefined;
    });
    await f.controller.start();
    try {
      await f.controller.run({type: scenario.type === 'login' ? 'startCodexLogin' : 'installCodex'}, async () => '/tmp/work');
      await until(() => f.controller.current().jobs[0]?.phase === (scenario.allowed ? 'authorizing' : 'unresolved'));
      if (scenario.allowed) assert.equal(f.controller.authorization(id), scenario.url);
      else assert.throws(() => f.controller.authorization(id));
      await f.controller.cancel(id);
      assert.throws(() => f.controller.authorization(id));
    } finally { await f.controller.quit(); }
  }
});
