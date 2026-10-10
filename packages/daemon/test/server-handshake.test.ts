import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { startFixture, socketClient } from './server-fixture';

describe('local WebSocket handshake', () => {
  it('accepts credentials, keeps a positive different version, and emits no unsolicited snapshot', async () => {
    const fixture = await startFixture();
    try {
      const client = await socketClient(fixture.api.port, fixture.credential, 2);
      await client.ready();
      expect(client.frames).toHaveLength(1);
      expect(client.socket.extensions).toBe('');
      if (process.platform !== 'win32') expect((await stat(join(fixture.home, 'local-credential'))).mode & 0o777).toBe(0o600);
      expect((await readFile(join(fixture.home, 'local-credential'), 'utf8')).trim()).toHaveLength(64);
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
  }, 10_000);

});
