import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { VonvonClient } from '@vonvon/client';
import { agentIdSchema, type SettingsRequest } from '@vonvon/protocol';
import { commandFailure, CommandError } from '../src/cli/command-error';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import { runSettingsSet, runSettingsAccess } from '../src/cli/commands/settings';
import { runFeishu } from '../src/cli/commands/feishu';

const scope = { kind: 'agent', botId: agentIdSchema.parse('cli_test') } as const;
const value = { stored: { showToolCalls: true }, effective: { showToolCalls: true }, revision: 'latest', access: { kind: 'writable' }, apply: [] };
function harness(settings: (request: SettingsRequest) => Promise<unknown>, run: (request: unknown) => Promise<unknown> = vi.fn(async () => ({ kind: 'groups', groups: [], nextCursor: 'next' }))) {
  let out = '';
  const close = vi.fn(async () => {});
  const daemon: Daemon = fn => withDaemon(fn, async () => ({
    snapshot: async () => ({ agents: [{ id: 'cli_test', name: 'Test' }] }), settings, run, close,
  }) as unknown as VonvonClient);
  return { daemon, io: { json: true, write: (text: string) => { out += text; } }, out: () => JSON.parse(out), close };
}
it('sends the caller revision unchanged and reports authorized current on conflict without retry', async () => {
  const settings = vi.fn(async (request: SettingsRequest) => request.type === 'read'
    ? { kind: 'view', view: { scope, sections: { cards: value } } }
    : { kind: 'saved', result: { kind: 'conflict', current: { scope, section: 'cards', value } } });
  const h = harness(settings);
  const error = await runSettingsSet(['cards.showToolCalls=false'], { revision: 'old', reason: 'test' }, h.io, h.daemon).catch(error => error);
  expect(commandFailure(error)).toMatchObject({ exitCode: 5, error: { kind: 'conflict', current: { value: { revision: 'latest' } } } });
  expect(settings.mock.calls.filter(([r]) => r.type === 'save')).toEqual([[{ type: 'save', edit: { scope, section: 'cards', revision: 'old', patch: { showToolCalls: false } } }]]);
  expect(h.close).toHaveBeenCalledOnce();
});
it('keeps terminal field patches compatible and retains reason only after a saved result', async () => {
  const h = harness(async request => request.type === 'read' ? { kind: 'view', view: { scope, sections: { cards: value } } }
    : { kind: 'saved', result: { kind: 'saved', section: { scope, section: 'cards', value }, effects: [] } });
  await runSettingsSet(['cards.showToolCalls=false'], { reason: 'requested' }, h.io, h.daemon);
  expect(h.out()).toMatchObject({ section: { value: { revision: 'latest' } }, reason: 'requested' });
});
it('returns the shared access structure and Feishu pagination without converting a failure to empty success', async () => {
  const h = harness(async () => ({ kind: 'view', view: { scope, sections: { cards: value } } }));
  await runSettingsAccess({}, h.io, h.daemon);
  expect(h.out()).toEqual({ access: { cards: { kind: 'writable' } } });
  const groups = harness(async () => undefined);
  await runFeishu('groups', undefined, { cursor: 'before' }, groups.io, groups.daemon);
  expect(groups.out()).toEqual({ groups: [], nextCursor: 'next' });
  const failed = harness(async () => undefined, vi.fn(async () => { throw new Error('upstream'); }));
  await expect(runFeishu('groups', undefined, {}, failed.io, failed.daemon)).rejects.toThrow('upstream');
});
it.each([['bad-args', 2], ['connection', 3], ['refused', 4], ['conflict', 5], ['outcome-unknown', 6], ['failed', 1]] as const)('serializes %s with a stable exit code', (kind, exitCode) => {
  expect(JSON.parse(JSON.stringify(commandFailure(new CommandError(kind, 'message'))))).toEqual({ ok: false, error: { kind, message: 'message' }, exitCode });
});
it('does not classify an unreadable save response as a retryable connection error', async () => {
  let saves = 0;
  const h = harness(async request => {
    if (request.type === 'read') return { kind: 'view', view: { scope, sections: { cards: value } } };
    saves++;
    throw Object.assign(new Error('reply schema'), { name: 'ZodError' });
  });
  const error = await runSettingsSet(['cards.showToolCalls=false'], {}, h.io, h.daemon).catch(error => error);
  expect(commandFailure(error)).toMatchObject({ exitCode: 6, error: { kind: 'outcome-unknown' } });
  expect(saves).toBe(1);
});

it('built CLI prints JSON on argument/connection failures without creating a data root or starting a daemon', async () => {
  const root = await mkdtemp(join(tmpdir(), 's47-cli-process-'));
  try {
    for (const [args, exitCode] of [
      [['settings', 'set', 'invalid', '--json'], 2],
      [['settings', 'set', '--json'], 2],
      [['settings', 'get', '--unknown', '--json'], 2],
      [['settings', 'get', '--json'], 3],
      [['feishu', 'groups', '--json'], 3],
      [['feishu', 'members', 'invalid', '--json'], 2],
    ] as const) {
      const child = spawnSync(process.execPath, ['bin/vonvon.mjs', ...args], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, HOME: join(root, 'home'), VONVON_HOME: join(root, 'data') },
      });
      expect(child.status, child.stderr).toBe(exitCode);
      expect(JSON.parse(child.stdout)).toMatchObject({ ok: false, exitCode });
      expect(child.stderr).toBe('');
    }
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 70_000);

it('strips transport reply envelopes from member results shared with MCP', async () => {
  const run = vi.fn(async () => ({ kind: 'members', members: [{ openId: 'synthetic-member', name: 'Fixture' }], nextCursor: 'more' }));
  const h = harness(async () => undefined, run);
  await runFeishu('members', 'oc_fixture', { cursor: 'page' }, h.io, h.daemon);
  expect(h.out()).toEqual({ members: [{ openId: 'synthetic-member', name: 'Fixture' }], nextCursor: 'more' });
  expect(run).toHaveBeenCalledWith({ type: 'listGroupMembers', agentId: 'cli_test', groupId: 'oc_fixture', cursor: 'page' });
});
