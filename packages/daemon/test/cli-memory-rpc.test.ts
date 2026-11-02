import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from '@vonvon/protocol';

/** cli-5-memory-rpc: `vonvon memory` goes through the daemon's memory RPC, recorded as the command line's. */
const fakes = vi.hoisted(() => ({ action: vi.fn(), item: vi.fn() }));
vi.mock('../src/admin/memory', async original => ({ ...await original<object>(), memoryAction: fakes.action }));
vi.mock('../src/cli/commands/memory', async original => ({ ...await original<object>(), runMemoryItem: fakes.item }));
import { fakeService, socketClient, startFixture } from './server-fixture';
import { authorize, SESSION_DENIED } from '../src/server/authz';

afterEach(() => { fakes.action.mockReset(); fakes.item.mockReset(); });
const request = (id: string, payload: object): Request => ({ type: 'request', id, method: 'memory', payload } as Request);
const ADD = { type: 'add', scope: { kind: 'project', projectId: 'prj_0000000a' }, text: '周四发版' };

describe('the memory RPC', () => {
  // devices 5.2 under the table: the command line is `cli`, the web page and the desktop `ui`
  it('writes as the command line for the cli client and as the owner UI for the web page', async () => {
    fakes.action.mockResolvedValue({ kind: 'branches', branches: [], moved: 0 });
    const fixture = await startFixture(fakeService());
    try {
      for (const [clientKind, origin] of [['cli', 'cli'], ['web', 'ui'], ['desktop', 'ui']] as const) {
        const client = await socketClient(fixture.api.port, fixture.credential, undefined, undefined, clientKind);
        await client.ready();
        expect(await client.call(request(clientKind, ADD))).toMatchObject({ type: 'response', method: 'memory' });
        expect(fakes.action).toHaveBeenLastCalledWith(ADD, { origin });
        await client.close();
      }
      // C5: the web page's 删除分支 as one write
      const client = await socketClient(fixture.api.port, fixture.credential);
      await client.ready();
      const remove = { type: 'branchDelete', scope: { kind: 'bot', botId: 'cli_a' }, name: '发版', expected: 2 };
      expect(await client.call(request('d', remove))).toMatchObject({ type: 'response', payload: { kind: 'branches' } });
      expect(fakes.action).toHaveBeenLastCalledWith(remove, { origin: 'cli' });
      await client.close();
    } finally { await fixture.close(); }
  });

  // devices 5.2: no memory tool deletes a branch, so no Bot session may
  it('refuses branchDelete to every Bot session, and lets the owner', async () => {
    const remove = request('d', { type: 'branchDelete', scope: { kind: 'bot', botId: 'cli_x' }, name: '发版' });
    for (const place of ['dm', 'group', 'comment'] as const) {
      const principal = { kind: 'bot-session' as const, sessionId: 'ses_0123456789abcdef', appId: 'cli_x', place, ...(place === 'comment' ? {} : { chatId: 'oc_y' }) };
      expect(await authorize({ principal, protocolVersion: 2, negotiated: true, scope: { bot: 'cli_x', ...(place === 'group' ? { group: 'oc_y' } : {}) } }, remove))
        .toEqual({ ok: false, code: 'permission_denied', message: SESSION_DENIED });
    }
    expect(await authorize({ principal: { kind: 'owner' as const, via: 'local' as const }, protocolVersion: 2, negotiated: false, scope: null }, remove)).toEqual({ ok: true });
  });
});

describe('vonvon memory archive', () => {
  /** The CLI entry runs its command line as it loads: under `--version` it only prints. */
  async function program() {
    const argv = process.argv;
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    process.argv = [argv[0] ?? 'node', 'vonvon', '--version'];
    try { return (await import('../src/cli/index')).program; }
    finally { process.argv = argv; write.mockRestore(); }
  }

  // main 必败: the command was forget, and archive did not exist
  it('is the web page\'s word, and forget still names it', async () => {
    const cli = await program();
    for (const name of ['archive', 'forget']) {
      await cli.parseAsync(['memory', name, 'i1', '--revision', '2', '--project', '研发'], { from: 'user' });
      expect(fakes.item).toHaveBeenLastCalledWith('archive', 'i1', expect.objectContaining({ revision: '2', project: '研发' }), expect.anything());
    }
    expect(fakes.item).toHaveBeenCalledTimes(2);
  });
});
