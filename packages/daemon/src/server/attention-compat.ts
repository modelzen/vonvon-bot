import type {DesktopSnapshot} from '@vonvon/protocol';
import type {Outgoing} from './remote-outbox';

/** Older v2 clients parse attention records strictly. Send group fields only after opt-in. */
export function attentionSnapshot(snapshot: DesktopSnapshot, enabled: boolean): DesktopSnapshot {
  if (enabled) return snapshot;
  const {attentionModel: _model, ...legacy} = snapshot;
  return {...legacy, agents: snapshot.agents.map(agent => {
    const attention = agent.diagnostics?.attention;
    if (!attention) return agent;
    return {...agent, diagnostics: {...agent.diagnostics!, attention: attention.map(({group: _group, ...place}) => place)}};
  })};
}

export function attentionFrame<T extends Outgoing>(value: T, enabled: boolean): T {
  if (enabled) return value;
  if ((value.type === 'event' && value.event === 'snapshot') || (value.type === 'response' && value.method === 'snapshot')) {
    return {...value, payload: attentionSnapshot(value.payload, false)};
  }
  if (value.type === 'response' && value.method === 'command') {
    const payload = value.payload as typeof value.payload & {snapshot?: DesktopSnapshot};
    if (payload.snapshot) return {...value, payload: {...payload, snapshot: attentionSnapshot(payload.snapshot, false)}};
  }
  return value;
}
