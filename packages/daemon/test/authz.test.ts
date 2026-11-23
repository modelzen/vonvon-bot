import { expect, it } from 'vitest';
import { DRAIN_KINDS, MAINTENANCE_KINDS, rpcKinds, type Request } from '@vonvon/protocol';
import { authorize, RULES } from '../src/server/authz';
import type { Principal } from '../src/server/principal';

const peer = (principal: Principal) => ({ principal, protocolVersion: principal.kind === 'maintenance' ? 1 : 2, negotiated: false, scope: null });
const request = (method: string, payload: object): Request => ({ type: 'request', id: '1', method, payload } as Request);

// devices 5.2: a new RPC kind is refused until the table names it. main 必败: there was no table.
it('has one row for every RPC kind and no row for anything else', () => {
  const kinds = rpcKinds().map(entry => entry.kind);
  expect(kinds.filter(kind => !RULES.has(kind))).toEqual([]);
  expect([...RULES.keys()].filter(kind => !kinds.includes(kind))).toEqual([]);
  for (const kind of MAINTENANCE_KINDS) expect(RULES.get(kind)?.maintenance).toBe(true);
  for (const kind of DRAIN_KINDS) expect(RULES.has(kind)).toBe(true);
});
it('lets the owner do everything, a connection of another protocol only the maintenance kinds', async () => {
  const owner = peer({ kind: 'owner', via: 'local' });
  const old = peer({ kind: 'maintenance', protocolVersion: 1, inner: 'owner:local' });
  expect(await authorize(owner, request('command', { type: 'refresh' }))).toEqual({ ok: true });
  expect(await authorize(owner, request('machine', { type: 'service', action: 'start' }))).toEqual({ ok: true });
  expect(await authorize(old, request('command', { type: 'refresh' }))).toMatchObject({ ok: false, code: 'protocol_mismatch', details: { serverProtocol: 2, clientProtocol: 1 } });
  expect(await authorize(old, request('admin', { type: 'daemonStatus' }))).toEqual({ ok: true });
  // a 0.8 desktop or CLI still stops a newer daemon (devices 4.5), by the shared constant D4a enforces, not a local exception
  expect(MAINTENANCE_KINDS).toContain('machine.stopHost');
  expect(await authorize(old, request('machine', { type: 'stopHost' }))).toEqual({ ok: true });
  expect(await authorize(peer({ kind: 'unpaired' }), request('admin', { type: 'daemonStatus' }))).toMatchObject({ ok: false, code: 'permission_denied' });
  expect(await authorize(owner, request('command', { type: 'notAKind' }))).toMatchObject({ ok: false, code: 'permission_denied' });
  expect(await authorize(owner, request('recipeAuthoring', { type: 'richUnknown' }))).toMatchObject({ ok: false, code: 'permission_denied' });
});

// s1b, owner 2026-11-02: a group session's cells are a whitelist, written out row by row. main 必败.
it('gives a group session only what its work needs, and the not-dm sentence for the settings writes', () => {
  const cells = (want: (cell: string) => boolean) => [...RULES].filter(([, rule]) => want(rule.places.group)).map(([kind]) => kind).sort();
  expect(cells(cell => cell === 'host')).toEqual(['admin.negotiate', 'command.listGroupMembers', 'snapshot.get']);
  expect(cells(cell => cell === 'bot')).toEqual(['command.feishuRead', 'memory.add', 'memory.archive', 'memory.edit', 'memory.list',
    'schedule.create', 'schedule.delete', 'schedule.edit', 'schedule.list', 'schedule.pause', 'schedule.resume', 'schedule.runNow']);
  expect(cells(cell => cell === 'not-dm')).toEqual(['collaboration.createProject', 'collaboration.editProject', 'command.setPermission', 'command.setResponse',
    'settings.act.adminMember', 'settings.act.commentInstructions', 'settings.act.projectAudience', 'settings.act.projectMember', 'settings.act.voice',
    'settings.read.agent', 'settings.read.project', 'settings.read.session', 'settings.save.agent', 'settings.save.project', 'settings.save.session']);
  // the queries a group no longer has: the bot's groups, the settings' models and sessions, history, the library, daemonStatus
  for (const kind of ['command.refresh', 'command.listPendingGroups', 'command.listJoinedGroups', 'settings.models', 'settings.sessions', 'collaboration.history',
    'collaboration.context', 'collaboration.project', 'collaboration.providerModels', 'library.list', 'admin.daemonStatus', 'memory.export', 'memory.events']) {
    expect(RULES.get(kind)?.places.group, kind).toBe('deny');
  }
  // dm-agent 5: who has a private chat is the owner's page, no session's: another administrator's name is not this one's to read
  expect(RULES.get('memory.dmPeople')?.places).toEqual({ dm: 'deny', group: 'deny', comment: 'deny' });
  // dm-agent 3.3. main 必败: the list never changes by chat, a private chat's included
  expect(RULES.get('settings.act.adminMember')?.places).toEqual({ dm: 'deny', group: 'not-dm', comment: 'not-dm' });
  // dm-agent 6.2: a private chat reads what a turn may; a comment's own group-less reads none of these either
  expect(RULES.get('library.list')?.places).toEqual({ dm: 'bot', group: 'deny', comment: 'deny' });
  expect(RULES.get('settings.models')?.places).toEqual({ dm: 'bot', group: 'deny', comment: 'deny' });
});
