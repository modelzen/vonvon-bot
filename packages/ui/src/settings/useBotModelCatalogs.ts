import {useCallback, useEffect, useRef, useState} from 'react';
import type {AgentId, ModelCatalog} from '@vonvon/protocol';
import {useClient} from '../client-context';

const providers = ['codex-appserver', 'claude-agent'] as const;

/** Keep the Bot/purpose boundary of settings.models, including cached fallback catalogs. */
export function useBotModelCatalogs(botId: AgentId, purpose: 'titles' | 'comments') {
  const client = useClient();
  const [catalogs, setCatalogs] = useState<Partial<Record<string, ModelCatalog>>>({});
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    setCatalogs({});
    await Promise.all(providers.map(async backend => {
      let catalog: ModelCatalog;
      try {
        const reply = await client.settings({type: 'models', query: {botId, backend, purpose}});
        if (reply.kind !== 'models' || reply.catalog.backend !== backend) throw new Error(reply.kind === 'refused' ? reply.message : '模型目录暂不可用。');
        catalog = reply.catalog;
      } catch (failure) {
        catalog = {backend, state: 'unavailable', source: 'backend-provided', observedAt: new Date().toISOString(), models: [], titleEfforts: [],
          error: failure instanceof Error ? failure.message : '模型目录暂不可用。'};
      }
      if (request === serial.current) setCatalogs(current => ({...current, [backend]: catalog}));
    }));
  }, [client, botId, purpose]);
  useEffect(() => {void refresh(); return () => {serial.current++;};}, [refresh]);
  return {catalogs, refresh};
}
