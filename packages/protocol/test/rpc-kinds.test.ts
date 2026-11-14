import { expect, it } from "vitest";
import { requestSchema, rpcKindOf, rpcKinds, type Request } from "../src/index.js";

it("names every request once, nested variants by their own field", () => {
  const entries = rpcKinds();
  const kinds = entries.map(entry => entry.kind);
  expect(new Set(kinds).size).toBe(kinds.length);
  for (const entry of entries) expect(entry.kind.startsWith(`${entry.method}.${entry.type}`)).toBe(true);
  for (const kind of [
    "snapshot.get", "contextPreview.get", "command.bindGroup", "command.readGroupIdentity", "command.setAgentBadgeNumber", "schedule.create", "schedule.listBot", "memory.newCounts",
    "settings.read.host", "settings.save.session", "settings.act.adminMember", "settings.sessions",
    "machine.mcp.add", "machine.service.start", "machine.bridgeImport.rollback", "machine.stopHost",
  ]) expect(kinds).toContain(kind);
  // an expanded request has no name of its own
  for (const kind of ["settings.act", "settings.read", "settings.save", "machine.mcp", "machine.service", "machine.bridgeImport"]) expect(kinds).not.toContain(kind);
  expect(new Set(entries.map(entry => entry.method))).toEqual(new Set(requestSchema.options.map(option => option.shape.method.value)));
  // devices 8.4: the eleven dead kinds left, the nine device kinds and admin.negotiate came; C5 added memory.branchDelete.
  // devices-ui-2 4.9: environment.installCodex and environment.startCodexLogin left too. devices-ui-4 added
  // machine.desktopUpdateReport. main 必败: 152 kinds, none of them device
  // dm-agent 7.3: command.feishuRead. Badges added command.setAgentBadgeNumber.
  const installs=kinds.filter(kind=>kind.startsWith('recipeInstall.')).sort();
  expect(installs).toEqual(['cancel','commit','createdGroup','ignoreVersion','issuing','prepare','reconcile','richCancel','richCommit','richIssuing','richPrepare','richReconcile','richSetup','richStatus','source','status'].map(kind=>'recipeInstall.'+kind));
  const authoring = kinds.filter(kind => kind.startsWith('recipeAuthoring.')).sort();
  expect(authoring).toEqual('advance answerField beginLink cancel close confirmLink deliver edit groupSourceIdentity inspectCandidate inspectLink open operationSourceIdentity prepare reconcile resend resumeContext reviewSource richAdvance richBindMembers richEdit richInspect richInventory richMembers richPrepare richReadMember richSourceOptions settle status updateCard workflow'.split(' ').map(kind => 'recipeAuthoring.' + kind));
  expect(kinds.length - installs.length - authoring.length).toBe(155);
  for (const kind of ["device.pair", "device.setPort", "admin.negotiate", "memory.branchDelete", "machine.desktopUpdateReport"]) expect(kinds).toContain(kind);
  for (const kind of ["machine.repairCli", "collaboration.openGroup", "environment.installCodex", "environment.startCodexLogin"]) expect(kinds).not.toContain(kind);
});

// devices 5.2: the permission table looks a request up by this name.
it("names a parsed request the way rpcKinds names its variant", () => {
  const request = (method: string, payload: object): Request => ({ type: "request", id: "1", method, payload } as Request);
  expect(rpcKindOf(request("snapshot", { type: "get" }))).toBe("snapshot.get");
  expect(rpcKindOf(request("machine", { type: "service", action: "start" }))).toBe("machine.service.start");
  expect(rpcKindOf(request("machine", { type: "stopHost" }))).toBe("machine.stopHost");
  expect(rpcKindOf(request("settings", { type: "act", action: { kind: "voice" } }))).toBe("settings.act.voice");
  expect(rpcKindOf(request("settings", { type: "save", edit: { scope: { kind: "host" } } }))).toBe("settings.save.host");
  expect(rpcKindOf(request("schedule", { request: { action: "create" } }))).toBe("schedule.create");
  expect(rpcKindOf(request("device", { type: "pair" }))).toBe("device.pair");
});
