import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectionError, createClient, type ClientConnection } from "../../client/src/client";

const harness = vi.hoisted(() => ({
  effect: (): (() => void) | void => {},
  setConnection: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("react", () => ({
  useEffect: (effect: () => (() => void) | void) => { harness.effect = effect; },
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, harness.setConnection],
}));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: () => {} }) }));
vi.mock("@vonvon/client/browser", async () => ({
  ...await import("../../client/src/browser"), connectBrowser: harness.connect,
}));
vi.mock("../src/App", () => ({ App: () => null }));
vi.mock("../src/devices/DesktopRoot", () => ({ DesktopRoot: () => null }));
vi.mock("../src/directory-picker", () => ({ DirectoryPickerProvider: () => null }));
vi.mock("../src/client-context", () => ({ ClientProvider: () => null }));

const connected = <T>(client: T) => ({ client, serverInfo: { type: "serverInfo", machineId: "00000000-0000-4000-8000-000000000000", version: "1", protocolVersion: 2 } });
let dispose: (() => void) | void;
beforeEach(() => {
  vi.useFakeTimers();
  harness.connect.mockReset();
  harness.setConnection.mockClear();
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { getElementById: () => ({}) });
  vi.stubGlobal("location", { host: "127.0.0.1:12345", hash: "", pathname: "/", search: "" });
  vi.stubGlobal("sessionStorage", { getItem: () => "a".repeat(64) });
});
afterEach(async () => {
  dispose?.();
  dispose = undefined;
  await Promise.resolve();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture(close: () => Promise<void> = async () => {}) {
  let message = (_data: string): void => {};
  const socket: ClientConnection = {
    isOpen: () => true,
    onMessage: listener => { message = listener; },
    onClose: () => {}, onError: () => {}, send: () => {}, close: vi.fn(close),
  };
  const client = createClient(socket);
  client.onLog(() => { throw new Error("observer failed"); });
  const subscription = vi.spyOn(client, "onError");
  const closeClient = vi.spyOn(client, "close");
  return { client, subscription, closeClient, socket, fail: () => message("invalid JSON"),
    observe: () => message(JSON.stringify({ type: "event", event: "log", payload: { lines: "test" } })),
    message };
}
async function mount(): Promise<void> {
  const { Root } = await import("../src/main");
  Root();
  dispose = harness.effect();
  await vi.advanceTimersByTimeAsync(0);
}

it("retires one client before one retry, ignoring repeated and stale terminal callbacks", async () => {
  let finishClose = (): void => {};
  const first = fixture(() => new Promise<void>(resolve => { finishClose = resolve; }));
  const second = fixture();
  harness.connect.mockResolvedValueOnce(connected(first.client)).mockResolvedValueOnce(connected(second.client));
  await mount();
  const staleCallback = first.subscription.mock.calls[0]?.[0];
  expect(staleCallback).toBeDefined();
  first.fail();
  staleCallback?.(new ConnectionError(new Error("repeated terminal failure")));
  await vi.advanceTimersByTimeAsync(5000);
  expect(first.closeClient).toHaveBeenCalledTimes(1);
  expect(harness.connect).toHaveBeenCalledTimes(1);
  finishClose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(harness.connect).toHaveBeenCalledTimes(2);
  staleCallback?.(new ConnectionError(new Error("stale failure")));
  await vi.advanceTimersByTimeAsync(5000);
  expect(harness.connect).toHaveBeenCalledTimes(2);
  dispose?.();
  dispose = undefined;
  await vi.advanceTimersByTimeAsync(5000);
  expect(second.closeClient).toHaveBeenCalledTimes(1);
  expect(harness.connect).toHaveBeenCalledTimes(2);
});

it("handles synchronous retained errors during subscription without duplicating retries", async () => {
  const first = fixture();
  first.fail();
  first.fail();
  const second = fixture();
  harness.connect.mockResolvedValueOnce(connected(first.client)).mockResolvedValueOnce(connected(second.client));
  await mount();
  await vi.advanceTimersByTimeAsync(1000);
  expect(first.closeClient).toHaveBeenCalledTimes(1);
  expect(harness.connect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(harness.connect).toHaveBeenCalledTimes(2);
});

it("cancels pending retry on unmount", async () => {
  harness.connect.mockRejectedValue(new Error("offline"));
  await mount();
  dispose?.();
  dispose = undefined;
  await vi.advanceTimersByTimeAsync(5000);
  expect(harness.connect).toHaveBeenCalledTimes(1);
});

it("closes a late connection after unmount and consumes cleanup rejection", async () => {
  const late = fixture(async () => { throw new Error("close timed out"); });
  let resolveConnection = (_connected: ReturnType<typeof connected>): void => {};
  harness.connect.mockImplementation(() => new Promise(resolve => { resolveConnection = resolve; }));
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  await mount();
  dispose?.();
  dispose = undefined;
  harness.setConnection.mockClear();
  resolveConnection(connected(late.client));
  await vi.advanceTimersByTimeAsync(5000);
  expect(late.closeClient).toHaveBeenCalledTimes(1);
  expect(harness.setConnection).not.toHaveBeenCalled();
  expect(harness.connect).toHaveBeenCalledTimes(1);
  expect(diagnostic).toHaveBeenCalledWith("Daemon connection cleanup failed", new Error("close timed out"));
});

it("does not create another socket if physical close was not observed", async () => {
  const first = fixture(async () => { throw new Error("physical closure was not observed"); });
  harness.connect.mockResolvedValue(connected(first.client));
  await mount();
  first.fail();
  await vi.advanceTimersByTimeAsync(5000);
  expect(harness.connect).toHaveBeenCalledTimes(1);
  expect(harness.setConnection).toHaveBeenLastCalledWith({ kind: "disconnected", message: "physical closure was not observed", retrying: false });
});

it("stops retries after handshake cleanup fails", async () => {
  harness.connect.mockRejectedValue(new AggregateError([new Error("bad handshake"), new Error("close timeout")], "physical closure was not observed"));
  await mount();
  await vi.advanceTimersByTimeAsync(5000);
  expect(harness.connect).toHaveBeenCalledTimes(1);
  expect(harness.setConnection).toHaveBeenLastCalledWith({ kind: "disconnected", message: "physical closure was not observed", retrying: false });
});


it("keeps one healthy client through persistent log and watch failures, then retries one terminal failure", async () => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const clients: ReturnType<typeof fixture>[] = [];
  const snapshot = (revision: number) => ({ revision, observedAt: 1, stale: false, host: { kind: "starting" }, agents: [], groups: [], memberships: [], tools: [], jobs: [], application: { platform: "macos", version: "1", loginItem: false, dataPath: "/tmp" } });
  harness.connect.mockImplementation(async () => {
    const next = fixture();
    next.client.watchSnapshots(() => { throw new Error("watch observer failed"); });
    clients.push(next);
    return connected(next.client);
  });
  await mount();
  const first = clients[0];
  if (!first) throw new Error("Missing first client");
  const observed: Error[] = [];
  first.client.onError(error => observed.push(error));
  for (let revision = 1; revision <= 4; revision++) {
    first.observe();
    first.message(JSON.stringify({ type: "event", event: "snapshot", payload: snapshot(revision) }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.connect).toHaveBeenCalledTimes(1);
    expect(first.closeClient).not.toHaveBeenCalled();
    expect(first.socket.close).not.toHaveBeenCalled();
    expect(harness.setConnection).toHaveBeenLastCalledWith({ kind: "connected", client: first.client });
  }
  expect(observed).toHaveLength(8);
  expect(observed.every(error => !(error instanceof ConnectionError))).toBe(true);
  expect(diagnostic).toHaveBeenCalledTimes(8);
  first.fail();
  first.fail();
  await vi.advanceTimersByTimeAsync(1000);
  expect(first.closeClient).toHaveBeenCalledTimes(1);
  expect(first.socket.close).toHaveBeenCalledTimes(1);
  expect(harness.connect).toHaveBeenCalledTimes(2);
  expect(observed.at(-1)).toBeInstanceOf(ConnectionError);
  const second = clients[1];
  if (!second) throw new Error("Missing second client");
  second.observe();
  second.message(JSON.stringify({ type: "event", event: "snapshot", payload: snapshot(1) }));
  await vi.advanceTimersByTimeAsync(5000);
  expect(harness.connect).toHaveBeenCalledTimes(2);
  expect(second.closeClient).not.toHaveBeenCalled();
});

it("reports retained observer errors without retiring the healthy client", async () => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const first = fixture();
  first.observe();
  first.observe();
  harness.connect.mockResolvedValue(connected(first.client));
  await mount();
  await vi.advanceTimersByTimeAsync(5000);
  expect(harness.connect).toHaveBeenCalledTimes(1);
  expect(first.closeClient).not.toHaveBeenCalled();
  expect(diagnostic).toHaveBeenCalledTimes(2);
  expect(harness.setConnection).toHaveBeenLastCalledWith({ kind: "connected", client: first.client });
});


it("treats a terminal error thrown by an observer as a callback failure", async () => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const first = fixture();
  const thrown = new ConnectionError(new Error("observer dependency disconnected"));
  first.client.onLog(() => { throw thrown; });
  harness.connect.mockResolvedValue(connected(first.client));
  await mount();
  first.observe();
  await vi.advanceTimersByTimeAsync(5000);
  expect(first.closeClient).not.toHaveBeenCalled();
  expect(harness.connect).toHaveBeenCalledTimes(1);
  const reported = diagnostic.mock.calls.at(-1)?.[1];
  expect(reported).toBeInstanceOf(Error);
  expect(reported).not.toBeInstanceOf(ConnectionError);
  expect(reported).toHaveProperty("cause", thrown);
});
