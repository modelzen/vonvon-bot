import {useEffect, useState} from 'react';
import type {HostSettingsView} from '@vonvon/protocol';
import {useClient} from '../client-context';

type Configuration = NonNullable<HostSettingsView['sections']['judge']>['effective'];
export type DecisionConfigurationState = {kind: 'loading'} | {kind: 'ready'; configuration: Configuration} | {kind: 'failed'};

/** Re-read shared configuration when opening or returning to the group form. */
export function useDecisionConfiguration(enabled: boolean): DecisionConfigurationState {
  const client = useClient();
  const [state, setState] = useState<DecisionConfigurationState>({kind: 'loading'});
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setState({kind: 'loading'});
    void client.settings({type: 'read', scope: {kind: 'host'}}).then(reply => {
      if (!active) return;
      const section = reply.kind === 'view' && reply.view.scope.kind === 'host' && 'runtime' in reply.view ? reply.view.sections.judge : undefined;
      setState(section ? {kind: 'ready', configuration: section.effective} : {kind: 'failed'});
    }).catch(() => {if (active) setState({kind: 'failed'});});
    return () => {active = false;};
  }, [client, enabled]);
  return state;
}
