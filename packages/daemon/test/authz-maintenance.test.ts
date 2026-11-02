import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@vonvon/protocol';
import { MAINTENANCE_STRIKES } from '../src/server/authz';
import { socketClient, startFixture } from './server-fixture';

/** devices 4.7 and devices-4a 4.4: a connection of another protocol only checks, updates or stops the daemon. */
describe('the maintenance subset', () => {
  // main 必败: refused as permission_denied, with no versions, and never closed
  it('refuses the rest with both versions, answers the subset, and closes after 20 refusals in a row', async () => {
    const fixture = await startFixture();
    try {
      const newer = PROTOCOL_VERSION + 1;
      const client = await socketClient(fixture.api.port, fixture.credential, newer);
      await client.ready();
      expect(client.frames[0]).toMatchObject({ principal: 'maintenance' });
      const refused = await client.call({ type: 'request', id: 'r0', method: 'command', payload: { type: 'refresh' } });
      expect(refused).toMatchObject({ type: 'error', code: 'protocol_mismatch', details: { serverProtocol: PROTOCOL_VERSION, clientProtocol: newer, serverVersion: expect.any(String), clientVersion: null } });
      expect(await client.call({ type: 'request', id: 's', method: 'admin', payload: { type: 'daemonStatus' } })).toMatchObject({ type: 'response' });
      expect(await client.call({ type: 'request', id: 'u', method: 'machine', payload: { type: 'coreUpdateStatus' } })).toMatchObject({ type: 'response', payload: { type: 'coreUpdateStatus' } });
      // an answered request starts the count again
      for (let i = 1; i < MAINTENANCE_STRIKES; i++) {
        expect(await client.call({ type: 'request', id: `r${i}`, method: 'snapshot', payload: { type: 'get' } })).toMatchObject({ code: 'protocol_mismatch' });
      }
      expect(client.socket.readyState).toBe(client.socket.OPEN);
      const closed = new Promise<{ code: number; reason: string }>(resolve => client.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
      client.socket.send(JSON.stringify({ type: 'request', id: 'last', method: 'snapshot', payload: { type: 'get' } }));
      expect(await closed).toEqual({ code: 4001, reason: 'protocol_mismatch' });
      expect(client.frames.find(frame => frame.type === 'error' && frame.id === 'last')).toMatchObject({ code: 'protocol_mismatch' });
    } finally { await fixture.close(); }
  });

  it('keeps a 0.8 client\'s envelope as it parses it: no details', async () => {
    const fixture = await startFixture();
    try {
      const client = await socketClient(fixture.api.port, fixture.credential, 1);
      await client.ready();
      const refused = await client.call({ type: 'request', id: 'r', method: 'command', payload: { type: 'refresh' } });
      expect(refused).toMatchObject({ type: 'error', code: 'protocol_mismatch' });
      expect(refused).not.toHaveProperty('details');
      expect(await client.call({ type: 'request', id: 'stop', method: 'machine', payload: { type: 'stopHost' } })).toMatchObject({ type: 'response' });
      expect(fixture.control.requestStop).toHaveBeenCalledOnce();
      await client.close();
    } finally { await fixture.close(); }
  });
});
