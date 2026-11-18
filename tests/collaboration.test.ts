import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createCollaborationService } from "../desktop/main/collaboration";
import { agentIdSchema, folderTokenSchema, groupIdSchema, membershipIdSchema, type DesktopSnapshot } from "../desktop/shared/bridge";
import type { HostHandle } from "../desktop/main/host";
import {searchEntries} from "../desktop/renderer/search";

const agentId = agentIdSchema.parse("cli_testagent");
const groupId = groupIdSchema.parse("oc_testgroup");
const folderToken = folderTokenSchema.parse("a87a68a0-197d-4f2a-bc7b-835b55d68d32");
const snapshot: DesktopSnapshot = {
  revision: 2, observedAt: Date.now(), stale: false,
  host: { kind: "connected", ownership: "owned", version: "0.7.0" },
  agents: [{ id: agentId, name: "Test", enabled: true, running: true, connection: "connected", activation: "active" }],
  groups: [{ id: groupId, name: "Test group" }],
  memberships: [{ id: membershipIdSchema.parse("test"), agentId, groupId, name: "Test project", directory: "/tmp/project", backend: "codex-appserver", conversation: "threads", response: "mention", permission: { administrator: "full", member: "qa", network: false }, stale: false }],
  tools: [], jobs: [], diagnostics: [],
  application: { platform: "macos", version: "0.7.0", loginItem: false, dataPath: "/tmp/test" },
};

test("Codex account usage is available without any Agent and refreshes through the Host endpoint", async () => {
  const paths: string[] = [];
  const usage = {profile: {topInvocations: [], dailyBuckets: []}, usage: {main: {}, extras: [], fetchedAt: 1000}};
  const host: HostHandle = {kind: "connected", ownership: "owned", pid: 1, async request(path, init) {
    paths.push(path);
    assert.equal(init?.method, "GET");
    return Response.json({data: usage});
  }, async restart() {}, async close() {}};
  const empty = {...snapshot, agents: [], memberships: []};
  const execute = createCollaborationService({host: () => host, snapshot: () => empty, async resolveFolder() {throw new Error("unexpected folder read");}, async openExternal() {throw new Error("unexpected link");}});
  assert.equal((await execute({action: "usage", force: false})).kind, "usage");
  assert.equal((await execute({action: "usage", force: true})).kind, "usage");
  assert.deepEqual(paths, ["/api/account/codex/usage", "/api/account/codex/usage?force=1"]);
});

test("settings search opens the owning detail pane", () => {
  const entries = searchEntries(snapshot);
  const card = entries.find(item => item.id === `${agentId}-任务卡片`);
  const permission = entries.find(item => item.id === `${snapshot.memberships[0]?.id}-工作目录权限`);
  assert.deepEqual(card?.destination.detail, {kind: "agent-settings"});
  assert.ok(card?.aliases.includes('飞书任务卡片'));
  assert.deepEqual(permission?.destination.detail, {kind: "membership-settings"});
  assert.equal(entries.find(item => item.id === "usage")?.destination.page, "usage");
});

test("project creation resolves the selected folder only in main and sends a scoped Core request", async () => {
  let path = "";
  let body: unknown;
  let folderReads = 0;
  const host: HostHandle = {
    kind: "connected", ownership: "owned", pid: 100,
    async request(nextPath, init) {
      path = nextPath;
      body = JSON.parse(String(init?.body));
      return Response.json({ ok: true, project: { name: "New project", chatId: "oc_created", cwd: "/tmp/project", kind: "multi", backend: "codex-appserver", enabled: true, revision: "sha" } });
    },
    async restart() {}, async close() {},
  };
  const execute = createCollaborationService({ host: () => host, snapshot: () => snapshot, async resolveFolder(token) { assert.equal(token, folderToken); folderReads++; return "/tmp/project"; }, async openExternal() {} });
  const reply = await execute({ action: "createProject", agentId, name: "New project", folder: { kind: "existing", folderToken }, tool: "codex", conversation: "threads" });
  assert.equal(reply.kind, "applied");
  assert.equal(path, "/api/bots/cli_testagent/collaboration");
  assert.equal(folderReads, 1);
  assert.equal(typeof body, "object");
  assert.equal(JSON.stringify(body).includes(folderToken), false);
  assert.deepEqual(Object.keys(z.record(z.unknown()).parse(body)).sort(), ["action", "backend", "directory", "kind", "name", "requestId"].sort());
});

test("stale project and unknown group cannot mutate or open a link", async () => {
  let calls = 0;
  const host: HostHandle = { kind: "connected", ownership: "owned", pid: 1, async request() { calls++; return Response.json({ ok: true }); }, async restart() {}, async close() {} };
  const execute = createCollaborationService({ host: () => host, snapshot: () => snapshot, async resolveFolder() { throw new Error("not expected"); }, async openExternal() { calls++; } });
  const wrong = groupIdSchema.parse("oc_elsewhere");
  const edit = await execute({ action: "removeProject", agentId, groupId: wrong, projectName: "Test project", expectedRevision: "sha" });
  const open = await execute({ action: "openGroup", agentId, groupId: wrong, projectName: "Test project" });
  assert.equal(edit.kind, "refused");
  assert.equal(open.kind, "refused");
  assert.equal(calls, 0);
});

test("retrying an uncertain create reuses the Core idempotency key", async () => {
  const ids: string[] = [];
  const host: HostHandle = {
    kind: "connected", ownership: "owned", pid: 1,
    async request(_path, init) {
      const body = z.object({ requestId: z.string() }).parse(JSON.parse(String(init?.body)));
      ids.push(body.requestId);
      if (ids.length === 1) throw new Error("connection ended after request");
      return Response.json({ ok: true, project: { name: "Retry", chatId: "oc_new", cwd: "/tmp/retry", kind: "multi", backend: "codex-appserver", enabled: true, revision: "sha" } });
    },
    async restart() {}, async close() {},
  };
  const execute = createCollaborationService({ host: () => host, snapshot: () => snapshot, async resolveFolder() { throw new Error("not expected"); }, async openExternal() {} });
  const command = { action: "createProject", agentId, name: "Retry", folder: { kind: "default" }, tool: "codex", conversation: "threads" } as const;
  assert.equal((await execute(command)).kind, "refused");
  assert.equal((await execute(command)).kind, "applied");
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test("remove result preserves group side-effect warning and allows only validated Feishu links", async () => {
  let url = "";
  const host: HostHandle = { kind: "connected", ownership: "owned", pid: 1, async request() { return Response.json({ ok: true, groupEffect: "failed", warning: "群权限不足" }); }, async restart() {}, async close() {} };
  const execute = createCollaborationService({ host: () => host, snapshot: () => snapshot, async resolveFolder() { throw new Error("not expected"); }, async openExternal(next) { url = next; } });
  const removed = await execute({ action: "removeProject", agentId, groupId, projectName: "Test project", expectedRevision: "sha" });
  assert.deepEqual(removed, { kind: "applied", groupEffect: "failed", warning: "群权限不足" });
  const opened = await execute({ action: "openGroup", agentId, groupId, projectName: "Test project", threadId: "omt_test" });
  assert.equal(opened.kind, "opened");
  assert.equal(url.startsWith("https://applink.feishu.cn/client/thread/open?open_chat_id=oc_testgroup"), true);
});

test("history preserves archived bindings and the native session needed for recovery", async () => {
  const host: HostHandle = { kind: "connected", ownership: "owned", pid: 1, async request() {
    return Response.json({ backend: "codex-appserver", sessions: [{ threadId: "omt_old", chatId: groupId, sessionId: "old", cwd: "/tmp/project", backend: "codex-appserver", summary: "old", createdAt: 1, updatedAt: 2, detached: true }], threads: [{ sessionId: "old", preview: "old", createdAt: 1, updatedAt: 2 }] });
  }, async restart() {}, async close() {} };
  const execute = createCollaborationService({ host: () => host, snapshot: () => snapshot, async resolveFolder() { throw new Error("not expected"); }, async openExternal() {} });
  const reply = await execute({ action: "history", agentId, groupId, projectName: "Test project" });
  assert.equal(reply.kind, "history");
  if (reply.kind !== "history") throw new Error("Expected history");
  assert.equal(reply.sessions[0]?.detached, true);
  assert.equal(reply.threads[0]?.sessionId, "old");
});
