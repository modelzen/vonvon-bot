import type WebSocket from "ws";
import {
  adminReplySchema, collaborationReplySchema, commandResultSchema,
  desktopSnapshotSchema, directoryReplySchema, environmentReplySchema,
  errorEnvelopeSchema, eventSchema, machineReplySchema, requestSchema,
  settingsReplySchema,
  type AdminReply, type AdminRequest, type BackendInstallEventPayload,
  type CollaborationReply, type CollaborationRequest, type Command,
  type CommandResult, type DesktopSnapshot, type DirectoryReply,
  type DirectoryRequest, type EnvironmentReply, type EnvironmentRequest,
  type LogEventPayload, type MachineReply, type MachineRequest,
  type SettingsReply, type SettingsRequest,
} from "@vonvon/protocol";
import type { z } from "zod";

export class RpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RpcError";
  }
}

export interface VonvonClient {
  snapshot(): Promise<DesktopSnapshot>;
  watchSnapshots(listener: (value: DesktopSnapshot) => void): () => void;
  run(command: Command): Promise<CommandResult>;
  settings(request: SettingsRequest): Promise<SettingsReply>;
  collaboration(request: CollaborationRequest): Promise<CollaborationReply>;
  environment(request: EnvironmentRequest): Promise<EnvironmentReply>;
  machine(request: MachineRequest): Promise<MachineReply>;
  admin(request: AdminRequest): Promise<AdminReply>;
  directory(request: DirectoryRequest): Promise<DirectoryReply>;
  onLog(listener: (payload: LogEventPayload) => void): () => void;
  onBackendInstall(listener: (payload: BackendInstallEventPayload) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

const replySchemas = {
  snapshot: desktopSnapshotSchema, command: commandResultSchema,
  settings: settingsReplySchema, collaboration: collaborationReplySchema,
  environment: environmentReplySchema, machine: machineReplySchema,
  admin: adminReplySchema, directory: directoryReplySchema,
} satisfies Record<z.infer<typeof requestSchema>["method"], z.ZodTypeAny>;
type Method = keyof typeof replySchemas;
type Payload<M extends Method> = Extract<z.input<typeof requestSchema>, { method: M }>["payload"];
type Pending = { method: Method; resolve: (value: unknown) => void; reject: (error: Error) => void };

export function createClient(socket: WebSocket): VonvonClient {
  const pending = new Map<string, Pending>();
  const snapshots = new Set<(value: DesktopSnapshot) => void>();
  const logs = new Set<(value: LogEventPayload) => void>();
  const installs = new Set<(value: BackendInstallEventPayload) => void>();
  const errors = new Set<(error: Error) => void>();
  const undeliveredErrors: Error[] = [];
  let closed = false;

  function retainError(error: unknown): void {
    undeliveredErrors.push(error instanceof Error ? error : new Error(String(error)));
    if (undeliveredErrors.length > 32) undeliveredErrors.shift();
  }
  function emitError(error: Error): void {
    if (errors.size === 0) {
      retainError(error);
      return;
    }
    for (const listener of errors) {
      try { listener(error); } catch (failure) { retainError(failure); }
    }
  }
  function deliver<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      try { listener(value); } catch (error) { emitError(error instanceof Error ? error : new Error(String(error))); }
    }
  }
  function failAll(error: Error): void {
    if (closed) return;
    closed = true;
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    emitError(error);
  }
  socket.on("message", data => {
    let frame: unknown;
    try { frame = JSON.parse(data.toString()); }
    catch { failAll(new Error("Invalid daemon frame")); socket.close(); return; }
    const event = eventSchema.safeParse(frame);
    if (event.success) {
      switch (event.data.event) {
        case "snapshot": deliver(snapshots, event.data.payload); break;
        case "log": deliver(logs, event.data.payload); break;
        case "backendInstall": deliver(installs, event.data.payload); break;
      }
      return;
    }
    if (!frame || typeof frame !== "object" || !("id" in frame) || typeof frame.id !== "string") {
      failAll(new Error("Invalid daemon frame")); socket.close(); return;
    }
    const call = pending.get(frame.id);
    if (!call) { failAll(new Error("Unexpected daemon response ID")); socket.close(); return; }
    pending.delete(frame.id);
    const remoteError = errorEnvelopeSchema.safeParse(frame);
    if (remoteError.success) { call.reject(new RpcError(remoteError.data.code, remoteError.data.message)); return; }
    if (!("type" in frame) || frame.type !== "response" || !("method" in frame) || frame.method !== call.method || !("payload" in frame)) {
      call.reject(new Error("Daemon response method or envelope mismatch")); return;
    }
    try { call.resolve(frame.payload); }
    catch (error) { call.reject(error instanceof Error ? error : new Error(String(error))); }
  });
  socket.on("close", () => failAll(new Error("Daemon connection closed")));
  socket.on("error", error => failAll(error));

  function send<M extends Method>(method: M, payload: Payload<M>): Promise<z.output<(typeof replySchemas)[M]>> {
    if (closed || socket.readyState !== socket.OPEN) return Promise.reject(new Error("Daemon connection closed"));
    const id = globalThis.crypto.randomUUID();
    const frame = requestSchema.parse({type:"request",id,method,payload});
    return new Promise<z.output<(typeof replySchemas)[M]>>((resolve, reject) => {
      pending.set(id, {method, resolve: value => resolve(replySchemas[method].parse(value)), reject});
      socket.send(JSON.stringify(frame), error => {
        if (error && pending.delete(id)) reject(error);
      });
    });
  }
  const snapshot = () => send("snapshot", {type:"get"});
  return {
    snapshot,
    watchSnapshots(listener) {
      let active = true;
      let revision = -1;
      const receive = (value: DesktopSnapshot) => {
        if (active && value.revision > revision) { revision = value.revision; listener(value); }
      };
      snapshots.add(receive);
      void snapshot().then(receive).catch(error => {
        if (active) emitError(error instanceof Error ? error : new Error(String(error)));
      });
      return () => { active = false; snapshots.delete(receive); };
    },
    run: command => send("command", command),
    settings: request => send("settings", request),
    collaboration: request => send("collaboration", request),
    environment: request => send("environment", request),
    machine: request => send("machine", request),
    admin: request => send("admin", request),
    directory: request => send("directory", request),
    onLog(listener) { logs.add(listener); return () => { logs.delete(listener); }; },
    onBackendInstall(listener) { installs.add(listener); return () => { installs.delete(listener); }; },
    onError(listener) {
      errors.add(listener);
      for (const error of undeliveredErrors.splice(0)) {
        try { listener(error); } catch (failure) { retainError(failure); }
      }
      return () => { errors.delete(listener); };
    },
    async close() {
      if (socket.readyState === socket.CLOSED) return;
      await new Promise<void>(resolve => {
        socket.once("close", () => resolve());
        socket.close();
        setTimeout(() => { socket.terminate(); resolve(); }, 1000).unref();
      });
    },
  };
}
