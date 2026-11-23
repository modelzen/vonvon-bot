import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, type AdminState } from "@vonvon/protocol";
import { connectLocal, RpcError } from "../src/index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture(onRequest: (socket: WebSocket, frame: {id:string;method:string;payload:unknown}) => void, capabilities: string[] = []) {
  const home = await mkdtemp(join(tmpdir(), "vonvon-client-"));
  const server = new WebSocketServer({host:"127.0.0.1",port:0,perMessageDeflate:false});
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback address");
  const cliEntry = join(home, "fake-cli.mjs");
  await writeFile(cliEntry, `process.stdout.write(JSON.stringify({running:true,listen:"127.0.0.1:${address.port}"}));`);
  await writeFile(join(home, "local-credential"), "a".repeat(64));
  server.on("connection", socket => {
    let authenticated = false;
    socket.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      if (!authenticated) {
        expect(frame).toEqual({type:"hello",protocolVersion:PROTOCOL_VERSION,clientKind:"cli",credential:"a".repeat(64)});
        authenticated = true;
        socket.send(JSON.stringify({type:"serverInfo",machineId:randomUUID(),version:"1",protocolVersion:PROTOCOL_VERSION, capabilities}));
        return;
      }
      onRequest(socket, frame);
    });
  });
  cleanup.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home,{recursive:true,force:true}); });
  return {home,cliEntry};
}

const state: AdminState = {version:"1",generatedAt:1,bots:[]};
const snapshot = (revision:number) => ({revision,observedAt:1,stale:false,host:{kind:"starting"},agents:[],groups:[],memberships:[],tools:[],jobs:[],diagnostics:[],application:{platform:"macos",version:"1",loginItem:false,dataPath:"/tmp"}});

it("discovers the daemon, authenticates, and correlates concurrent group replies", async () => {
  const requests: Array<{socket:WebSocket;id:string;method:string}> = [];
  const options = await fixture((socket, frame) => {
    requests.push({socket,id:frame.id,method:frame.method});
    if (requests.length === 2) {
      const [first, second] = requests;
      if (!first || !second) throw new Error("Missing request");
      second.socket.send(JSON.stringify({type:"response",id:second.id,method:second.method,payload:{kind:"entries",path:"/tmp",parent:null,entries:[],truncated:false}}));
      first.socket.send(JSON.stringify({type:"response",id:first.id,method:first.method,payload:{kind:"state",state}}));
    }
  });
  const { client } = await connectLocal(options);
  const [admin, directory] = await Promise.all([client.admin({type:"state"}),client.directory({type:"list"})]);
  expect(admin).toEqual({kind:"state",state});
  expect(directory.kind).toBe("entries");
  await client.close();
});

// main 必败: the discovery child had no marker, and `daemon status` asks a running daemon through this function (cli-8-machine)
it("tells the discovery child to answer from the files", async () => {
  const options = await fixture(() => {});
  await writeFile(options.cliEntry, `if (process.env.VONVON_STATUS_FROM_FILES !== "1") process.exit(9);\n${await readFile(options.cliEntry, "utf8")}`);
  const { client } = await connectLocal(options);
  await client.close();
});

it("rejects a mismatched method and exposes remote errors", async () => {
  let count = 0;
  const options = await fixture((socket, frame) => {
    count++;
    if (count === 1) socket.send(JSON.stringify({type:"response",id:frame.id,method:"directory",payload:{kind:"state",state}}));
    else socket.send(JSON.stringify({type:"error",id:frame.id,code:"outside_home",message:"outside"}));
  });
  const { client } = await connectLocal(options);
  await expect(client.admin({type:"state"})).rejects.toThrow("method or envelope mismatch");
  await expect(client.directory({type:"list",path:"/elsewhere"})).rejects.toMatchObject({code:"outside_home"} satisfies Partial<RpcError>);
  await client.close();
});

it("sends schedule as { botId, request } and parses the tasks reply", async () => {
  const frames: unknown[] = [];
  const reply = {kind:"tasks",tasks:[],now:1,timeZone:"Asia/Tokyo"};
  const options = await fixture((socket, frame) => {
    frames.push(frame);
    socket.send(JSON.stringify({type:"response",id:frame.id,method:"schedule",payload:reply}));
  });
  const { client } = await connectLocal(options);
  const request = {action:"list",chatId:"oc_pay"} as const;
  expect(await client.schedule("cli_a", request)).toEqual(reply);
  expect(frames).toEqual([{type:"request",id:expect.any(String),method:"schedule",payload:{botId:"cli_a",request}}]);
  await client.close();
});

it("seeds snapshot watching without regressing after an earlier event", async () => {
  const options = await fixture((socket, frame) => {
    if (frame.method !== "snapshot") throw new Error("Unexpected method");
    socket.send(JSON.stringify({type:"event",event:"snapshot",payload:snapshot(2)}));
    socket.send(JSON.stringify({type:"response",id:frame.id,method:"snapshot",payload:snapshot(1)}));
  });
  const { client } = await connectLocal(options);
  const seen: number[] = [];
  const done = new Promise<void>(resolve => {
    client.watchSnapshots(value => { seen.push(value.revision); resolve(); });
  });
  await done;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(seen).toEqual([2]);
  await client.close();
});

it("delivers log and backend events and rejects an invalid reply payload", async () => {
  const operationId = randomUUID();
  const options = await fixture((socket, frame) => {
    socket.send(JSON.stringify({type:"event",event:"log",payload:{lines:"hello\n"}}));
    socket.send(JSON.stringify({type:"event",event:"backendInstall",payload:{operationId,id:"codex",update:false,item:{type:"log",chunk:"downloading"}}}));
    socket.send(JSON.stringify({type:"event",event:"device",payload:{change:"client-paired",clientId:"cl_0123456789abcdef",name:"笔记本",clientKind:"desktop"}}));
    socket.send(JSON.stringify({type:"event",event:"desktopUpdateRequest",payload:{requestId:"dur_0123456789abcdef",action:"apply",by:"「笔记本」"}}));
    socket.send(JSON.stringify({type:"response",id:frame.id,method:frame.method,payload:{kind:"state",state:{version:"bad"}}}));
  });
  const { client } = await connectLocal(options);
  const lines: string[] = [];
  const chunks: string[] = [];
  client.onLog(value => lines.push(value.lines));
  client.onBackendInstall(value => { if (value.item.type === "log") chunks.push(value.item.chunk); });
  const paired: string[] = [];
  client.onDevice(value => paired.push(`${value.change}:${value.name}`));
  // devices-ui-4: the daemon the desktop app carries asks the app to update
  const updates: string[] = [];
  client.onDesktopUpdateRequest(value => updates.push(`${value.action}:${value.by}`));
  await expect(client.admin({type:"state"})).rejects.toThrow();
  expect(lines).toEqual(["hello\n"]);
  expect(chunks).toEqual(["downloading"]);
  expect(paired).toEqual(["client-paired:笔记本"]);
  expect(updates).toEqual(["apply:「笔记本」"]);
  await client.close();
});

it("keeps observer failures inspectable while allowing RPC to complete", async () => {
  const options = await fixture((socket, frame) => {
    socket.send(JSON.stringify({type:"event",event:"log",payload:{lines:"hello\n"}}));
    socket.send(JSON.stringify({type:"response",id:frame.id,method:frame.method,payload:{kind:"state",state}}));
  });
  const { client } = await connectLocal(options);
  client.onLog(() => { throw new Error("log observer failed"); });
  const stop = client.onError(() => { throw new Error("error observer failed"); });
  expect(await client.admin({type:"state"})).toEqual({kind:"state",state});
  stop();
  const failures: string[] = [];
  client.onError(error => failures.push(error.message));
  expect(failures).toEqual(["error observer failed"]);
  await client.close();
});

it.each([{capabilities: []}, {capabilities: ["attention.group"]}])("connects through the browser WebSocket API and negotiates supported snapshot fields ($capabilities)", async ({capabilities}) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback address");
  const credential = "b".repeat(64);
  server.on("connection", socket => {
    let authenticated = false;
    socket.on("message", data => {
      const frame = JSON.parse(data.toString());
      if (!authenticated) {
        expect(frame).toEqual({ type: "hello", protocolVersion: PROTOCOL_VERSION, clientKind: "web", credential });
        authenticated = true;
        socket.send(JSON.stringify({ type: "serverInfo", machineId: randomUUID(), version: "1", protocolVersion: PROTOCOL_VERSION, capabilities }));
        return;
      }
      if (frame.method === "snapshot") {
        expect(frame.payload).toEqual({type: "get", ...(capabilities.length ? {groupAttention: true} : {})});
        socket.send(JSON.stringify({type: "response", id: frame.id, method: "snapshot", payload: snapshot(1)}));
      }
      if (frame.method === "admin") socket.send(JSON.stringify({ type: "response", id: frame.id, method: "admin", payload: { kind: "state", state } }));
    });
  });
  cleanup.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const { connectBrowser } = await import("../src/browser.js");
  const { client, serverInfo } = await connectBrowser({ url: `ws://127.0.0.1:${address.port}`, credential });
  expect(serverInfo).toMatchObject({ type: "serverInfo", protocolVersion: PROTOCOL_VERSION });
  await client.snapshot();
  expect(await client.admin({ type: "state" })).toEqual({ kind: "state", state });
  await client.close();
});

it.each([{capabilities: []}, {capabilities: ['attention.group']}])('requests group attention only when the loopback daemon advertised it ($capabilities)', async ({capabilities}) => {
  const requests: unknown[] = [];
  const options = await fixture((socket, frame) => {
    requests.push(frame.payload);
    socket.send(JSON.stringify({type: 'response', id: frame.id, method: 'snapshot', payload: snapshot(1)}));
  }, capabilities);
  const {client} = await connectLocal(options);
  await client.snapshot();
  expect(requests).toEqual([{type: 'get', ...(capabilities.length ? {groupAttention: true} : {})}]);
  await client.close();
});

it('delivers the negotiated attention model even when an initial legacy event has the same revision', async () => {
  const options = await fixture((socket, frame) => {
    socket.send(JSON.stringify({type: 'event', event: 'snapshot', payload: snapshot(1)}));
    socket.send(JSON.stringify({type: 'response', id: frame.id, method: 'snapshot', payload: {...snapshot(1), attentionModel: 'group'}}));
  }, ['attention.group']);
  const {client} = await connectLocal(options);
  const seen: Array<string | undefined> = [];
  const stop = client.watchSnapshots(value => seen.push(value.attentionModel));
  await expect.poll(() => seen.at(-1)).toBe('group');
  expect(seen).toEqual([undefined, 'group']);
  stop(); await client.close();
});

it.each([
  {preview:false,resource:false},{preview:true,resource:false},{preview:false,resource:true},{preview:true,resource:true},{preview:true,resource:true,scopeEdit:true},
])('sends creator preview and resource fields independently after the hello ($preview/$resource)',async ({preview,resource,scopeEdit})=>{
  const session=randomUUID(),binding=randomUUID(),scope='f'.repeat(64);
  const input={type:'creatorOpen' as const,botId:'cli_creator',accountId:randomUUID(),binding,scope,wakeId:null};
  const payloads:unknown[]=[];
  const options=await fixture((socket,frame)=>{
    payloads.push(frame.payload);
    socket.send(JSON.stringify({type:'response',id:frame.id,method:'recipeAuthoring',payload:{kind:'creatorSession',session,binding,scope,leaseMs:45000}}));
  },[...preview?['recipe.native-preview']:[],...resource?['recipe.resource-context.v2']:[],...scopeEdit?['recipe.draft-scope.v1']:[]]);
  const {client}=await connectLocal(options);
  const {recipeAuthoringRequestSchema}=await import('@vonvon/protocol');
  await client.recipeAuthoring!(recipeAuthoringRequestSchema.parse({...input,nativePreview:true,resourceContext:true,draftScope:true}));
  expect(client.supportsResourceContext).toBe(resource);
  if(!resource)await expect(client.recipeAuthoring!(recipeAuthoringRequestSchema.parse({type:'resourceHandoff',botId:input.botId,session,requestId:randomUUID(),
    target:{recipeId:randomUUID(),versionId:randomUUID()}}))).rejects.toThrow('不支持');
  expect(payloads).toEqual([{...input,...preview&&{nativePreview:true},...resource&&{resourceContext:true},...scopeEdit&&{draftScope:true}}]);
  await client.close();
});
