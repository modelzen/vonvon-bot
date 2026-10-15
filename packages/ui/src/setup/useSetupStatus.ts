import {useCallback, useEffect, useRef, useState} from 'react';
import type {AdminSetupStatus, AgentId} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {remoteStepsDone} from '@vonvon/protocol';

export type SetupRead = {status?: AdminSetupStatus; problem?: string; checking: boolean};
/** Each read makes several Feishu calls per bot, so only unfinished bots are polled. */
export const SETUP_POLL_MS = 10_000;

/** Polls `setupStatus` one bot at a time while the checklist is open, and stops once
 * every bot's Feishu steps are done. A failed read keeps the last good status. With
 * `poll: false` (the 状态与诊断 page) each bot is read once, and again only on recheck. */
export function useSetupStatus(agentIds: readonly AgentId[], {poll: polling = true}: {poll?: boolean} = {}) {
  const client = useClient();
  const [reads, setReads] = useState<Partial<Record<AgentId, SetupRead>>>({});
  // Kept beside the state so the loop sees a result before React re-renders.
  const statuses = useRef<Partial<Record<AgentId, AdminSetupStatus>>>({});
  const sequence = useRef<Partial<Record<AgentId, number>>>({});
  const wake = useRef<() => void>(() => {});
  const scope = JSON.stringify([...agentIds].sort());

  const read = useCallback(async (agentId: AgentId) => {
    const mine = (sequence.current[agentId] ?? 0) + 1;
    sequence.current[agentId] = mine;
    const settle = (next: (previous: SetupRead | undefined) => SetupRead) => {
      if (sequence.current[agentId] === mine) setReads(current => ({...current, [agentId]: next(current[agentId])}));
    };
    settle(previous => ({...previous, checking: true}));
    try {
      const reply = await client.admin({type: 'setupStatus', agentId});
      if (reply.kind !== 'setupStatus') throw new Error('检测结果格式不对。');
      if (sequence.current[agentId] === mine) statuses.current[agentId] = reply.status;
      settle(() => ({status: reply.status, checking: false}));
    } catch (error) {
      settle(previous => ({status: previous?.status, problem: error instanceof Error ? error.message : '检测失败，请稍后重试。', checking: false}));
    }
  }, [client]);

  useEffect(() => {
    const ids: AgentId[] = JSON.parse(scope);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    async function poll() {
      if (running) return;
      running = true;
      clearTimeout(timer);
      for (const id of ids) {
        if (!live) return;
        if (!remoteStepsDone(statuses.current[id])) await read(id);
      }
      running = false;
      if (polling && live && ids.some(id => !remoteStepsDone(statuses.current[id]))) timer = setTimeout(() => void poll(), SETUP_POLL_MS);
    }
    wake.current = () => { if (live && !running) void poll(); };
    void poll();
    return () => { live = false; clearTimeout(timer); wake.current = () => {}; };
  }, [scope, read, polling]);

  /** Re-reads one bot now, and resumes polling if it turned out unfinished. */
  const recheck = useCallback(async (agentId: AgentId) => {
    await read(agentId);
    if (polling) wake.current();
  }, [read, polling]);
  return {reads, recheck};
}
