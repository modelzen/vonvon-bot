import { createSdkMcpServer, tool, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, it, vi } from 'vitest';
import type { Request } from '@vonvon/protocol';
import { fakeService, socketClient, startFixture } from './server-fixture';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { createAgentEntries } from '../src/agent/entry/registry';

/**
 * devices 5.3: a session's token ends with the session. Codex review 230-1: a warm Claude process can go between two
 * turns (it exits, or its stream fails), when no turn is there to clean up after it.
 */
const BOT = 'cli_x';
const GROUP = 'oc_y';

it.each(['ends', 'fails'] as const)('ends the token, and the connections made with it, when the Claude process %s between turns', async how => {
  let stop: ((failure?: Error) => void) | undefined;
  const query = vi.fn<ClaudeSdkFacade['query']>(() => Object.assign((async function* (): AsyncGenerator<SDKMessage> {
    const failure = await new Promise<Error | undefined>(resolve => { stop = resolve; });
    if (failure) throw failure;
  })(), { close: () => stop?.(), interrupt: async () => {} }) as unknown as Query);
  const sdk = { query, listSessions: vi.fn(), getSessionInfo: vi.fn(), getSessionMessages: vi.fn(), renameSession: vi.fn(), createSdkMcpServer, tool } satisfies ClaudeSdkFacade;
  const fixture = await startFixture(fakeService());
  try {
    const entries = createAgentEntries({ appId: BOT, isAdmin: () => false, sessions: { revoke: sessionId => fixture.sessionTokens.revoke(sessionId) } });
    const entry = entries.issue({ kind: 'group', chatId: GROUP });
    const token = fixture.sessionTokens.issue({ appId: BOT, place: 'group', chatId: GROUP, sessionId: entry.sessionId });
    const thread = await new ClaudeAgentBackend(async () => sdk, () => undefined).startThread({ cwd: '/fixture', entry });
    entry.attach(thread);
    // A background command the last turn left behind, connected with the session's token.
    const client = await socketClient(fixture.api.port, token);
    await client.ready();
    const negotiate = { type: 'request', id: 'n', method: 'admin', payload: { type: 'negotiate', capabilities: ['cli'], scope: { bot: BOT, group: GROUP } } } as unknown as Request;
    expect(await client.call(negotiate)).toMatchObject({ type: 'response' });
    const closed = new Promise<[number, string]>(resolve => client.socket.once('close', (code, reason) => resolve([code, reason.toString()])));

    await vi.waitFor(() => expect(stop).toBeDefined());
    stop!(how === 'fails' ? new Error('claude exited') : undefined);
    await vi.waitFor(() => expect(thread.isAlive()).toBe(false));
    expect(await closed).toEqual([4401, 'invalid_session_token']);
    expect(fixture.sessionTokens.resolve(token)).toBeUndefined();
    // nor does a new hello with it get in
    const again = await socketClient(fixture.api.port, token);
    expect(await new Promise<[number, string]>(resolve => again.socket.once('close', (code, reason) => resolve([code, reason.toString()])))).toEqual([4401, 'invalid_session_token']);
    await thread.close();
  } finally { await fixture.close(); }
});
