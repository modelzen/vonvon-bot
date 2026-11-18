import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { commandSchema, agentViewSchema } from "../dist/index.js";

const agentId = "cli_fixture";
const groupId = "oc_fixture";
const jobId = "job_fixture";
const membershipId = "membership_fixture";
const folderToken = randomUUID();
const samples = [
  {type:"refresh"},
  {type:"listPendingGroups",agentId},
  {type:"registerAgent"},
  {type:"refreshAgentCredentials",agentId},
  {type:"restartHost"},
  {type:"listJoinedGroups",agentId},
  {type:"listGroupMembers",agentId,groupId},
  {type:"feishuRead",agentId,tool:"search",args:{}},
  {type:"bindGroup",agentId,groupId,projectName:"fixture",folder:{kind:"existing",folderToken},tool:"codex",conversation:"threads"},
  {type:"setResponse",membershipId,response:"mention"},
  {type:"setPermission",membershipId,administrator:"full",network:false},
  {type:"setAgentEnabled",agentId,enabled:true},
  {type:"setAgentBadgeNumber",agentId,badgeNumber:"0001234"},
  {type:"deleteAgent",agentId},
  {type:"cancelJob",jobId},
];
assert.deepEqual(new Set(samples.map(sample => sample.type)), new Set(commandSchema.options.map(option => option.shape.type.value)));
for (const sample of samples) commandSchema.parse(sample);
commandSchema.parse({type:"bindGroup",agentId,groupId,projectName:"fixture",folder:{kind:"default"},tool:"codex",conversation:"threads"});
for (const type of ["quit","hideWindow","setLoginItem","chooseFolder"]) {
  assert.equal(commandSchema.safeParse({type}).success,false);
}
const settings = JSON.parse(await readFile(new URL("../test/fixtures/agent-settings.json", import.meta.url),"utf8"));
for (let i=0;i<100;i++) agentViewSchema.parse(settings);
const started = performance.now();
for (let i=0;i<1000;i++) agentViewSchema.parse(settings);
const meanMs = (performance.now()-started)/1000;
console.log(JSON.stringify({commandVariants:samples.length,excluded:4,settingsParseMeanMs:meanMs}));
if (meanMs >= 2) process.exitCode = 1;
