import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { PROTOCOL_VERSION } from "@vonvon/protocol";
import { ConnectionError } from "../src/browser.js";
import { connectBrowser } from "../src/transport-browser.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0)) await close();
});
const info = { type: "serverInfo", machineId: randomUUID(), version: "1", protocolVersion: PROTOCOL_VERSION };
async function loopback(onRequest: (socket: ServerSocket) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  server.on("connection", socket => {
    socket.once("message", () => {
      socket.send(JSON.stringify(info));
      socket.on("message", () => onRequest(socket));
    });
  });
  const { client } = await connectBrowser({ url: `ws://127.0.0.1:${address.port}`, credential: "a".repeat(64) });
  return { client, server };
}

it("explicit close settles concurrent RPCs immediately and rejects future RPCs", async () => {
  const { client } = await loopback(() => {});
  const results = Promise.allSettled([client.admin({ type: "state" }), client.snapshot()]);
  const closing = client.close();
  expect(client.close()).toBe(closing);
  expect(await results).toEqual([
    { status: "rejected", reason: new Error("Daemon connection closed") },
    { status: "rejected", reason: new Error("Daemon connection closed") },
  ]);
  await expect(client.snapshot()).rejects.toThrow("Daemon connection closed");
  await closing;
});

it.each(["binary", "malformed text"])("fails pending RPCs and physically closes after %s frames", async kind => {
  const { client, server } = await loopback(socket => socket.send(kind === "binary" ? Buffer.from([0, 255]) : "not json"));
  const errors: string[] = [];
  client.onError(error => errors.push(error.message));
  await expect(client.snapshot()).rejects.toThrow("Invalid daemon frame");
  await client.close();
  await vi.waitFor(() => expect(server.clients.size).toBe(0));
  expect(errors).toEqual(["Invalid daemon frame"]);
  await expect(client.snapshot()).rejects.toThrow("Daemon connection closed");
});

class StuckSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;
  static latest: StuckSocket;
  readyState = 1;
  closeCalls = 0;
  handshake = JSON.stringify(info);
  constructor() {
    super();
    StuckSocket.latest = this;
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: this.handshake })));
  }
  send(): void {}
  close(): void { this.closeCalls++; this.readyState = 2; }
}

it("rejects an unobserved physical close while settling RPCs once and ignoring late frames", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", StuckSocket);
  const { client } = await connectBrowser({ url: "ws://127.0.0.1:1", credential: "a".repeat(64) });
  const errors: string[] = [];
  const logs: string[] = [];
  client.onError(error => errors.push(error.message));
  client.onLog(value => logs.push(value.lines));
  const pending = client.snapshot();
  const rejected = expect(pending).rejects.toThrow("Daemon connection closed");
  const closing = client.close();
  const timedOut = expect(closing).rejects.toThrow("physical closure was not observed");
  expect(client.close()).toBe(closing);
  await rejected;
  await vi.advanceTimersByTimeAsync(1000);
  await timedOut;
  const socket = StuckSocket.latest;
  expect(socket.readyState).toBe(2);
  expect(socket.closeCalls).toBe(1);
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "event", event: "log", payload: { lines: "late" } }) }));
  socket.dispatchEvent(new Event("close"));
  socket.dispatchEvent(new Event("error"));
  expect(logs).toEqual([]);
  expect(errors).toEqual([]);
  await expect(client.snapshot()).rejects.toThrow("Daemon connection closed");
});

it("retains automatic malformed-frame close timeout without an unhandled rejection", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", StuckSocket);
  const { client } = await connectBrowser({ url: "ws://127.0.0.1:1", credential: "a".repeat(64) });
  const pending = expect(client.snapshot()).rejects.toThrow("Invalid daemon frame");
  StuckSocket.latest.dispatchEvent(new MessageEvent("message", { data: new Blob(["bad"]) }));
  await pending;
  await vi.advanceTimersByTimeAsync(1000);
  const errors: Error[] = [];
  client.onError(error => errors.push(error));
  expect(errors.map(error => error.message)).toEqual(["Invalid daemon frame", "Daemon WebSocket close timed out; physical closure was not observed"]);
  for (const error of errors) {
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).toHaveProperty("message", error.message);
  }
});

// devices 4.5: the caller decides on a daemon of another protocol. main 必败: the transport threw and returned no server info.
it("returns the server info of a daemon of another protocol instead of refusing it", async () => {
  class OldDaemonSocket extends StuckSocket {
    override handshake = JSON.stringify({ ...info, protocolVersion: 1 });
  }
  vi.stubGlobal("WebSocket", OldDaemonSocket);
  const { serverInfo } = await connectBrowser({ url: "ws://127.0.0.1:1", credential: "a".repeat(64) });
  expect(serverInfo).toEqual({ ...info, protocolVersion: 1 });
  expect(StuckSocket.latest.closeCalls).toBe(0);
});

it("preserves handshake and cleanup errors when browser closure cannot be observed", async () => {
  vi.useFakeTimers();
  class BadHandshakeSocket extends StuckSocket {
    override handshake = "bad handshake";
  }
  vi.stubGlobal("WebSocket", BadHandshakeSocket);
  const connecting = connectBrowser({ url: "ws://127.0.0.1:1", credential: "a".repeat(64) });
  const rejected = expect(connecting).rejects.toMatchObject({
    name: "AggregateError",
    message: "Daemon connection failed and physical closure was not observed",
    errors: [expect.any(Error), expect.objectContaining({ message: "Daemon WebSocket close timed out; physical closure was not observed" })],
  });
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(StuckSocket.latest.closeCalls).toBe(1);
});
