import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  agentViewSchema, bridgeProjectsStoreSchema, commandSchema, helloSchema,
  machineIdSchema, requestSchema, responseSchema, errorEnvelopeSchema,
  desktopSnapshotSchema, eventSchema, watchSnapshots,
  type DesktopSnapshot, settingsViewSchema,
} from "../src/index.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("pinned contract extraction", () => {
  it("parses the agent settings fixture", () => {
    expect(agentViewSchema.parse(fixture("agent-settings.json")).scope.kind).toBe("agent");
  });
  it("rejects a bindGroup project name with a slash", () => {
    expect(commandSchema.safeParse({type:"bindGroup",agentId:"cli_fixture",groupId:"oc_fixture",projectName:"a/b",folderToken:randomUUID(),tool:"codex",conversation:"threads"}).success).toBe(false);
  });
  it("omits only the four desktop commands", () => {
    for (const type of ["quit", "hideWindow", "setLoginItem", "chooseFolder"]) {
      expect(commandSchema.safeParse({type}).success).toBe(false);
    }
  });
  it("requires clientKind and protocolVersion but accepts a newer version", () => {
    expect(helloSchema.safeParse({type:"hello",clientKind:"cli"}).success).toBe(false);
    const missingClient = helloSchema.safeParse({type:"hello",protocolVersion:1});
    expect(missingClient.success).toBe(false);
    if (!missingClient.success) expect(missingClient.error.issues[0]?.path).toContain("clientKind");
    expect(helloSchema.parse({type:"hello",protocolVersion:2,clientKind:"web"}).protocolVersion).toBe(2);
  });
  it("validates machine UUIDs and historical bridge project rows without dropping extensions", () => {
    expect(machineIdSchema.parse(randomUUID())).toBeTruthy();
    expect(machineIdSchema.safeParse("").success).toBe(false);
    const parsed = bridgeProjectsStoreSchema.parse(fixture("projects.json"));
    expect(parsed.extensionAtRoot).toEqual({keep:true});
    expect(parsed.projects[0]?.extensionFromOlderVersion).toEqual({keep:true});
    expect(bridgeProjectsStoreSchema.parse({projects:[{name:"old",cwd:"/tmp"}]}).projects).toHaveLength(1);
  });
  it("round-trips settings views for all four scopes", () => {
    const section = (value: unknown) => ({stored:value,effective:value,revision:"r1",access:{kind:"writable"},apply:[]});
    const selection = {kind:"default"};
    const views = [
      fixture("agent-settings.json"),
      {scope:{kind:"project",botId:"cli_fixture",projectName:"fixture"},sections:{
        permission:section({mode:"qa",guestMode:"qa",network:false}),
        response:section({noMention:false}),compact:section({autoCompact:true}),model:section({selection}),
      },identity:{chatId:"oc_fixture",backend:"codex-appserver",cwd:"/tmp",kind:"multi"},members:{openIds:[],revision:"r1"}},
      {scope:{kind:"session",botId:"cli_fixture",threadId:"thread"},sections:{model:section({selection})},identity:{backend:"codex-appserver",sessionId:"session",chatId:"oc_fixture",projectName:"fixture"}},
      {scope:{kind:"host"},sections:{execution:section({codexBin:null})},runtime:{codexBin:null,fallbackCwd:"/tmp",platform:"macos"}},
    ];
    for (const view of views) {
      const parsed = settingsViewSchema.parse(view);
      expect(settingsViewSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }
  });
  it("correlates method and payload in both directions", () => {
    expect(requestSchema.safeParse({type:"request",id:"1",method:"settings",payload:{type:"refresh"}}).success).toBe(false);
    expect(responseSchema.safeParse({type:"response",id:"1",method:"environment",payload:{type:"done",message:"ok"}}).success).toBe(false);
    expect(errorEnvelopeSchema.parse({type:"error",id:"1",code:"BAD_REQUEST",message:"bad"}).id).toBe("1");
  });
  it("rejects malformed snapshots in event envelopes", () => {
    expect(desktopSnapshotSchema.safeParse({revision:1}).success).toBe(false);
    expect(eventSchema.safeParse({type:"event",event:"snapshot",payload:{revision:1}}).success).toBe(false);
  });
  it("watchSnapshots delivers increasing revisions and stops after unsubscribe", async () => {
    const seen: number[] = [];
    let receive: ((snapshot: DesktopSnapshot) => void) | undefined;
    const snapshot = (revision: number) => desktopSnapshotSchema.parse({
      revision,observedAt:0,stale:false,host:{kind:"starting"},agents:[],groups:[],memberships:[],tools:[],jobs:[],diagnostics:[],
      application:{platform:"macos",version:"1",loginItem:false,dataPath:"/tmp"},
    });
    const stop = watchSnapshots({listen: callback => { receive = callback; return () => {}; },initial:async () => snapshot(1),listener:value => seen.push(value.revision)});
    receive?.(snapshot(2));
    await Promise.resolve();
    receive?.(snapshot(1));
    stop();
    receive?.(snapshot(3));
    expect(seen).toEqual([2]);
  });
});
