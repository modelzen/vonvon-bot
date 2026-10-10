import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { helloSchema, PROTOCOL_VERSION, serverInfoSchema } from "@vonvon/protocol";
import { z } from "zod";
import { createClient, type VonvonClient } from "./client.js";

const run = promisify(execFile);
const statusSchema = z.object({
  running: z.literal(true), listen: z.string().regex(/^127\.0\.0\.1:\d{1,5}$/),
});

export async function connectLocal(options: { home: string; cliEntry: string }): Promise<VonvonClient> {
  const { stdout } = await run(process.execPath, [options.cliEntry, "daemon", "status", "--json"], {
    env: { ...process.env, VONVON_HOME: options.home }, timeout: 10_000,
  });
  const status = statusSchema.parse(JSON.parse(stdout));
  const credential = (await readFile(join(options.home, "local-credential"), "utf8")).trim();
  if (!/^[a-f0-9]{64}$/i.test(credential)) throw new Error("Invalid local daemon credential");
  const socket = new WebSocket(`ws://${status.listen}`, { perMessageDeflate: false });
  try {
    await new Promise<void>((resolve, reject) => {
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
          if (info.protocolVersion !== PROTOCOL_VERSION) throw new Error("Daemon protocol version mismatch");
          clearTimeout(timer);
          socket.off("error", fail);
          socket.off("close", closed);
          resolve();
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    return createClient(socket);
  } catch (error) {
    socket.terminate();
    throw error;
  }
}
