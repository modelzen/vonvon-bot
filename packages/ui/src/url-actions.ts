import type { ShellCapabilities } from "./client-context";

const registrationHosts = new Set([
  "accounts.feishu.cn", "accounts.larksuite.com", "open.feishu.cn",
  "open.larksuite.com",
]);
const verificationHosts = new Set([
  ...registrationHosts, "auth.openai.com", "chatgpt.com",
  "claude.ai", "console.anthropic.com", "platform.claude.com",
]);
export type ExternalUrlKind = "registration" | "authorization" | "verification" | "event-settings" | "group" | "releases";

export function allowedExternalUrl(value: string, kind: ExternalUrlKind): string | null {
  try {
    const url = new URL(value);
    const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        authority?.toLowerCase() !== url.hostname) return null;
    switch (kind) {
      case "registration": if (!registrationHosts.has(url.hostname)) return null; break;
      case "authorization": if (url.hostname !== "auth.openai.com") return null; break;
      case "verification": if (!verificationHosts.has(url.hostname)) return null; break;
      case "event-settings":
        if (!new Set(["open.feishu.cn", "open.larksuite.com"]).has(url.hostname) ||
            !/^\/app\/[^/]+\/event$/.test(url.pathname)) return null;
        break;
      case "group":
        if (url.hostname !== "applink.feishu.cn" ||
            !new Set(["/client/chat/open", "/client/thread/open"]).has(url.pathname)) return null;
        break;
      case "releases":
        if (url.hostname !== "github.com" || url.pathname !== "/modelzen/vonvon-bot/releases") return null;
        break;
    }
    return url.href;
  } catch {
    return null;
  }
}

export async function openExternalUrl(value: string, kind: ExternalUrlKind, shell?: ShellCapabilities): Promise<void> {
  const url = allowedExternalUrl(value, kind);
  if (!url) throw new Error("链接不是受支持的官方地址。");
  if (shell?.openExternal) await shell.openExternal(url);
  else window.open(url, "_blank", "noopener");
}

export async function copyAuthorizationUrl(value: string, kind: "registration" | "authorization"): Promise<void> {
  const url = allowedExternalUrl(value, kind);
  if (!url) throw new Error("链接不是受支持的官方地址。");
  await navigator.clipboard.writeText(url);
}

export function groupUrl(groupId: string, threadId?: string): string {
  const group = encodeURIComponent(groupId);
  const topic = threadId?.replace(/#(?:admin|guest)$/, "");
  if (topic && /^omt_[A-Za-z0-9_-]+$/.test(topic))
    return `https://applink.feishu.cn/client/thread/open?open_chat_id=${group}&open_thread_id=${encodeURIComponent(topic)}&thread_position=0`;
  return `https://applink.feishu.cn/client/chat/open?openChatId=${group}`;
}
