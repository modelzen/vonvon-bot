import {
  adminReplySchema, collaborationReplySchema, commandResultSchema,
  desktopSnapshotSchema, directoryReplySchema, environmentReplySchema, memoryReplySchema, contextPreviewReplySchema,
  errorEnvelopeSchema, eventSchema, machineReplySchema, requestSchema,
  libraryReplySchema, scheduleReplySchema, settingsReplySchema, deviceReplySchema, recipeInstallReplySchema,
  recipeAuthoringReplySchema, type RecipeAuthoringRequest, type RecipeAuthoringReply,
  type RecipeInstallRequest, type RecipeInstallReply,
  type AdminReply, type DeviceReply, type DeviceRequest, type AdminRequest, type BackendInstallEventPayload,
  type CollaborationReply, type CollaborationRequest, type Command,
  type CommandResult, type DesktopSnapshot, type DirectoryReply,
  type DirectoryRequest, type EnvironmentReply, type EnvironmentRequest, type MemoryReply, type MemoryRequest, type ContextPreviewReply, type ContextPreviewRequest,
  type LibraryReply, type LibraryRequest, type LogEventPayload, type MachineReply, type MachineRequest, type DeviceEventPayload,
  type ScheduleReply, type ScheduleRequest, type SettingsReply, type SettingsRequest, type DesktopUpdateRequestPayload,
} from "@vonvon/protocol";
import type { z } from "zod";

export class RpcError extends Error {
  /** `details`: what the daemon added for a program to read (both versions of a `protocol_mismatch`). */
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "RpcError";
  }
}

export class ConnectionError extends Error {
  /** When the daemon closed the socket during the handshake: its close code and reason (devices 4.7), e.g. 4401 `invalid_session_token`. */
  readonly closeCode?: number;
  readonly closeReason?: string;
  constructor(cause: unknown, closed?: { code: number; reason: string }) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ConnectionError";
    if (closed) { this.closeCode = closed.code; this.closeReason = closed.reason; }
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
  library(request: LibraryRequest): Promise<LibraryReply>;
  memory(request: MemoryRequest): Promise<MemoryReply>;
  contextPreview(request: ContextPreviewRequest): Promise<ContextPreviewReply>;
  schedule(botId: string, request: ScheduleRequest): Promise<ScheduleReply>;
  device(request: DeviceRequest): Promise<DeviceReply>;
  recipeAuthoring?(request: RecipeAuthoringRequest): Promise<RecipeAuthoringReply>;
  recipeInstall?(request: RecipeInstallRequest): Promise<RecipeInstallReply>;
  onLog(listener: (payload: LogEventPayload) => void): () => void;
  onBackendInstall(listener: (payload: BackendInstallEventPayload) => void): () => void;
  /** A client paired with or revoked from this device (devices 4.3); only the owner's connections hear it. */
  onDevice(listener: (payload: DeviceEventPayload) => void): () => void;
  /** U4: the daemon asks this computer's desktop shell to check for or run the app's update. Only a connection that
   * declared `desktop.self-update` hears it. */
  onDesktopUpdateRequest(listener: (payload: DesktopUpdateRequestPayload) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

const replySchemas = {
  snapshot: desktopSnapshotSchema, command: commandResultSchema,
  settings: settingsReplySchema, collaboration: collaborationReplySchema,
  environment: environmentReplySchema, machine: machineReplySchema,
  admin: adminReplySchema, directory: directoryReplySchema, memory: memoryReplySchema,
  library: libraryReplySchema, contextPreview: contextPreviewReplySchema, schedule: scheduleReplySchema, device: deviceReplySchema, recipeInstall: recipeInstallReplySchema, recipeAuthoring: recipeAuthoringReplySchema,
} satisfies Record<z.infer<typeof requestSchema>["method"], z.ZodTypeAny>;
type Method = keyof typeof replySchemas;
type Payload<M extends Method> = Extract<z.input<typeof requestSchema>, { method: M }>["payload"];
type Pending = { method: Method; resolve: (value: unknown) => void; reject: (error: Error) => void };

export interface ClientConnection {
  isOpen(): boolean;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
  send(data: string, callback: (error?: Error) => void): void;
  close(): Promise<void>;
  /** What the transport puts back into each parsed frame before anything reads it (the secure channel's avatars). */
  restore?(frame: unknown): void;
}

export function createClient(socket: ClientConnection, capabilities: readonly string[] = []): VonvonClient {
  const pending = new Map<string, Pending>();
  const snapshots = new Set<(value: DesktopSnapshot) => void>();
  const logs = new Set<(value: LogEventPayload) => void>();
  const installs = new Set<(value: BackendInstallEventPayload) => void>();
  const devices = new Set<(value: DeviceEventPayload) => void>();
  const updateRequests = new Set<(value: DesktopUpdateRequestPayload) => void>();
  const errors = new Set<(error: Error) => void>();
  const undeliveredErrors: Error[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;

  function observerError(error: unknown): Error {
    if (error instanceof ConnectionError) return new Error(error.message, { cause: error });
    return error instanceof Error ? error : new Error(String(error));
  }
  function retainError(error: Error): void {
    undeliveredErrors.push(error);
    if (undeliveredErrors.length > 32) undeliveredErrors.shift();
  }
  function emitError(error: Error): void {
    if (errors.size === 0) {
      retainError(error);
      return;
    }
    for (const listener of errors) {
      try { listener(error); } catch (failure) { retainError(observerError(failure)); }
    }
  }
  function deliver<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      try { listener(value); } catch (error) { emitError(observerError(error)); }
    }
  }
  function settlePending(error: Error): boolean {
    if (closed) return false;
    closed = true;
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    return true;
  }
  function close(): Promise<void> {
    settlePending(new Error("Daemon connection closed"));
    closing ??= Promise.resolve().then(() => socket.close());
    return closing;
  }
  function failAll(cause: Error): void {
    const error = new ConnectionError(cause);
    if (!settlePending(error)) return;
    void close().catch(failure => emitError(new ConnectionError(failure)));
    emitError(error);
  }
  socket.onMessage(data => {
    if (closed) return;
    let frame: unknown;
    try { frame = JSON.parse(data); }
    catch { failAll(new Error("Invalid daemon frame")); return; }
    socket.restore?.(frame);
    const event = eventSchema.safeParse(frame);
    if (event.success) {
      switch (event.data.event) {
        case "snapshot": deliver(snapshots, event.data.payload); break;
        case "log": deliver(logs, event.data.payload); break;
        case "backendInstall": deliver(installs, event.data.payload); break;
        case "device": deliver(devices, event.data.payload); break;
        case "desktopUpdateRequest": deliver(updateRequests, event.data.payload); break;
      }
      return;
    }
    if (!frame || typeof frame !== "object" || !("id" in frame) || typeof frame.id !== "string") {
      failAll(new Error("Invalid daemon frame")); return;
    }
    const call = pending.get(frame.id);
    if (!call) { failAll(new Error("Unexpected daemon response ID")); return; }
    pending.delete(frame.id);
    const remoteError = errorEnvelopeSchema.safeParse(frame);
    if (remoteError.success) { call.reject(new RpcError(remoteError.data.code, remoteError.data.message, remoteError.data.details)); return; }
    if (!("type" in frame) || frame.type !== "response" || !("method" in frame) || frame.method !== call.method || !("payload" in frame)) {
      call.reject(new Error("Daemon response method or envelope mismatch")); return;
    }
    try { call.resolve(frame.payload); }
    catch (error) { call.reject(error instanceof Error ? error : new Error(String(error))); }
  });
  socket.onClose(() => failAll(new Error("Daemon connection closed")));
  socket.onError(error => failAll(error));

  function send<M extends Method>(method: M, payload: Payload<M>): Promise<z.output<(typeof replySchemas)[M]>> {
    if (closed || !socket.isOpen()) return Promise.reject(new Error("Daemon connection closed"));
    const id = globalThis.crypto.randomUUID();
    const frame = requestSchema.parse({type:"request",id,method,payload});
    return new Promise<z.output<(typeof replySchemas)[M]>>((resolve, reject) => {
      pending.set(id, {method, resolve: value => resolve(replySchemas[method].parse(value)), reject});
      socket.send(JSON.stringify(frame), error => {
        if (error && pending.delete(id)) reject(error);
      });
    });
  }
  const snapshot = () => send("snapshot", {type:"get", ...(capabilities.includes("attention.group") ? {groupAttention: true as const} : {})});
  return {
    snapshot,
    watchSnapshots(listener) {
      let active = true;
      let revision = -1;
      let groupModel = false;
      const receive = (value: DesktopSnapshot) => {
        if (active && (value.revision > revision || (value.revision === revision && !groupModel && value.attentionModel === "group"))) {
          revision = value.revision;
          groupModel = value.attentionModel === "group";
          listener(value);
        }
      };
      snapshots.add(receive);
      void snapshot().then(receive).catch(error => {
        if (active && !closed) emitError(observerError(error));
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
    library: request => send("library", request),
    memory: request => send("memory", request),
    contextPreview: request => send("contextPreview", request),
    schedule: (botId, request) => send("schedule", { botId, request }),
    device: request => send("device", request),
    recipeAuthoring: request => send('recipeAuthoring', request),
    recipeInstall: request => send('recipeInstall', request),
    onLog(listener) { logs.add(listener); return () => { logs.delete(listener); }; },
    onBackendInstall(listener) { installs.add(listener); return () => { installs.delete(listener); }; },
    onDevice(listener) { devices.add(listener); return () => { devices.delete(listener); }; },
    onDesktopUpdateRequest(listener) { updateRequests.add(listener); return () => { updateRequests.delete(listener); }; },
    onError(listener) {
      errors.add(listener);
      for (const error of undeliveredErrors.splice(0)) {
        try { listener(error); } catch (failure) { retainError(observerError(failure)); }
      }
      return () => { errors.delete(listener); };
    },
    close,
  };
}
