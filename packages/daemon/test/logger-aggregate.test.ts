import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { formatErrorTree } from '../src/core/error-parts';
import { log, TEST_LOGS_DIR } from '../src/core/logger';

afterEach(() => vi.restoreAllMocks());

/** The JSON lines of this test's marker, once the write stream has flushed them. */
async function lines(marker: string, count: number): Promise<Record<string, unknown>[]> {
  let found: Record<string, unknown>[] = [];
  for (let attempt = 0; attempt < 40 && found.length < count; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const text = readdirSync(TEST_LOGS_DIR).filter(file => file.endsWith('.log')).map(file => readFileSync(join(TEST_LOGS_DIR, file), 'utf8')).join('');
    found = text.split('\n').filter(row => row.includes(marker)).map(row => JSON.parse(row) as Record<string, unknown>);
  }
  return found;
}

it('writes a fail line, then one fail_part per error inside, on stderr too; a whole Feishu id is cut in the log only', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const marker = `aggregate-${Date.now()}`;
  const failure = new AggregateError([
    new Error('Owned-work IPC channel is closed.'),
    new AggregateError([new Error('oc_0123456789abcdef')], 'Codex cleanup errors'),
  ], 'Provider cleanup failed.');
  log.fail('daemon-shutdown', failure, { phase: 'cleanup', marker });
  const rows = await lines(marker, 3);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ level: 'error', phase: 'daemon-shutdown', event: 'fail', _phase: 'cleanup', err: 'Provider cleanup failed.', parts: 2 });
  expect(rows[0]).not.toHaveProperty('partsLogged');
  expect(rows[1]).toMatchObject({ event: 'fail_part', _phase: 'cleanup', part: '1', of: 2, errName: 'Error', err: 'Owned-work IPC channel is closed.' });
  expect(rows[1]).not.toHaveProperty('within');
  expect(rows[1]?.stack).toContain('Owned-work IPC channel is closed.');
  expect(rows[2]).toMatchObject({ event: 'fail_part', part: '2.1', of: 2, within: 'Codex cleanup errors', err: 'abcdef' });
  expect(rows.every(row => row.ts === rows[0]?.ts)).toBe(true);
  expect(error).toHaveBeenCalledTimes(3);
  expect(String(error.mock.calls[2]?.[0])).toMatch(/^✗ \[daemon-shutdown\.fail_part\] phase=cleanup .*part=2\.1 of=2 within=Codex cleanup errors errName=Error err=abcdef$/);
  // stderr of a failed command keeps the whole text.
  expect(formatErrorTree(failure)).toContain('Codex cleanup errors › Error: oc_0123456789abcdef');
  // The stacks stay in the JSON log: stderr gets one line per error, without its stack.
  const printed = error.mock.calls.map(call => String(call[0]));
  expect(printed.every(line => !line.includes('\n'))).toBe(true);
  expect([...printed, formatErrorTree(failure)].join('\n')).not.toContain('logger-aggregate.test');
});

it('logs the same group again as one line that says where its parts are', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const marker = `again-${Date.now()}`;
  const failure = new AggregateError([new Error('drain failed')], 'API listener closed with cleanup errors');
  log.fail('daemon-shutdown', failure, { phase: 'listener-cleanup', marker });
  log.fail('daemon-shutdown', failure, { phase: 'cleanup', marker });
  const rows = await lines(marker, 3);
  expect(rows.map(row => row.event)).toEqual(['fail', 'fail_part', 'fail']);
  expect(rows[2]).toMatchObject({ _phase: 'cleanup', partsLogged: true, partsAt: rows[0]?.ts });
  expect(rows[2]).not.toHaveProperty('parts');
});

it('leaves a plain error as one fail line, as before', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const marker = `plain-${Date.now()}`;
  log.fail('daemon-shutdown', new Error('fetch failed', { cause: new Error('ECONNRESET') }), { phase: 'cleanup', marker });
  const rows = await lines(marker, 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(await lines(marker, 1)).toHaveLength(1);
  expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['_phase', 'err', 'event', 'level', 'marker', 'phase', 'stack', 'ts']);
  expect(error).toHaveBeenCalledTimes(1);
});

it('with console: false writes the JSON lines only', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const marker = `quiet-${Date.now()}`;
  log.fail('daemon-run', new AggregateError([new Error('a')], 'group'), { phase: 'run', marker }, { console: false });
  expect((await lines(marker, 2)).map(row => row.event)).toEqual(['fail', 'fail_part']);
  expect(error).not.toHaveBeenCalled();
});

it('writes a fail line and its parts into the file of their ts, also across midnight', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const marker = `midnight-${Date.now()}`;
  const days = ['2031-03-01.log', '2031-03-02.log'].map(file => join(TEST_LOGS_DIR, file));
  // Each `new Date()` is 1 ms later than the one before: the day changes between the fail line and its parts.
  let now = Date.parse('2031-03-01T23:59:59.998Z');
  class Ticking extends Date { constructor(value?: number | string) { super(value ?? now++); } }
  try {
    vi.stubGlobal('Date', Ticking);
    try { log.fail('daemon-shutdown', new AggregateError([new Error('a'), new Error('b'), new Error('c')], 'group'), { marker }); }
    finally { vi.unstubAllGlobals(); }
    const rows = await lines(marker, 4);
    expect(rows.map(row => row.ts)).toEqual(Array(4).fill('2031-03-01T23:59:59.998Z'));
    const count = (file: string): number => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(row => row.includes(marker)).length : 0;
    expect(days.map(count)).toEqual([4, 0]);
  } finally { for (const file of days) rmSync(file, { force: true }); }
});
