import { describe, expect, it } from 'vitest';
import { fromIpcReply, toIpcReply, type AgentCallReply } from '../src/agent/entry/ipc-codec';

describe('agent IPC reply boundary', () => {
  it.each<AgentCallReply | 'unauthorized'>([
    'unauthorized', { ok: true, result: { place: 'group' } },
    { ok: false, code: 'revoked', message: 'expired' },
    { ok: true, tools: [{ name: 'session_info', description: 'fixture', inputSchema: { type: 'object' } }] },
  ])('round-trips a valid reply without changing authorization', reply => {
    expect(fromIpcReply(toIpcReply(reply))).toEqual(reply);
  });
  it('encodes unauthorized only at the IPC boundary', () => {
    expect(toIpcReply('unauthorized')).toEqual({ unauthorized: true });
    expect(fromIpcReply({ unauthorized: true })).toBe('unauthorized');
  });
  it.each([undefined, null, {}, 'unauthorized', { unauthorized: false }, { unauthorized: true, ok: true },
    { ok: false }, { ok: false, code: 'other', message: 'no' }, { ok: true, tools: [null] },
  ])('rejects malformed IPC data: %j', value => {
    expect(() => fromIpcReply(value)).toThrow();
  });
});
