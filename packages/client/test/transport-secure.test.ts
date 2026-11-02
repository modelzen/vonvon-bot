import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@vonvon/protocol";
import { createResponder, decodeFrame, encodeFrame, FRAME, generateStaticKey, type Channel, type StaticKey } from "@vonvon/protocol/secure-channel";
import { ConnectionError } from "../src/client.js";
import { connectSecure, SecureChannelError, type BinarySocket, type SecureChannelErrorCode } from "../src/transport-secure.js";

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
}
const socketPair = (): [End, End] => {
  const client = new End();
  const device = new End();
  client.other = device;
  device.other = client;
  return [client, device];
};

interface DeviceScript {
  /** Close instead of answering message 1 (a device whose key is not the link's closes 4005 here). */
  closeOnMessage1?: number;
  /** Never answer message 1. */
  ignoreMessage1?: boolean;
  /** Answer message 1 with a broken message 2. */
  badMessage2?: boolean;
  /** Close as soon as this JSON frame type arrives (pairRequest, hello) instead of answering it. */
  closeOn?: { type: string; code: number };
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
  end.onMessage(bytes => {
    const data = Buffer.from(bytes);
    if (!channel) {
      if (script.closeOnMessage1 !== undefined) { end.close(script.closeOnMessage1, "x"); return; }
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
    if (script.closeOn && value.type === script.closeOn.type) { end.close(script.closeOn.code, "x"); return; }
    if (value.type === "pairRequest") reply({ type: "pairResult", clientId: "cl_0123456789abcdef", deviceName: "服务器" });
    else if (value.type === "hello") reply(serverInfo);
    else if (value.type === "request") script.request?.(value as { id: string; method: string; payload: unknown }, reply);
  });
  return { received, controls, reply, sendFrame, state, get channel() { return channel; } };
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
  ] as Array<[number, SecureChannelErrorCode, "hello" | "pairing"]>)("maps close %i to %s", async (code, expected, stage) => {
    const { options } = setup({ closeOn: { type: stage === "pairing" ? "pairRequest" : "hello", code } });
    const pairing = stage === "pairing" ? { pairing: { inviteId: "inv_0123456789abcdef", inviteSecret: "x", clientName: "n" } } : {};
    expect(await failure(connectSecure({ ...options, ...pairing }))).toMatchObject({ code: expected, stage, closeCode: code });
  });

  it("maps 4004 and 4006 before message 2 too", async () => {
    expect(await failure(connectSecure(setup({ closeOnMessage1: 4004 }).options))).toMatchObject({ code: "rate_limited", stage: "handshake" });
    expect(await failure(connectSecure(setup({ closeOnMessage1: 4006 }).options))).toMatchObject({ code: "remote_disabled", stage: "handshake" });
  });

  it("refuses a malformed device key before sending anything", async () => {
    const { options, client } = setup();
    await expect(connectSecure({ ...options, device: { id: "d", pk: "short" } })).rejects.toThrow("32 bytes");
    expect(client.sent).toHaveLength(0);
  });
});

describe("an open connection", () => {
  it("resolves closed with the code the device closed with, and fails the client with it as the cause", async () => {
    const { options, device } = setup();
    const connection = await connectSecure(options);
    const errors: Error[] = [];
    connection.client.onError(error => errors.push(error));
    device.close(4003, "client_revoked");
    expect(await connection.closed).toMatchObject({ code: "client_revoked", stage: "open", closeCode: 4003 });
    expect(errors[0]).toBeInstanceOf(ConnectionError);
    expect(errors[0]?.cause).toMatchObject({ code: "client_revoked" });
    await expect(connection.client.snapshot()).rejects.toThrow();
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

  it("answers a device ping with a pong", async () => {
    const { options, served } = setup();
    const connection = await connectSecure(options);
    served.sendFrame(FRAME.ping);
    await vi.waitFor(() => expect(served.controls).toContain(FRAME.pong));
    connection.close();
  });
});
