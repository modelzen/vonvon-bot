import { beforeAll, describe, expect, it } from 'vitest';
import { rpcKinds } from '@vonvon/protocol';
import type { CommandInfo } from '../src/cli/index';
import { CLI_PARITY_ALLOWLIST, type ParityEntry } from '../src/cli/parity-allowlist';
import { loadCommands } from './helpers/cli-commands';

/**
 * devices 8.5: each RPC kind is covered by a command or listed in the allowlist with why, never both; a command covers
 * only kinds the protocol has; an allowlist line names a kind the protocol has, unless it says which slice adds it.
 */
function parityProblems(kinds: readonly string[], commands: readonly CommandInfo[], allowlist: Readonly<Record<string, ParityEntry>>): string[] {
  const known = new Set(kinds);
  const covered = new Map<string, string[]>();
  for (const command of commands) for (const kind of command.covers) covered.set(kind, [...covered.get(kind) ?? [], command.path]);
  const problems: string[] = [];
  for (const kind of kinds) {
    if (!covered.has(kind) && !Object.hasOwn(allowlist, kind)) problems.push(`${kind}: no command covers it and the allowlist does not name it`);
    if (covered.has(kind) && Object.hasOwn(allowlist, kind)) problems.push(`${kind}: covered by ${covered.get(kind)!.join(', ')} and still in the allowlist`);
  }
  for (const [kind, paths] of covered) if (!known.has(kind)) problems.push(`${kind}: ${paths.join(', ')} covers a kind the protocol does not have`);
  for (const [kind, entry] of Object.entries(allowlist)) {
    if (entry.arrives && known.has(kind)) problems.push(`${kind}: in the protocol now, so the allowlist line drops arrives: ${entry.arrives}`);
    if (!entry.arrives && !known.has(kind)) problems.push(`${kind}: in the allowlist, but the protocol has no such kind`);
    const needsSlice = entry.reason === 'pending' || entry.reason === 'dead';
    if (needsSlice !== Boolean(entry.slice)) problems.push(`${kind}: ${entry.reason} ${needsSlice ? 'needs the slice that ends it' : 'takes no slice'}`);
    if (!entry.note.trim()) problems.push(`${kind}: the allowlist line says nothing`);
  }
  return problems;
}

const kinds = rpcKinds().map(entry => entry.kind);
let commands: CommandInfo[] = [];
beforeAll(async () => { commands = await loadCommands(); });

describe('CLI parity with the RPC kinds (devices 8.5)', () => {
  it('keeps every rich authoring RPC on the signed-in desktop', () => {
    const richAuthoring = kinds.filter(kind => kind.startsWith('recipeAuthoring.rich'));
    expect(richAuthoring).toHaveLength(9);
    for (const kind of richAuthoring) expect(CLI_PARITY_ALLOWLIST[kind], kind).toMatchObject({ reason: 'desktop-only' });
  });

  // main 必败: there was no covers metadata and no allowlist
  it('covers every kind or names it in the allowlist, and nothing else', () => {
    expect(parityProblems(kinds, commands, CLI_PARITY_ALLOWLIST)).toEqual([]);
  });

  it('goes red when a command stops covering its kind, covers an unknown one, or the allowlist goes stale', () => {
    const stop = commands.find(command => command.path === 'daemon stop');
    expect(stop?.covers).toEqual(['machine.stopHost']);
    const without = commands.map(command => command === stop ? { ...command, covers: [] } : command);
    expect(parityProblems(kinds, without, CLI_PARITY_ALLOWLIST)).toEqual(['machine.stopHost: no command covers it and the allowlist does not name it']);
    const unknown = [...commands, { path: 'x', hidden: false, covers: ['command.nope'], options: [] }];
    expect(parityProblems(kinds, unknown, CLI_PARITY_ALLOWLIST)).toEqual(['command.nope: x covers a kind the protocol does not have']);
    const both = { ...CLI_PARITY_ALLOWLIST, 'machine.stopHost': { reason: 'unused', note: 'x' } } as const;
    expect(parityProblems(kinds, commands, both)).toEqual(['machine.stopHost: covered by daemon stop and still in the allowlist']);
    // a line registered before its kind exists drops `arrives` once the protocol has it
    const early = { ...CLI_PARITY_ALLOWLIST, 'remote.later': { reason: 'pending', slice: 'D3', note: 'x', arrives: 'D3' } } as const;
    expect(parityProblems(kinds, commands, early)).toEqual([]);
    expect(parityProblems([...kinds, 'remote.later'], commands, early)).toEqual(['remote.later: in the protocol now, so the allowlist line drops arrives: D3']);
    const loose = { ...CLI_PARITY_ALLOWLIST, 'library.previous': { reason: 'pending', note: 'x' } } as const;
    expect(parityProblems(kinds, commands, loose)).toEqual(['library.previous: pending needs the slice that ends it']);
  });

  // main 必败: the device kinds were not in the protocol and no command covered them
  // D3: the four remote kinds are covered now, and nothing waits for D3. main 必败: they were pending('D3').
  it('covers every device kind, the remote ones with vonvon remote (devices 8.1 SLICE-1, D3 4.8)', () => {
    expect(Object.values(CLI_PARITY_ALLOWLIST).filter(entry => entry.arrives)).toEqual([]);
    const covered = new Map(commands.flatMap(command => command.covers.map(kind => [kind, command.path] as const)));
    expect(['device.pair', 'device.clients', 'device.renameClient', 'device.revokeClient', 'device.rename'].map(kind => covered.get(kind)))
      .toEqual(['pair', 'clients ls', 'clients rename', 'clients revoke', 'device rename']);
    expect(['device.status', 'device.enable', 'device.disable', 'device.setPort'].map(kind => covered.get(kind)))
      .toEqual(['remote status', 'remote enable', 'remote disable', 'remote port']);
    expect(Object.entries(CLI_PARITY_ALLOWLIST).filter(([, entry]) => entry.slice === 'D3')).toEqual([]);
    expect(CLI_PARITY_ALLOWLIST['admin.negotiate']).toMatchObject({ reason: 'internal' });
  });

  it('covers the update kinds I3 brings: vonvon update ends their pending lines (server-3)', () => {
    for (const kind of ['machine.checkCoreUpdate', 'machine.applyCoreUpdate', 'machine.coreUpdateStatus']) {
      expect(CLI_PARITY_ALLOWLIST[kind], kind).toBeUndefined();
      expect(commands.find(command => command.path === 'update')?.covers, kind).toContain(kind);
    }
  });

  // main 必败: C8's kinds were pending, admin.logs superseded by machine.logs
  it('covers the machine kinds C8 brings: daemon logs takes admin.logs, so machine.logs is the superseded one', () => {
    for (const kind of ['machine.mcp.list', 'machine.mcp.add', 'machine.mcp.remove', 'machine.bridgeImport.detect', 'machine.bridgeImport.preflight', 'machine.bridgeImport.start',
      'machine.bridgeImport.status', 'machine.bridgeImport.rollback', 'machine.setServiceSkipped', 'admin.followLogs', 'contextPreview.get', 'admin.logs']) {
      expect(CLI_PARITY_ALLOWLIST[kind], kind).toBeUndefined();
      expect(commands.some(command => command.covers.includes(kind)), kind).toBe(true);
    }
    expect(CLI_PARITY_ALLOWLIST['machine.logs']).toMatchObject({ reason: 'superseded' });
    expect(commands.find(command => command.path === 'daemon logs')?.options).toContain('--follow');
  });

  // main 必败: only settings, feishu and schedule took --json
  it('gives every command --json but `daemon run` and the hidden ones', () => {
    const missing = commands.filter(command => !command.hidden && command.path !== 'daemon run' && !command.options.includes('--json')).map(command => command.path);
    expect(missing).toEqual([]);
    // the reads that rebuild first, and memory list's archived entries (devices 8.1)
    for (const path of ['bot list', 'bot status', 'group list']) expect(commands.find(command => command.path === path)?.options, path).toContain('--fresh');
    expect(commands.find(command => command.path === 'memory list')?.options).toContain('--all');
  });
});
