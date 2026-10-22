import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionError, connectBrowser, type VonvonClient } from "@vonvon/client/browser";
import { App } from "./App";
import { DirectoryPickerProvider } from "./directory-picker";
import { ClientProvider, type ShellCapabilities } from "./client-context";
import "./reference/App.css";
import "./collaboration.css";
import "./desktop.css";
import "./today.css";

declare global {
  interface Window { vonvonClient?: VonvonClient; vonvonShell?: ShellCapabilities }
}

type Connection = { kind: "connecting" } | { kind: "connected"; client: VonvonClient } | { kind: "disconnected"; message: string; retrying: boolean };

function credentialFromLocation(): string | null {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const credential = fragment.get("credential");
  if (credential) {
    sessionStorage.setItem("vonvon-local-credential", credential);
    history.replaceState(null, "", location.pathname + location.search);
  }
  return credential ?? sessionStorage.getItem("vonvon-local-credential");
}

export function Root() {
  const [injected] = useState(() => window.vonvonClient ?? null);
  const [credential] = useState(() => injected ? null : credentialFromLocation());
  const [connection, setConnection] = useState<Connection>({ kind: "connecting" });
  useEffect(() => {
    if (injected || !credential) return;
    let active = true;
    type OwnedClient = { client: VonvonClient; unsubscribe: () => void };
    let current: OwnedClient | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const options = { url: `ws://${location.host}`, credential, clientKind: "web" as const };
    function retry(message: string): void {
      if (!active || timer !== undefined) return;
      setConnection({ kind: "disconnected", message, retrying: true });
      timer = setTimeout(() => {
        timer = undefined;
        if (!active) return;
        setConnection({ kind: "connecting" });
        void connect();
      }, 1000);
    }
    async function disconnect(owner: OwnedClient, error: Error): Promise<void> {
      if (!active || current !== owner) return;
      current = undefined;
      owner.unsubscribe();
      setConnection({ kind: "disconnected", message: error.message, retrying: false });
      try {
        await owner.client.close();
        retry(error.message);
      } catch (failure) {
        if (active) setConnection({ kind: "disconnected", message: failure instanceof Error ? failure.message : "连接关闭失败", retrying: false });
        else console.error("Daemon connection cleanup failed", failure);
      }
    }
    async function connect(): Promise<void> {
      try {
        const next = await connectBrowser(options);
        if (!active) {
          await next.close().catch(error => console.error("Daemon connection cleanup failed", error));
          return;
        }
        const owner: OwnedClient = { client: next, unsubscribe: () => {} };
        current = owner;
        setConnection({ kind: "connected", client: next });
        owner.unsubscribe = next.onError(error => {
          if (!active || current !== owner) return;
          if (error instanceof ConnectionError) void disconnect(owner, error);
          else console.error("Daemon client observer failed", error);
        });
        if (current !== owner) owner.unsubscribe();
      } catch (error) {
        if (error instanceof AggregateError) {
          if (active) setConnection({ kind: "disconnected", message: error.message, retrying: false });
          else console.error("Daemon connection cleanup failed", error);
          return;
        }
        retry(error instanceof Error ? error.message : "无法连接 daemon");
      }
    }
    void connect();
    return () => {
      active = false;
      clearTimeout(timer);
      const owner = current;
      current = undefined;
      owner?.unsubscribe();
      void owner?.client.close().catch(error => console.error("Daemon connection cleanup failed", error));
    };
  }, [credential, injected]);
  if (injected) return <ClientProvider client={injected} shell={window.vonvonShell}><DirectoryPickerProvider><App /></DirectoryPickerProvider></ClientProvider>;
  if (!credential) return <main className="app-connection-state" role="alert"><h1>需要本机访问凭证</h1><p>请在终端运行 <code>vonvon open</code> 打开此页面；在远程主机上用 <code>vonvon open --print</code>。</p></main>;
  if (connection.kind === "connecting") return <main className="app-connection-state" role="status"><h1>正在连接 Vonvon Bot…</h1></main>;
  if (connection.kind === "disconnected") return <main className="app-connection-state" role="alert"><h1>连接已断开</h1><p>{connection.message}</p><p>{connection.retrying ? <>正在重试连接。若 daemon 未运行，请执行 <code>vonvon daemon start</code>。</> : "正在关闭连接；若关闭失败，请刷新页面重试。"}</p></main>;
  return <ClientProvider client={connection.client}><DirectoryPickerProvider><App /></DirectoryPickerProvider></ClientProvider>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Application root missing");
createRoot(root).render(<Root />);
