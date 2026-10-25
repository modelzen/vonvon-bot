import type {Command, CommandResult, DesktopSnapshot, Job} from '@vonvon/protocol';
import {withRegisteredAgent, type RegisterModal} from './GrantStep';

export function canRetryRegistration(job: Job | undefined, now = Date.now()): boolean {
  return !job || job.phase === 'failed' || job.phase === 'cancelled' ||
    (job.phase === 'qr' && job.expiresAt <= now);
}

type RetryContext = {
  modal: RegisterModal;
  current: () => boolean;
  latest: () => DesktopSnapshot;
  read: () => Promise<DesktopSnapshot>;
  run: (command: Command) => Promise<CommandResult>;
};
type RetryResult = {kind: 'ready'; modal: RegisterModal} | {kind: 'blocked'; message: string} | {kind: 'ignored'};
const blocked = (message: string): RetryResult => ({kind: 'blocked', message});

/** A synchronous lock also covers double clicks before React commits the busy state. */
export function createRegistrationRetry() {
  let pending = false;
  const uncertainStarts = new Set<string>();
  return async ({modal, current, latest, read, run}: RetryContext): Promise<RetryResult> => {
    if (pending || !current()) return {kind: 'ignored'};
    if (uncertainStarts.has(modal.jobId)) return blocked('上次重新注册的结果还无法确认，请关闭弹窗并检查 Bot 列表。');
    pending = true;
    let starting = false;
    try {
      const before = latest();
      const job = before.jobs.find(item => item.id === modal.jobId);
      if (modal.agentId || job?.phase === 'succeeded') return {kind: 'ready', modal: withRegisteredAgent(modal, before.jobs)};
      if (!canRetryRegistration(job)) return {kind: 'ignored'};
      if (modal.refresh && !modal.refreshAgentId) return blocked('无法确认要刷新的 Bot，请关闭后从该 Bot 的设置重新扫码。');
      const cancelled = await run({type: 'cancelJob', jobId: modal.jobId});
      if (!current()) return {kind: 'ignored'};
      if (cancelled.kind !== 'cancelled' && !(cancelled.kind === 'refused' && cancelled.code === 'unknown_job'))
        return blocked('未能确认旧注册已结束，请稍后重试。');

      // cancelJob waits for persistence, but its reply does not mean nothing was saved.
      const snapshot = await read();
      if (!current()) return {kind: 'ignored'};
      if (snapshot.host.kind !== 'connected') return blocked('暂时无法读取后台状态，请恢复连接后重试。');
      const previous = snapshot.jobs.find(item => item.id === modal.jobId);
      if (previous?.phase === 'succeeded') return {kind: 'ready', modal: withRegisteredAgent(modal, snapshot.jobs)};
      if (previous && !['failed', 'cancelled'].includes(previous.phase))
        return blocked('旧注册仍在处理中，请等待完成。');
      if (!modal.refresh && (!modal.initialAgentIds || snapshot.agents.some(agent => !modal.initialAgentIds!.includes(agent.id))))
        return blocked('Bot 列表已有变化，注册可能已完成。请关闭弹窗并检查 Bot 列表，避免重复注册。');
      if (snapshot.jobs.some(item => item.type === 'registerAgent' && item.id !== modal.jobId && !['failed', 'cancelled', 'succeeded'].includes(item.phase)))
        return blocked('已有其他注册正在进行，请关闭弹窗并检查当前注册状态。');

      starting = true;
      const result = await run(modal.refreshAgentId
        ? {type: 'refreshAgentCredentials', agentId: modal.refreshAgentId}
        : {type: 'registerAgent'});
      starting = false;
      if (result.kind === 'outcomeUnknown' || (result.kind === 'refused' && result.code === 'ipc-failed')) uncertainStarts.add(modal.jobId);
      if (!current()) {
        if (result.kind === 'started') await run({type: 'cancelJob', jobId: result.jobId});
        return {kind: 'ignored'};
      }
      if (result.kind !== 'started') return blocked(result.kind === 'refused' || result.kind === 'outcomeUnknown'
        ? result.message : '未能重新开始注册，请稍后重试。');
      return {kind: 'ready', modal: withRegisteredAgent({...modal, jobId: result.jobId}, latest().jobs)};
    } catch (error) {
      if (starting) uncertainStarts.add(modal.jobId);
      return current() ? blocked(error instanceof Error ? error.message : '无法确认注册状态，请稍后重试。') : {kind: 'ignored'};
    } finally { pending = false; }
  };
}
