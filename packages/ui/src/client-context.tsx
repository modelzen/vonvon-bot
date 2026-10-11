import { createContext, useContext, type ReactNode } from "react";
import type { VonvonClient } from "@vonvon/client/browser";
import type { DesktopUpdate, MachineReply } from "@vonvon/protocol";

export type ShellCapabilities = {
  openExternal?: (url: string) => Promise<void>;
  chooseExecutablePath?: () => Promise<string | null>;
  setLoginItem?: (enabled: boolean) => Promise<void>;
  hideWindow?: () => Promise<void>;
  quit?: () => Promise<void>;
  onQuitRequested?: (listener: () => void) => () => void;
  service?: (action: "install" | "start" | "stop" | "uninstall") => Promise<MachineReply>;
  startHost?: (bot?: string) => Promise<MachineReply>;
  repairCli?: () => Promise<MachineReply>;
  checkDesktopUpdate?: () => Promise<DesktopUpdate>;
  installDesktopUpdate?: () => Promise<DesktopUpdate>;
};

const ClientContext = createContext<VonvonClient | null>(null);
const ShellContext = createContext<ShellCapabilities | undefined>(undefined);

export function ClientProvider({ client, shell, children }: { client: VonvonClient; shell?: ShellCapabilities; children: ReactNode }) {
  return <ClientContext.Provider value={client}><ShellContext.Provider value={shell}>{children}</ShellContext.Provider></ClientContext.Provider>;
}

export function useClient(): VonvonClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("VonvonClient provider is missing");
  return client;
}

export function useShellCapabilities(): ShellCapabilities | undefined {
  return useContext(ShellContext);
}
