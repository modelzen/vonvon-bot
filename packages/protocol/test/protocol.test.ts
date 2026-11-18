import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  pendingGroupsSchema, agentViewSchema, bridgeProjectsStoreSchema, commandSchema, helloSchema,
  machineIdSchema, requestSchema, responseSchema, errorEnvelopeSchema,
  desktopSnapshotSchema, eventSchema, watchSnapshots,
  adminRequestSchema, adminReplySchema, adminStateSchema, directoryRequestSchema, directoryReplySchema,
  jobSchema, environmentReplySchema,
  type DesktopSnapshot, settingsViewSchema, projectViewSchema, projectEditableSchemas, settingsReplySchema,
  applicationCrashesSchema, crashText, FORCED_DETAIL, NOT_REPLIED_TEXT, diagnosticsEventSchema, notRepliedSchema, KEY_FAILURE, keyFailureOf, keyProblem,
  isKnownJudgeSelection, type JudgeSelectionView,
  adminProjectSchema, collaborationRequestSchema, collaborationReplySchema, topicConversationCopy, conversationCopy, conversationSchema, conversationToMode, modeToConversation, projectRecordSchema,
  toolSteps, environmentToolStateSchema,
} from "../src/index.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const permissionOptions = {
  tiers: ["qa", "write", "full"].map(tier => ({ tier, name: "权限", summary: "说明", native: "" })),
  strength: "能力说明", fields: [], expanded: { qa: {}, write: {}, full: {} },
};

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
    for (const enabled of [true, false]) {
      const project = {...state.bots[0]!.projects[0]!, enabled};
      const withFlag = {...state, bots: [{...state.bots[0]!, projects: [project]}]};
      expect(adminReplySchema.parse({kind:"state", state:withFlag}).state).toEqual(withFlag);
    }
    expect(adminStateSchema.parse({...state,bots:[{...state.bots[0],projects:[],projectsError:"corrupt"}]}).bots[0]?.projectsError).toBe("corrupt");
  });
  it("parses each V3 request and reply variant", () => {
    const adminRequests = [
      {type:"state"},{type:"diagnosis",agentId:"cli_fixture"},{type:"hostDoctor"},
      {type:"setupStatus",agentId:"cli_fixture"},{type:"confirmCardCallback",agentId:"cli_fixture",confirmed:true},{type:"daemonStatus"},{type:"codexSetup"},
      {type:"logs",maxBytes:1024},{type:"followLogs",follow:true},
      {type:"switchBackend",agentId:"cli_fixture",projectName:"p",backend:"codex-appserver"},
      {type:"secrets"},{type:"setSecret",keyId:"typesafe-api-key",value:"ts_TESTKEY0000"},
      {type:"removeSecret",keyId:"typesafe-api-key"},{type:"testSecret",keyId:"typesafe-api-key"},
    ];
    for (const payload of adminRequests) expect(adminRequestSchema.safeParse(payload).success).toBe(true);
    for (const payload of [{type:"list"},{type:"list",path:"/tmp"},{type:"suggest",query:"~/Projects/vonvon"},{type:"choose",path:"/tmp"}]) {
      expect(directoryRequestSchema.safeParse(payload).success).toBe(true);
    }
    expect(directoryReplySchema.parse({kind:"entries",path:"/tmp",parent:null,entries:[{name:"p",path:"/tmp/p",hidden:false}],truncated:false}).kind).toBe("entries");
    expect(directoryReplySchema.parse({kind:"suggestions",root:"/home",path:null,parent:null,entries:[{name:"project",path:"/home/project",hidden:false}],truncated:true}).kind).toBe("suggestions");
    expect(directoryRequestSchema.safeParse({type:"suggest",query:"x".repeat(4097)}).success).toBe(false);
    expect(directoryReplySchema.parse({kind:"folderChosen",folder:{token:randomUUID(),displayPath:"/tmp/p"}}).kind).toBe("folderChosen");
    const backend = {id:"codex",name:"Codex",ok:true,version:"1",isDefault:true};
    const daemon = {installed:false,running:true,selfHosted:true,version:"1",supported:false,startedAt:1};
    for (const payload of [
      {kind:"diagnosis",bot:"cli_fixture",backends:[backend],event:{state:"ok"},eventConfigUrl:"https://example.test"},
      {kind:"hostDoctor",doctor:{node:"24",platform:"darwin",arch:"arm64",osRelease:"1",appDir:"/tmp",logsDir:"/tmp/logs",logBytes:0,version:"1",backends:[backend]}},
      {kind:"setupStatus",status:{appId:"cli_fixture",tenant:"feishu",credentials:{ok:true},connection:{running:true},event:{state:"ok"},scopes:{grantUrl:"https://example.test"},eventConfigUrl:"https://example.test",consoleUrl:"https://example.test/app/cli_fixture",cardCallback:{confirmed:false}}},
      {kind:"daemonStatus",status:daemon},
      {kind:"codexSetup",setup:{installation:"installed",authentication:"signedIn",version:"1",executable:"/bin/codex"}},
      {kind:"logs",text:"x"},{kind:"following",follow:true},{kind:"applied",revision:2},
      {kind:"secrets",unreadBots:0,removed:true,services:[{provider:"typesafe",displayName:"TypeSafe",keyId:"typesafe-api-key",models:[{id:"jev-latest",displayName:"Jev"}],status:"set",last4:"0000",
        inUse:[{agentId:"cli_fixture",agentName:"bot"},{agentId:"cli_fixture",agentName:"bot",groupId:"oc_fixture",groupName:"g",inherited:true,notSmart:true}]}]},
      {kind:"secretTested",keyId:"typesafe-api-key",outcome:"auth",message:"key 不对",status:401},{kind:"refused",code:"invalid_key",message:"x"},
    ]) {
      expect(adminReplySchema.safeParse(payload).success).toBe(true);
    }
    expect(requestSchema.safeParse({type:"request",id:"1",method:"snapshot",payload:{type:"get"}}).success).toBe(true);
    expect(requestSchema.safeParse({type:"request",id:"2",method:"admin",payload:{type:"state"}}).success).toBe(true);
    expect(requestSchema.safeParse({type:"request",id:"3",method:"directory",payload:{type:"list"}}).success).toBe(true);
    // the key's length only: its shape is the daemon's to refuse in words (s23g)
    for (const value of ["", "x".repeat(4097)]) expect(adminRequestSchema.safeParse({type:"setSecret",keyId:"typesafe-api-key",value}).success).toBe(false);
    expect(adminRequestSchema.safeParse({type:"setSecret",keyId:"typesafe-api-key",value:"ts_TEST KEY"}).success).toBe(true);
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
  it("requires an explicit default or tokenized existing folder when binding", () => {
    const base = {type:"bindGroup",agentId:"cli_fixture",groupId:"oc_fixture",projectName:"Group",tool:"codex",conversation:"threads"};
    expect(commandSchema.safeParse({...base,folder:{kind:"default"}}).success).toBe(true);
    expect(commandSchema.safeParse({...base,folder:{kind:"existing",folderToken:randomUUID()}}).success).toBe(true);
    for (const folder of [undefined, {kind:"existing"}, {kind:"default",folderToken:randomUUID()}, {kind:"existing",path:"/untrusted"}]) {
      expect(commandSchema.safeParse({...base,folder}).success).toBe(false);
    }
  });
  it("s25c: carries 智能 as smart on every 会话方式 field, mapped one to one with the stored mode", () => {
    expect(conversationSchema.options).toEqual(["threads", "shared", "smart"]);
    expect(Object.keys(conversationCopy)).toEqual(["threads", "shared", "smart"]);
    expect(conversationSchema.options.map(conversationToMode)).toEqual(["multi", "single", "smart"]);
    for (const value of conversationSchema.options) expect(modeToConversation(conversationToMode(value))).toBe(value);
    expect(commandSchema.safeParse({type:"bindGroup",agentId:"cli_fixture",groupId:"oc_fixture",projectName:"Group",folder:{kind:"default"},tool:"codex",conversation:"smart"}).success).toBe(true);
    expect(collaborationRequestSchema.safeParse({action:"editProject",agentId:"cli_fixture",projectName:"Group",groupId:"oc_fixture",expectedRevision:"r",conversation:"smart"}).success).toBe(true);
    expect(projectRecordSchema.parse({name:"Group",chatId:"oc_fixture",cwd:"/tmp",kind:"smart",backend:"codex-appserver",enabled:true,revision:"r"}).kind).toBe("smart");
    expect(adminProjectSchema.shape.kind.options).toEqual(["multi", "single", "smart"]);
    expect(conversationSchema.safeParse("smart-ish").success).toBe(false);
  });
  it("rejects a bindGroup project name with a slash", () => {
    expect(commandSchema.safeParse({type:"bindGroup",agentId:"cli_fixture",groupId:"oc_fixture",projectName:"a/b",folder:{kind:"existing",folderToken:randomUUID()},tool:"codex",conversation:"threads"}).success).toBe(false);
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
    const legacyMachineId = "00000000-0000-0000-0000-000000000001";
    expect(machineIdSchema.parse(legacyMachineId)).toBe(legacyMachineId);
    expect(machineIdSchema.safeParse("").success).toBe(false);
    const parsed = bridgeProjectsStoreSchema.parse(fixture("projects.json"));
    expect(parsed.extensionAtRoot).toEqual({keep:true});
    expect(parsed.projects[0]?.extensionFromOlderVersion).toEqual({keep:true});
    expect(bridgeProjectsStoreSchema.parse({projects:[{name:"old",cwd:"/tmp"}]}).projects).toHaveLength(1);
    const old = {version:"legacy",projects:[{name:"old",cwd:"/tmp",chatId:42,enabled:"legacy"}]};
    expect(bridgeProjectsStoreSchema.parse(old)).toEqual(old);
  });
  it("accepts a settings save reply with omitted section values", () => {
    const reply = {
      kind: "saved",
      result: {
        kind: "saved",
        section: {
          scope: { kind: "host" },
          section: "execution",
          value: { revision: "1", access: { kind: "writable" }, apply: [] },
        },
        effects: [],
      },
    };
    expect(settingsReplySchema.parse(reply)).toEqual(reply);
  });
  it("round-trips settings views for all four scopes", () => {
    const section = (value: unknown) => ({stored:value,effective:value,revision:"r1",access:{kind:"writable"},apply:[]});
    const selection = {kind:"default"};
    const views = [
      fixture("agent-settings.json"),
      {scope:{kind:"project",botId:"cli_fixture",projectName:"fixture"},sections:{
        permission:section({mode:"qa",guestMode:"qa",network:false,custom:null,options:permissionOptions}),
        response:section({noMention:false}),model:section({selection}),
      },identity:{chatId:"oc_fixture",backend:"codex-appserver",cwd:"/tmp",kind:"multi"},members:{openIds:[],revision:"r1"}},
      // s21's run section: stored "default" inherits the bot's
      {scope:{kind:"project",botId:"cli_fixture",projectName:"fixture"},sections:{
        permission:section({mode:"qa",guestMode:"qa",network:false,custom:null,options:permissionOptions}),
        response:section({noMention:false}),model:section({selection}),run:section({pendingPolicy:"default"}),
      },identity:{chatId:"oc_fixture",backend:"codex-appserver",cwd:"/tmp",kind:"multi"},members:{openIds:[],revision:"r1"}},
      {scope:{kind:"session",botId:"cli_fixture",threadId:"thread"},sections:{model:section({selection})},identity:{backend:"codex-appserver",sessionId:"session",chatId:"oc_fixture",projectName:"fixture"}},
      {scope:{kind:"host"},sections:{execution:section({codexBin:null})},runtime:{codexBin:null,fallbackCwd:"/tmp",platform:"macos"}},
      {scope:{kind:"host"},sections:{execution:section({codexBin:null}),judge:section({byProvider:{"codex-appserver":{model:"luna",effort:"low"}}})},runtime:{codexBin:null,fallbackCwd:"/tmp",platform:"macos"}},
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
  it('accepts three session speed tiers without group inheritance', () => {
    const save = (scope: object, tier: string) => requestSchema.safeParse({ type: 'request', id: 'speed', method: 'settings', payload: { type: 'save', edit: { scope, section: 'speed', revision: 'r1', patch: { tier } } } }).success;
    expect(save({ kind: 'project', botId: 'cli_fixture', projectName: 'fixture' }, 'ultrafast')).toBe(true);
    for (const tier of ['standard', 'fast', 'ultrafast']) expect(save({ kind: 'session', botId: 'cli_fixture', threadId: 'omt_fixture' }, tier)).toBe(true);
    expect(save({ kind: 'session', botId: 'cli_fixture', threadId: 'omt_fixture' }, 'inherit')).toBe(false);
    expect(save({ kind: 'session', botId: 'cli_fixture', threadId: 'omt_fixture' }, 'turbo')).toBe(false);
  });
  it('accepts global title settings and one-provider legacy input without exposing legacy in views', () => {
    const save = (patch: unknown) => requestSchema.safeParse({type:'request',id:'1',method:'settings',payload:{type:'save',edit:{scope:{kind:'agent',botId:'cli_fixture'},section:'titles',revision:'r1',patch}}}).success;
    expect(save({policy:{enabled:true,backend:'claude-agent',model:'title-model',effort:'low'}})).toBe(true);
    expect(save({policy:{enabled:false}})).toBe(true);
    expect(save({byBackend:{'codex-appserver':{enabled:false}}})).toBe(true);
    expect(save({byBackend:{a:{enabled:false},b:{enabled:false}}})).toBe(false);
    expect(save({policy:{enabled:true,model:'missing-backend',effort:'low'}})).toBe(false);
    const view = agentViewSchema.parse(fixture('agent-settings.json'));
    expect(view.sections.titles.stored).toHaveProperty('policy');
    expect(view.sections.titles.stored).not.toHaveProperty('byBackend');
  });
  it("s23f: decisionModels is optional in agent and project views", () => {
    const old = fixture("agent-settings.json") as Record<string, unknown>;
    expect(agentViewSchema.parse(old).decisionModels).toBeUndefined();
    const decisionModels = [{provider:"typesafe",displayName:"TypeSafe",models:[{id:"jev-latest",displayName:"Jev"}],keyId:"typesafe-api-key",keySet:false}];
    expect(agentViewSchema.parse({ ...old, decisionModels }).decisionModels).toEqual(decisionModels);
    expect(agentViewSchema.safeParse({ ...old, decisionModels: [{ ...decisionModels[0], keySet: "no" }] }).success).toBe(false);
    expect(agentViewSchema.parse({ ...old, decisionModels: [{ ...decisionModels[0], keyUnreadable: true }] }).decisionModels?.[0]?.keyUnreadable).toBe(true);
  });
  it("s23d: the judge section, smartPrompt and judgeByBackend are optional in views; default, llm and decision save", () => {
    const section = (value: unknown) => ({stored:value,effective:value,revision:"r1",access:{kind:"writable"},apply:[]});
    const old = fixture("agent-settings.json") as { sections: Record<string, unknown> };
    expect(agentViewSchema.parse(old).sections.judge).toBeUndefined();
    const llm = {kind:"llm",backend:"codex-appserver",model:"gpt-6-luna",effort:"low"};
    const jev = {kind:"decision",provider:"typesafe",model:"jev-latest"};
    const prompt = {source:"default",path:"/p",text:"t",formatLines:{main:"a",mentioned:"b",topic:"c"},inputExample:"x",maxLength:8000};
    const noMentioned = { ...prompt, formatLines: { main: 'a', topic: 'c' } };
    expect(agentViewSchema.parse({ ...old, smartPrompt: noMentioned }).smartPrompt?.formatLines).toEqual(noMentioned.formatLines);
    expect(agentViewSchema.parse({ ...old, smartPrompt: prompt }).smartPrompt?.formatLines.mentioned).toBe('b');
    const parsed = agentViewSchema.parse({ ...old, sections: { ...old.sections, judge: {...section({selection:{kind:"default"}}),effective:{selection:llm}} }, smartPrompt: prompt,
      judgeByBackend: {"codex-appserver":{model:"gpt-6-luna",effort:"low",source:"default"},"claude-agent":{model:"jev-latest",provider:"typesafe",source:"bot"}} });
    expect(parsed.sections.judge?.effective.selection).toEqual(llm);
    expect(parsed.judgeByBackend?.["claude-agent"]).toEqual({model:"jev-latest",provider:"typesafe",source:"bot"});
    expect(agentViewSchema.parse({ ...old, sections: { ...old.sections, judge: section({selection:jev}) } }).sections.judge?.stored.selection).toEqual(jev);
    // a kind from a newer daemon parses as sent; a known kind that is malformed does not
    const future = {kind:"oracle",provider:"x",model:"y",weights:[1,2]};
    expect(agentViewSchema.parse({ ...old, sections: { ...old.sections, judge: section({selection:future}) } }).sections.judge?.stored.selection).toEqual(future);
    // a client narrows with the guard first: `kind` alone leaves the fields unknown
    const read = (selection: JudgeSelectionView): string => !isKnownJudgeSelection(selection) ? `unknown ${selection.kind}`
      : selection.kind === "llm" ? `${selection.backend} ${selection.model}` : selection.kind === "decision" ? `${selection.provider} ${selection.model}` : "default";
    const pick = (selection: unknown) => agentViewSchema.parse({ ...old, sections: { ...old.sections, judge: section({selection}) } }).sections.judge!.stored.selection;
    expect([llm, jev, {kind:"default"}, future].map((selection) => read(pick(selection))))
      .toEqual(["codex-appserver gpt-6-luna", "typesafe jev-latest", "default", "unknown oracle"]);
    for (const bad of [{kind:"llm"}, {kind:"decision",model:"x"}, {kind:""}, {model:"x"}]) {
      expect(agentViewSchema.safeParse({ ...old, sections: { ...old.sections, judge: section({selection:bad}) } }).success).toBe(false);
    }
    const project = {scope:{kind:"project",botId:"cli_fixture",projectName:"fixture"},sections:{
      permission:section({mode:"qa",guestMode:"qa",network:false,custom:null,options:permissionOptions}),response:section({noMention:false}),model:section({selection:{kind:"default"}}),
    },identity:{chatId:"oc_fixture",backend:"codex-appserver",cwd:"/tmp",kind:"multi"},members:{openIds:[],revision:"r1"}};
    expect(projectViewSchema.parse(project).sections.judge).toBeUndefined();
    expect(projectViewSchema.parse({ ...project, sections: { ...project.sections, judge: section({selection:{kind:"default"}}) }, smartPrompt: { ...prompt, error: "SMART.md 是符号链接" } }).smartPrompt?.error).toBe("SMART.md 是符号链接");

    const save = (kind: string, patch: unknown) => requestSchema.safeParse({type:"request",id:"1",method:"settings",payload:{type:"save",edit:{
      scope: kind === "agent" ? {kind,botId:"cli_fixture"} : {kind,botId:"cli_fixture",projectName:"fixture"},section:"judge",revision:"r1",patch}}}).success;
    for (const kind of ["agent", "project"]) {
      expect(save(kind, {selection:{kind:"default"}})).toBe(true);
      expect(save(kind, {selection:{kind:"llm",model:"my-gw/qwen3-coder",custom:true}})).toBe(true);
      expect(save(kind, {selection:llm})).toBe(true);
      expect(save(kind, {selection:jev})).toBe(true);
      expect(save(kind, {selection:{...jev,backend:"codex-appserver"}})).toBe(false);
      expect(save(kind, {selection:future})).toBe(false);
      expect(save(kind, {selection:{kind:"llm",model:"m",extra:1}})).toBe(false);
    }
    const models = (purpose: string) => requestSchema.safeParse({type:"request",id:"1",method:"settings",payload:{type:"models",query:{botId:"cli_fixture",backend:"claude-agent",purpose}}}).success;
    expect(models("judge")).toBe(true);
    expect(models("decision")).toBe(false);
  });
  it("has one permission tier per group (s15c): no guestMode edit, no member in setPermission", () => {
    const scope = {kind:"project",botId:"cli_fixture",projectName:"fixture"};
    const save = (patch: unknown) => requestSchema.safeParse({type:"request",id:"1",method:"settings",payload:{type:"save",edit:{scope,section:"permission",revision:"r1",patch}}}).success;
    expect(save({mode:"full"})).toBe(true);
    expect(save({guestMode:"qa"})).toBe(false);
    expect(save({mode:"full",guestMode:"qa"})).toBe(false);
    expect(save({custom:{sandbox:"read-only",network:true}})).toBe(true);
    expect(save({custom:null})).toBe(true);
    expect(save({network:true})).toBe(false);
    expect(save({options:permissionOptions})).toBe(false);
    expect(save({custom:[]})).toBe(false);
    const membershipId = JSON.stringify(["cli_fixture","oc_fixture"]);
    expect(commandSchema.safeParse({type:"setPermission",membershipId,administrator:"full",network:false}).success).toBe(true);
    expect(commandSchema.safeParse({type:"setPermission",membershipId,administrator:"full",member:"qa",network:false}).success).toBe(false);
  });
  it("keeps guestMode in the group's view, output only, so a client from before s15c still parses it", () => {
    const section = (value: unknown) => ({stored:value,effective:value,revision:"r1",access:{kind:"writable"},apply:[]});
    const view = (permission: object) => ({scope:{kind:"project",botId:"cli_fixture",projectName:"fixture"},sections:{
      permission:section({custom:null,options:permissionOptions,...permission}),response:section({noMention:false}),model:section({selection:{kind:"default"}}),
    },identity:{chatId:"oc_fixture",backend:"codex-appserver",cwd:"/tmp",kind:"multi"},members:{openIds:[],revision:"r1"}});
    // The permission section as clients from before s15c (4e22f1b) parse it.
    const tier = z.enum(["qa","write","full"]);
    const before = z.object({mode:tier,guestMode:tier,network:z.boolean()});
    const parsed = projectViewSchema.parse(view({mode:"write",guestMode:"write",network:true}));
    expect(before.parse(parsed.sections.permission.stored)).toEqual({mode:"write",guestMode:"write",network:true});
    expect(before.parse(parsed.sections.permission.effective)).toEqual({mode:"write",guestMode:"write",network:true});
    expect(projectViewSchema.safeParse(view({mode:"write",network:true})).success).toBe(false);
    expect(settingsReplySchema.parse({kind:"view",view:view({mode:"qa",guestMode:"qa",network:false})})).toMatchObject({view:{sections:{permission:{stored:{guestMode:"qa"}}}}});
    expect(Object.keys(projectEditableSchemas.permission.shape)).toEqual(["mode","custom"]);
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

// cli-7-environment 审查 202: the request id is optional both ways, so an older client and an older reply still parse
it("takes an optional request id on the install starts and echoes it in their states, older shapes still parsing", () => {
  const requestId = randomUUID();
  const envelope = (payload: unknown) => requestSchema.safeParse({type:"request",id:"1",method:"environment",payload});
  for (const start of [{type:"install",tool:"codex"}, {type:"update",tool:"lark-cli"}, {type:"backendInstall",id:"claude-agent",update:false}]) {
    expect(envelope(start).success).toBe(true);
    expect(envelope({...start,requestId}).success).toBe(true);
    expect(envelope({...start,requestId:"not-a-uuid"}).success).toBe(false);
  }
  // only the starts carry one
  expect(envelope({type:"toolInstallStatus",requestId}).success).toBe(false);
  expect(envelope({type:"startLogin",tool:"lark-cli",requestId}).success).toBe(false);
  const running = {kind:"running",id:"op",tool:"codex",update:false,startedAt:1};
  const ended = {kind:"failed",id:"op",message:"x"};
  for (const operation of [running, ended]) {
    expect(environmentReplySchema.parse({kind:"toolInstall",operation})).toEqual({kind:"toolInstall",operation});
    expect(environmentReplySchema.parse({kind:"toolInstall",operation:{...operation,requestId}})).toEqual({kind:"toolInstall",operation:{...operation,requestId}});
  }
  const status = {operationId:randomUUID(),id:"claude-agent",update:false,state:"running",replay:[],omittedBytes:0};
  expect(environmentReplySchema.parse({kind:"backendInstallStatus",operation:status})).toEqual({kind:"backendInstallStatus",operation:status});
  expect(environmentReplySchema.parse({kind:"backendInstallStatus",operation:{...status,requestId}})).toEqual({kind:"backendInstallStatus",operation:{...status,requestId}});
  // a reply schema without the field (an older client's) drops it instead of failing
  const older = z.object({kind:z.literal("running"),id:z.string(),tool:z.string(),update:z.boolean(),startedAt:z.number()});
  expect(older.parse({...running,requestId})).toEqual(running);
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

it("points a judgement a decision model's key stopped at the key page, and a keystore it cannot read at the log (s23g2)", () => {
  const record = { at: 1, count: 1, groupId: "oc_fixture_group", place: "main" as const, reason: "judge-failed" as const };
  const next = (detail?: string) => NOT_REPLIED_TEXT["judge-failed"].next({ ...record, ...(detail ? { detail } : {}) });
  for (const detail of [KEY_FAILURE.missing("TypeSafe"), KEY_FAILURE.invalid("TypeSafe"), KEY_FAILURE.rejected("TypeSafe")]) {
    expect(keyFailureOf(detail)).toBe("key");
    expect(next(detail)).toBe("在密钥页填了就恢复；真人 @ 它的照旧会回。");
  }
  expect(keyFailureOf("密钥库读不了")).toBe("keystore");
  expect(next("密钥库读不了")).toBe("密钥库读得了就恢复，原因在下面 daemon 日志的 secrets.unreadable；真人 @ 它的照旧会回。");
  // any other failure, a model's words that merely mention a key included, keeps the old next step
  for (const detail of [undefined, "判断超时", "模型说：没填 key 的话", "decision timeout"]) {
    expect(keyFailureOf(detail)).toBeUndefined();
    expect(next(detail)).toBe("真人 @ 它的照旧会回；反复出现时看下面的日志。");
  }
});

it("says why a key cannot be saved in the daemon's words, never quoting it (s23g2)", () => {
  expect(keyProblem("")).toBe("没有读到 key");
  expect(keyProblem("x".repeat(4097))).toBe("key 太长了，最多 4096 个字符");
  expect(keyProblem("tsk test")).toBe("key 只能是一串可见的英文字符，不能有空格、换行或中文");
  expect(keyProblem("tsk-密钥")).toBe("key 只能是一串可见的英文字符，不能有空格、换行或中文");
  expect(keyProblem("x".repeat(4096))).toBeUndefined();
  expect(keyProblem("tsk-test-0000000000000000abcd")).toBeUndefined();
});

it("words a queued message a restart dropped, and lets one event count several messages (s18c)", () => {
  const record = { at: 1, groupId: "oc_fixture_group", place: "topic" as const, reason: "restarted" as const, ref: "abc123" };
  expect(NOT_REPLIED_TEXT.restarted.reason({ ...record, count: 1 })).toBe("重启或停止时这条还在排队，没处理");
  expect(NOT_REPLIED_TEXT.restarted.next({ ...record, count: 1 })).toBe("已在原处回了一句请重发。");
  expect(NOT_REPLIED_TEXT.restarted.next({ ...record, count: 1, detail: "HTTP 503" })).toBe("在原处回一句请重发没成功（HTTP 503），请告诉发消息的人重发。");
  expect(diagnosticsEventSchema.parse({ kind: "notReplied", record, times: 3 })).toEqual({ kind: "notReplied", record, times: 3 });
  expect(diagnosticsEventSchema.safeParse({ kind: "notReplied", record, times: 0 }).success).toBe(false);
  expect(diagnosticsEventSchema.safeParse({ kind: "notReplied", record, times: 10_001 }).success).toBe(false);
});

it("words another bot's @ that got no answer, saying Bot as the page does (s27a-0)", () => {
  const record = { at: 1, count: 1, groupId: "oc_fixture_group", place: "topic" as const, ref: "abc123" };
  for (const reason of ["bot-wake-cap", "bot-wake-failed", "bot-wake-not-allowed", "bot-wake-dropped"] as const) {
    expect(notRepliedSchema.parse({ ...record, reason }).reason).toBe(reason);
    const text = NOT_REPLIED_TEXT[reason];
    expect(`${text.reason({ ...record, reason })}${text.next({ ...record, reason })}`).not.toMatch(/bot/);
  }
  expect(NOT_REPLIED_TEXT["bot-wake-cap"].reason({ ...record, reason: "bot-wake-cap" })).toBe("自上一条真人消息起，Bot 之间已互相叫醒 6 次，到了上限，这条 Bot 的 @ 没回");
  expect(NOT_REPLIED_TEXT["bot-wake-failed"].reason({ ...record, reason: "bot-wake-failed", detail: "历史读不到" })).toBe("处理这条 Bot 的 @ 时出错（历史读不到），没回");
  expect(NOT_REPLIED_TEXT["bot-wake-failed"].reason({ ...record, reason: "bot-wake-failed" })).toBe("处理这条 Bot 的 @ 时出错，没回");
  expect(NOT_REPLIED_TEXT["bot-wake-dropped"].reason({ ...record, reason: "bot-wake-dropped", detail: "群正在改设置" })).toBe("这条 Bot 的 @ 没处理：群正在改设置");
  expect(NOT_REPLIED_TEXT["bot-wake-not-allowed"].reason({ ...record, reason: "bot-wake-not-allowed" })).toBe("这个群设了「响应成员」，这个 Bot 不在名单上，它的 @ 叫不醒");
  expect(NOT_REPLIED_TEXT["bot-wake-not-allowed"].next({ ...record, reason: "bot-wake-not-allowed" })).toBe("这是设置的效果。要让它能叫醒，把它加进「响应成员」，或者清空名单。");
});

it("validates daily judge usage requests and replies", () => {
  expect(adminRequestSchema.parse({ type: "judgeUsage" })).toEqual({ type: "judgeUsage" });
  expect(adminRequestSchema.safeParse({ type: "judgeUsage", x: 1 }).success).toBe(false);
  const reply = { kind: "judgeUsage", days: [{ date: "2026-10-19", total: 0, sources: [], bots: [] }], unreadBots: 0 };
  expect(adminReplySchema.parse(reply)).toEqual(reply);
  expect(adminReplySchema.safeParse({ ...reply, days: [{ ...reply.days[0], date: "2026-1-9" }] }).success).toBe(false);
});


it("words judging a bot mention without promising that every @ is answered (s27a)", () => {
  const record = { at: 1, count: 1, groupId: "oc_fixture", place: "topic" as const, ref: "abc123" };
  expect(NOT_REPLIED_TEXT["judge-skip"].next({ ...record, reason: "judge-skip" })).toBe("智能模式下这是正常的。总是漏回就改智能提示词。");
  expect(NOT_REPLIED_TEXT["judge-failed"].reason({ ...record, reason: "judge-failed", detail: "超时" })).toBe("判断没出结果（超时），这条没回");
  expect(NOT_REPLIED_TEXT["judge-budget"].reason({ ...record, reason: "judge-budget" })).toBe("这个群这一小时判断了 60 次，到了上限，这条没判断");
  expect(NOT_REPLIED_TEXT["judge-budget"].next({ ...record, reason: "judge-budget" })).toBe("一小时内会恢复；真人 @ 它的不算在这个数里，照常判断。");
  expect(NOT_REPLIED_TEXT["bot-wake-failed"].reason({ ...record, reason: "bot-wake-failed", detail: "boom" })).toBe("处理这条 Bot 的 @ 时出错（boom），没回");
  expect(NOT_REPLIED_TEXT["bot-wake-failed"].next({ ...record, reason: "bot-wake-failed" })).toBe("反复出现时看下面的日志。");
  expect(NOT_REPLIED_TEXT["bot-wake-dropped"].next({ ...record, reason: "bot-wake-dropped" })).toBe("不用处理。");
});

it("s36b: topic conversation copy has two choices in product order", () => {
  expect(Object.keys(topicConversationCopy)).toEqual(["threads", "smart"]);
  expect(topicConversationCopy.threads).toEqual({ name: "按话题聊", title: "按话题聊", subtitle: "一个话题一条会话，几件事各聊各的" });
  expect(topicConversationCopy.smart.subtitle).toBe("一个话题一条会话，不用 @ 我也会看情况接话");
});

it("s34b: validates strict single-subagent stop requests and optional context rows", () => {
  const request = { action: "stopSubagent", agentId: "cli_fixture", projectName: "demo", groupId: "oc_fixture", threadId: "thread", runId: "run", subagentId: "child" };
  expect(collaborationRequestSchema.parse(request)).toEqual(request);
  expect(collaborationRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false);
  const run = { id: "run", goal: false, canStop: true, canEndGoal: false, canRemind: true, reminderRequested: false };
  const reply = { kind: "context", threadId: "thread", usage: null, run };
  expect(collaborationReplySchema.parse(reply)).toEqual(reply);
  const rows = [{ id: "child", name: "worker", task: "count files", status: "running", stoppable: true }];
  const withRows = { ...reply, run: { ...run, subagents: rows } };
  expect(collaborationReplySchema.parse(withRows)).toEqual(withRows);
});

it("preserves optional pending group topic flags", () => {
  const group = { chatId: "oc_pending", name: "Pending", addedAt: 1 };
  expect(pendingGroupsSchema.parse({ groups: [group, { ...group, topic: true }, { ...group, topic: false }] }).groups).toEqual([group, { ...group, topic: true }, { ...group, topic: false }]);
  expect(pendingGroupsSchema.safeParse({ groups: [{ ...group, topic: "x" }] }).success).toBe(false);
});

// 0.9.0 Linux acceptance (task 287): a managed Codex or Claude Code is on no PATH, so a bare `codex` was not found
it("names what starts a managed copy where a step says to run Codex or Claude in a terminal", () => {
  const codex = "/srv/node/bin/node /srv/data/managed-tools/codex/releases/g/bin/codex";
  const claude = "/srv/data/managed-tools/claude/releases/g/bin/claude";
  const [codexStep, claudeStep] = toolSteps([
    { tool: "codex", installation: "installed", authentication: "signedOut", version: "0.166.0", command: codex },
    { tool: "claude", installation: "installed", authentication: "signedOut", version: "2.1.0", command: claude },
  ]).steps;
  expect(codexStep?.detail).toBe(`在终端运行 ${codex} 配置好（账号或自定义 API 都行），然后重新检测。`);
  expect(claudeStep?.detail).toBe(`在终端运行 ${claude} 配置好（账号或自定义 API 都行），然后点"检查配置"。`);
  expect(toolSteps([{ tool: "codex", installation: "installed", authentication: "signedOut", version: null }]).steps[0]?.detail).toBe("在终端运行 codex 配置好（账号或自定义 API 都行），然后重新检测。");
  const record = { at: 1, count: 1, groupId: "oc_fixture_group", place: "main" as const, reason: "signed-out" as const };
  expect(NOT_REPLIED_TEXT["signed-out"].next({ ...record, backend: "codex" }, undefined, codex)).toBe(`先把 Codex 配置好（账号或自定义 API 都行，用 Codex App 或 \`${codex}\` 命令行），再回到 Vonvon 检测。`);
  expect(NOT_REPLIED_TEXT["signed-out"].next({ ...record, backend: "claude" })).toBe("在终端运行 claude 配置好（账号或自定义 API 都行），再点「检查配置」。");
  // a daemon from before the field sends none; a client from before it drops it
  const state = { tool: "codex", installation: "managed", executable: "/x/codex", version: "1.0.0", managedVersion: "1.0.0", latestVersion: null, updateAvailable: null, canUninstall: true };
  expect(environmentToolStateSchema.parse({ ...state, command: codex }).command).toBe(codex);
  expect(environmentToolStateSchema.parse(state).command).toBeUndefined();
});

it("explains unbound reply throttling and both setup routes", () => {
  const record = notRepliedSchema.parse({ reason: "unbound", groupId: "oc_pending", place: "main", ref: "abc123", at: 1, count: 1 });
  expect(NOT_REPLIED_TEXT.unbound.reason(record)).toBe("这个群还没设置好，@ 它只回了一句提示（同一个群 10 分钟最多回一次）");
  expect(NOT_REPLIED_TEXT.unbound.next(record)).toBe("主人在私聊的设置卡上选会话方式、点绑定；或者在 Bot 页点「加入飞书群」设置这个群。");
});

// devices-ui-2 4.5 and 4.9 (main 必败): Windows has its platform name; the old Codex install and login jobs are gone.
describe("devices-ui-2 protocol", () => {
  it("parses a windows application and no longer knows the Codex jobs", async () => {
    const { commandSchema, desktopSnapshotSchema, jobSchema } = await import("../src/index.js");
    expect(desktopSnapshotSchema.shape.application.shape.platform.parse("windows")).toBe("windows");
    for (const type of ["installCodex", "startCodexLogin"]) expect(commandSchema.safeParse({ type }).success).toBe(false);
    expect(jobSchema.safeParse({ id: "job_1", type: "installCodex", phase: "running", message: "" }).success).toBe(false);
  });
});
