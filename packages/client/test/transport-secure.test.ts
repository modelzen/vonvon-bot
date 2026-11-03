import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { CLOSE_CODES, PROTOCOL_VERSION } from "@vonvon/protocol";
import {
  closeBody, createResponder, decodeFrame, encodeFrame, FRAME, generateStaticKey, HANDSHAKE_TIMEOUT_REASON, type Channel, type StaticKey,
} from "@vonvon/protocol/secure-channel";
import { ConnectionError } from "../src/client.js";
import { connectSecure, nodeBinarySocket, SecureChannelError, webBinarySocket, type BinarySocket, type SecureChannelErrorCode } from "../src/transport-secure.js";

// devices-2 第 5 节, in process: a pair of fake binary sockets, and a fake device built from the protocol's responder.
// main 必败: there was no secure transport.

/** One end of an in-memory socket pair; frames and the close arrive in order, a microtask later, as on a real socket. */
class End implements BinarySocket {
  other!: End;
  open = true;
  sent: Buffer[] = [];
  closedWith: { code: number; reason: string } | undefined;
  private messages: Array<(bytes: Uint8Array) => void> = [];
  private closes: Array<(code: number, reason: string) => void> = [];
  private data: Array<() => void> = [];
  /** Part of a message reaches the other end: bytes, but no whole frame yet. */
  trickle(): void { queueMicrotask(() => { for (const listener of this.other.data) listener(); }); }
  send(bytes: Uint8Array): void {
    if (!this.open) throw new Error("socket closed");
    const copy = Buffer.from(bytes);
    this.sent.push(copy);
    queueMicrotask(() => { for (const listener of this.other.messages) listener(copy); });
  }
  close(code = 1005, reason = ""): void {
    if (!this.open) return;
    this.open = false;
    this.other.open = false;
    this.closedWith = { code, reason };
    queueMicrotask(() => { for (const end of [this, this.other]) for (const listener of end.closes) listener(code, reason); });
  }
  onMessage(listener: (bytes: Uint8Array) => void): void { this.messages.push(listener); }
  onClose(listener: (code: number, reason: string) => void): void { this.closes.push(listener); }
  onError(): void { /* never errors */ }
  isOpen(): boolean { return this.open; }
  onData(listener: () => void): void { this.data.push(listener); }
}
const socketPair = (): [End, End] => {
  const client = new End();
  const device = new End();
  client.other = device;
  device.other = client;
  return [client, device];
};

/** The reason the daemon gives with a code, as `CLOSE_CODES` names it. */
const reasonOf = (code: number): string => Object.entries(CLOSE_CODES).find(([, value]) => value === code)?.[0] ?? "x";
interface DeviceScript {
  /** Close instead of answering message 1 (a device whose key is not the link's closes 4005 here), with the code's reason. */
  closeOnMessage1?: number;
  closeReason?: string;
  /** Never answer message 1. */
  ignoreMessage1?: boolean;
  /** Answer message 1 with a broken message 2. */
  badMessage2?: boolean;
  /** Close as soon as this JSON frame type arrives (pairRequest, hello) instead of answering it: said inside the channel
   * first, as the daemon does, unless `bare` (a close frame only, what anyone on the path could write). */
  closeOn?: { type: string; code: number; reason?: string; bare?: boolean };
  /** RPC requests after the hello. */
  request?(frame: { id: string; method: string; payload: unknown }, reply: (value: unknown) => void): void;
}
const serverInfo = { type: "serverInfo", machineId: randomUUID(), version: "0.9.0", protocolVersion: PROTOCOL_VERSION, deviceName: "服务器", platform: "linux", capabilities: ["device"], principal: "owner:paired" };
function fakeDevice(end: End, key: StaticKey, script: DeviceScript = {}) {
  const received: Array<Record<string, unknown>> = [];
  const controls: number[] = [];
  let channel: Channel | undefined;
  const state = { muted: false };
  const sendFrame = (type: number, body?: Buffer) => { if (channel && !state.muted) end.send(channel.encrypt(encodeFrame(type as 0, body))); };
  const reply = (value: unknown) => sendFrame(FRAME.json, Buffer.from(JSON.stringify(value)));
  const closeTold = (code: number, reason = reasonOf(code)) => { sendFrame(FRAME.close, closeBody(code, reason)); end.close(code, reason); };
  end.onMessage(bytes => {
    const data = Buffer.from(bytes);
    if (!channel) {
      if (script.closeOnMessage1 !== undefined) { end.close(script.closeOnMessage1, script.closeReason ?? reasonOf(script.closeOnMessage1)); return; }
      if (script.ignoreMessage1) return;
      const responder = createResponder(key);
      // As the daemon does: a message 1 it cannot read (sealed to another key) is closed 4005 before any answer.
      try { responder.readMessage1(data); } catch { end.close(4005, "handshake_failed"); return; }
      const answer = responder.message2();
      if (script.badMessage2) { answer.bytes[40] = (answer.bytes[40] ?? 0) ^ 1; end.send(answer.bytes); return; }
      channel = answer.channel;
      end.send(answer.bytes);
      return;
    }
    const frame = decodeFrame(channel.decrypt(data));
    if (frame.type !== FRAME.json) {
      controls.push(frame.type);
      if (frame.type === FRAME.ping) sendFrame(FRAME.pong);
      return;
    }
    const value = JSON.parse(frame.body.toString()) as Record<string, unknown>;
    received.push(value);
    if (script.closeOn && value.type === script.closeOn.type) {
      const { code, reason = reasonOf(code), bare } = script.closeOn;
      if (bare) end.close(code, reason); else closeTold(code, reason);
      return;
    }
    if (value.type === "pairRequest") reply({ type: "pairResult", clientId: "cl_0123456789abcdef", deviceName: "服务器" });
    else if (value.type === "hello") reply(serverInfo);
    else if (value.type === "request") script.request?.(value as { id: string; method: string; payload: unknown }, reply);
  });
  return { received, controls, reply, sendFrame, closeTold, state, get channel() { return channel; } };
}
const setup = (script?: DeviceScript, wrongKey = false) => {
  const [client, device] = socketPair();
  const deviceKey = generateStaticKey();
  const served = fakeDevice(device, wrongKey ? generateStaticKey().key : deviceKey.key, script);
  const options = { socket: client, device: { id: randomUUID(), pk: deviceKey.publicKeyBase64url }, clientKey: generateStaticKey().key, clientKind: "desktop" as const };
  return { client, device, served, options };
};
const failure = async (promise: Promise<unknown>): Promise<SecureChannelError> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(SecureChannelError);
  return error as SecureChannelError;
};

afterEach(() => { vi.useRealTimers(); });

describe("connectSecure", () => {
  it("pairs with the invite inside the channel, says hello without a credential and gets the v2 server info", async () => {
    const { served, options, client } = setup({ request: (frame, reply) => reply({ type: "response", id: frame.id, method: "admin", payload: { kind: "daemonStatus", status: { installed: false, running: true, selfHosted: true, version: "0.9.0", supported: true, startedAt: 1 } } }) });
    const connection = await connectSecure({ ...options, pairing: { inviteId: "inv_0123456789abcdef", inviteSecret: "s".repeat(43), clientName: "笔记本" } });
    expect(connection.pairResult?.clientId).toBe("cl_0123456789abcdef");
    expect(connection.serverInfo.principal).toBe("owner:paired");
    expect(served.received[0]).toEqual({ type: "pairRequest", inviteId: "inv_0123456789abcdef", inviteSecret: "s".repeat(43), clientName: "笔记本", clientKind: "desktop" });
    expect(served.received[1]).toEqual({ type: "hello", protocolVersion: PROTOCOL_VERSION, clientKind: "desktop" });
    expect(served.received[1]).not.toHaveProperty("credential");
    // Every frame after message 1 is a channel frame: nothing on the wire reads as JSON.
    for (const bytes of client.sent.slice(1)) expect(() => JSON.parse(bytes.toString())).toThrow();
    expect(await connection.client.admin({ type: "daemonStatus" })).toMatchObject({ kind: "daemonStatus", status: { running: true } });
    connection.close();
    expect(await connection.closed).toMatchObject({ code: "closed", stage: "open" });
  });

  it("connects a paired key without pairing", async () => {
    const { served, options } = setup();
    const connection = await connectSecure({ ...options, clientKind: "cli" });
    expect(connection.pairResult).toBeUndefined();
    expect(served.received).toEqual([{ type: "hello", protocolVersion: PROTOCOL_VERSION, clientKind: "cli" }]);
    connection.close();
  });

  it("reads a 4005 before message 2 as another device at that address, and a bad message 2 as a failed handshake", async () => {
    const changed = setup({ closeOnMessage1: 4005 });
    expect(await failure(connectSecure(changed.options))).toMatchObject({ code: "device_identity_changed", stage: "handshake", closeCode: 4005 });
    const broken = setup({ badMessage2: true });
    expect(await failure(connectSecure(broken.options))).toMatchObject({ code: "handshake_failed", stage: "handshake" });
    expect(broken.client.closedWith?.code).toBe(1008);
    // The address answers with another key: it cannot read message 1 and closes 4005, which is that same case.
    expect(await failure(connectSecure(setup({}, true).options))).toMatchObject({ code: "device_identity_changed", stage: "handshake", closeCode: 4005 });
    const silent = setup({ ignoreMessage1: true });
    expect(await failure(connectSecure({ ...silent.options, timers: { handshake: 50 } }))).toMatchObject({ code: "timeout", stage: "handshake" });
    expect(silent.client.closedWith?.code).toBe(1001);
  });

  it.each([
    [4002, "unknown_client", "hello"], [4003, "client_revoked", "hello"], [4004, "rate_limited", "hello"], [4006, "remote_disabled", "hello"],
    [4001, "protocol_mismatch", "hello"], [4007, "pairing_failed", "pairing"], [4005, "handshake_failed", "pairing"], [1001, "closed", "hello"], [4401, "closed", "hello"],
  ] as Array<[number, SecureChannelErrorCode, "hello" | "pairing"]>)("maps close %i, said inside the channel, to %s", async (code, expected, stage) => {
    const { options } = setup({ closeOn: { type: stage === "pairing" ? "pairRequest" : "hello", code } });
    const pairing = stage === "pairing" ? { pairing: { inviteId: "inv_0123456789abcdef", inviteSecret: "x", clientName: "n" } } : {};
    expect(await failure(connectSecure({ ...options, ...pairing }))).toMatchObject({ code: expected, stage, closeCode: code });
  });

  it("reads the device's hello timeout inside the channel as a timeout", async () => {
    const { options } = setup({ closeOn: { type: "hello", code: 4005, reason: HANDSHAKE_TIMEOUT_REASON } });
    expect(await failure(connectSecure(options))).toMatchObject({ code: "timeout", stage: "hello", closeCode: 4005 });
  });

  // 审查 D2-CRYPTO-1: a WebSocket close frame is not authenticated, so past message 2 a bare one is never a revocation.
  it.each([4002, 4003, 4006, 4007])("reads a bare close %i after message 2 as closed, which a caller retries", async code => {
    const { options } = setup({ closeOn: { type: "hello", code, bare: true } });
    expect(await failure(connectSecure(options))).toMatchObject({ code: "closed", stage: "hello", closeCode: code });
  });

  it("reads what a device can say before message 2: rate limited, turned off, another version, a late message 1", async () => {
    expect(await failure(connectSecure(setup({ closeOnMessage1: 4004 }).options))).toMatchObject({ code: "rate_limited", stage: "handshake" });
    expect(await failure(connectSecure(setup({ closeOnMessage1: 4006 }).options))).toMatchObject({ code: "remote_disabled", stage: "handshake" });
    expect(await failure(connectSecure(setup({ closeOnMessage1: 4001 }).options))).toMatchObject({ code: "protocol_mismatch", stage: "handshake", closeCode: 4001 });
    // 审查 R2: the device's 4005 for a message 1 that came late is no reason to think it is another device.
    expect(await failure(connectSecure(setup({ closeOnMessage1: 4005, closeReason: HANDSHAKE_TIMEOUT_REASON }).options))).toMatchObject({ code: "timeout", stage: "handshake", closeCode: 4005 });
    expect(await failure(connectSecure(setup({ closeOnMessage1: 4005, closeReason: "" }).options))).toMatchObject({ code: "handshake_failed", stage: "handshake", closeCode: 4005 });
    // A device never sends these before message 2: only someone on the path could.
    expect(await failure(connectSecure(setup({ closeOnMessage1: 4003 }).options))).toMatchObject({ code: "closed", stage: "handshake", closeCode: 4003 });
    expect(await failure(connectSecure(setup({ closeOnMessage1: 4002 }).options))).toMatchObject({ code: "closed", stage: "handshake", closeCode: 4002 });
  });

  it("refuses a malformed device key before sending anything", async () => {
    const { options, client } = setup();
    await expect(connectSecure({ ...options, device: { id: "d", pk: "short" } })).rejects.toThrow("32 bytes");
    expect(client.sent).toHaveLength(0);
  });
});

describe("an open connection", () => {
  it("resolves closed with the close the device said inside the channel, and fails the client with it as the cause", async () => {
    const { options, served } = setup();
    const connection = await connectSecure(options);
    const errors: Error[] = [];
    connection.client.onError(error => errors.push(error));
    served.closeTold(4003);
    expect(await connection.closed).toMatchObject({ code: "client_revoked", stage: "open", closeCode: 4003 });
    expect(errors[0]).toBeInstanceOf(ConnectionError);
    expect(errors[0]?.cause).toMatchObject({ code: "client_revoked" });
    await expect(connection.client.snapshot()).rejects.toThrow();
  });

  it("resolves closed with closed for a bare 4003: anyone on the path can write one", async () => {
    const { options, device } = setup();
    const connection = await connectSecure(options);
    device.close(4003, "client_revoked");
    expect(await connection.closed).toMatchObject({ code: "closed", stage: "open", closeCode: 4003 });
  });

  it("closes 1008 on a frame that does not decrypt", async () => {
    const { options, device, served, client } = setup();
    const connection = await connectSecure(options);
    const frame = served.channel?.encrypt(encodeFrame(FRAME.json, Buffer.from("{}")));
    if (!frame) throw new Error("no channel");
    frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 1;
    device.send(frame);
    expect(await connection.closed).toMatchObject({ code: "closed", closeCode: 1008 });
    expect(client.closedWith?.code).toBe(1008);
  });

  it("pings every 20 seconds, stays open while answered, and gives up after 30 seconds without a frame", async () => {
    vi.useFakeTimers();
    const { options, served, client } = setup();
    const connection = await connectSecure(options);
    let ended: SecureChannelError | undefined;
    void connection.closed.then(error => { ended = error; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(served.controls).toEqual([FRAME.ping]);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(served.controls).toEqual([FRAME.ping, FRAME.ping, FRAME.ping]);
    expect(ended).toBeUndefined();
    // The device stops answering: 30 seconds after its last frame the client ends it.
    served.state.muted = true;
    await vi.advanceTimersByTimeAsync(29_000);
    expect(ended).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ended).toMatchObject({ code: "timeout", stage: "open" });
    expect(client.closedWith?.code).toBe(1001);
  });

  // 0.9.0 Mac 验收 B-1: an 875 KB snapshot over a relay at 20 KB/s took longer than 30 seconds, so the client cut a live
  // connection, reconnected and asked again, for ever.
  it("stays open while a long message is still arriving, and gives up 30 seconds after its last bytes", async () => {
    vi.useFakeTimers();
    const { options, served, device } = setup();
    const connection = await connectSecure(options);
    let ended: SecureChannelError | undefined;
    void connection.closed.then(error => { ended = error; });
    served.state.muted = true;
    for (let second = 0; second < 90; second += 10) {
      device.trickle();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(ended).toBeUndefined();
    await vi.advanceTimersByTimeAsync(19_000);
    expect(ended).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ended).toMatchObject({ code: "timeout", stage: "open" });
  });

  it("answers a device ping with a pong", async () => {
    const { options, served } = setup();
    const connection = await connectSecure(options);
    served.sendFrame(FRAME.ping);
    await vi.waitFor(() => expect(served.controls).toContain(FRAME.pong));
    connection.close();
  });
});

describe("nodeBinarySocket", () => {
  it("tells the bytes of a message as they arrive", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    server.once("connection", socket => socket.once("message", () => socket.send(Buffer.alloc(64, 7))));
    const ws = new NodeWebSocket(`ws://127.0.0.1:${address.port}/`);
    try {
      await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
      const socket = nodeBinarySocket(ws);
      let bytes = 0;
      socket.onData?.(() => { bytes++; });
      const message = new Promise<Uint8Array>(resolve => socket.onMessage(resolve));
      socket.send(new Uint8Array([1]));
      expect((await message).byteLength).toBe(64);
      expect(bytes).toBeGreaterThan(0);
    } finally {
      ws.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

// 审查 R3: a WHATWG WebSocket throws for 1001, 1008 and 1011, which connectSecure closes with; the socket must close anyway.
describe.skipIf(typeof globalThis.WebSocket === "undefined")("webBinarySocket", () => {
  it("closes a WHATWG socket for a broken message 2, with 1000 for the 1008 a browser refuses", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const closedWith = new Promise<number>(resolve => server.once("connection", socket => {
      socket.once("message", () => socket.send(Buffer.alloc(48, 7)));
      socket.once("close", code => resolve(code));
    }));
    const ws = new globalThis.WebSocket(`ws://127.0.0.1:${address.port}/`);
    try {
      await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("no open"))); });
      expect(() => ws.close(1008, "x")).toThrow();
      const device = generateStaticKey();
      const pending = connectSecure({ socket: webBinarySocket(ws), device: { id: "d", pk: device.publicKeyBase64url }, clientKey: generateStaticKey().key, clientKind: "desktop" });
      expect(await failure(pending)).toMatchObject({ code: "handshake_failed", stage: "handshake" });
      expect(await closedWith).toBe(1000);
      await vi.waitFor(() => expect(ws.readyState).toBe(3));
    } finally {
      ws.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
