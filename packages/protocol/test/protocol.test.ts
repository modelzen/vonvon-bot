import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agentViewSchema, bridgeProjectsStoreSchema, commandSchema, helloSchema,
  machineIdSchema, requestSchema, responseSchema, errorEnvelopeSchema,
  desktopSnapshotSchema, eventSchema, watchSnapshots,
  adminRequestSchema, adminReplySchema, adminStateSchema, directoryRequestSchema, directoryReplySchema,
  jobSchema, environmentReplySchema,
  type DesktopSnapshot, settingsViewSchema, projectViewSchema, projectEditableSchemas, settingsReplySchema,
  applicationCrashesSchema, crashText, FORCED_DETAIL,
} from "../src/index.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("pinned contract extraction", () => {
  it("parses V3 admin state without dropping legacy fields", () => {
    const state = {version:"0.7",generatedAt:100,bots:[{
      name:"bot",appId:"cli_fixture",tenant:"feishu",active:true,current:true,running:true,
      pid:42,startedAt:10,connection:"connected",completionReminder:{mode:"failures",longTaskMinutes:3},
      projects:[{name:"p",chatId:"oc_fixture",cwd:"/tmp/p",blank:false,kind:"multi",origin:"joined",
        noMention:true,mode:"full",guestMode:"qa",network:false,backend:"codex-appserver",
        allowedUsersCount:2,sessionCount:3,createdAt:9}],
    }]};
    expect(adminStateSchema.parse(state)).toEqual(state);
    expect(adminReplySchema.parse({kind:"state",state}).state).toEqual(state);
    expect(adminStateSchema.parse({...state,bots:[{...state.bots[0],projects:[],projectsError:"corrupt"}]}).bots[0]?.projectsError).toBe("corrupt");
  });
  it("parses each V3 request and reply variant", () => {
    const adminRequests = [
      {type:"state"},{type:"diagnosis",agentId:"cli_fixture"},{type:"hostDoctor"},
      {type:"setupStatus",agentId:"cli_fixture"},{type:"confirmCardCallback",agentId:"cli_fixture",confirmed:true},{type:"daemonStatus"},{type:"codexSetup"},
      {type:"logs",maxBytes:1024},{type:"followLogs",follow:true},
      {type:"switchBackend",agentId:"cli_fixture",projectName:"p",backend:"codex-appserver"},
    ];
    for (const payload of adminRequests) expect(adminRequestSchema.safeParse(payload).success).toBe(true);
    for (const payload of [{type:"list"},{type:"list",path:"/tmp"},{type:"choose",path:"/tmp"}]) {
      expect(directoryRequestSchema.safeParse(payload).success).toBe(true);
    }
    expect(directoryReplySchema.parse({kind:"entries",path:"/tmp",parent:null,entries:[{name:"p",path:"/tmp/p",hidden:false}],truncated:false}).kind).toBe("entries");
    expect(directoryReplySchema.parse({kind:"folderChosen",folder:{token:randomUUID(),displayPath:"/tmp/p"}}).kind).toBe("folderChosen");
    const backend = {id:"codex",name:"Codex",ok:true,version:"1",isDefault:true};
    const daemon = {installed:false,running:true,selfHosted:true,version:"1",supported:false};
    for (const payload of [
      {kind:"diagnosis",bot:"cli_fixture",backends:[backend],event:{state:"ok"},eventConfigUrl:"https://example.test"},
      {kind:"hostDoctor",doctor:{node:"24",platform:"darwin",arch:"arm64",osRelease:"1",appDir:"/tmp",logsDir:"/tmp/logs",logBytes:0,version:"1",backends:[backend]}},
      {kind:"setupStatus",status:{appId:"cli_fixture",tenant:"feishu",credentials:{ok:true},connection:{running:true},event:{state:"ok"},scopes:{grantUrl:"https://example.test"},eventConfigUrl:"https://example.test",consoleUrl:"https://example.test/app/cli_fixture",cardCallback:{confirmed:false}}},
      {kind:"daemonStatus",status:daemon},
      {kind:"codexSetup",setup:{installation:"installed",authentication:"signedIn",version:"1",executable:"/bin/codex"}},
      {kind:"logs",text:"x"},{kind:"following",follow:true},{kind:"applied",revision:2},
    ]) {
      expect(adminReplySchema.safeParse(payload).success).toBe(true);
    }
    expect(requestSchema.safeParse({type:"request",id:"1",method:"snapshot",payload:{type:"get"}}).success).toBe(true);
    expect(requestSchema.safeParse({type:"request",id:"2",method:"admin",payload:{type:"state"}}).success).toBe(true);
    expect(requestSchema.safeParse({type:"request",id:"3",method:"directory",payload:{type:"list"}}).success).toBe(true);
  });
  it("keeps optional V3 job, install, and event fields", () => {
    const base = {id:"job",type:"registerAgent"};
    expect(jobSchema.parse({...base,phase:"qr",image:"data:image/png;base64,a",url:"https://example.test",expiresAt:1,status:"pending"}).status).toBe("pending");
    expect(jobSchema.parse({...base,phase:"authorizing",userCode:"code",verificationUrl:"https://example.test"}).verificationUrl).toBe("https://example.test");
    expect(jobSchema.parse({...base,phase:"succeeded",message:"done",agentId:"cli_fixture"}).agentId).toBe("cli_fixture");
    expect(jobSchema.parse({...base,phase:"failed",message:"failed",code:"network"}).code).toBe("network");
    const operationId = randomUUID();
    expect(environmentReplySchema.parse({kind:"backendInstall",operationId,id:"codex",update:false,attached:true,replay:[{type:"log",chunk:"x"},{type:"done"}]}).kind).toBe("backendInstall");
    for (const value of [
      {type:"event",event:"log",payload:{lines:"x"}},
      {type:"event",event:"backendInstall",payload:{operationId,id:"codex",update:false,item:{type:"error",code:"install_failed",message:"failed"}}},
    ]) expect(eventSchema.safeParse(value).success).toBe(true);
    expect(helloSchema.parse({type:"hello",protocolVersion:2,clientKind:"cli",credential:"secret"}).credential).toBe("secret");
  });
  it("parses the agent settings fixture", () => {
    expect(agentViewSchema.parse(fixture("agent-settings.json")).scope.kind).toBe("agent");
  });
  it("s02c1: drops 咖啡一下 from an older daemon's view and refuses its four actions", () => {
    const old = fixture("agent-settings.json") as { sections: Record<string, unknown> };
    const parsed = agentViewSchema.parse({ ...old, sections: { ...old.sections, cliBridge: {} }, cliRuntime: { enabled: true } });
    expect(parsed.sections).not.toHaveProperty("cliBridge");
    expect(parsed).not.toHaveProperty("cliRuntime");
    for (const action of [
      { kind: "setCliBridgeEnabled", botId: "cli_fixture", enabled: true, revision: "r" }, { kind: "repairCliHooks", botId: "cli_fixture" },
      { kind: "setHostCliRoute", botId: null, revision: "r" }, { kind: "repairHostCliHooks", agents: ["codex"] },
    ]) expect(requestSchema.safeParse({ type: "request", id: "x", method: "settings", payload: { type: "act", action } }).success).toBe(false);
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
    const old = {version:"legacy",projects:[{name:"old",cwd:"/tmp",chatId:42,enabled:"legacy"}]};
    expect(bridgeProjectsStoreSchema.parse(old)).toEqual(old);
  });
  it("round-trips settings views for all four scopes", () => {
    const section = (value: unknown) => ({stored:value,effective:value,revision:"r1",access:{kind:"writable"},apply:[]});
    const selection = {kind:"default"};
    const views = [
      fixture("agent-settings.json"),
      {scope:{kind:"project",botId:"cli_fixture",projectName:"fixture"},sections:{
        permission:section({mode:"qa",guestMode:"qa",network:false}),
        response:section({noMention:false}),model:section({selection}),
      },identity:{chatId:"oc_fixture",backend:"codex-appserver",cwd:"/tmp",kind:"multi"},members:{openIds:[],revision:"r1"}},
      {scope:{kind:"session",botId:"cli_fixture",threadId:"thread"},sections:{model:section({selection})},identity:{backend:"codex-appserver",sessionId:"session",chatId:"oc_fixture",projectName:"fixture"}},
      {scope:{kind:"host"},sections:{execution:section({codexBin:null})},runtime:{codexBin:null,fallbackCwd:"/tmp",platform:"macos"}},
    ];
    for (const view of views) {
      const parsed = settingsViewSchema.parse(view);
      expect(settingsViewSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }
  });
  it("no longer accepts the auto-compaction switch (s12)", () => {
    const scope = {kind:"project",botId:"cli_fixture",projectName:"fixture"};
    const save = (section: string, patch: unknown) => requestSchema.safeParse({type:"request",id:"1",method:"settings",payload:{type:"save",edit:{scope,section,revision:"r1",patch}}}).success;
    expect(save("response", {noMention:true})).toBe(true);
    expect(save("compact", {autoCompact:false})).toBe(false);
  });
  it("has one permission tier per group (s15c): no guestMode edit, no member in setPermission", () => {
    const scope = {kind:"project",botId:"cli_fixture",projectName:"fixture"};
    const save = (patch: unknown) => requestSchema.safeParse({type:"request",id:"1",method:"settings",payload:{type:"save",edit:{scope,section:"permission",revision:"r1",patch}}}).success;
    expect(save({mode:"full"})).toBe(true);
    expect(save({guestMode:"qa"})).toBe(false);
    expect(save({mode:"full",guestMode:"qa"})).toBe(false);
    const membershipId = JSON.stringify(["cli_fixture","oc_fixture"]);
    expect(commandSchema.safeParse({type:"setPermission",membershipId,administrator:"full",network:false}).success).toBe(true);
    expect(commandSchema.safeParse({type:"setPermission",membershipId,administrator:"full",member:"qa",network:false}).success).toBe(false);
  });
  it("keeps guestMode in the group's view, output only, so a client from before s15c still parses it", () => {
    const section = (value: unknown) => ({stored:value,effective:value,revision:"r1",access:{kind:"writable"},apply:[]});
    const view = (permission: object) => ({scope:{kind:"project",botId:"cli_fixture",projectName:"fixture"},sections:{
      permission:section(permission),response:section({noMention:false}),model:section({selection:{kind:"default"}}),
    },identity:{chatId:"oc_fixture",backend:"codex-appserver",cwd:"/tmp",kind:"multi"},members:{openIds:[],revision:"r1"}});
    // The permission section as clients from before s15c (4e22f1b) parse it.
    const tier = z.enum(["qa","write","full"]);
    const before = z.object({mode:tier,guestMode:tier,network:z.boolean()});
    const parsed = projectViewSchema.parse(view({mode:"write",guestMode:"write",network:true}));
    expect(before.parse(parsed.sections.permission.stored)).toEqual({mode:"write",guestMode:"write",network:true});
    expect(before.parse(parsed.sections.permission.effective)).toEqual({mode:"write",guestMode:"write",network:true});
    expect(projectViewSchema.safeParse(view({mode:"write",network:true})).success).toBe(false);
    expect(settingsReplySchema.parse({kind:"view",view:view({mode:"qa",guestMode:"qa",network:false})})).toMatchObject({view:{sections:{permission:{stored:{guestMode:"qa"}}}}});
    expect(Object.keys(projectEditableSchemas.permission.shape)).toEqual(["mode","network"]);
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

it("accepts optional omittedBytes and rejects negative or fractional counts", () => {
  const reply = {kind:"backendInstall",operationId:randomUUID(),id:"claude-agent",update:false,attached:false,replay:[]};
  expect(environmentReplySchema.parse(reply)).toEqual(reply);
  expect(environmentReplySchema.parse({...reply,omittedBytes:123})).toEqual({...reply,omittedBytes:123});
  expect(environmentReplySchema.safeParse({...reply,omittedBytes:-1}).success).toBe(false);
  expect(environmentReplySchema.safeParse({...reply,omittedBytes:0.5}).success).toBe(false);
});

it("writes a crash in one line: a signal the supervisor saw with its uptime, a forced end found later with a lower bound (s18a)", () => {
  expect(crashText({ kind: "exception", reason: "TypeError: x", uptimeMs: 192_000 })).toBe("程序出错：TypeError: x，运行了 3 分 12 秒");
  expect(crashText({ kind: "forced", reason: "SIGKILL", uptimeMs: 500 })).toBe("被系统强制结束（SIGKILL），运行了 0 秒");
  expect(crashText({ kind: "forced", reason: "被系统强制结束", uptimeMs: 500 })).toBe(`被系统强制结束${FORCED_DETAIL}`);
  expect(crashText({ kind: "forced", reason: "被系统强制结束", uptimeMs: 7_380_000, paused: true })).toBe(`被系统强制结束${FORCED_DETAIL}，运行了至少 2 小时 3 分（暂停期间）`);
  expect(crashText({ kind: "fatal", reason: "退出码 1" })).toBe("出错退出：退出码 1");
  // A newer daemon's extra field or longer list does not fail the snapshot (the daemon trims to 20).
  const records = Array.from({ length: 25 }, () => ({ at: 1, kind: "fatal", reason: "x", extra: true }));
  expect(applicationCrashesSchema.parse({ records }).records).toHaveLength(25);
});
