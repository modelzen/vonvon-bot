import { readdirSync, readFileSync } from 'node:fs';
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
