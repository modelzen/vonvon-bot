import {useCallback, useEffect, useRef, useState} from 'react';
import {useClient} from '../client-context';
import {decisionNativeProviders, type DecisionCatalogs} from './DecisionPicker';

export function useDecisionCatalogs(enabled = true) {
  const client = useClient();
  const [catalogs, setCatalogs] = useState<DecisionCatalogs>({});
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    const results = await Promise.all(decisionNativeProviders.map(async provider => {
      try {
        const reply = await client.collaboration({action: 'providerModels', backend: provider.id});
        return [provider.id, reply.kind === 'providerModels' ? reply : {kind: 'providerModels', backend: provider.id, state: 'unavailable', models: [], message: reply.kind === 'refused' ? reply.message : '模型目录暂不可用。'}] as const;
      } catch {return [provider.id, {kind: 'providerModels', backend: provider.id, state: 'unavailable', models: [], message: '模型目录暂不可用。'}] as const;}
    }));
    if (request === serial.current) setCatalogs(Object.fromEntries(results) as DecisionCatalogs);
  }, [client]);
  useEffect(() => {if (!enabled) return; void refresh(); return () => {serial.current++;};}, [refresh, enabled]);
  return {catalogs, refresh};
}
