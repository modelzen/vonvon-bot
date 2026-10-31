import { expect, it } from "vitest";
import { requestSchema, rpcKinds } from "../src/index.js";

it("names every request once, nested variants by their own field", () => {
  const entries = rpcKinds();
  const kinds = entries.map(entry => entry.kind);
  expect(new Set(kinds).size).toBe(kinds.length);
  for (const entry of entries) expect(entry.kind.startsWith(`${entry.method}.${entry.type}`)).toBe(true);
  for (const kind of [
    "snapshot.get", "contextPreview.get", "command.bindGroup", "schedule.create", "schedule.listBot", "memory.newCounts",
    "settings.read.host", "settings.save.session", "settings.act.adminMember", "settings.sessions",
    "machine.mcp.add", "machine.service.start", "machine.bridgeImport.rollback", "machine.stopHost",
  ]) expect(kinds).toContain(kind);
  // an expanded request has no name of its own
  for (const kind of ["settings.act", "settings.read", "settings.save", "machine.mcp", "machine.service", "machine.bridgeImport"]) expect(kinds).not.toContain(kind);
  expect(new Set(entries.map(entry => entry.method))).toEqual(new Set(requestSchema.options.map(option => option.shape.method.value)));
});
