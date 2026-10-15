import {useEffect, useState} from 'react';
import type {AdminSetupStatus, AgentId, Job} from '@vonvon/protocol';
import {useClient, useShellCapabilities} from '../client-context';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button, StatusBadge} from '../reference/components/ui';
import {openExternalUrl} from '../url-actions';
import {scopeStep, type StepTone} from './setupPresentation';
import {stepDescription} from './SetupChecklist';
import './setup.css';

/** Faster than the checklist (10 s): the user is waiting on this one screen. */
export const GRANT_POLL_MS = 5_000;
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

export type ScopeRead = {status?: AdminSetupStatus; problem?: string};
/** Reads one bot's setupStatus. With `pollMs` it keeps reading until the required scopes read granted;
 * without, it reads once. A failed read keeps the last good status. */
export function useScopeStatus(agentId: AgentId, pollMs?: number): ScopeRead {
  const client = useClient();
  const [read, setRead] = useState<ScopeRead>({});
  useEffect(() => {
    let current = true;
    const stop = pollEvery(pollMs ?? 0, async () => {
      try {
        const reply = await client.admin({type: 'setupStatus', agentId});
        if (reply.kind !== 'setupStatus') throw new Error('检测结果格式不对。');
        if (current) setRead({status: reply.status});
        return pollMs !== undefined && reply.status.scopes.missingRequired?.length !== 0;
      } catch (error) {
        if (current) setRead(previous => ({status: previous.status, problem: error instanceof Error ? error.message : '检测失败，请稍后重试。'}));
        return pollMs !== undefined;
      }
    });
    return () => { current = false; stop(); };
  }, [client, agentId, pollMs]);
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

/** Bot 设置 → 连接与权限: the same grant link, read once when the page opens. */
export function ScopeGrantRow({agentId, disabled, onError}: {agentId: AgentId; disabled: boolean; onError: (message: string) => void}) {
  const shell = useShellCapabilities();
  const read = useScopeStatus(agentId);
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
        onClick={() => { if (url) void openExternalUrl(url, 'app-console', shell).catch(error => onError(error instanceof Error ? error.message : '无法打开飞书开发者后台。')); }}>一键开权限</Button>
    </span>}/>;
}
