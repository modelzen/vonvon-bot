import {useCallback, useEffect, useRef, useState} from 'react';
import type {AdminSetupStatus, AgentId} from '@vonvon/protocol';
import {RpcError} from '@vonvon/client/browser';
import {useClient} from '../client-context';
import {remoteStepsDone} from '@vonvon/protocol';

export type SetupRead = {status?: AdminSetupStatus; problem?: string; checking: boolean};
/** Remote checks stop when done. Unverified callbacks then use a local-only read. */
export const SETUP_POLL_MS = 10_000;

/** Polls `setupStatus` one bot at a time while the checklist is open, and stops remote
 * reads once the Feishu steps are done. Receipt evidence still refreshes locally,
 * so manual confirmation can upgrade to verified. A failed read keeps the last good status. With
 * `poll: false` (the 状态与诊断 page) each bot is read once, and again only on recheck. */
export function useSetupStatus(agentIds: readonly AgentId[], {poll: polling = true}: {poll?: boolean} = {}) {
  const client = useClient();
  const [reads, setReads] = useState<Partial<Record<AgentId, SetupRead>>>({});
  // Kept beside the state so the loop sees a result before React re-renders.
  const statuses = useRef<Partial<Record<AgentId, AdminSetupStatus>>>({});
  const sequence = useRef<Partial<Record<AgentId, number>>>({});
  const callbackReadUnsupported = useRef(false);
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

  const readCallback = useCallback(async (agentId: AgentId) => {
    const mine = (sequence.current[agentId] ?? 0) + 1;
    sequence.current[agentId] = mine;
    try {
      const reply = await client.admin({type: 'cardCallbackStatus', agentId});
      if (sequence.current[agentId] !== mine) return;
      if (reply.kind !== 'cardCallbackStatus') { callbackReadUnsupported.current = true; return; }
      const previous = statuses.current[agentId];
      if (!previous) return;
      const status = {...previous, cardCallback: reply.cardCallback};
      statuses.current[agentId] = status;
      setReads(current => ({...current, [agentId]: {...current[agentId], status, checking: false}}));
    } catch (error) {
      // An older daemon cannot provide this extension. Keep its manual status;
      // transient connection errors retain the last result and retry next time.
      if (error instanceof RpcError && ['unsupported', 'invalid_request'].includes(error.code)) callbackReadUnsupported.current = true;
    }
  }, [client]);

  useEffect(() => {
    const ids: AgentId[] = JSON.parse(scope);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const needsRead = (id: AgentId) => !remoteStepsDone(statuses.current[id])
      || (!callbackReadUnsupported.current && !statuses.current[id]?.cardCallback.verifiedAt);
    async function poll() {
      if (running) return;
      running = true;
      clearTimeout(timer);
      for (const id of ids) {
        if (!live) return;
        if (!remoteStepsDone(statuses.current[id])) await read(id);
        else if (polling && needsRead(id)) await readCallback(id);
      }
      running = false;
      if (polling && live && ids.some(needsRead)) timer = setTimeout(() => void poll(), SETUP_POLL_MS);
    }
    wake.current = () => { if (live && !running) void poll(); };
    void poll();
    return () => {
      live = false; clearTimeout(timer); wake.current = () => {};
      for (const id of ids) sequence.current[id] = (sequence.current[id] ?? 0) + 1;
    };
  }, [scope, read, readCallback, polling]);

  /** Re-reads one bot now, and resumes polling if it turned out unfinished. */
  const recheck = useCallback(async (agentId: AgentId) => {
    await read(agentId);
    if (polling) wake.current();
  }, [read, polling]);
  return {reads, recheck};
}
