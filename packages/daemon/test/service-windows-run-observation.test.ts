import { expect, it, vi } from 'vitest';
import { readVonvonRunValue } from '../src/service/win-startup';

function observe(output: { status: number | null; stdout: string | null; stderr: string | null; error?: Error }) {
  const run = vi.fn((_command: string, _args: string[], _options: { encoding: 'utf8'; timeout: number; maxBuffer: number; windowsHide: true }) => output);
  return { result: readVonvonRunValue({ run }), run };
}

it('reads only the Vonvon HKCU Run value with bounded, hidden, noninteractive PowerShell', () => {
  const { result, run } = observe({ status: 0, stdout: '{"kind":"native-error","operation":"open","code":2}\n', stderr: '' });
  expect(result).toEqual({ kind: 'absent' });
  expect(run).toHaveBeenCalledOnce();
  const call = run.mock.calls[0];
  if (!call) throw new Error('Run query was not called');
  const [command, args, options] = call;
  expect(command).toBe('powershell.exe');
  expect(args).toContain('-NoProfile');
  expect(args).toContain('-NonInteractive');
  expect(args.join(' ')).toContain('RegOpenKeyExW([IntPtr]::new(-2147483647)');
  expect(args.join(' ')).toContain("'Software\\Microsoft\\Windows\\CurrentVersion\\Run', 0, 1, [ref]$key)");
  expect(args.join(' ')).toContain("kind = 'native-error'; operation = 'open'; code = $code");
  expect(args.join(' ')).toContain("kind = 'native-error'; operation = 'query'; code = $code");
  expect(args.join(' ')).toContain('Vonvon Bot');
  expect(args.join(' ')).toContain('RegQueryValueExW');
  expect(args.join(' ')).not.toContain('ExpandEnvironmentStrings');
  expect(args.join(' ')).not.toContain('SetValue');
  expect(options).toMatchObject({ encoding: 'utf8', windowsHide: true });
  expect(options.timeout).toBe(5000);
  expect(options.maxBuffer).toBe(16384);
});

it.each(['REG_SZ', 'REG_EXPAND_SZ'] as const)('preserves %s and the exact unexpanded string', type => {
  const value = 'wscript.exe //B "%VONVON_HOME%\\service\\vonvon-bot.vbs"';
  const { result } = observe({ status: 0, stdout: JSON.stringify({ kind: 'value', type, value }), stderr: '' });
  expect(result).toEqual({ kind: 'value', type, value });
});

it.each([
  [{ status: 1, stdout: '', stderr: 'Access denied' }, 'Windows Run query failed'],
  [{ status: null, stdout: '', stderr: '', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }, 'Windows Run query timed out'],
  [{ status: 0, stdout: '{"kind":"unavailable","reason":"permission denied"}', stderr: '' }, 'permission denied'],
  [{ status: 0, stdout: 'ERROR: invalid', stderr: '' }, 'Malformed Windows Run query response'],
  [{ status: 0, stdout: '{"kind":"value","type":"REG_BINARY","value":"x"}', stderr: '' }, 'Malformed Windows Run query response'],
  [{ status: 0, stdout: '{"kind":"absent","value":"hidden"}', stderr: '' }, 'Malformed Windows Run query response'],
  [{ status: 0, stdout: '{"kind":"absent"}', stderr: 'warning' }, 'Windows Run query failed'],
] as const)('never infers absence from denied, timed out, or malformed observations', (output, reason) => {
  expect(observe(output).result).toEqual({ kind: 'unavailable', reason });
});


it.each([
  ['open', 2, { kind: 'absent' }],
  ['open', 3, { kind: 'absent' }],
  ['query', 2, { kind: 'absent' }],
  ...['open', 'query'].flatMap(operation => [5, 6, 8, 234, 1015].map(code => [operation, code, { kind: 'unavailable', reason: `Windows Run ${operation} failed (Win32 ${code})` }] as const)),
  ['query', 3, { kind: 'unavailable', reason: 'Windows Run query failed (Win32 3)' }],
] as const)('classifies raw native %s error %s without losing failure evidence', (operation, code, expected) => {
  expect(observe({ status: 0, stdout: JSON.stringify({ kind: 'native-error', operation, code }), stderr: '' }).result).toEqual(expected);
});

it.each([
  { kind: 'absent' },
  { kind: 'native-error', operation: 'open', code: '2' },
  { kind: 'native-error', operation: 'open', code: 0 },
  { kind: 'native-error', operation: 'open', code: -1 },
  { kind: 'native-error', operation: 'open', code: 2.5 },
  { kind: 'native-error', operation: 'open', code: 2147483648 },
  { kind: 'native-error', operation: 'unknown', code: 2 },
  { kind: 'native-error', operation: 'open', code: 2, extra: true },
])('rejects an unproven or malformed absence %#', response => {
  expect(observe({ status: 0, stdout: JSON.stringify(response), stderr: '' }).result).toEqual({ kind: 'unavailable', reason: 'Malformed Windows Run query response' });
});
