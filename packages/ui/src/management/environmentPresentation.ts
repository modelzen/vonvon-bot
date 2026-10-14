import type { BackendEntry, EnvironmentProfile, EnvironmentReply, EnvironmentToolState, EnvironmentTool } from "@vonvon/protocol";

export type ToolAction = "install" | "update" | "login" | "none";
export type ToolPresentation = {
  action: ToolAction;
  status: string;
  tone: "neutral" | "success" | "warning" | "info";
  summary: string;
};

export const toolNames: Record<EnvironmentTool, string> = {
  codex: "Codex CLI",
  claude: "Claude Code CLI",
  "lark-cli": "飞书 CLI",
};

export function groupAgentBackends(tools: EnvironmentToolState[], backends: BackendEntry[]): { codexHost?: BackendEntry; otherBackends: BackendEntry[] } {
  if (!tools.some((tool) => tool.tool === "codex")) return { otherBackends: backends };
  const index = backends.findIndex((backend) => backend.id === "codex" && backend.depKind === "external-cli");
  if (index < 0) return { otherBackends: backends };
  return { codexHost: backends[index], otherBackends: backends.filter((_, position) => position !== index) };
}

export function profileTokenLabel(status: string | undefined): string {
  if (status === "valid") return "凭据有效";
  if (status === "needs_refresh") return "需要刷新凭据";
  if (status === "expired") return "凭据已过期";
  if (status === "missing") return "尚未登录";
  return "凭据状态未知";
}

export function presentTool(tool: EnvironmentToolState, auth: Extract<EnvironmentReply, { kind: "auth" }> | undefined, profile?: EnvironmentProfile): ToolPresentation {
  if (tool.installation === "missing") return {
    action: "install", status: "未安装", tone: "neutral",
    summary: tool.latestVersion ? `可安装 ${tool.latestVersion}` : "尚未安装",
  };
  const source = tool.installation === "managed" ? "Vonvon 托管" : "现有安装";
  const version = tool.version ? `版本 ${tool.version}` : "版本未知";
  const summary = `${version} · ${source}${tool.updateAvailable && tool.latestVersion ? ` · 可更新至 ${tool.latestVersion}` : ""}`;
  if (tool.tool === "lark-cli" && (profile?.tokenStatus === "needs_refresh" || profile?.tokenStatus === "expired" || profile?.tokenStatus === "missing")) return {
    action: "login", status: profileTokenLabel(profile.tokenStatus), tone: "warning", summary,
  };
  if (auth?.state === "signedOut") return { action: "login", status: "需要授权", tone: "warning", summary };
  const action = tool.updateAvailable ? "update" : "none";
  if (auth?.state === "signedIn") return { action, status: "已授权", tone: "success", summary };
  return { action, status: "授权未确认", tone: "neutral", summary };
}
