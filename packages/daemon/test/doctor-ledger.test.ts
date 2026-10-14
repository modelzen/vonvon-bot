import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { readStartToken } from '../src/provider/process/identity';
import { startToken, type HostPlatform, type LedgerRecord, type StartToken } from '../src/provider/process/ledger';
import { inspectLedger } from '../src/provider/process/process-host';

vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: () => ({ doctor: async () => ({ ok: true, version: 'fixture', location: '/fixture/codex' }) }) }));

const PLATFORM: HostPlatform = process.platform === 'win32' ? 'win32' : 'posix';
const dirs: string[] = [];
let kill: MockInstance<typeof process.kill>;
beforeEach(() => { kill = vi.spyOn(process, 'kill'); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vonvon-doctor-'));
  dirs.push(dir);
  return dir;
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await once(child, 'exit');
  return child.pid!;
}

async function liveHolder(): Promise<{ pid: number; start: StartToken }> {
  const read = await readStartToken(process.pid);
  if (read === 'absent' || read === 'unreadable') throw new Error(`cannot read this process's start token: ${read}`);
  return { pid: process.pid, start: read };
}

function writeIndentedLedger(dir: string, records: LedgerRecord[]): Buffer {
  const path = join(dir, 'process-owners.json');
  writeFileSync(path, JSON.stringify({ version: 1, records }, null, 2));
  return readFileSync(path);
}

const base = { daemonBootId: 'boot-old', providerId: 'codex' as const };

describe('inspectLedger', () => {
  it('derives ownership from outside the daemon without signalling, retiring, or writing', async () => {
    const dir = dataDir();
    const gone = await exitedPid();
    const before = writeIndentedLedger(dir, [
      { ...base, id: 'intent', stage: 'intent' },
      { ...base, id: 'live-holder', stage: 'running', holder: await liveHolder(), provider: { pid: process.pid } },
      { ...base, id: 'holder-gone', stage: 'running', holder: { pid: gone, start: startToken('fixture:gone') }, provider: { pid: gone } },
    ]);
    const listing = readdirSync(dir);

    const inspection = await inspectLedger(dir, PLATFORM);

    expect(inspection).toMatchObject({ kind: 'ok', path: join(dir, 'process-owners.json') });
    if (inspection.kind !== 'ok') throw new Error('expected records');
    expect(inspection.records.map(r => [r.id, r.stage, r.holderPid, r.ownership])).toEqual([
      ['intent', 'intent', undefined, 'inert'],
      ['live-holder', 'running', process.pid, 'unknown'],
      ['holder-gone', 'running', gone, PLATFORM === 'posix' ? 'gone' : 'unknown'],
    ]);
    expect(readFileSync(join(dir, 'process-owners.json')).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(listing);
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  });

  it('reports an unreadable ledger as such and leaves it byte for byte', async () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'process-owners.json'), '{"version":1,"records":[{"id":');
    const inspection = await inspectLedger(dir, PLATFORM);
    expect(inspection.kind).toBe('unreadable');
    expect(readFileSync(join(dir, 'process-owners.json'), 'utf8')).toBe('{"version":1,"records":[{"id":');
  });

  it('reports a missing ledger without creating one', async () => {
    const dir = dataDir();
    expect(await inspectLedger(dir, PLATFORM)).toEqual({ kind: 'missing', path: join(dir, 'process-owners.json') });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('doctor', () => {
  it('lists every ledger record, the supervisor\'s and each bot process\'s, and fails on an unknown one', async () => {
    const home = dataDir();
    const bot = join(home, 'bots', 'cli_fixture');
    mkdirSync(bot, { recursive: true });
    writeIndentedLedger(home, [{ ...base, id: 'supervisor-intent', stage: 'intent' }]);
    writeIndentedLedger(bot, [{ ...base, id: 'bot-unknown', stage: 'running', holder: await liveHolder(), provider: { pid: process.pid } }]);
    vi.stubEnv('VONVON_HOME', home);
    vi.resetModules();
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { printed.push(args.join(' ')); });
    const exitCode = process.exitCode;
    try {
      await (await import('../src/cli/commands/doctor')).runDoctor();
      const text = printed.join('\n');
      expect(text).toMatch(/✅ agent 进程记录\s+\S*process-owners\.json，1 条\n\s+supervisor-intent codex intent holder - inert/);
      expect(text).toMatch(new RegExp(`❌ agent 进程记录\\s+\\S*cli_fixture\\S*process-owners\\.json，1 条\\n\\s+bot-unknown codex running holder ${process.pid} unknown`));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
      vi.unstubAllEnvs();
    }
  });
});
