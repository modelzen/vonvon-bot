import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@vonvon/protocol';
import { fakeService, FIXTURE_STARTED_AT, startFixture, socketClient } from './server-fixture';

describe('local WebSocket handshake', () => {
  it('advertises native recipe callbacks when the authoring service is available',async()=>{
    const fixture=await startFixture(fakeService({recipeAuthoring:async()=>undefined}));
    try {
      const client=await socketClient(fixture.api.port,fixture.credential);
      await client.ready();
      expect(client.frames[0]).toHaveProperty('capabilities',expect.arrayContaining(['recipe.native-preview']));
      await client.close();
    } finally {await fixture.close();}
  });
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
      // devices 4.7: refused as another protocol's; a 0.8 client parses errors strictly, so the versions stay out of its envelope
      const refused = await client.call({ type: 'request', id: 'r', method: 'command', payload: { type: 'refresh' } });
      expect(refused).toMatchObject({ type: 'error', code: 'protocol_mismatch' });
      expect(refused).not.toHaveProperty('details');
      await client.close();
    } finally { await fixture.close(); }
  });

  it('answers a current hello with the device, its capabilities and who the connection is, and negotiates once', async () => {
    const fixture = await startFixture();
    try {
      const client = await socketClient(fixture.api.port, fixture.credential);
      await client.ready();
      expect(client.frames[0]).toMatchObject({ protocolVersion: PROTOCOL_VERSION, deviceName: expect.any(String), platform: expect.any(String), principal: 'owner:local' });
      expect(client.frames[0]).toHaveProperty('capabilities', expect.arrayContaining(['device', 'session-scope', 'attention.group']));
      expect(await client.call({ type: 'request', id: 's', method: 'admin', payload: { type: 'daemonStatus' } })).toMatchObject({ payload: { status: { startedAt: FIXTURE_STARTED_AT } } });
      const negotiate = (id: string) => ({ type: 'request' as const, id, method: 'admin' as const, payload: { type: 'negotiate' as const, capabilities: ['device'] } });
      expect(await client.call(negotiate('n1'))).toMatchObject({ type: 'response', payload: { kind: 'negotiated', principal: 'owner:local', scope: null } });
      expect(await client.call(negotiate('n2'))).toMatchObject({ type: 'error', code: 'invalid_request' });
      await client.close();
    } finally { await fixture.close(); }
  });

  // main 必败: serverInfo said only `device`, so no client offered a remote update (devices-ui-2 4.11). U4: the desktop app
  // updates the daemon it carries, except on Windows (owner 2026-11-02).
  const bundled = process.platform === 'win32' ? [] : ['update.bundled'];
  it.each([['standalone', ['update.standalone']], ['global-npm', ['update.npm']], ['bundled', bundled]] as const)('reports what a %s install can update', async (kind, update) => {
    const fixture = await startFixture(undefined, undefined, undefined, undefined, undefined, async () => ({ kind }));
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const client = await socketClient(fixture.api.port, fixture.credential);
      await client.ready();
      expect((client.frames[0] as { capabilities: string[] }).capabilities).toEqual(['device', 'session-scope', 'attention.group', ...update]);
      await client.close();
    } finally { await fixture.close(); }
  });

  // devices-ui-4: a Windows desktop app is not updated from another device in 0.9.0, so its daemon does not offer it.
  it('offers the desktop update on macOS and Linux only', async () => {
    // after the fixture's module, which mocks the paths http.ts reads
    const { capabilities } = await import('../src/server/http');
    expect(capabilities('bundled', false, 'darwin')).toEqual(['device', 'session-scope', 'attention.group', 'update.bundled']);
    expect(capabilities('bundled', true, 'linux')).toEqual(['device', 'session-scope', 'attention.group', 'remote', 'update.bundled']);
    expect(capabilities('bundled', false, 'win32')).toEqual(['device', 'session-scope', 'attention.group']);
    expect(capabilities('standalone', false, 'win32')).toContain('update.standalone');
  });

  it.each([undefined, 'bad'])('rejects credential %s with 4401', async credential => {
    const fixture = await startFixture();
    try {
      const client = await socketClient(fixture.api.port, credential);
      const code = await new Promise<number>(resolve => client.socket.once('close', code => resolve(code)));
      expect(code).toBe(4401);
    } finally { await fixture.close(); }
  });

  // devices-4a 4.4: a `vs1.` credential is a Bot session's token, looked up in the host's table and never compared with
  // local-credential. main 必败: it was compared and refused as `unauthorized`.
  it('takes a Bot session token as the session, and closes a bad one with invalid_session_token', async () => {
    const fixture = await startFixture();
    try {
      const token = fixture.sessionTokens.issue({ appId: 'cli_x', place: 'group', chatId: 'oc_y', sessionId: 'ses_0123456789abcdef' });
      const client = await socketClient(fixture.api.port, token);
      await client.ready();
      expect(client.frames[0]).toMatchObject({ protocolVersion: PROTOCOL_VERSION, principal: 'bot-session:group' });
      await client.close();
      // Codex review 256-2. main 必败: a session's hello named the device, its machine id, platform and capabilities.
      // Its command line reads the protocol (a version check) and who it is; a group's, a comment's and a private chat's alike.
      for (const [place, chatId, sessionId] of [['group', 'oc_y', 'ses_1111111111111111'], ['comment', undefined, 'ses_2222222222222222'], ['dm', 'oc_dm', 'ses_3333333333333333']] as const) {
        const issued = fixture.sessionTokens.issue({ appId: 'cli_x', place, ...(chatId ? { chatId } : {}), sessionId });
        const session = await socketClient(fixture.api.port, issued);
        await session.ready();
        expect(session.frames[0]).toEqual({ type: 'serverInfo', version: expect.any(String), protocolVersion: PROTOCOL_VERSION, principal: `bot-session:${place}` });
        await session.close();
      }
      const forged = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
      for (const credential of [forged, 'vs1.ses_0123456789abcdef.short', `vs1.ses_ffffffffffffffff.${'a'.repeat(43)}`]) {
        const bad = await socketClient(fixture.api.port, credential);
        const closed = await new Promise<{ code: number; reason: string }>(resolve => bad.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
        expect(closed).toEqual({ code: 4401, reason: 'invalid_session_token' });
      }
      fixture.sessionTokens.revoke('ses_0123456789abcdef');
      const revoked = await socketClient(fixture.api.port, token);
      expect(await new Promise<string>(resolve => revoked.socket.once('close', (_code, reason) => resolve(reason.toString())))).toBe('invalid_session_token');
      // the owner's credential is untouched
      const owner = await socketClient(fixture.api.port, fixture.credential);
      await owner.ready();
      expect(owner.frames[0]).toMatchObject({ principal: 'owner:local' });
      await owner.close();
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

it('advertises and marks unified attention only for a snapshot client that opted in', async () => {
  const fixture = await startFixture();
  try {
    const client = await socketClient(fixture.api.port, fixture.credential);
    await client.ready();
    expect((client.frames[0] as {capabilities: string[]}).capabilities).toContain('attention.group');
    const old = await client.call({type: 'request', id: 'old-attention', method: 'snapshot', payload: {type: 'get'}});
    expect(old.type === 'response' && old.method === 'snapshot' && old.payload.attentionModel).toBeUndefined();
    const opted = await client.call({type: 'request', id: 'group-attention', method: 'snapshot', payload: {type: 'get', groupAttention: true}});
    expect(opted.type === 'response' && opted.method === 'snapshot' && opted.payload.attentionModel).toBe('group');
    await client.close();
  } finally {await fixture.close();}
});
