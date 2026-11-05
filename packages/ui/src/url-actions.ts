import type { ShellCapabilities } from "./client-context";

const registrationHosts = new Set([
  "accounts.feishu.cn", "accounts.larksuite.com", "open.feishu.cn",
  "open.larksuite.com",
]);
const verificationHosts = new Set([
  ...registrationHosts, "auth.openai.com", "chatgpt.com",
  "claude.ai", "console.anthropic.com", "platform.claude.com",
]);
export type ExternalUrlKind = "registration" | "authorization" | "verification" | "event-settings" | "app-console" | "group" | "bot-chat" | "releases" | "download" | "tailscale";

/** 官网的更新日志和下载页；安装包在这里下载，应用内更新没生效时也指到这里。 */
export const changelogUrl = "https://vonvon.cc/changelog/";
export const downloadPageUrl = "https://vonvon.cc/get/";

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
      case "app-console":
        // The app's console page, or its permission page with preselected scopes.
        if (!new Set(["open.feishu.cn", "open.larksuite.com"]).has(url.hostname) ||
            !/^\/app\/[^/]+(?:\/auth)?$/.test(url.pathname)) return null;
        break;
      case "group":
        if (url.hostname !== "applink.feishu.cn" ||
            !new Set(["/client/chat/open", "/client/thread/open"]).has(url.pathname)) return null;
        break;
      case "bot-chat":
        if (!new Set(["applink.feishu.cn", "applink.larksuite.com"]).has(url.hostname) || url.pathname !== "/client/bot/open" || !/^cli_[A-Za-z0-9_-]+$/.test(url.searchParams.get('appId') ?? '') || [...url.searchParams.keys()].some(key => key !== 'appId') || url.hash) return null;
        break;
      case "releases":
        if (url.hostname !== "vonvon.cc" || url.pathname !== "/changelog/") return null;
        break;
      case "download":
        if (url.hostname !== "vonvon.cc" || url.pathname !== "/get/") return null;
        break;
      case "tailscale":
        // devices-ui-1b 4.9: only Tailscale's download page, exactly.
        if (value !== "https://tailscale.com/download") return null;
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

export type CopyOutcome = "copied" | "selected";
/** Copies a validated link. When the clipboard refuses (or is missing) and `select` is given, `select`
 * puts the link in a selected field for a manual ⌘C / Ctrl+C and this resolves "selected";
 * without `select` the refusal is thrown. An unsupported link always throws. */
export async function copyAuthorizationUrl(value: string, kind: "registration" | "authorization", select?: () => void): Promise<CopyOutcome> {
  const url = allowedExternalUrl(value, kind);
  if (!url) throw new Error("链接不是受支持的官方地址。");
  try { await navigator.clipboard.writeText(url); }
  catch (error) {
    if (!select) throw error;
    select();
    return "selected";
  }
  return "copied";
}

/** The copy shortcut on the viewer's own keyboard. */
export function copyShortcut(platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘C" : "Ctrl+C";
}
export function copyFeedback(outcome: CopyOutcome, shortcut = copyShortcut()): string {
  return outcome === "copied" ? "已复制" : `已选中链接，按 ${shortcut} 复制`;
}

export function groupUrl(groupId: string, threadId?: string): string {
  const group = encodeURIComponent(groupId);
  if (threadId && /^omt_[A-Za-z0-9_-]+$/.test(threadId))
    return `https://applink.feishu.cn/client/thread/open?open_chat_id=${group}&open_thread_id=${encodeURIComponent(threadId)}&thread_position=0`;
  return `https://applink.feishu.cn/client/chat/open?openChatId=${group}`;
}

/** The bot's private chat in the Feishu or Lark client. */
export function botChatUrl(botId: string, tenant: "feishu" | "lark"): string {
  return `https://applink.${tenant === "lark" ? "larksuite.com" : "feishu.cn"}/client/bot/open?appId=${encodeURIComponent(botId)}`;
}
