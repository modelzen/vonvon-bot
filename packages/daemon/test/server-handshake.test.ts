import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@vonvon/protocol';
import { FIXTURE_STARTED_AT, startFixture, socketClient } from './server-fixture';

describe('local WebSocket handshake', () => {
  it('accepts credentials, keeps a positive different version, and emits no unsolicited snapshot', async () => {
    const fixture = await startFixture();
    try {
      const client = await socketClient(fixture.api.port, fixture.credential, PROTOCOL_VERSION + 1);
      await client.ready();
      expect(client.frames).toHaveLength(1);
      expect(client.socket.extensions).toBe('');
      if (process.platform !== 'win32') expect((await stat(join(fixture.home, 'local-credential'))).mode & 0o777).toBe(0o600);
      expect((await readFile(join(fixture.home, 'local-credential'), 'utf8')).trim()).toHaveLength(64);
      await client.close();
    } finally { await fixture.close(); }
  });

  // devices 4.5 旧的也能停新的: a 0.8 client parses this strictly. main 必败: it got the current protocol and startedAt.
  it('answers a protocol 1 hello in the old shape and lets it only check, update or stop', async () => {
    const fixture = await startFixture();
    try {
      const client = await socketClient(fixture.api.port, fixture.credential, 1);
      await client.ready();
      expect(Object.keys(client.frames[0] ?? {}).sort()).toEqual(['machineId', 'protocolVersion', 'type', 'version']);
      expect(client.frames[0]).toMatchObject({ type: 'serverInfo', protocolVersion: 1 });
      const status = await client.call({ type: 'request', id: 's', method: 'admin', payload: { type: 'daemonStatus' } });
      expect(status).toMatchObject({ type: 'response', payload: { kind: 'daemonStatus', status: { running: true } } });
      expect(JSON.stringify(status)).not.toContain('startedAt');
      expect(await client.call({ type: 'request', id: 'r', method: 'command', payload: { type: 'refresh' } })).toMatchObject({ type: 'error', code: 'permission_denied' });
      await client.close();
    } finally { await fixture.close(); }
  });

  it('answers a current hello with the device, its capabilities and who the connection is, and negotiates once', async () => {
    const fixture = await startFixture();
    try {
      const client = await socketClient(fixture.api.port, fixture.credential);
      await client.ready();
      expect(client.frames[0]).toMatchObject({ protocolVersion: PROTOCOL_VERSION, deviceName: expect.any(String), platform: expect.any(String), principal: 'owner:local' });
      expect(client.frames[0]).toHaveProperty('capabilities', expect.arrayContaining(['device']));
      expect(await client.call({ type: 'request', id: 's', method: 'admin', payload: { type: 'daemonStatus' } })).toMatchObject({ payload: { status: { startedAt: FIXTURE_STARTED_AT } } });
      const negotiate = (id: string) => ({ type: 'request' as const, id, method: 'admin' as const, payload: { type: 'negotiate' as const, capabilities: ['device'] } });
      expect(await client.call(negotiate('n1'))).toMatchObject({ type: 'response', payload: { kind: 'negotiated', principal: 'owner:local', scope: null } });
      expect(await client.call(negotiate('n2'))).toMatchObject({ type: 'error', code: 'invalid_request' });
      await client.close();
    } finally { await fixture.close(); }
  });

  // main 必败: serverInfo said only `device`, so no client offered a remote update (devices-ui-2 4.11).
  it.each([['standalone', ['update.standalone']], ['global-npm', ['update.npm']], ['bundled', []]] as const)('reports what a %s install can update', async (kind, update) => {
    const fixture = await startFixture(undefined, undefined, undefined, async () => ({ kind }));
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const client = await socketClient(fixture.api.port, fixture.credential);
      await client.ready();
      expect((client.frames[0] as { capabilities: string[] }).capabilities).toEqual(['device', ...update]);
      await client.close();
    } finally { await fixture.close(); }
  });

  it.each([undefined, 'bad'])('rejects credential %s with 4401', async credential => {
    const fixture = await startFixture();
    try {
      const client = await socketClient(fixture.api.port, credential);
      const code = await new Promise<number>(resolve => client.socket.once('close', code => resolve(code)));
      expect(code).toBe(4401);
    } finally { await fixture.close(); }
  });

  it('rejects another first frame and a non-loopback Origin', async () => {
    const fixture = await startFixture();
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${fixture.api.port}`);
      const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)));
      await new Promise<void>(resolve => socket.once('open', resolve));
      socket.send(JSON.stringify({ type: 'request', id: 'early', method: 'snapshot', payload: { type: 'get' } }));
      expect(await closed).toBe(4401);
      const forbidden = new WebSocket(`ws://127.0.0.1:${fixture.api.port}`, { origin: 'https://evil.example' });
      expect(await new Promise<string>(resolve => forbidden.once('error', error => resolve(error.message)))).toContain('403');
    } finally { await fixture.close(); }
  });

  it('keeps the socket usable after unknown methods and invalid payloads', async () => {
    const fixture = await startFixture();
    try {
      const client = await socketClient(fixture.api.port, fixture.credential);
      await client.ready();
      client.socket.send(JSON.stringify({ type: 'request', id: 'unknown', method: 'missing', payload: {} }));
      expect(await client.wait(frame => frame.type === 'error' && frame.id === 'unknown')).toMatchObject({ code: 'unknown_method' });
      client.socket.send(JSON.stringify({ type: 'request', id: 'invalid', method: 'snapshot', payload: {} }));
      expect(await client.wait(frame => frame.type === 'error' && frame.id === 'invalid')).toMatchObject({ code: 'invalid_request' });
      expect(await client.call({ type: 'request', id: 'good', method: 'snapshot', payload: { type: 'get' } })).toMatchObject({ type: 'response', payload: { revision: 1 } });
      await client.close();
    } finally { await fixture.close(); }
  });
  it('closes a silent first connection at the five-second authentication deadline', async () => {
    const fixture = await startFixture();
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${fixture.api.port}`);
      const code = await new Promise<number>(resolve => socket.once('close', code => resolve(code)));
      expect(code).toBe(4401);
    } finally { await fixture.close(); }
  });

});
