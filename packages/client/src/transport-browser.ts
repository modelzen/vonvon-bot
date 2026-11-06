import { helloSchema, PROTOCOL_VERSION, serverInfoSchema, type ServerInfo } from "@vonvon/protocol";
import { createClient, type ClientConnection, type VonvonClient } from "./client.js";

export interface BrowserConnectionOptions {
  url: string;
  credential: string;
  clientKind?: "web" | "desktop";
}

/** devices 4.1: the daemon's server info comes back too; a different protocol is the caller's to judge (devices 4.5). */
export async function connectBrowser(options: BrowserConnectionOptions): Promise<{ client: VonvonClient; serverInfo: ServerInfo }> {
  if (!/^[a-f0-9]{64}$/i.test(options.credential)) throw new Error("Invalid local daemon credential");
  const socket = new WebSocket(options.url);
  async function closeSocket(): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve, reject) => {
      function onClose(): void { clearTimeout(timer); resolve(); }
      const timer = setTimeout(() => {
        socket.removeEventListener("close", onClose);
        reject(new Error("Daemon WebSocket close timed out; physical closure was not observed"));
      }, 1000);
      socket.addEventListener("close", onClose, { once: true });
      try { socket.close(); }
      catch (error) {
        clearTimeout(timer);
        socket.removeEventListener("close", onClose);
        reject(error);
      }
    });
  }
  try {
    let serverInfo: ServerInfo | undefined;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Daemon handshake timed out")), 5_000);
      function finish(error?: Error): void {
        clearTimeout(timer);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("open", onOpen);
        if (error) reject(error); else resolve();
      }
      function onError(): void { finish(new Error("Daemon connection failed")); }
      function onClose(): void { finish(new Error("Daemon closed during handshake")); }
      function onMessage(event: MessageEvent): void {
        try {
          if (typeof event.data !== "string") throw new Error("Invalid daemon handshake frame");
          serverInfo = serverInfoSchema.parse(JSON.parse(event.data));
          finish();
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      }
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      socket.addEventListener("message", onMessage);
      function onOpen(): void {
        try {
          socket.send(JSON.stringify(helloSchema.parse({
            type: "hello", protocolVersion: PROTOCOL_VERSION,
            clientKind: options.clientKind ?? "web", credential: options.credential,
          })));
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      }
      socket.addEventListener("open", onOpen, { once: true });
    });
    const connection: ClientConnection = {
      isOpen: () => socket.readyState === WebSocket.OPEN,
      onMessage: listener => { socket.addEventListener("message", event => { listener(typeof event.data === "string" ? event.data : ""); }); },
      onClose: listener => { socket.addEventListener("close", listener); },
      onError: listener => { socket.addEventListener("error", () => listener(new Error("Daemon connection failed"))); },
      send: (data, callback) => { try { socket.send(data); callback(); } catch (error) { callback(error instanceof Error ? error : new Error(String(error))); } },
      close: closeSocket,
    };
    if (!serverInfo) throw new Error("Daemon handshake ended without server info");
    return { client: createClient(connection, serverInfo.capabilities), serverInfo };
  } catch (error) {
    try { await closeSocket(); }
    catch (failure) { throw new AggregateError([error, failure], "Daemon connection failed and physical closure was not observed"); }
    throw error;
  }
}
