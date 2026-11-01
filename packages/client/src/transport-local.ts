import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { helloSchema, PROTOCOL_VERSION, serverInfoSchema, type ServerInfo } from "@vonvon/protocol";
import { z } from "zod";
import { createClient, type ClientConnection, type VonvonClient } from "./client.js";

const run = promisify(execFile);
const statusSchema = z.object({
  running: z.literal(true), listen: z.string().regex(/^127\.0\.0\.1:\d{1,5}$/),
});

/** devices 4.1: the daemon's server info comes back too; a different protocol is the caller's to judge (devices 4.5). */
export async function connectLocal(options: { home: string; cliEntry: string }): Promise<{ client: VonvonClient; serverInfo: ServerInfo }> {
  const { stdout } = await run(process.execPath, [options.cliEntry, "daemon", "status", "--json"], {
    env: { ...process.env, VONVON_HOME: options.home }, timeout: 10_000,
  });
  const status = statusSchema.parse(JSON.parse(stdout));
  const credential = (await readFile(join(options.home, "local-credential"), "utf8")).trim();
  if (!/^[a-f0-9]{64}$/i.test(credential)) throw new Error("Invalid local daemon credential");
  const socket = new WebSocket(`ws://${status.listen}`, { perMessageDeflate: false });
  try {
    const serverInfo = await new Promise<ServerInfo>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Daemon handshake timed out")), 5_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      const closed = () => fail(new Error("Daemon closed during handshake"));
      socket.once("error", fail);
      socket.once("close", closed);
      socket.once("open", () => {
        socket.send(JSON.stringify(helloSchema.parse({type:"hello",protocolVersion:PROTOCOL_VERSION,clientKind:"cli",credential})));
      });
      socket.once("message", data => {
        try {
          const info = serverInfoSchema.parse(JSON.parse(data.toString()));
          clearTimeout(timer);
          socket.off("error", fail);
          socket.off("close", closed);
          resolve(info);
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    const connection: ClientConnection = {
      isOpen: () => socket.readyState === WebSocket.OPEN,
      onMessage: listener => { socket.on("message", data => listener(data.toString())); },
      onClose: listener => { socket.on("close", listener); },
      onError: listener => { socket.on("error", listener); },
      send: (data, callback) => socket.send(data, callback),
      close: async () => {
        if (socket.readyState === WebSocket.CLOSED) return;
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => socket.terminate(), 1000);
          timer.unref();
          socket.once("close", () => { clearTimeout(timer); resolve(); });
          socket.close();
        });
      },
    };
    return { client: createClient(connection), serverInfo };
  } catch (error) {
    socket.terminate();
    throw error;
  }
}
