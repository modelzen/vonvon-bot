import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "../../client/src/client";
import type { DevicesState } from "@vonvon/protocol";
import {
  activeDeviceFrom, ClientProvider, deviceCopyName, LOCAL_ACTIVE_DEVICE, shellForDevice, useActiveDevice, useClient, useDevicesState,
  useShellCapabilities, type DevicesShell, type ShellCapabilities,
} from "../src/client-context";

const client = createClient({
  isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {},
  send: () => {}, close: async () => {},
});

function Probe() {
  const injected = useClient();
  const shell = useShellCapabilities();
  return <span>{injected === client ? "client" : "wrong"}:{shell?.hideWindow ? "hide" : "web"}:{shell?.quit ? "quit" : "no-quit"}</span>;
}

it("supports web without a shell and a partial desktop capability object", () => {
  expect(renderToStaticMarkup(<ClientProvider client={client}><Probe /></ClientProvider>))
    .toBe("<span>client:web:no-quit</span>");
  expect(renderToStaticMarkup(<ClientProvider client={client} shell={{ hideWindow: async () => {} }}><Probe /></ClientProvider>))
    .toBe("<span>client:hide:no-quit</span>");
});

// devices-ui-1a 第 5 节 client-context. main 必败: there was no device in the context.
const REMOTE = "11111111-1111-4111-8111-111111111111";
function state(active: DevicesState["active"]): DevicesState {
  return {
    v: 1, revision: 1, client: { version: "0.9.0", protocolVersion: 2 }, registry: "ok", secureStorage: true,
    devices: [
      { id: "local", name: "这台电脑", current: active.id === "local", status: "online", routes: [] },
      { id: REMOTE, name: "机房", current: active.id === REMOTE, status: "connecting", platform: "windows", version: "0.8.1",
        routes: [{ host: "203.0.113.10", port: 7767, kind: "public" }] },
    ],
    active,
  };
}

function DeviceProbe() {
  const device = useActiveDevice();
  return <span>{device.isRemote ? "remote" : "local"}:{deviceCopyName(device)}:{useDevicesState()?.revision ?? "none"}</span>;
}

it("is this computer where no device was given", () => {
  expect(renderToStaticMarkup(<ClientProvider client={client}><DeviceProbe /></ClientProvider>)).toBe("<span>local:这台电脑:none</span>");
  const remote = activeDeviceFrom(state({ id: REMOTE, phase: "connecting", attempt: 0 }));
  expect(renderToStaticMarkup(<ClientProvider client={client} device={remote} devices={state({ id: REMOTE, phase: "connecting", attempt: 0 })}><DeviceProbe /></ClientProvider>))
    .toBe("<span>remote:「机房」:1</span>");
});

it("leaves out what only acts on this computer while a remote device is shown", () => {
  const action = async () => ({ type: "done" as const, message: "" });
  const shell: ShellCapabilities = {
    openExternal: async () => {}, chooseExecutablePath: async () => null, chooseDirectoryPaths: async () => null, setLoginItem: async () => {},
    service: action, startHost: action, repairCli: action, hideWindow: async () => {}, devices: {} as DevicesShell,
  };
  expect(shellForDevice(shell, LOCAL_ACTIVE_DEVICE)).toBe(shell);
  const remote = shellForDevice(shell, activeDeviceFrom(state({ id: REMOTE, phase: "connecting", attempt: 0 })))!;
  expect(Object.keys(remote).sort()).toEqual(["devices", "hideWindow", "openExternal"]);
  expect(shellForDevice(undefined, LOCAL_ACTIVE_DEVICE)).toBeUndefined();
});

it("takes a ready device from its connection and a connecting one from its row", () => {
  const serverInfo = { type: "serverInfo" as const, machineId: REMOTE, version: "0.9.0", protocolVersion: 2, platform: "linux", capabilities: ["device"] };
  expect(activeDeviceFrom(state({ id: REMOTE, phase: "ready", mode: "full", attempt: 0, serverInfo }))).toEqual({
    id: REMOTE, isRemote: true, name: "机房", mode: "full", platform: "linux", version: "0.9.0", capabilities: ["device"],
  });
  expect(activeDeviceFrom(state({ id: REMOTE, phase: "connecting", attempt: 0 }))).toEqual({
    id: REMOTE, isRemote: true, name: "机房", mode: "full", platform: "windows", version: "0.8.1", capabilities: [],
  });
  expect(activeDeviceFrom(state({ id: "local", phase: "ready", attempt: 0 }))).toEqual({ ...LOCAL_ACTIVE_DEVICE, capabilities: [] });
});

it('keeps the desktop account capability while another device is shown', () => {
  const account = {status: vi.fn(), onStatus: vi.fn(), login: vi.fn(), cancelLogin: vi.fn(), logout: vi.fn()};
  const remote = shellForDevice({account}, activeDeviceFrom(state({id: REMOTE, phase: 'connecting', attempt: 0})));
  expect(remote?.account).toBe(account);
});
