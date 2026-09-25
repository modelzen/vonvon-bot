import { useEffect, useRef, useState } from "react";
import { Button, InlineNotice } from "../reference/components/ui";
import { SettingsGroup, SettingsRow } from "../reference/components/system-settings";
import type { AgentId, GroupId } from "../../shared/bridge";
import type { CollaborationClient, CollaborationReply } from "../../shared/collaboration";
import "../settings/settings.css";

type Usage = Extract<CollaborationReply, { kind: "usage" }>["data"];
type Props = {
  agentId: AgentId;
  project?: { projectName: string; groupId: GroupId };
  request: CollaborationClient;
};

function windowValue(window: { usedPercent: number; resetAt?: number } | undefined) {
  if (!window) return "暂不可用";
  const reset = window.resetAt ? ` · ${new Date(window.resetAt * 1000).toLocaleString()} 重置` : "";
  return `已用 ${window.usedPercent}%${reset}`;
}

export function UsagePanel({ agentId, project, request }: Props) {
  const requestRef = useRef(request);
  requestRef.current = request;
  const [data, setData] = useState<Usage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void requestRef.current({ action: "usage", agentId, force: false }).then((reply) => {
      if (!active) return;
      if (reply.kind === "usage") setData(reply.data);
      else setError(reply.kind === "refused" ? reply.message : "无法读取 Codex 用量。");
    }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "无法读取 Codex 用量。"); });
    return () => { active = false; };
  }, [agentId]);

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const reply = await request({ action: "usage", agentId, force: true });
      if (reply.kind === "usage") { setData(reply.data); setNotice("用量已刷新。"); }
      else setError(reply.kind === "refused" ? reply.message : "无法读取 Codex 用量。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法刷新 Codex 用量。"); }
    finally { setBusy(false); }
  }

  async function share() {
    if (!project) return;
    setBusy(true);
    setError("");
    try {
      const reply = await request({ action: "shareUsage", agentId, projectName: project.projectName, groupId: project.groupId });
      if (reply.kind === "applied") setNotice("已向此飞书群发送用量卡片。");
      else setError(reply.kind === "refused" ? reply.message : "无法发送用量卡片。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法发送用量卡片。"); }
    finally { setBusy(false); }
  }

  return <SettingsGroup label="Codex 用量" action={<Button size="sm" loading={busy} onClick={() => void refresh()}>刷新</Button>} footer="用量来自本机 Codex 登录账号。分享到飞书群需要明确点击。">
    {data ? <>
      <SettingsRow title="账号" value={data.profile.displayName || "当前 Codex 账号"} />
      <SettingsRow title="套餐" value={data.usage.planType || "未提供"} />
      <SettingsRow title="短期窗口" value={windowValue(data.usage.main.primary)} />
      <SettingsRow title="长期窗口" value={windowValue(data.usage.main.secondary)} />
      {data.usage.extras.map((item, index) => <SettingsRow key={`${item.name ?? "额外限额"}-${index}`} title={item.name || "额外限额"} value={`${windowValue(item.primary)}；${windowValue(item.secondary)}`} />)}
      <SettingsRow title="最近读取" value={new Date(data.usage.fetchedAt).toLocaleString()} />
      {project && <SettingsRow title="发送到当前群" description="在飞书群中发送当前用量卡片。" trailing={<Button size="sm" disabled={busy} onClick={() => void share()}>分享用量</Button>} />}
    </> : <SettingsRow title="用量尚未读取" description="登录 Codex 后可查看本机账号用量。" />}
    {error && <InlineNotice title="用量读取失败" tone="warning">{error}</InlineNotice>}
    {notice && <InlineNotice title="用量操作完成">{notice}</InlineNotice>}
  </SettingsGroup>;
}
