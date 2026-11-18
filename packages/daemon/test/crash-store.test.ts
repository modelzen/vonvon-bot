import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  readUnsentNotices, writeUnsentNoticesSync, type UnsentNotice, countInWindow, crashDir, crashErrorName, crashRecordFor, crashScopeKey, createCrashRecordCache, createSystemClock, hasCrashRecordFor, listCrashRecords,
  pruneCrashRecords, readBootId, readBotPauses, readCrashSummary, readNotices, readRunMarker, removeResumeRequest, sanitizeReason, startedBeforeThisBoot, stderrReason,
  takeResumeRequest, writeBotPausesSync, writeCrashRecordSync, writeNoticesSync, writeResumeRequest, writeRunMarkerSync, type Clock, type CrashRecord, type RunMarker,
} from '../src/host/crash-store';

// Passes through, so one test can cut a write short the way a full disk does.
vi.mock('node:fs', async original => {
  const real = await original<typeof import('node:fs')>();
  return { ...real, writeFileSync: vi.fn(real.writeFileSync) };
});

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const tempRoot = (): string => { const root = mkdtempSync(join(tmpdir(), 'vonvon-crash-store-')); roots.push(root); return root; };
const RUN = '11111111-1111-4111-8111-111111111111';
const CHAIN = '22222222-2222-4222-8222-222222222222';
const at = (ms: number): string => new Date(ms).toISOString();
const T0 = Date.parse('2026-10-16T05:00:00.000Z');
function record(fields: Partial<CrashRecord> = {}): CrashRecord {
  return {
    v: 1, at: at(T0), sysUptimeMs: 1_000_000, kind: 'exception', scope: 'host', pid: 4242, runId: RUN, chainId: CHAIN,
    startedAt: at(T0 - 60_000), uptimeMs: 60_000, version: '0.7.0', managed: null, during: 'run', reason: 'Error: boom', ...fields,
  };
}
const clock = (fields: Partial<{ now: number; uptimeMs: number; bootId: string | undefined }> = {}): Clock => ({
  now: () => fields.now ?? T0, uptimeMs: () => fields.uptimeMs ?? 1_000_000, bootId: () => fields.bootId,
});

describe('stderrReason', () => {
  // Node's own printout of an uncaught error, as this Node writes it: its first line, never the closing `Node.js vX`.
  it.each([
    ['an error thrown', "throw new TypeError('x')", 'TypeError: x'],
    ['a module that is not there', "require('/vonvon-no-such-module')", "Error: Cannot find module '/vonvon-no-such-module'"],
    ['an error with a cause', "throw new Error('a', { cause: new Error('b') })", 'Error: a'],
    ['a string thrown', "throw 'just text'", 'just text'],
    ['a rejection that is not an error', 'Promise.reject(42)', expect.stringMatching(/^UnhandledPromiseRejection: /)],
  ])('%s', (_label, source, expected) => {
    const { stderr } = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8' });
    const lines = stderr.split(/\r?\n/).filter(line => line.trim());
    expect(lines.at(-1)).toMatch(/^Node\.js v\d/);
    expect(stderrReason(lines)).toEqual(expected);
  });
  it('without the caret, the last error-like line; any other ending is the last line', () => {
    expect(stderrReason(['Error: early', 'TypeError: late', '    at x (y.js:1:1)', 'Node.js v24.0.0'])).toBe('TypeError: late');
    expect(stderrReason(['  ^', 'Node.js v24.0.0'])).toBeUndefined();
    expect(stderrReason(['Node.js v24.0.0'])).toBeUndefined();
    expect(stderrReason(['TypeError: logged earlier', 'fatal: no config'])).toBe('fatal: no config');
    expect(stderrReason([])).toBeUndefined();
  });
});

describe('sanitizeReason', () => {
  const home = '/home/operator';
  it.each([
    ['first line only, control characters removed', new Error('line one\tx\nline two'), 'Error: line onex'],
    ['a string', 'plain text', 'plain text'],
    ['an object', { a: 1 }, '[object Object]'],
    ['undefined', undefined, 'undefined'],
    ['a symbol', Symbol('s'), 'Symbol(s)'],
    ['an empty message', new Error(''), 'Error'],
    ['nothing at all', '   ', '(无说明)'],
    ['the home folder', new Error(`ENOENT: open '${home}/x/y.json'`), "Error: ENOENT: open '~/x/y.json'"],
    ['another macOS user', 'at /Users/alice/proj/a.ts', 'at ~/proj/a.ts'],
    ['another Linux user', 'read /home/bob/.codex/auth.json', 'read ~/.codex/auth.json'],
    ['Feishu ids', 'chat oc_abcdef1234567 user ou_zyxwvu9876543', 'chat 234567 user 876543'],
    ['a token', `token ${'a'.repeat(40)} end`, 'token [redacted] end'],
    ['URL credentials and query', 'GET https://user:pass@host.example/p/a?secret=1#f failed', 'GET https://host.example/p/a failed'],
  ])('%s', (_label, value, expected) => {
    expect(sanitizeReason(value, home)).toBe(expected);
  });
  it('cuts at 200 without splitting a surrogate pair', () => {
    expect(sanitizeReason('ab '.repeat(100), '/h')).toHaveLength(200);
    const prefix = `${'ab '.repeat(66)}c`;
    expect(sanitizeReason(`${prefix}😀tail`, '/h')).toBe(prefix);
  });
  it('names the error and its system code only', () => {
    expect(crashErrorName(Object.assign(new Error('listen'), { code: 'EADDRINUSE' }))).toBe('Error:EADDRINUSE');
    expect(crashErrorName(new TypeError('x'))).toBe('TypeError');
    expect(crashErrorName(Object.assign(new Error('x'), { code: 'not a code' }))).toBe('Error');
    expect(crashErrorName('string')).toBeUndefined();
    expect(crashErrorName(Object.assign(new Error('x'), { name: 'bad name!' }))).toBeUndefined();
  });
});

describe('records', () => {
  it('writes 0600 files in a 0700 directory with a fixed name and no temp file left', () => {
    const root = tempRoot();
    const name = writeCrashRecordSync(root, record());
    expect(name).toMatch(/^host-20261016T050000000Z-4242-[0-9a-f]{8}\.json$/);
    const bot = writeCrashRecordSync(root, record({ scope: 'bot', appId: 'cli_abc' }));
    expect(bot.startsWith(`${crashScopeKey('bot', 'cli_abc')}-`)).toBe(true);
    expect(crashScopeKey('bot', 'cli_abc')).toMatch(/^bot-[0-9a-f]{12}$/);
    expect(statSync(crashDir(root)).mode & 0o777).toBe(0o700);
    expect(statSync(join(crashDir(root), name)).mode & 0o777).toBe(0o600);
    expect(readdirSync(crashDir(root)).filter(entry => entry.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(crashDir(root), name), 'utf8'))).toEqual(record());
    expect(() => writeCrashRecordSync(root, record({ reason: '' }))).toThrow();
  });

  it('a write cut short (a full disk) leaves no temp file and the file before it as it was', async () => {
    const root = tempRoot();
    writeBotPausesSync(root, CHAIN, { cli_a: { resumedUptimeMs: 5 } });
    const { writeFileSync: realWrite } = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(writeFileSync).mockImplementationOnce((file, data, options) => {
      realWrite(file, String(data).slice(0, 8), options);
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    });
    expect(() => writeBotPausesSync(root, CHAIN, { cli_b: { resumedUptimeMs: 6 } })).toThrow('ENOSPC');
    expect(readdirSync(crashDir(root))).toEqual(['bot-pauses.json']);
    expect(readBotPauses(root, CHAIN)).toEqual({ cli_a: { resumedUptimeMs: 5 } });
  });

  it('lists newest first and skips foreign names, oversized files, bad JSON, bad shapes and a missing directory', () => {
    const root = tempRoot();
    expect(listCrashRecords(root)).toEqual([]);
    writeCrashRecordSync(root, record({ at: at(T0) }));
    writeCrashRecordSync(root, record({ at: at(T0 + 2000), kind: 'forced' }));
    writeCrashRecordSync(root, record({ at: at(T0 + 1000), scope: 'bot', appId: 'cli_abc' }));
    const dir = crashDir(root);
    writeFileSync(join(dir, 'notes.json'), JSON.stringify(record()));
    writeFileSync(join(dir, 'host-20261016T060000000Z-1-aaaaaaaa.json'), '{not json');
    writeFileSync(join(dir, 'host-20261016T060000001Z-1-bbbbbbbb.json'), JSON.stringify({ ...record(), extra: 1 }));
    writeFileSync(join(dir, 'host-20261016T060000002Z-1-cccccccc.json'), JSON.stringify({ ...record(), reason: 'x'.repeat(17_000) }));
    expect(listCrashRecords(root).map(entry => entry.at)).toEqual([at(T0 + 2000), at(T0 + 1000), at(T0)]);
    expect(listCrashRecords(root, { scope: 'host' }).map(entry => entry.kind)).toEqual(['forced', 'exception']);
    expect(listCrashRecords(root, { limit: 1 })).toEqual([]);
  });

  it('keeps the newest 50 per scope within 30 days and removes temp files older than an hour', () => {
    const root = tempRoot();
    for (let index = 0; index < 55; index++) writeCrashRecordSync(root, record({ at: at(T0 + index * 1000) }));
    writeCrashRecordSync(root, record({ at: at(T0 - 31 * 86_400_000), scope: 'bot', appId: 'cli_old' }));
    writeCrashRecordSync(root, record({ at: at(T0), scope: 'bot', appId: 'cli_new' }));
    const dir = crashDir(root);
    writeFileSync(join(dir, '.host-x.json.aaaa.tmp'), '');
    writeFileSync(join(dir, '.run.json.bbbb.tmp'), '');
    const old = (T0 - 2 * 3_600_000) / 1000;
    utimesSync(join(dir, '.host-x.json.aaaa.tmp'), old, old);
    expect(pruneCrashRecords(root, { now: T0 + 60_000, scope: crashScopeKey('bot', 'cli_old') })).toBe(1);
    expect(pruneCrashRecords(root, { now: Date.parse(at(T0)) + 60_000 })).toBe(5 + 1);
    const host = listCrashRecords(root, { scope: 'host' });
    expect(host).toHaveLength(50);
    expect(host.at(-1)?.at).toBe(at(T0 + 5000));
    expect(listCrashRecords(root, { scope: crashScopeKey('bot', 'cli_new') })).toHaveLength(1);
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual(['.run.json.bbbb.tmp']);
  });

  it('two processes writing at once leave 50 valid distinct records', async () => {
    const root = tempRoot();
    const bundle = join(root, 'store.cjs');
    await build({ entryPoints: [fileURLToPath(new URL('../src/host/crash-store.ts', import.meta.url))], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const code = `const m=require(${JSON.stringify(bundle)});for(let i=0;i<25;i++)m.writeCrashRecordSync(process.argv[1],${JSON.stringify(record())});`;
    const exits = await Promise.all([0, 1].map(() => new Promise<number | null>(resolve => {
      spawn(process.execPath, ['-e', code, root], { stdio: 'inherit' }).once('exit', resolve);
    })));
    expect(exits).toEqual([0, 0]);
    expect(new Set(readdirSync(crashDir(root)).filter(name => name.startsWith('host-'))).size).toBe(50);
    expect(listCrashRecords(root)).toHaveLength(50);
  }, 30_000);
});

describe('counting', () => {
  const now = 2_000_000;
  it.each([
    ['600 000 ms back is in', { sysUptimeMs: now - 600_000 }, 1],
    ['600 001 ms back is out', { sysUptimeMs: now - 600_001 }, 0],
    ['5 s ahead (clock jitter) is in', { sysUptimeMs: now + 5000 }, 1],
    ['another chain', { chainId: '33333333-3333-4333-8333-333333333333' }, 0],
    ['during a requested restart', { during: 'restart' as const }, 0],
    ['during a requested stop', { during: 'stop' as const }, 0],
    ['a bot', { scope: 'bot' as const, appId: 'cli_a' }, 0],
    ['no during (old record)', { during: undefined }, 1],
  ])('%s', (_label, fields, expected) => {
    expect(countInWindow([record({ sysUptimeMs: now, ...fields })], { chainId: CHAIN, nowUptimeMs: now })).toBe(expected);
  });
  it('counts one bot\'s records only, and only those after its last 恢复运行 (s18a)', () => {
    const bot = (fields: Partial<CrashRecord>) => record({ scope: 'bot', appId: 'cli_a', sysUptimeMs: now - 1000, ...fields });
    const records = [bot({}), bot({ appId: 'cli_b' }), record({ sysUptimeMs: now }), bot({ sysUptimeMs: now - 5000 })];
    expect(countInWindow(records, { chainId: CHAIN, nowUptimeMs: now, appId: 'cli_a' })).toBe(2);
    expect(countInWindow(records, { chainId: CHAIN, nowUptimeMs: now, appId: 'cli_a', sinceUptimeMs: now - 3000 })).toBe(1);
    expect(countInWindow(records, { chainId: CHAIN, nowUptimeMs: now })).toBe(1);
  });
});

describe('bot records for the supervisor and the snapshot (s18a)', () => {
  it('finds a child\'s record by its file name: scope, PID and a stamp not before the child started', () => {
    const root = tempRoot();
    const key = crashScopeKey('bot', 'cli_a');
    writeCrashRecordSync(root, record({ scope: 'bot', appId: 'cli_a', pid: 77, at: at(T0) }));
    expect(hasCrashRecordFor(root, key, 77, T0 - 1000)).toBe(true);
    expect(hasCrashRecordFor(root, key, 78, T0 - 1000)).toBe(false);
    expect(hasCrashRecordFor(root, 'host', 77, T0 - 1000)).toBe(false);
    expect(hasCrashRecordFor(root, key, 77, T0 + 60_000)).toBe(false); // a PID reused since
    // s18b: the record itself, for the owner's message; a damaged one reads as none.
    expect(crashRecordFor(root, key, 77, T0 - 1000)).toMatchObject({ pid: 77, appId: 'cli_a', reason: 'Error: boom' });
    expect(crashRecordFor(root, key, 77, T0 + 60_000)).toBeUndefined();
    const [name] = readdirSync(crashDir(root));
    writeFileSync(join(crashDir(root), name ?? ''), '{');
    expect(crashRecordFor(root, key, 77, T0 - 1000)).toBeUndefined();
  });
  it('lists again only when crash/ changed or 30 s passed, and shows the last day\'s newest 20', () => {
    let mtime = 1;
    let lists = 0;
    const many = Array.from({ length: 30 }, (_, index) => record({ at: at(T0 - index * 60_000) }));
    const read = createCrashRecordCache('/unused', { stat: () => mtime, list: () => { lists++; return [record({ at: at(T0 - 25 * 3_600_000) }), ...many]; } });
    expect(read(T0)).toHaveLength(20);
    expect(read(T0)[0]).toEqual({ at: T0, kind: 'exception', uptimeMs: 60_000, reason: 'Error: boom' });
    read(T0 + 29_000);
    expect(lists).toBe(1);
    mtime = 2;
    read(T0 + 29_000);
    read(T0 + 60_000);
    expect(lists).toBe(3);
    read.invalidate(); // a child exited: the next read lists again, whatever the mtime says
    read(T0 + 61_000);
    expect(lists).toBe(4);
    expect(createCrashRecordCache('/unused', { stat: () => { throw new Error('ENOENT'); } })(T0)).toEqual([]);
  });
  it('reads the bot pauses of this chain only, and nothing from a damaged file, which it reports', () => {
    const root = tempRoot();
    let corrupt = 0;
    const onCorrupt = (): void => { corrupt++; };
    expect(readBotPauses(root, CHAIN, onCorrupt)).toEqual({});
    writeBotPausesSync(root, CHAIN, { cli_a: { pausedAt: at(T0), pauseCrashes: 3 }, cli_b: { resumedUptimeMs: 5 } });
    expect(readBotPauses(root, CHAIN, onCorrupt)).toEqual({ cli_a: { pausedAt: at(T0), pauseCrashes: 3 }, cli_b: { resumedUptimeMs: 5 } });
    expect(readBotPauses(root, RUN, onCorrupt)).toEqual({});
    expect(corrupt).toBe(0); // missing, or another chain's: nothing wrong
    writeFileSync(join(crashDir(root), 'bot-pauses.json'), '{"v":1');
    expect(readBotPauses(root, CHAIN, onCorrupt)).toEqual({});
    writeFileSync(join(crashDir(root), 'bot-pauses.json'), JSON.stringify({ v: 2, chainId: CHAIN, bots: {} }));
    expect(readBotPauses(root, CHAIN, onCorrupt)).toEqual({});
    expect(corrupt).toBe(2);
    expect(listCrashRecords(root)).toEqual([]);
  });
});

describe('notices (s18b)', () => {
  it('reads nothing from a missing, damaged or foreign file, and reports the last two', () => {
    const root = tempRoot();
    let corrupt = 0;
    expect(readNotices(root, () => corrupt++)).toEqual({});
    mkdirSync(crashDir(root), { recursive: true });
    writeFileSync(join(crashDir(root), 'notices.json'), '{"v":1,');
    expect(readNotices(root, () => corrupt++)).toEqual({});
    writeFileSync(join(crashDir(root), 'notices.json'), JSON.stringify({ v: 2, bots: {} }));
    expect(readNotices(root, () => corrupt++)).toEqual({});
    expect(corrupt).toBe(2);
  });
  it('writes 0600, drops the entries of more than a day ago, and is neither listed nor pruned as a record', () => {
    const root = tempRoot();
    writeNoticesSync(root, { cli_new: { at: at(T0 - 60_000), uptimeMs: 5, bootId: 'boot-a' }, cli_old: { at: at(T0 - 25 * 3_600_000), uptimeMs: 1 } }, T0);
    expect(readNotices(root)).toEqual({ cli_new: { at: at(T0 - 60_000), uptimeMs: 5, bootId: 'boot-a' } });
    if (process.platform !== 'win32') expect(statSync(join(crashDir(root), 'notices.json')).mode & 0o777).toBe(0o600);
    expect(listCrashRecords(root)).toEqual([]);
    pruneCrashRecords(root, { now: T0 + 40 * 24 * 3_600_000 });
    expect(readdirSync(crashDir(root))).toEqual(['notices.json']);
    expect(() => writeNoticesSync(root, { 'not-an-app': { at: at(T0), uptimeMs: 1 } }, T0)).toThrow();
  });
});

describe('boots', () => {
  it('compares boot ids when both are known (Linux /proc, macOS kern.bootsessionuuid)', () => {
    expect(startedBeforeThisBoot({ startedAt: at(T0), bootId: 'a' }, clock({ bootId: 'a', uptimeMs: 1 }))).toBe(false);
    expect(startedBeforeThisBoot({ startedAt: at(T0), bootId: 'a' }, clock({ bootId: 'b' }))).toBe(true);
  });
  it('falls back to the uptime rule without ids, which a forward clock step defeats (known miss)', () => {
    const noId = clock({ now: T0, uptimeMs: 3_600_000 });
    expect(startedBeforeThisBoot({ startedAt: at(T0 - 60_000) }, noId)).toBe(false);
    expect(startedBeforeThisBoot({ startedAt: at(T0 - 3_700_000) }, noId)).toBe(true);
    // macOS: the wall clock stepped forward 10 s after the run started moves kern.boottime too, so a crash looks like a boot.
    expect(startedBeforeThisBoot({ startedAt: at(T0 - 3_600_000 + 1000) }, clock({ now: T0 + 10_000, uptimeMs: 3_600_000 }))).toBe(true);
  });
  it('reads the boot id per platform and memoizes it in the system clock', () => {
    const uuid = '63D06F6C-7229-449F-A0F4-376A6B8827A0';
    const exec = (file: string, args: string[]) => { expect([file, ...args]).toEqual(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid']); return `${uuid}\n`; };
    expect(readBootId('darwin', { readFile: () => '', exec })).toBe(uuid);
    expect(readBootId('darwin', { readFile: () => '', exec: () => 'garbage' })).toBeUndefined();
    expect(readBootId('darwin', { readFile: () => '', exec: () => { throw new Error('timeout'); } })).toBeUndefined();
    expect(readBootId('linux', { readFile: () => `${uuid.toLowerCase()}\n`, exec: () => '' })).toBe(uuid.toLowerCase());
    expect(readBootId('win32', { readFile: () => uuid, exec: () => uuid })).toBeUndefined();
    let reads = 0;
    const system = createSystemClock(() => { reads++; return uuid; });
    expect([system.bootId(), system.bootId()]).toEqual([uuid, uuid]);
    expect(reads).toBe(1);
  });
});

describe('marker and resume request', () => {
  const marker = (fields: Partial<RunMarker> = {}): RunMarker => ({
    v: 1, runId: RUN, chainId: CHAIN, pid: 4242, startedAt: at(T0), startUptimeMs: 1000, aliveAt: at(T0), aliveUptimeMs: 1000,
    version: '0.7.0', managed: 'systemd', state: 'running', ...fields,
  });
  it('reads a missing marker as null and an unparsable one as corrupt', () => {
    const root = tempRoot();
    expect(readRunMarker(root)).toBeNull();
    writeRunMarkerSync(root, marker());
    expect(readRunMarker(root)).toEqual(marker());
    writeFileSync(join(crashDir(root), 'run.json'), '{');
    expect(readRunMarker(root)).toBe('corrupt');
  });
  it('honours a resume request only within two minutes and consumes it either way', () => {
    const root = tempRoot();
    expect(takeResumeRequest(root, T0)).toBe('none');
    writeResumeRequest(root, T0);
    expect(takeResumeRequest(root, T0 + 60_000)).toBe('fresh');
    expect(takeResumeRequest(root, T0 + 60_000)).toBe('none');
    writeResumeRequest(root, T0);
    expect(takeResumeRequest(root, T0 + 180_000)).toBe('stale');
    expect(readdirSync(crashDir(root))).toEqual([]);
    mkdirSync(crashDir(root), { recursive: true });
    writeFileSync(join(crashDir(root), 'resume.json'), 'garbage');
    expect(takeResumeRequest(root, T0)).toBe('stale');
    const mine = writeResumeRequest(root, T0);
    removeResumeRequest(root, mine + 1);
    expect(readdirSync(crashDir(root))).toEqual(['resume.json']);
    removeResumeRequest(root, mine);
    expect(readdirSync(crashDir(root))).toEqual([]);
  });
  it('shows the pause of a stopped daemon only from this boot: the next start counts afresh after a reboot', () => {
    const root = tempRoot();
    writeRunMarkerSync(root, marker({ state: 'paused', pausedAt: at(T0), pauseCrashes: 3, bootId: 'boot-a' }));
    const summary = (bootId: string) => readCrashSummary(root, { running: false, now: T0, clock: clock({ bootId }) }).paused;
    expect(summary('boot-a')).toEqual({ since: at(T0), crashes: 3, running: false });
    expect(summary('boot-b')).toBeUndefined();
  });
  it('lists the paused bots of the live run\'s chain (s18a)', () => {
    const root = tempRoot();
    writeRunMarkerSync(root, marker({ pid: process.pid }));
    writeBotPausesSync(root, CHAIN, { cli_a: { pausedAt: at(T0), pauseCrashes: 4 }, cli_b: { resumedUptimeMs: 5 } });
    expect(readCrashSummary(root, { running: true, ownerPid: process.pid, now: T0 }).pausedBots).toEqual([{ appId: 'cli_a', since: at(T0), crashes: 4 }]);
    expect(readCrashSummary(root, { running: true, ownerPid: process.pid + 1, now: T0 }).pausedBots).toEqual([]);
  });
});


describe('unsent pause message storage', () => {
  const item = (i = 0): UnsentNotice => ({ kind: 'bot-paused', appId: 'cli_one', name: 'One', crashes: 3, reason: '出错退出',
    uuid: `vc-${i.toString(16).padStart(32, '0')}`, chainId: CHAIN, at: at(T0) });
  it('bounds retained records, prunes old ones, and leaves crash listing and pruning independent', () => {
    const root = tempRoot();
    writeUnsentNoticesSync(root, [...Array.from({ length: 25 }, (_, i) => item(i)), { ...item(30), at: at(T0 - 86_400_001) }], T0);
    expect(readUnsentNotices(root)).toEqual(Array.from({ length: 20 }, (_, i) => item(i + 5)));
    expect(statSync(join(crashDir(root), 'unsent-notices.json')).mode & 0o777).toBe(0o600);
    expect(listCrashRecords(root)).toEqual([]);
    pruneCrashRecords(root, { now: T0 + 100 * 86_400_000 });
    expect(readUnsentNotices(root)).toHaveLength(20);
    writeUnsentNoticesSync(root, [], T0);
    expect(readdirSync(crashDir(root))).not.toContain('unsent-notices.json');
  });
  it.each(['{bad', JSON.stringify({ v: 1, items: [{ ...item(), secret: 'unexpected' }] }),
    JSON.stringify({ v: 1, items: [{ ...item(), uuid: 'foreign' }] })])('parses unknown disk data strictly: %s', raw => {
    const root = tempRoot();
    mkdirSync(crashDir(root));
    writeFileSync(join(crashDir(root), 'unsent-notices.json'), raw);
    const corrupt = vi.fn();
    expect(readUnsentNotices(root, corrupt)).toEqual([]);
    expect(corrupt).toHaveBeenCalledOnce();
  });
});

it('redacts raw and encoded tokens from the serialized crash record', () => {
  const root = tempRoot();
  const token = `vvs1_${'a'.repeat(43)}`;
  const encoded = Buffer.from(token).toString('base64');
  const name = writeCrashRecordSync(root, record({ reason: `${token} ${encoded}` }));
  const text = readFileSync(join(crashDir(root), name), 'utf8');
  expect(text).not.toContain(token);
  expect(text).not.toContain(encoded);
  expect(listCrashRecords(root)[0]?.reason).toBe('[已隐藏的 vonvon 令牌] [已隐藏的 vonvon 令牌]');
});
