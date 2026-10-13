import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  advance, legacyExpired, ownershipOf, readLedger, readLegacy, startToken, writeLedger,
  type Evidence, type HostPlatform, type LedgerRecord, type Stage,
} from '../../src/provider/process/ledger';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function ledgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vonvon-ledger-'));
  dirs.push(dir);
  return join(dir, 'process-owners.json');
}

const holder = { pid: 4100, start: startToken('linux:boot:123') };
function record(stage: Stage, id = 'r1'): LedgerRecord {
  const base = { id, daemonBootId: 'boot-a', providerId: 'codex' as const, sessionId: 's1' };
  switch (stage) {
    case 'intent': return { ...base, stage };
    case 'born': case 'attempting': return { ...base, stage, holder };
    case 'launched': case 'running': return { ...base, stage, holder, provider: { pid: 4101 } };
  }
}
const stages: Stage[] = ['intent', 'born', 'attempting', 'launched', 'running'];
const platforms: HostPlatform[] = ['posix', 'win32'];

describe('stage order', () => {
  const legal: Record<HostPlatform, string[]> = {
    posix: ['intent>born', 'born>attempting', 'attempting>launched', 'launched>running'],
    win32: ['intent>born', 'born>attempting', 'attempting>running'],
  };
  it.each(platforms)('allows exactly the %s stage order and throws on every other transition', platform => {
    for (const from of stages) for (const to of stages) {
      const step = () => advance(record(from), record(to), platform);
      if (legal[platform].includes(`${from}>${to}`)) expect(step()).toEqual(record(to));
      else expect(step, `${from}>${to}`).toThrow(/illegal ledger transition/);
    }
  });
  it('refuses to advance one reservation into another', () => {
    expect(() => advance(record('intent', 'r1'), record('born', 'r2'), 'posix')).toThrow(/illegal/);
  });
});

describe('ownershipOf', () => {
  const evidence: Evidence[] = [
    { kind: 'retained' }, { kind: 'no-provider' }, { kind: 'unsealed' },
    ...(['empty', 'live', 'unknown'] as const).map(probe => ({ kind: 'reaped' as const, probe })),
    ...(['empty', 'live', 'unknown', 'none'] as const).map(probe => ({ kind: 'sealed' as const, probe })),
  ];
  function expected(stage: Stage, e: Evidence, platform: HostPlatform): string {
    if (stage === 'intent' || stage === 'born') return 'inert';
    if (e.kind === 'retained') return 'bound';
    if (e.kind === 'no-provider') return 'gone';
    if (e.kind === 'sealed' && stage === 'attempting' && platform === 'posix') return 'gone';
    if (e.kind === 'sealed' && e.probe === 'empty') return 'gone';
    if (e.kind === 'reaped' && e.probe === 'empty' && stage === 'running') return 'gone';
    return 'unknown';
  }
  it('derives every stage, evidence, and platform combination', () => {
    for (const platform of platforms) for (const stage of stages) for (const e of evidence) {
      expect(ownershipOf(record(stage), e, platform), `${platform} ${stage} ${JSON.stringify(e)}`).toBe(expected(stage, e, platform));
    }
  });
  it('pins the documented edge cases', () => {
    expect(ownershipOf(record('born'), { kind: 'retained' }, 'posix')).toBe('inert');
    expect(ownershipOf(record('attempting'), { kind: 'sealed', probe: 'none' }, 'posix')).toBe('gone');
    expect(ownershipOf(record('attempting'), { kind: 'sealed', probe: 'none' }, 'win32')).toBe('unknown');
    expect(ownershipOf(record('attempting'), { kind: 'sealed', probe: 'empty' }, 'win32')).toBe('gone');
    expect(ownershipOf(record('running'), { kind: 'sealed', probe: 'live' }, 'posix')).toBe('unknown');
    expect(ownershipOf(record('running'), { kind: 'unsealed' }, 'posix')).toBe('unknown');
    expect(ownershipOf(record('launched'), { kind: 'reaped', probe: 'empty' }, 'posix')).toBe('unknown');
  });
});

describe('process-owners.json', () => {
  it('round-trips every stage and deletes the file once empty', () => {
    const path = ledgerPath();
    expect(readLedger(path)).toEqual({ kind: 'missing' });
    const records = stages.map((stage, index) => record(stage, `r${index}`));
    records[0] = { ...records[0]!, control: { pipe: '\\\\.\\pipe\\vonvon-r0', jobName: 'Local\\vonvon-r0', osSession: 1 } };
    writeLedger(path, records);
    expect(readLedger(path)).toEqual({ kind: 'ok', records });
    writeLedger(path, []);
    expect(readLedger(path)).toEqual({ kind: 'missing' });
  });

  it.each([
    ['not JSON', '{'],
    ['an unknown stage', { version: 1, records: [{ ...record('intent'), stage: 'spawned' }] }],
    ['a launched record without a provider', { version: 1, records: [{ ...record('attempting'), stage: 'launched' }] }],
    ['an intent record with a pid', { version: 1, records: [{ ...record('intent'), holder }] }],
    ['a duplicate reservation', { version: 1, records: [record('born'), record('running')] }],
    ['one bad record among good ones', { version: 1, records: [record('running', 'a'), { ...record('born', 'b'), holder: { pid: -1 } }] }],
  ])('reports %s as unreadable and leaves the bytes alone', (_name, content) => {
    const path = ledgerPath();
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    writeFileSync(path, text);
    expect(readLedger(path).kind).toBe('unreadable');
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('keeps the previous file when the process dies between write and rename', () => {
    const path = ledgerPath();
    const old = [record('running')];
    writeLedger(path, old);
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('crash before rename'); });
    expect(() => writeLedger(path, [record('intent', 'r2')])).toThrow('crash before rename');
    expect(readLedger(path)).toEqual({ kind: 'ok', records: old });
    writeLedger(path, [record('intent', 'r2')]);
    expect(readLedger(path)).toEqual({ kind: 'ok', records: [record('intent', 'r2')] });
    expect(readdirSync(join(path, '..'))).toEqual(['process-owners.json']);
  });
});

describe('legacy owned-pids.json', () => {
  it('lists a record until the host boots after its start, then retires it', () => {
    const path = join(ledgerPath(), '..', 'owned-pids.json');
    const legacy = { pid: 77, startedAtMs: 1_000_000, daemonBootId: 'old', providerId: 'codex', sessionId: 's' };
    writeFileSync(path, JSON.stringify([legacy, { pid: 'x' }]));
    const [only, ...rest] = readLegacy(path);
    expect(rest).toEqual([]);
    expect(only).toEqual(legacy);
    expect(legacyExpired(only!, 999_000)).toBe(false);
    expect(legacyExpired(only!, 1_000_000)).toBe(false);
    expect(legacyExpired(only!, 1_000_001)).toBe(true);
  });
  it('reads a missing or corrupt legacy file as no records', () => {
    const path = join(ledgerPath(), '..', 'owned-pids.json');
    expect(readLegacy(path)).toEqual([]);
    writeFileSync(path, 'nope');
    expect(readLegacy(path)).toEqual([]);
  });
});
