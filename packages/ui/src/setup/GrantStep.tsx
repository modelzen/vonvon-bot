import {useEffect, useRef, useState} from 'react';
import {ArrowUpRight, Check, ChevronDown, RefreshCw, ShieldCheck, TriangleAlert} from 'lucide-react';
import type {VonvonClient} from '@vonvon/client/browser';
import type {AdminSetupStatus, Agent, AgentId, Job, JobId} from '@vonvon/protocol';
import {useClient, useShellCapabilities} from '../client-context';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button, IconButton, StatusBadge} from '../reference/components/ui';
import {openExternalUrl} from '../url-actions';
import {scopeStep, type StepTone} from '@vonvon/protocol';
import './setup.css';
import './grant-step.css';
import {settingAnchor} from '../search';

/** Faster than the checklist (10 s): the user is waiting on this one screen. */
export const GRANT_POLL_MS = 5_000;
/** Bot 设置 re-reads slowly until the user opens the grant link there, then at {@link GRANT_POLL_MS}. */
export const GRANT_ROW_POLL_MS = 30_000;
export const PUBLISH_NOTE = '在飞书确认后，要创建版本并发布才生效；这里会继续检测配置状态。';

/** Runs `tick` now, then again `intervalMs` after each run settles, for as long as it resolves true.
 * The returned function stops it; a run already in flight is not interrupted. */
export function pollEvery(intervalMs: number, tick: () => Promise<boolean>): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function run() {
    const again = await tick().catch(() => true);
    if (live && again) timer = setTimeout(() => void run(), intervalMs);
  }
  void run();
  return () => { live = false; clearTimeout(timer); };
}

/** The bot a finished first registration created. A credential refresh keeps its own bot, so it has none. */
export function registeredAgentId(job: Job | undefined, refresh: boolean | undefined): AgentId | undefined {
  return !refresh && job?.type === 'registerAgent' && job.phase === 'succeeded' ? job.agentId : undefined;
}

/** The 注册 Bot dialog. `agentId` is set once a first registration succeeds; the dialog then shows the grant step. */
export type RegisterModal = {kind: 'register'; jobId: JobId; refresh?: boolean; refreshAgentId?: AgentId; initialAgentIds?: readonly AgentId[]; agentId?: AgentId};
/** The dialog after a snapshot. Job views expire after a while, so it keeps the new bot's id itself. */
export function withRegisteredAgent(modal: RegisterModal, jobs: readonly Job[]): RegisterModal {
  if (modal.agentId) return modal;
  const agentId = registeredAgentId(jobs.find(job => job.id === modal.jobId), modal.refresh);
  return agentId ? {...modal, agentId} : modal;
}
/** The job to cancel when the dialog closes. A finished registration has none, and its job may already be gone. */
export function jobToCancel(modal: RegisterModal): JobId | undefined {
  return modal.agentId ? undefined : modal.jobId;
}

export type ScopeRead = {status?: AdminSetupStatus; problem?: string};
/** Nothing left to grant: the required scopes, and the join-group scope the step warns about. */
export function scopesSettled(status: AdminSetupStatus): boolean {
  const step = scopeStep(status);
  return step.done && !step.warnings?.length;
}
/** Reads one bot's setupStatus now, then every `pollMs` until {@link scopesSettled}. A failed read keeps the
 * last good status and is retried. The returned function stops it; a read still in flight is not reported. */
export function watchScopeStatus(client: Pick<VonvonClient, 'admin'>, agentId: AgentId, pollMs: number,
  onRead: (update: (previous: ScopeRead) => ScopeRead) => void): () => void {
  let live = true;
  const stop = pollEvery(pollMs, async () => {
    try {
      const reply = await client.admin({type: 'setupStatus', agentId});
      if (reply.kind !== 'setupStatus') throw new Error('检测结果格式不对。');
      if (live) onRead(() => ({status: reply.status}));
      return !scopesSettled(reply.status);
    } catch (error) {
      if (live) onRead(previous => ({status: previous.status, problem: error instanceof Error ? error.message : '检测失败，请稍后重试。'}));
      return true;
    }
  });
  return () => { live = false; stop(); };
}
/** Changing `retry` restarts the watcher immediately and drops any older in-flight answer. */
export function useScopeStatus(agentId: AgentId, pollMs: number, retry = 0): ScopeRead {
  const client = useClient();
  const [read, setRead] = useState<ScopeRead>({});
  useEffect(() => watchScopeStatus(client, agentId, pollMs, setRead), [client, agentId, pollMs, retry]);
  return read;
}

export type GrantView = {
  status: string; tone: StepTone; done: boolean; grantUrl?: string;
  detail?: string; items?: readonly string[]; warnings?: readonly string[]; note?: string;
};
/** What the grant step shows for the latest read, and whether the user already opened the grant page. */
export function grantView(read: ScopeRead, opened: boolean): GrantView {
  if (!read.status) return read.problem
    ? {status: '检测失败', tone: 'warning', done: false, detail: read.problem}
    : {status: '正在检测…', tone: 'neutral', done: false};
  const step = scopeStep(read.status);
  const base = {grantUrl: read.status.scopes.grantUrl, warnings: step.warnings};
  if (step.done) return {...base, status: '权限已开通', tone: 'success', done: true};
  return {...base, status: step.status, tone: step.tone, done: false, detail: step.detail, items: step.items, note: opened ? PUBLISH_NOTE : undefined};
}

/** The registration dialog cannot advance on a cached successful result after the latest read failed. */
export function grantStepView(read: ScopeRead, opened: boolean): GrantView {
  return grantView(read.problem ? {problem: read.problem} : read, opened);
}

/** Step 2 of 注册 Bot: the bot exists, now grant its Feishu scopes. Events, callback and publishing stay on the checklist. */
export function GrantStep({agentId, onReadyChange}: {agentId: AgentId; onReadyChange?: (ready: boolean) => void}) {
  const shell = useShellCapabilities();
  const [retry, setRetry] = useState(0);
  const read = useScopeStatus(agentId, GRANT_POLL_MS, retry);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState('');
  const view = grantStepView(read, opened);
  const ready = view.done && !view.warnings?.length;
  const unknown = Boolean(read.status && read.status.scopes.missingRequired === undefined);
  useEffect(() => { onReadyChange?.(ready); }, [onReadyChange, ready]);
  async function grant(url: string) {
    setError('');
    try { await openExternalUrl(url, 'app-console', shell); setOpened(true); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '无法打开飞书开发者后台。'); }
  }
  return <section className="registration-grant" aria-label="开通飞书权限">
    <div className="registration-grant-heading">
      <span className="registration-grant-icon"><ShieldCheck size={21} aria-hidden="true"/></span>
      <div>
        <h3>{ready ? '权限已开通' : read.problem || unknown ? '暂时无法确认权限' : '开通飞书权限'}</h3>
        <p>{ready ? '接下来检查事件、回调与发布状态。' : read.problem ? 'Bot 已注册成功，稍后可以继续配置。' : '在飞书确认预选权限，然后创建版本并发布。'}</p>
      </div>
    </div>
    {read.problem ? <div className="registration-grant-warning" role="alert">
      <TriangleAlert size={16} aria-hidden="true"/><span>{read.problem}</span>
      <IconButton label="重新检测权限" title="重新检测权限" size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} aria-hidden="true"/></IconButton>
    </div> : ready ? <div className="registration-grant-success" role="status"><Check size={16} aria-hidden="true"/><span>必需权限已全部开通</span></div> : <div className="registration-grant-card">
      <div className="registration-grant-card-heading">
        <span><strong>飞书权限</strong><small data-tone={view.tone} role="status">{view.done ? '必需权限已开通' : view.status}</small></span>
        <div className="registration-grant-actions">
          {unknown && <IconButton label="重新检测权限" title="重新检测权限" size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} aria-hidden="true"/></IconButton>}
          {view.grantUrl && <Button size="sm" variant={view.done ? 'secondary' : 'primary'} onClick={() => { if (view.grantUrl) void grant(view.grantUrl); }}>一键开权限<ArrowUpRight size={13} aria-hidden="true"/></Button>}
        </div>
      </div>
      {unknown && view.detail && <p className="registration-grant-detail">{view.detail}</p>}
      {view.items?.length ? <details className="registration-grant-permissions">
        <summary>查看缺少的权限<ChevronDown size={13} aria-hidden="true"/></summary>
        <div>{view.items.map(item => <code key={item}>{item}</code>)}</div>
      </details> : null}
    </div>}
    {view.warnings?.map(warning => <p key={warning} className="registration-grant-warning" role="status"><TriangleAlert size={16} aria-hidden="true"/><span>{warning}</span></p>)}
    {opened && !ready && <p className="registration-grant-note" role="status">{PUBLISH_NOTE}</p>}
    {error && <p className="registration-grant-warning" role="alert"><TriangleAlert size={16} aria-hidden="true"/><span>{error}</span></p>}
  </section>;
}

/** Bot 设置 → 连接与权限: the same grant link. It re-reads slowly, so a failed read or a grant made elsewhere
 * shows up, and at the dialog's pace once the user opened the link here. */
export function ScopeGrantRow({agentId, disabled, onError}: {agentId: AgentId; disabled: boolean; onError: (message: string) => void}) {
  const [opened, setOpened] = useState(false);
  const read = useScopeStatus(agentId, opened ? GRANT_POLL_MS : GRANT_ROW_POLL_MS);
  return <ScopeGrantRowContent read={read} disabled={disabled} onError={onError} onOpened={() => setOpened(true)}/>;
}

function ScopeGrantRowContent({read, disabled, onError, onOpened}: {read: ScopeRead; disabled: boolean; onError: (message: string) => void; onOpened: () => void}) {
  const shell = useShellCapabilities();
  const view = grantView(read, false);
  const url = view.grantUrl;
  return <SettingsRow title="飞书权限"
    description={<>
      一键开权限会打开飞书开发者后台并预选所需权限；确认后要创建版本并发布才生效。
      {!read.status && read.problem ? <span className="setup-step-warning">读不到权限状态：{read.problem}</span> : null}
      {view.warnings?.map(warning => <span key={warning} className="setup-step-warning">{warning}</span>)}
    </>}
    trailing={<span className="setup-step-trailing">
      <StatusBadge tone={view.tone} variant="pill">{view.status}</StatusBadge>
      <Button size="sm" disabled={disabled || !url}
        onClick={() => { if (url) void openExternalUrl(url, 'app-console', shell).then(onOpened, error => onError(error instanceof Error ? error.message : '无法打开飞书开发者后台。')); }}>一键开权限</Button>
    </span>}/>;
}

/** A failed latest read must not look healthy just because a previous read succeeded. */
export function connectionNeedsAttention(agent: Agent, read: ScopeRead): boolean {
  const view = grantView(read, false);
  return Boolean(read.problem || (read.status && (!view.done || view.warnings?.length)) || agent.readError ||
    (agent.enabled && agent.connection !== 'connected') || (!agent.enabled && agent.running) || agent.activation === 'restartRequired');
}

/** One poll supplies both the collapsed summary and the full grant controls. */
export function BotConnectionSettings({agent, disabled, onError, onSetup, onRefreshCredentials, onDiagnostics}: {
  agent: Agent; disabled: boolean; onError: (message: string) => void;
  onSetup: () => void; onRefreshCredentials: () => void; onDiagnostics: () => void;
}) {
  const [openedGrant, setOpenedGrant] = useState(false);
  const read = useScopeStatus(agent.id, openedGrant ? GRANT_POLL_MS : GRANT_ROW_POLL_MS);
  const view = grantView(read.problem ? {problem: read.problem} : read, false);
  const details = useRef<HTMLDetailsElement>(null);
  const attention = connectionNeedsAttention(agent, read);
  useEffect(() => { if (attention && details.current) details.current.open = true; }, [attention]);
  return <details ref={details} className="agent-settings-disclosure bot-settings-connection" id={settingAnchor('连接与权限')}>
    <summary><span className="bot-settings-connection-title">连接与权限<small data-search-title="应用 ID">应用 ID · <code>{agent.id}</code></small></span><StatusBadge tone={view.tone}>{view.status}</StatusBadge></summary>
    <SettingsGroup>
      <SettingsRow title="连接与设置" description="检测权限、事件与发布状态。" onClick={onSetup}/>
      {read.problem && read.status && <p className="setup-step-warning" role="status">读不到最新权限状态：{read.problem}</p>}
      <ScopeGrantRowContent read={read} disabled={disabled} onError={onError} onOpened={() => setOpenedGrant(true)}/>
      <SettingsRow title="刷新飞书凭据" description="重新扫码，保留群聊、会话和设置。" trailing={<Button size="sm" disabled={disabled} onClick={onRefreshCredentials}>重新扫码</Button>}/>
      <SettingsRow title="状态与诊断" description="查看连接问题与运行日志。" trailing={<Button size="sm" onClick={onDiagnostics}>查看</Button>}/>
    </SettingsGroup>
  </details>;
}
