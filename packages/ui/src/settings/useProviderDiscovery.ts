import {useCallback, useEffect, useRef, useState} from 'react';
import type {ToolState} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {providerBackends, providerInstalled, providerUsable} from '../setup/provider-state';

export type DiscoveredProvider = {id: string; displayName: string};
type Discovery = {providers: DiscoveredProvider[]; checking: boolean; message?: string};
const failureText = (error: unknown) => error instanceof Error ? error.message : 'Provider 状态读取失败，请重试。';

/** Snapshot authentication is cached; an installed Claude needs the SDK login probe on first discovery. */
export function useProviderDiscovery(tools?: readonly ToolState[]) {
  const client = useClient();
  const readiness = tools?.map(tool => `${tool.tool}:${tool.installation}:${tool.compatibility?.status}:${tool.authentication}`).join('|') ?? 'snapshot';
  const [attempt, setAttempt] = useState(0);
  const key = readiness;
  const [result, setResult] = useState<Discovery & {key: string}>({key, providers: [], checking: true});
  // Share only in-flight work across effect restarts (including StrictMode). The daemon
  // owns the login TTL; later known → unknown snapshot transitions must probe again.
  const pending = useRef<Promise<{state: ToolState['authentication']; message: string}> | undefined>(undefined);
  const checkedAttempt = useRef(0);
  const retry = useCallback(() => {
    setResult(previous => ({...previous, providers: previous.providers.filter(provider => provider.id !== 'claude-agent'), checking: true, message: undefined}));
    setAttempt(value => value + 1);
  }, []);
  useEffect(() => {
    let active = true;
    setResult(previous => ({...previous, checking: true, message: undefined}));
    void (async () => {
      const [reply, source] = await Promise.all([client.environment({type: 'backendCatalog'}), tools ? Promise.resolve(tools) : client.snapshot().then(snapshot => snapshot.tools)]);
      if (reply.kind !== 'backends') throw new Error(reply.kind === 'refused' ? reply.message : 'Provider 目录读取失败。');
      const usableProviders = (states: readonly ToolState[]) => reply.entries.filter(entry => (Object.entries(providerBackends) as Array<['codex' | 'claude', string]>).some(([tool, backend]) => backend === entry.id && providerUsable(states.find(item => item.tool === tool))))
        .map(entry => ({id: entry.id, displayName: entry.displayName}));
      let states = [...source];
      const claude = states.find(tool => tool.tool === 'claude');
      let message: string | undefined;
      const force = attempt > checkedAttempt.current;
      if (providerInstalled(claude) && (claude?.authentication === 'unknown' || force || pending.current)) {
        checkedAttempt.current = attempt;
        // Claude probing can be slow. Keep independently usable providers available.
        if (active) setResult({key, providers: usableProviders(states), checking: true});
        try {
          pending.current ??= client.environment({type: 'backendLogin', id: 'claude-agent', refresh: force}).then(answer => {
            if (answer.kind !== 'backendLogin' || answer.id !== 'claude-agent') throw new Error(answer.kind === 'refused' ? answer.message : 'Claude 登录状态读取失败。');
            return {state: answer.state, message: answer.message};
          });
          let answer: {state: ToolState['authentication']; message: string};
          try {answer = await pending.current;} finally {pending.current = undefined;}
          states = states.map(tool => tool.tool === 'claude' ? {...tool, authentication: answer.state} : tool);
          if (answer.state === 'signedOut') message = 'Claude 尚未登录，请在 Provider 页面登录后重新检查。';
          else if (answer.state === 'unknown') message = answer.message || '暂时无法确认 Claude 登录状态，请重新检查。';
        } catch (error) {
          states = states.map(tool => tool.tool === 'claude' ? {...tool, authentication: 'unknown'} : tool);
          message = `Claude 登录检查失败：${failureText(error)}`;
        }
      } else if (providerInstalled(claude) && claude?.authentication === 'signedOut') {
        message = 'Claude 尚未登录，请在 Provider 页面登录后重新检查。';
      }
      const providers = usableProviders(states);
      if (active) setResult({key, providers, checking: false, message});
    })().catch(error => {if (active) setResult({key, providers: [], checking: false, message: failureText(error)});});
    return () => {active = false;};
  }, [client, readiness, attempt]);
  const current: Discovery = result.key === key ? result : {providers: [], checking: true};
  return {...current, retry};
}
