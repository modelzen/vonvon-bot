import {useEffect, useState} from 'react';
import type {VonvonClient} from '@vonvon/client/browser';
import type {AdminSetupStatus, AgentId, Job, JobId} from '@vonvon/protocol';
import {useClient, useShellCapabilities} from '../client-context';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button, StatusBadge} from '../reference/components/ui';
import {openExternalUrl} from '../url-actions';
import {scopeStep, type StepTone} from '@vonvon/protocol';
import {stepDescription} from './SetupChecklist';
import './setup.css';

/** Faster than the checklist (10 s): the user is waiting on this one screen. */
export const GRANT_POLL_MS = 5_000;
/** Bot 设置 re-reads slowly until the user opens the grant link there, then at {@link GRANT_POLL_MS}. */
export const GRANT_ROW_POLL_MS = 30_000;
export const PUBLISH_NOTE = '在飞书确认后，要创建版本并发布才生效；首次运行清单会继续检测。';

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
export type RegisterModal = {kind: 'register'; jobId: JobId; refresh?: boolean; agentId?: AgentId};
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
export function useScopeStatus(agentId: AgentId, pollMs: number): ScopeRead {
  const client = useClient();
  const [read, setRead] = useState<ScopeRead>({});
  useEffect(() => watchScopeStatus(client, agentId, pollMs, setRead), [client, agentId, pollMs]);
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

/** Step 2 of 注册 Bot: the bot exists, now grant its Feishu scopes. Events, callback and publishing stay on the checklist. */
export function GrantStep({agentId, onOpenChecklist, onDone}: {agentId: AgentId; onOpenChecklist: () => void; onDone: () => void}) {
  const shell = useShellCapabilities();
  const read = useScopeStatus(agentId, GRANT_POLL_MS);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState('');
  const view = grantView(read, opened);
  async function grant(url: string) {
    setError('');
    try { await openExternalUrl(url, 'app-console', shell); setOpened(true); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '无法打开飞书开发者后台。'); }
  }
  return <>
    <p>机器人已注册。下一步：一键开权限，在飞书开发者后台确认预选好的权限。</p>
    <SettingsGroup label="第 2 步 · 开权限">
      <SettingsRow title="权限" description={stepDescription(view)}
        trailing={<span className="setup-step-trailing">
          <StatusBadge tone={view.tone} variant="pill">{view.status}</StatusBadge>
          {view.grantUrl && (!view.done || view.warnings?.length) ? <Button size="sm" variant={view.done ? 'secondary' : 'primary'} onClick={() => { if (view.grantUrl) void grant(view.grantUrl); }}>一键开权限</Button> : null}
        </span>}/>
    </SettingsGroup>
    {view.note && <p className="collaboration-footnote" role="status">{view.note}</p>}
    {error && <p className="settings-operation-message" role="alert">{error}</p>}
    <div className="desktop-actions">
      <Button onClick={onOpenChecklist}>去首次运行清单</Button>
      <Button variant={view.done ? 'primary' : 'secondary'} onClick={onDone}>完成</Button>
    </div>
  </>;
}

/** Bot 设置 → 连接与权限: the same grant link. It re-reads slowly, so a failed read or a grant made elsewhere
 * shows up, and at the dialog's pace once the user opened the link here. */
export function ScopeGrantRow({agentId, disabled, onError}: {agentId: AgentId; disabled: boolean; onError: (message: string) => void}) {
  const shell = useShellCapabilities();
  const [opened, setOpened] = useState(false);
  const read = useScopeStatus(agentId, opened ? GRANT_POLL_MS : GRANT_ROW_POLL_MS);
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
        onClick={() => { if (url) void openExternalUrl(url, 'app-console', shell).then(() => setOpened(true), error => onError(error instanceof Error ? error.message : '无法打开飞书开发者后台。')); }}>一键开权限</Button>
    </span>}/>;
}
