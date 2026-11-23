import { createContext, useContext, type ReactNode } from "react";
import type { VonvonClient } from "@vonvon/client/browser";
import type {
  AccountShell, CommunityShell, RecipeUseShell, RecipeAuthoringShell, RecipeSourceShell, AddDeviceRequest, AddDeviceResult, DesktopUpdate, DeviceEventPayload, DevicesState, LinkPreview, MachineReply, RemoveDeviceResult,
} from "@vonvon/protocol";

/** devices-ui-1a 4.7: the desktop's devices, through its shell. U2–U4 use the hooks below, not this directly. */
export type DevicesShell = {
  state(): Promise<DevicesState>;
  /** Hears the latest state at once when there is one. */
  onState(listener: (state: DevicesState) => void): () => void;
  /** A client whose requests go to `view` only, and which hears only its events. */
  clientFor(view: string): VonvonClient;
  inspect(link: string): Promise<LinkPreview>;
  add(request: AddDeviceRequest): Promise<AddDeviceResult>;
  cancelAdd(): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<RemoveDeviceResult>;
  switchTo(id: string): Promise<void>;
  retry(): Promise<void>;
};

export type ShellCapabilities = {
  account?: AccountShell;
  community?: CommunityShell;
  recipeAuthoring?: RecipeAuthoringShell;
  recipeUse?: RecipeUseShell;
  recipeSource?: RecipeSourceShell;
  openExternal?: (url: string) => Promise<void>;
  chooseExecutablePath?: () => Promise<string | null>;
  chooseDirectoryPaths?: (multiple: boolean) => Promise<string[] | null>;
  setLoginItem?: (enabled: boolean) => Promise<void>;
  hideWindow?: () => Promise<void>;
  quit?: () => Promise<void>;
  onQuitRequested?: (listener: () => void) => () => void;
  service?: (action: "install" | "start" | "stop" | "uninstall") => Promise<MachineReply>;
  startHost?: (bot?: string) => Promise<MachineReply>;
  repairCli?: () => Promise<MachineReply>;
  /** devices 7.4: quitting leaves this computer's daemon running, as one installed and registered on its own. */
  quitKeepsDaemon?: () => Promise<boolean>;
  checkDesktopUpdate?: () => Promise<DesktopUpdate>;
  /** 忘掉上次没生效的安装，再检查一次。 */
  retryDesktopUpdate?: () => Promise<DesktopUpdate>;
  installDesktopUpdate?: () => Promise<DesktopUpdate>;
  /** 桌面端自动检查更新的结果；订阅时会收到最近一次。 */
  onDesktopUpdate?: (listener: (update: DesktopUpdate) => void) => () => void;
  devices?: DevicesShell;
  /** This computer's own paired and revoked clients, whichever device is shown. */
  onLocalDeviceEvent?: (listener: (event: DeviceEventPayload) => void) => () => void;
  /** U4: another device is updating this computer's Vonvon Bot (the words to show), or no longer; the last one at once.
   * About this computer, whichever device is shown. */
  onRemoteUpdate?: (listener: (text: string | undefined) => void) => () => void;
};

/** The device the page shows. */
export type ActiveDevice = {
  id: string; isRemote: boolean; name: string; platform?: string;
  mode: "full" | "maintenance"; version?: string; capabilities: readonly string[];
};
export const LOCAL_ACTIVE_DEVICE: ActiveDevice = Object.freeze({ id: "local", isRemote: false, name: "这台电脑", mode: "full", capabilities: Object.freeze([]) as readonly string[] });

/** Name from the device's row; platform, version and capabilities from the connection, else what the row last saw. */
export function activeDeviceFrom(state: DevicesState): ActiveDevice {
  const { active } = state;
  if (active.id === "local") {
    const info = active.serverInfo;
    return {
      ...LOCAL_ACTIVE_DEVICE,
      ...(info?.platform ? { platform: info.platform } : {}), ...(info?.version ? { version: info.version } : {}),
      capabilities: info?.capabilities ?? [],
    };
  }
  const row = state.devices.find(device => device.id === active.id);
  const info = active.serverInfo;
  const platform = info?.platform ?? row?.platform;
  const version = info?.version ?? row?.version;
  return {
    id: active.id, isRemote: true, name: row?.name ?? active.id.slice(0, 8), mode: active.mode ?? "full",
    ...(platform ? { platform } : {}), ...(version ? { version } : {}),
    capabilities: info?.capabilities ?? [],
  };
}

/** How sentences name it: a remote device in 「」, this one as "这台电脑". */
export function deviceCopyName(device: Pick<ActiveDevice, "isRemote" | "name">): string {
  return device.isRemote ? `「${device.name}」` : "这台电脑";
}

/** What only acts on this computer, left out while a remote device is shown (devices-ui-1a 4.7); the native directory
 * dialog goes with it, so directory choices fall back to the device's own browser. */
const LOCAL_ONLY = ["chooseExecutablePath", "chooseDirectoryPaths", "setLoginItem", "service", "startHost", "repairCli", "quitKeepsDaemon"] as const satisfies readonly (keyof ShellCapabilities)[];
export function shellForDevice(shell: ShellCapabilities | undefined, device: ActiveDevice): ShellCapabilities | undefined {
  if (!shell || !device.isRemote) return shell;
  const remote: ShellCapabilities = { ...shell };
  for (const name of LOCAL_ONLY) delete remote[name];
  return remote;
}

const ClientContext = createContext<VonvonClient | null>(null);
const ShellContext = createContext<ShellCapabilities | undefined>(undefined);
const DeviceContext = createContext<ActiveDevice>(LOCAL_ACTIVE_DEVICE);
const DevicesContext = createContext<DevicesState | undefined>(undefined);

export function ClientProvider({ client, shell, device, devices, children }: {
  client: VonvonClient; shell?: ShellCapabilities; device?: ActiveDevice; devices?: DevicesState; children: ReactNode;
}) {
  return <ClientContext.Provider value={client}><ShellContext.Provider value={shell}>
    <DeviceContext.Provider value={device ?? LOCAL_ACTIVE_DEVICE}><DevicesContext.Provider value={devices}>{children}</DevicesContext.Provider></DeviceContext.Provider>
  </ShellContext.Provider></ClientContext.Provider>;
}

export function useClient(): VonvonClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("VonvonClient provider is missing");
  return client;
}

export function useShellCapabilities(): ShellCapabilities | undefined {
  return useContext(ShellContext);
}

/** This computer on the web UI and wherever no device was given. */
export function useActiveDevice(): ActiveDevice {
  return useContext(DeviceContext);
}

export function useDevicesState(): DevicesState | undefined {
  return useContext(DevicesContext);
}
