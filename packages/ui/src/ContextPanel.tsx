import {useCallback, useEffect, useState} from 'react';
import type {AgentId, ContextPreviewReply, ContextPreviewRequest, GroupId, MemoryItem, MemoryScopeRef} from '@vonvon/protocol';
import {useActiveDevice, useClient} from './client-context';
import {whereName} from './device-copy';
import {Button, InlineNotice} from './reference/components/ui';
import {groupByBranch, injectedLine, INSTRUCTION_FILES_NOTE, judgeItems, judgeLines, lastTurnLines, newestTurn, panelRows, type PanelTarget} from './context-model';

const failText = (error: unknown) => error instanceof Error ? error.message : '暂时读不到，请重试。';
type Detail = {kind: 'bot' | 'project' | 'judge'};
/** The entries behind a count, read when 逐条看 is opened. */
export type DetailItems = {bot?: {items: MemoryItem[]; branches: string[]}; project?: {items: MemoryItem[]; branches: string[]}};

function Items({items, branches}: {items: readonly MemoryItem[]; branches: readonly string[]}) {
  const groups = groupByBranch(items, branches);
  return groups.length ? <div className="context-items">{groups.map(group => <div key={group.branch}>
    <strong>{group.branch}</strong>
    <ul>{group.items.map(item => <li key={item.id}>{item.text}{item.trust === 'untrusted' && <small> · 待确认</small>}</li>)}</ul>
  </div>)}</div> : <p className="group-control-note">没有条目。</p>;
}

type ViewProps = {
  /** 模型看到什么（小支 · 支付组群 · Codex） */
  title: string;
  groupId: string;
  reply?: ContextPreviewReply;
  error?: string;
  details?: DetailItems;
  open?: Detail['kind'];
  onOpen: (kind?: Detail['kind']) => void;
  go?: Partial<Record<PanelTarget, () => void>>;
  /** One person's private chat: their memory where a group has its project's, and no smart mode to explain. */
  dm?: boolean;
};
/**
 * §5.5：只列 vonvon 自己交给模型的东西。两列：这条活会话实际有的、下一次新会话会有的；决策模型拿到什么；这一轮模型实际看到。
 * 项目自己的 AGENTS.md / CLAUDE.md 和个人指令文件不列、不读，只有最后一句固定文案（D6）。
 */
export function ContextPanelView({title, groupId, reply, error, details, open, onOpen, go, dm}: ViewProps) {
  const memoryName = dm ? '私聊记忆' : '项目记忆';
  const rows = reply ? panelRows(reply) : [];
  const session = reply?.session;
  const turn = session?.lastTurn;
  const lines = turn ? lastTurnLines(turn) : undefined;
  const where = useActiveDevice();
  const judge = reply ? judgeLines(reply.judge, where.isRemote ? `${whereName(where)}上的` : '本机') : [];
  return <section className="context-panel" aria-label="模型看到什么">
    <h3>模型看到什么（{title}）</h3>
    {error && <InlineNotice title="读取未完成" tone="warning">{error}</InlineNotice>}
    {!reply && !error && <p className="gd-empty" role="status">正在读取…</p>}
    {reply && <>
      {!reply.running && <p className="group-control-note">这个 Bot 现在没有运行，没有活会话；只显示下一次新会话会有的。</p>}
      {reply.running && !session && <p className="group-control-note">{dm ? '这个私聊' : '这个群'}现在没有活会话；只显示下一次新会话会有的。</p>}
      {session?.redeliverDue && <p className="group-control-note" role="status">压缩过上下文，下一轮会把 vonvon 交的内容整份重新交一遍。</p>}
      <table className="context-table">
        <thead><tr><th scope="col">vonvon 交的</th><th scope="col">这条活会话实际有的</th><th scope="col">下一次新会话会有的</th><th scope="col"><span className="visually-hidden">操作</span></th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.key}>
          <th scope="row">{row.label}</th>
          <td data-warn={row.liveWarn || undefined}>{row.live ? `${row.liveWarn ? '⚠ ' : ''}${row.live}` : '—'}</td>
          <td>{row.next}</td>
          <td>{row.target && go?.[row.target] && <Button size="sm" onClick={go[row.target]}>{row.target === 'role' || row.target === 'supplement' ? '去改' : '去看'}</Button>}</td>
        </tr>)}</tbody>
      </table>
      {(reply.next.items.bot > 0 || reply.next.items.trusted + reply.next.items.untrusted > 0) && <div className="context-detail">
        <div>
          {reply.next.items.trusted + reply.next.items.untrusted > 0 && <Button size="sm" onClick={() => onOpen(open === 'project' ? undefined : 'project')}>{open === 'project' ? `收起${memoryName}` : `逐条看${memoryName}`}</Button>}
          {reply.next.items.bot > 0 && <Button size="sm" onClick={() => onOpen(open === 'bot' ? undefined : 'bot')}>{open === 'bot' ? '收起 Bot 记忆' : '逐条看 Bot 记忆'}</Button>}
        </div>
        {open === 'project' && (details?.project ? <Items {...details.project}/> : <p className="group-control-note" role="status">正在读取…</p>)}
        {open === 'bot' && (details?.bot ? <Items {...details.bot}/> : <p className="group-control-note" role="status">正在读取…</p>)}
      </div>}
      <p className="group-control-note">vonvon 的工具：{reply.next.tools.join('、')}</p>
      {!dm && <div className="context-judge">
        <strong>{judge[0]}</strong>
        <p className="group-control-note">{judge[1]}</p>
        {reply.judge.memoryItems > 0 && <Button size="sm" onClick={() => onOpen(open === 'judge' ? undefined : 'judge')}>{open === 'judge' ? '收起' : '逐条看'}</Button>}
        {open === 'judge' && (details?.project
          ? <Items items={judgeItems(details.project.items, groupId, reply.judge.memoryItems)} branches={details.project.branches}/>
          : <p className="group-control-note" role="status">正在读取…</p>)}
      </div>}
      {turn && lines && <div className="context-turn">
        <strong>这一轮模型实际看到（最近一次运行）</strong>
        <p className="group-control-note">{injectedLine(turn, memoryName)}</p>
        <p className="group-control-note">模型说参考了 {turn.used.length} 条{lines.used.length ? `：${lines.used.join(' · ')}` : ''}　（模型自述，{dm ? '私聊' : '群'}里不显示）</p>
        {lines.missed && <p className="group-control-note">{lines.missed}</p>}
      </div>}
    </>}
    <p className="group-control-note context-files-note">{INSTRUCTION_FILES_NOTE}</p>
  </section>;
}

function usePreview(agentId: AgentId, place: ContextPreviewRequest['place'], revision?: number) {
  const client = useClient();
  const [state, setState] = useState<{reply?: ContextPreviewReply; error?: string}>({});
  const key = JSON.stringify(place);
  useEffect(() => {
    let live = true;
    setState({});
    client.contextPreview({type: 'get', agentId, place})
      .then(reply => {if (live) setState({reply});}, failure => {if (live) setState({error: failText(failure)});});
    return () => {live = false;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, agentId, key, revision]);
  return state;
}

type Props = {
  agentId: AgentId;
  groupId: GroupId;
  title: string;
  /** The project whose memory 逐条看 reads; a group not in a project has none. */
  projectId?: string;
  /** Changes when the snapshot does, so the panel reads again. */
  revision?: number;
  go?: ViewProps['go'];
};
type PlaceProps = Pick<Props, 'agentId' | 'title' | 'revision' | 'go'> & {place: ContextPreviewRequest['place']; memory?: MemoryScopeRef};
function PlacePanel({agentId, place, title, memory, revision, go}: PlaceProps) {
  const client = useClient();
  const {reply, error} = usePreview(agentId, place, revision);
  const [open, setOpen] = useState<Detail['kind']>();
  const [details, setDetails] = useState<DetailItems>({});
  const placeKey = JSON.stringify(place);
  const memoryKey = JSON.stringify(memory);
  const load = useCallback(async (kind: 'bot' | 'project') => {
    const scope = kind === 'bot' ? {kind: 'bot' as const, botId: agentId} : memory;
    if (!scope) return;
    try {
      const list = await client.memory({type: 'list', scope});
      if (list.kind === 'list') setDetails(current => ({...current, [kind]: {items: list.items.filter(item => item.state === 'active'), branches: list.branches.map(branch => branch.name)}}));
    } catch {setDetails(current => ({...current, [kind]: {items: [], branches: []}}));}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, agentId, memoryKey]);
  useEffect(() => {if (open) void load(open === 'bot' ? 'bot' : 'project');}, [open, load]);
  useEffect(() => {setDetails({}); setOpen(undefined);}, [agentId, placeKey]);
  return <ContextPanelView title={title} groupId={place.kind === 'group' ? place.groupId : ''} reply={reply} error={error} details={details} open={open} onOpen={setOpen} go={go} dm={place.kind === 'dm'}/>;
}
/** The panel for one Bot in one group (§5.5): the project page's tab, the group settings page's button, the Bot page's project rows. */
export function ContextPanel({agentId, groupId, title, projectId, revision, go}: Props) {
  return <PlacePanel agentId={agentId} place={{kind: 'group', groupId}} title={title} memory={projectId ? {kind: 'project', projectId} : undefined} revision={revision} go={go}/>;
}
/** The same panel for one person's private chat (dm-agent 5): what they alone have. */
export function DmContextPanel({agentId, openId, title, revision}: Pick<Props, 'agentId' | 'title' | 'revision'> & {openId: string}) {
  return <PlacePanel agentId={agentId} place={{kind: 'dm', openId}} title={title} memory={{kind: 'dm', botId: agentId, openId}} revision={revision}/>;
}

/** 最近一轮 and 没记上, above the project's map (§5.3): the newest `lastTurn` of the Bots in the project's groups. */
export function LastTurnNotice({bindings, names, revision}: {bindings: ReadonlyArray<{agentId: AgentId; groupId: GroupId}>; names: (binding: {agentId: AgentId; groupId: GroupId}) => string; revision?: number}) {
  const client = useClient();
  const [replies, setReplies] = useState<Array<{label: string; reply?: ContextPreviewReply}>>([]);
  const key = bindings.map(binding => `${binding.agentId}|${binding.groupId}`).join(',');
  useEffect(() => {
    let live = true;
    void Promise.all(bindings.slice(0, 8).map(async binding => {
      try {return {label: names(binding), reply: await client.contextPreview({type: 'get', agentId: binding.agentId, place: {kind: 'group', groupId: binding.groupId}})};}
      catch {return {label: names(binding)};}
    })).then(found => {if (live) setReplies(found);});
    return () => {live = false;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, revision]);
  const newest = newestTurn(replies);
  if (!newest) return null;
  const lines = lastTurnLines(newest.turn);
  return <div className="context-last-turn" role="status">
    <p className="group-control-note">最近一轮：模型说参考了 {newest.turn.used.length} 条（{newest.label}）{lines.used.length ? `：${lines.used.join(' · ')}` : ''}</p>
    {lines.missed && <p className="group-control-note">{lines.missed}</p>}
  </div>;
}
