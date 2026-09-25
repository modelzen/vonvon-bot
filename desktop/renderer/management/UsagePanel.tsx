import { useEffect, useRef, useState } from "react";
import { Button, InlineNotice } from "../reference/components/ui";
import { SettingsGroup, SettingsRow } from "../reference/components/system-settings";
import type { AgentId, GroupId } from "../../shared/bridge";
import type { CollaborationClient, CollaborationReply, UsageShareSection } from "../../shared/collaboration";
import "./usage.css";

type Usage = Extract<CollaborationReply, { kind: "usage" }>["data"];
type Profile = Usage["profile"];
type Props = {
  agentId: AgentId;
  project?: { projectName: string; groupId: GroupId };
  request: CollaborationClient;
};

const shareSections: { key: UsageShareSection; label: string }[] = [
  { key: "stats", label: "核心统计" },
  { key: "heatmap", label: "每日用量热力图" },
  { key: "insights", label: "活动洞察与常用技能" },
  { key: "limits", label: "限额进度" },
  { key: "plan", label: "套餐信息" },
];

function amount(value: number | undefined) {
  return value === undefined ? "未提供" : value.toLocaleString("zh-CN");
}

function windowValue(window: { usedPercent: number; resetAt?: number } | undefined) {
  if (!window) return "暂不可用";
  const reset = window.resetAt ? ` · ${new Date(window.resetAt * 1000).toLocaleString()} 重置` : "";
  return `已用 ${window.usedPercent}%${reset}`;
}

function profileStats(profile: Profile) {
  return [
    { label: "累计 Token", value: amount(profile.lifetimeTokens) },
    { label: "峰值单日 Token", value: amount(profile.peakDailyTokens) },
    { label: "当前连续天数", value: profile.currentStreakDays === undefined ? "未提供" : `${profile.currentStreakDays} 天` },
    { label: "最长连续天数", value: profile.longestStreakDays === undefined ? "未提供" : `${profile.longestStreakDays} 天` },
    { label: "最长单任务", value: profile.longestTurnSec === undefined ? "未提供" : `${Math.round(profile.longestTurnSec / 60)} 分钟` },
  ];
}

function Heatmap({ profile }: { profile: Profile }) {
  if (!profile.dailyBuckets.length) return <SettingsRow title="每日用量" description="Codex 暂未提供每日活动记录。" />;
  const daily = new Map(profile.dailyBuckets.map(item => [item.date, item.tokens]));
  const maximum = Math.max(...profile.dailyBuckets.map(item => item.tokens), 0);
  const today = new Date();
  const utcDay = Math.floor(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 86_400_000);
  const startMonday = utcDay - ((new Date(utcDay * 86_400_000).getUTCDay() + 6) % 7) - 12 * 7;
  const cells = Array.from({ length: utcDay - startMonday + 1 }, (_, offset) => {
    const date = new Date((startMonday + offset) * 86_400_000).toISOString().slice(0, 10);
    const tokens = daily.get(date) ?? 0;
    const level = tokens === 0 || maximum === 0 ? 0 : Math.max(1, Math.ceil(tokens / maximum * 4));
    return <span key={date} className={`usage-cell usage-cell--${level}`} title={`${date} · ${amount(tokens)} Token`} aria-label={`${date}，${amount(tokens)} Token`} />;
  });
  return <div className="usage-heatmap" aria-label="最近十三周每日 Token 用量">
    <div className="usage-heatmap__grid">{cells}</div>
    <span className="usage-heatmap__hint">最近十三周 · 悬停查看每日用量</span>
  </div>;
}

export function UsagePanel({ agentId, project, request }: Props) {
  const requestRef = useRef(request);
  requestRef.current = request;
  const [data, setData] = useState<Usage>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sections, setSections] = useState<UsageShareSection[]>([]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setData(undefined);
    setError("");
    void requestRef.current({ action: "usage", agentId, force: false }).then(reply => {
      if (!active) return;
      if (reply.kind === "usage") setData(reply.data);
      else setError(reply.kind === "refused" ? reply.message : "无法读取 Codex 用量。");
    }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "无法读取 Codex 用量。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [agentId]);

  async function refresh() {
    setBusy(true);
    setError("");
    setNotice("");
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
    setNotice("");
    try {
      const reply = await request({ action: "shareUsage", agentId, projectName: project.projectName, groupId: project.groupId, sections });
      if (reply.kind === "applied") setNotice("已在当前飞书群生成可转发的用量卡片。");
      else setError(reply.kind === "refused" ? reply.message : "无法生成用量卡片。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法生成用量卡片。"); }
    finally { setBusy(false); }
  }

  const profile = data?.profile;
  return <div className="usage-panel">
    <SettingsGroup label="Codex 用量" action={<Button size="sm" loading={busy} onClick={() => void refresh()}>刷新</Button>} footer="用量来自本机 Codex 登录账号。">
      {data ? <>
        <SettingsRow title="账号" value={profile?.displayName || "当前 Codex 账号"} />
        <SettingsRow title="套餐" value={data.usage.planType || "未提供"} />
        <SettingsRow title="短期窗口" value={windowValue(data.usage.main.primary)} />
        <SettingsRow title="长期窗口" value={windowValue(data.usage.main.secondary)} />
        {data.usage.extras.map((item, index) => <SettingsRow key={`${item.name ?? "额外限额"}-${index}`} title={item.name || "额外限额"} value={`${windowValue(item.primary)}；${windowValue(item.secondary)}`} />)}
        <SettingsRow title="最近读取" value={new Date(data.usage.fetchedAt).toLocaleString()} />
      </> : <SettingsRow title={loading ? "正在读取用量" : "用量尚未读取"} description={loading ? "请稍候。" : "登录 Codex 后可查看本机账号用量。"} />}
      {error && <InlineNotice title="用量读取失败" tone="warning">{error}</InlineNotice>}
      {notice && <InlineNotice title="用量操作完成">{notice}</InlineNotice>}
    </SettingsGroup>
    {profile && <>
      <SettingsGroup label="活动统计" footer={profile.statsAsOf ? `统计截至 ${profile.statsAsOf}` : undefined}>
        {profileStats(profile).map(item => <SettingsRow key={item.label} title={item.label} value={item.value} />)}
        <SettingsRow title="会话总数" value={amount(profile.totalThreads)} />
        <SettingsRow title="技能调用总数" value={amount(profile.totalSkillsUsed)} />
        <SettingsRow title="不同技能数" value={amount(profile.uniqueSkillsUsed)} />
        <SettingsRow title="Fast Mode 占比" value={profile.fastModePct === undefined ? "未提供" : `${Math.round(profile.fastModePct)}%`} />
        <SettingsRow title="常用推理强度" value={profile.mostUsedEffort ? `${profile.mostUsedEffort}${profile.mostUsedEffortPct === undefined ? "" : ` · ${Math.round(profile.mostUsedEffortPct)}%`}` : "未提供"} />
        {profile.topInvocations.map(item => <SettingsRow key={`${item.kind}:${item.name}`} title={`${item.kind === "plugin" ? "插件" : "技能"} · ${item.name}`} value={`${amount(item.count)} 次`} />)}
      </SettingsGroup>
      <SettingsGroup label="每日活动"><Heatmap profile={profile} /></SettingsGroup>
    </>}
    {project && <SettingsGroup label="分享到飞书群" footer="生成后可在飞书中转发。不选区块则包含全部内容。">
      <div className="usage-sections" role="group" aria-label="选择分享内容">
        {shareSections.map(option => <label key={option.key} className="usage-sections__item">
          <input type="checkbox" checked={sections.includes(option.key)} onChange={event => setSections(current => event.target.checked ? [...current, option.key] : current.filter(key => key !== option.key))} />
          {option.label}
        </label>)}
      </div>
      <SettingsRow title="当前飞书群" value={project.projectName} trailing={<Button size="sm" disabled={busy || !data} onClick={() => void share()}>生成分享卡</Button>} />
    </SettingsGroup>}
  </div>;
}
