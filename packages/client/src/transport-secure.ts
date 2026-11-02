import { Buffer } from "node:buffer";
import type { WebSocket as NodeWebSocket } from "ws";
import {
  CLOSE_CODES, helloSchema, pairRequestSchema, pairResultSchema, PROTOCOL_VERSION, serverInfoSchema, type PairResult, type ServerInfo,
} from "@vonvon/protocol";
import { createInitiator, decodeFrame, encodeFrame, FRAME, type Channel, type FrameType, type StaticKey } from "@vonvon/protocol/secure-channel";
import { createClient, type ClientConnection, type VonvonClient } from "./client.js";

export { ConnectionError, RpcError, type VonvonClient } from "./client.js";
export type { PairResult, ServerInfo } from "@vonvon/protocol";
export { generateStaticKey, staticKeyFromBase64url, type StaticKey } from "@vonvon/protocol/secure-channel";

/** What the channel needs of a WebSocket that is already open: binary frames in and out (Node `ws` or WHATWG). */
export interface BinarySocket {
  send(bytes: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (bytes: Uint8Array) => void): void;
  onClose(listener: (code: number, reason: string) => void): void;
  onError(listener: (error: Error) => void): void;
  isOpen(): boolean;
}
const OPEN = 1;
export function nodeBinarySocket(ws: NodeWebSocket): BinarySocket {
  return {
    send: bytes => ws.send(bytes, { binary: true }),
    close(code, reason) {
      if (ws.readyState >= 2) return;
      ws.close(code, reason);
      // A peer that never answers the close frame would hold the socket for ws's 30 seconds.
      const timer = setTimeout(() => ws.terminate(), 1000);
      timer.unref();
      ws.once("close", () => clearTimeout(timer));
    },
    onMessage: listener => { ws.on("message", data => listener(Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data)); },
    onClose: listener => { ws.on("close", (code, reason) => listener(code, reason.toString("utf8"))); },
    onError: listener => { ws.on("error", listener); },
    isOpen: () => ws.readyState === OPEN,
  };
}
export function webBinarySocket(ws: WebSocket): BinarySocket {
  ws.binaryType = "arraybuffer";
  return {
    send: bytes => ws.send(bytes),
    close: (code, reason) => ws.close(code, reason),
    onMessage: listener => {
      ws.addEventListener("message", event => listener(typeof event.data === "string" ? new TextEncoder().encode(event.data) : new Uint8Array(event.data as ArrayBuffer)));
    },
    onClose: listener => { ws.addEventListener("close", event => listener(event.code, event.reason)); },
    onError: listener => { ws.addEventListener("error", () => listener(new Error("WebSocket error"))); },
    isOpen: () => ws.readyState === OPEN,
  };
}

export type SecureChannelErrorCode = "device_identity_changed" | "handshake_failed" | "unknown_client" | "client_revoked"
  | "pairing_failed" | "rate_limited" | "remote_disabled" | "protocol_mismatch" | "timeout" | "closed";
/** Where the connection was: the channel handshake, the pairing request, the hello, or open (devices-ui-1a 4.4: a pairing
 * cut off half way may have used the invite already). */
export type SecureChannelStage = "handshake" | "pairing" | "hello" | "open";
export class SecureChannelError extends Error {
  constructor(readonly code: SecureChannelErrorCode, readonly stage: SecureChannelStage, readonly closeCode?: number) {
    super(`secure connection ${code} (${stage}${closeCode === undefined ? "" : `, close ${closeCode}`})`);
    this.name = "SecureChannelError";
  }
}
const BY_CLOSE_CODE = new Map<number, SecureChannelErrorCode>([
  [CLOSE_CODES.unknown_client, "unknown_client"], [CLOSE_CODES.client_revoked, "client_revoked"], [CLOSE_CODES.pairing_failed, "pairing_failed"],
  [CLOSE_CODES.rate_limited, "rate_limited"], [CLOSE_CODES.remote_disabled, "remote_disabled"], [CLOSE_CODES.protocol_mismatch, "protocol_mismatch"],
]);
/** devices-2 4.2. Under IK a device whose key is not the link's cannot read message 1 and closes 4005 before answering:
 * that is the only way "this is not the device you paired" shows (devices 4.4). After message 2, 4005 is a plain failure. */
function closeCodeError(code: number, stage: SecureChannelStage, message2: boolean): SecureChannelError {
  const mapped = code === CLOSE_CODES.handshake_failed ? (message2 ? "handshake_failed" : "device_identity_changed") : BY_CLOSE_CODE.get(code) ?? "closed";
  return new SecureChannelError(mapped, stage, code);
}

export interface SecureConnectOptions {
  /** Open already; the caller built its url (`ws://ip:port/`) and closes it if this fails before the socket is used. */
  socket: BinarySocket;
  /** From the pairing link or the device list: `pk` is pinned, a device with another key is refused. */
  device: { id: string; pk: string };
  clientKey: StaticKey;
  clientKind: "desktop" | "cli";
  /** Only the first time: the invite from the link, redeemed inside the channel for this key. */
  pairing?: { inviteId: string; inviteSecret: string; clientName: string };
  /** ping: how often the client pings; pong: how long without a frame ends the connection; handshake: up to the server info. */
  timers?: { ping?: number; pong?: number; handshake?: number };
}
export interface SecureConnection {
  client: VonvonClient;
  serverInfo: ServerInfo;
  pairResult?: PairResult;
  /** Resolves once, when the connection ends: the server's close code mapped as during setup (4003 client_revoked, 4006
   * remote_disabled, 1001 closed), `timeout` when the keepalive gave up, `closed` when the caller closed it. */
  closed: Promise<SecureChannelError>;
  close(): void;
}

/** devices-2 4.2: the channel, then the pairing request when there is one, then the hello (never with a credential: the key
 * is the authorization), and the usual client on top. Every frame either way is encrypted; the client pings to keep it. */
export async function connectSecure(options: SecureConnectOptions): Promise<SecureConnection> {
  const { socket, pairing } = options;
  const ping = options.timers?.ping ?? 20_000;
  const pong = options.timers?.pong ?? 30_000;
  let initiator: ReturnType<typeof createInitiator>;
  let hello: unknown;
  let pairRequest: unknown;
  try {
    const pk = /^[A-Za-z0-9_-]{43}$/.test(options.device.pk) ? Buffer.from(options.device.pk, "base64url") : Buffer.alloc(0);
    if (pk.length !== 32) throw new Error("the device key must be 32 bytes, base64url");
    initiator = createInitiator(options.clientKey, pk);
    hello = helloSchema.parse({ type: "hello", protocolVersion: PROTOCOL_VERSION, clientKind: options.clientKind });
    if (pairing) pairRequest = pairRequestSchema.parse({ type: "pairRequest", ...pairing, clientKind: options.clientKind });
  } catch (error) {
    socket.close(1000, "invalid");
    throw error;
  }

  let stage: SecureChannelStage = "handshake";
  let message2 = false;
  let channel: Channel | undefined;
  let pairResult: PairResult | undefined;
  /** Set once the connection is over, by the close event or by this side deciding to end it. */
  let ended = false;
  let socketClosed = false;
  const closeWaiters = new Set<() => void>();
  const messageListeners = new Set<(data: string) => void>();
  const closeListeners = new Set<() => void>();
  const errorListeners = new Set<(error: Error) => void>();
  let resolveClosed: (error: SecureChannelError) => void = () => undefined;
  const closed = new Promise<SecureChannelError>(resolve => { resolveClosed = resolve; });
  let setup: { resolve(connection: SecureConnection): void; reject(error: Error): void } | undefined;
  let setupTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;

  const sendFrame = (type: FrameType, body?: Buffer): void => {
    if (!channel) throw new Error("no channel yet");
    socket.send(channel.encrypt(encodeFrame(type, body)));
  };
  const sendJson = (value: unknown): void => sendFrame(FRAME.json, Buffer.from(JSON.stringify(value), "utf8"));
  const stopTimers = (): void => { clearTimeout(setupTimer); clearInterval(pingTimer); clearTimeout(silenceTimer); };
  /** Why this side ended it, set before its close frame goes out: the close event then reports this, not the code. */
  let ending: SecureChannelError | undefined;
  /** The connection is over: once, whichever side ended it. During setup the caller gets the error; once open, `closed`
   * resolves with it and the client hears it as the cause of its ConnectionError. */
  const finish = (error: SecureChannelError): void => {
    if (ended) return;
    ended = true;
    stopTimers();
    if (setup) { const pending = setup; setup = undefined; pending.reject(error); return; }
    resolveClosed(error);
    for (const listener of errorListeners) listener(error);
    for (const listener of closeListeners) listener();
  };
  const end = (error: SecureChannelError, code: number, reason: string): void => {
    if (!ended) ending ??= error;
    try { socket.close(code, reason); } catch { /* already closing */ }
    finish(ending ?? error);
  };
  const armSilence = (): void => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => end(new SecureChannelError("timeout", "open"), 1001, "timeout"), pong);
    silenceTimer.unref?.();
  };

  const opened = (serverInfo: ServerInfo): void => {
    stage = "open";
    clearTimeout(setupTimer);
    const connection: ClientConnection = {
      isOpen: () => !ended && socket.isOpen(),
      onMessage: listener => { messageListeners.add(listener); },
      onClose: listener => { closeListeners.add(listener); },
      onError: listener => { errorListeners.add(listener); },
      send(data, callback) {
        try { if (ended) throw new Error("Daemon connection closed"); sendFrame(FRAME.json, Buffer.from(data, "utf8")); }
        catch (error) { callback(error instanceof Error ? error : new Error(String(error))); return; }
        callback();
      },
      close: () => {
        end(new SecureChannelError("closed", "open"), 1000, "");
        if (socketClosed) return Promise.resolve();
        return new Promise<void>(resolve => {
          const timer = setTimeout(() => { closeWaiters.delete(done); resolve(); }, 1000);
          timer.unref?.();
          const done = (): void => { clearTimeout(timer); resolve(); };
          closeWaiters.add(done);
        });
      },
    };
    const client = createClient(connection);
    pingTimer = setInterval(() => { try { sendFrame(FRAME.ping); } catch { /* the close reports it */ } }, ping);
    pingTimer.unref?.();
    armSilence();
    const pending = setup;
    setup = undefined;
    pending?.resolve({ client, serverInfo, ...(pairResult ? { pairResult } : {}), closed, close: () => { void client.close().catch(() => undefined); } });
  };

  const receive = (bytes: Uint8Array): void => {
    if (ended) return;
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!channel) {
      message2 = true;
      try { channel = initiator.finish(data).channel; }
      catch { end(new SecureChannelError("handshake_failed", "handshake"), 1008, "policy_violation"); return; }
      stage = pairing ? "pairing" : "hello";
      sendJson(pairing ? pairRequest : hello);
      return;
    }
    let frame: ReturnType<typeof decodeFrame>;
    try { frame = decodeFrame(channel.decrypt(data)); }
    catch { end(new SecureChannelError("closed", stage, 1008), 1008, "policy_violation"); return; }
    if (stage === "open") armSilence();
    if (frame.type === FRAME.ping) { sendFrame(FRAME.pong); return; }
    if (frame.type === FRAME.pong) return;
    const text = frame.body.toString("utf8");
    if (stage === "open") { for (const listener of messageListeners) listener(text); return; }
    let value: unknown;
    try { value = JSON.parse(text); } catch { value = undefined; }
    if (stage === "pairing") {
      const result = pairResultSchema.safeParse(value);
      if (!result.success) { end(new SecureChannelError("closed", "pairing", 1008), 1008, "policy_violation"); return; }
      pairResult = result.data;
      stage = "hello";
      sendJson(hello);
      return;
    }
    const info = serverInfoSchema.safeParse(value);
    if (!info.success) { end(new SecureChannelError("closed", "hello", 1008), 1008, "policy_violation"); return; }
    opened(info.data);
  };

  return new Promise<SecureConnection>((resolve, reject) => {
    setup = { resolve, reject };
    socket.onMessage(bytes => {
      try { receive(bytes); }
      catch {
        // A send that threw: the socket is going away, and its close event says how.
        if (!ended) end(new SecureChannelError("closed", stage), 1011, "error");
      }
    });
    socket.onClose(code => {
      socketClosed = true;
      for (const done of closeWaiters) done();
      closeWaiters.clear();
      finish(ending ?? closeCodeError(code, stage, message2));
    });
    socket.onError(() => {
      if (!ended && stage !== "open") end(new SecureChannelError("closed", stage), 1011, "socket_error");
    });
    if (!socket.isOpen()) {
      // Closing already (a device refusing at once, 4004 or 4006): its close event says why. Closed already: nothing will.
      setupTimer = setTimeout(() => finish(new SecureChannelError("closed", "handshake")), 1000);
      setupTimer.unref?.();
      return;
    }
    setupTimer = setTimeout(() => end(new SecureChannelError("timeout", stage), 1001, "timeout"), options.timers?.handshake ?? 5_000);
    setupTimer.unref?.();
    try { socket.send(initiator.message1()); }
    catch (error) { end(new SecureChannelError(error instanceof Error && error.name === "HandshakeError" ? "handshake_failed" : "closed", "handshake"), 1000, ""); }
  });
}
