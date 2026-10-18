import type { BackendEntry, EnvironmentProfile, EnvironmentReply, EnvironmentToolState, EnvironmentTool } from "@vonvon/protocol";

export type ToolAction = "install" | "update" | "login" | "none";
export type ToolPresentation = {
  action: ToolAction;
  status: string;
  tone: "neutral" | "success" | "warning" | "info";
  summary: string;
};

/** Row titles, as the 叫法表 names them (docs/v1-plan.md section 5): Claude, not Claude Code; that it is the command line
 * goes in the summary, which {@link presentTool} starts with 命令行 for the two backends. */
export const toolNames: Record<EnvironmentTool, string> = {
  codex: "Codex",
  claude: "Claude",
  "lark-cli": "飞书 CLI",
};

export function groupAgentBackends(tools: EnvironmentToolState[], backends: BackendEntry[]): { codexHost?: BackendEntry; otherBackends: BackendEntry[] } {
  if (!tools.some((tool) => tool.tool === "codex")) return { otherBackends: backends };
  const index = backends.findIndex((backend) => backend.id === "codex-appserver" && backend.depKind === "external-cli");
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
  const kind = tool.tool === "lark-cli" ? "" : "命令行 · ";
  if (tool.installation === "missing") return {
    action: "install", status: "未安装", tone: "neutral",
    summary: `${kind}${tool.latestVersion ? `可安装 ${tool.latestVersion}` : "尚未安装"}`,
  };
  const source = tool.installation === "managed" ? "Vonvon 托管" : "现有安装";
  const version = tool.version ? `版本 ${tool.version}` : "版本未知";
  const compatibility = tool.compatibility;
  const versionNote = compatibility?.status === "tooOld" ? ` · 太旧，最低要 ${compatibility.minimum}` : compatibility?.status === "newer" ? ` · 比验证过的 ${compatibility.verified} 新` : "";
  const summary = `${kind}${version}${versionNote} · ${source}${tool.updateAvailable && tool.latestVersion ? ` · 可更新至 ${tool.latestVersion}` : ""}`;
  if (compatibility?.status === "tooOld") return { action: "update", status: "版本太旧", tone: "warning", summary };
  if (tool.tool === "lark-cli" && (profile?.tokenStatus === "needs_refresh" || profile?.tokenStatus === "expired" || profile?.tokenStatus === "missing")) return {
    action: "login", status: profileTokenLabel(profile.tokenStatus), tone: "warning", summary,
  };
  if (auth?.state === "signedOut") return { action: "login", status: "需要授权", tone: "warning", summary };
  const action = tool.updateAvailable ? "update" : "none";
  if (auth?.state === "signedIn") return { action, status: "已授权", tone: "success", summary };
  return { action, status: "授权未确认", tone: "neutral", summary };
}
