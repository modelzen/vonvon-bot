import {RefreshCw, Share2} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, IconButton, InlineNotice } from "../reference/components/ui";
import { SettingsGroup, SettingsRow } from "../reference/components/system-settings";
import type { Agent, Group, Membership, MembershipId } from "@vonvon/protocol";
import type { CollaborationClient, UsageShareSection } from "@vonvon/protocol";
import { settingAnchor } from "../search";
import "./usage.css";
import { JudgeUsageGroup } from "./JudgeUsage";
import {UsageAccount, UsageProfile} from "./UsageContent";
import {readUsage, type Usage} from "./usage-data";


type Props = {
  request: CollaborationClient;
  onOpenEnvironment: () => void;
  onOpenShare: () => void;
};

const shareSections: { key: UsageShareSection; label: string }[] = [
  { key: "stats", label: "核心统计" },
  { key: "heatmap", label: "每日用量热力图" },
  { key: "insights", label: "活动洞察与常用技能" },
  { key: "limits", label: "限额进度" },
  { key: "plan", label: "套餐信息" },
];

export function UsagePanel({ request, onOpenEnvironment, onOpenShare }: Props) {
  const requestRef = useRef(request);
  requestRef.current = request;
  const [data, setData] = useState<Usage>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setData(undefined);
    setError("");
    void readUsage(requestRef.current).then(value => {
      if (active) setData(value);
    }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "无法读取 Codex 用量。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function refresh() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setData(await readUsage(request, true));
      setNotice("用量已刷新。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法刷新 Codex 用量。"); }
    finally { setBusy(false); }
  }

  const profile = data?.profile;
  return <div className="usage-panel usage-page">
    <header className="usage-page-heading today-page-heading">
      <h1>用量</h1><div className="usage-page-actions" id={settingAnchor('分享 Codex 用量')}>
        <IconButton label="刷新用量" title="重新读取 Codex 用量" disabled={busy || loading} onClick={() => void refresh()}><RefreshCw size={15}/></IconButton>
        <Button size="sm" onClick={onOpenShare}><Share2 size={14}/>分享用量</Button>
      </div>
    </header>
    <UsageAccount data={data}>
      {!data && <SettingsRow title={loading ? '正在读取用量' : '用量尚未读取'} description={loading ? '请稍候。' : error ? '请先刷新重试，或到 Provider 设置检测本机配置。' : '在 Codex App 或 Codex CLI 中登录后，回到 Vonvon 检测配置。'} trailing={!loading && <Button size="sm" onClick={onOpenEnvironment}>检测 Provider</Button>}/>}
      {error && <InlineNotice title="用量读取失败" tone="warning">{error}</InlineNotice>}
      {notice && <p className="usage-operation-note" role="status">{notice}</p>}
    </UsageAccount>
    {profile && <UsageProfile profile={profile}/>}
    <JudgeUsageGroup />
  </div>;
}

export function ShareUsagePanel({memberships, agents, groups, request}: {memberships: readonly Membership[]; agents: readonly Agent[]; groups: readonly Group[]; request: CollaborationClient}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sections, setSections] = useState<UsageShareSection[]>([]);
  const [selectedId, setSelectedId] = useState<MembershipId>();
  const selected = memberships.find(member => member.id === selectedId);
  const eligible = selected && !selected.stale && agents.some(agent => agent.id === selected.agentId && !agent.readError);
  const anyEligible = memberships.some(member => !member.stale && agents.some(agent => agent.id === member.agentId && !agent.readError));
  async function share() {
    const member = memberships.find(item => item.id === selectedId);
    if (!member || member.stale || !agents.some(agent => agent.id === member.agentId && !agent.readError)) {
      setError("所选飞书群绑定已不可用，请重新选择。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const reply = await request({ action: "shareUsage", agentId: member.agentId, projectName: member.name, groupId: member.groupId, sections });
      if (reply.kind === "applied") setNotice("已在当前飞书群生成可转发的用量卡片。");
      else setError(reply.kind === "refused" ? reply.message : "无法生成用量卡片。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法生成用量卡片。"); }
    finally { setBusy(false); }
  }
  return <div className="usage-panel"><SettingsGroup label="分享到飞书群" footer="生成后可在飞书中转发。不选区块则包含全部内容。">
      <SettingsRow title="飞书群" value={<select aria-label="选择分享飞书群" value={selectedId ?? ''} disabled={busy} style={{maxWidth: '100%'}} onChange={event => {setSelectedId(memberships.find(member => member.id === event.target.value)?.id); setError(''); setNotice('');}}>
        <option value="">请选择飞书群</option>
        {memberships.map(member => {
          const agent = agents.find(item => item.id === member.agentId);
          const groupName = groups.find(item => item.id === member.groupId)?.name ?? member.name;
          const reason = member.stale ? '绑定状态已过期' : !agent ? 'Bot 已移除' : agent.readError ? 'Bot 暂不可用' : '';
          return <option key={member.id} value={member.id} disabled={Boolean(reason)}>{groupName} · {agent?.name ?? '未知 Bot'}{member.name !== groupName ? ` · 绑定名称：${member.name}` : ''}{reason ? `（${reason}）` : ''}</option>;
        })}
        {selectedId && !selected && <option value={selectedId} disabled>原绑定已移除</option>}
      </select>} />
      <div className="usage-sections" role="group" aria-label="选择分享内容">
        {shareSections.map(option => <label key={option.key} className="usage-sections__item">
          <input type="checkbox" checked={sections.includes(option.key)} onChange={event => setSections(current => event.target.checked ? [...current, option.key] : current.filter(key => key !== option.key))} />
          {option.label}
        </label>)}
      </div>
      <SettingsRow title="生成卡片" description={!anyEligible ? '暂无可分享的飞书群，请先连接群聊。' : !selectedId ? '先选择飞书群。' : !eligible ? '所选飞书群绑定已不可用，请重新选择。' : undefined} trailing={<Button size="sm" disabled={busy || !eligible} onClick={() => void share()}>生成分享卡</Button>} />
      {error && <InlineNotice title="分享未完成" tone="warning">{error}</InlineNotice>}
      {notice && <InlineNotice title="分享完成">{notice}</InlineNotice>}
    </SettingsGroup>
  </div>;
}
