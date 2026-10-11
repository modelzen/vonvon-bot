import { spawnSync } from 'node:child_process';
import { WINDOWS_RUN_KEY, WINDOWS_RUN_VALUE } from './identity';
import type { WindowsRunObservation } from './registration';

type RunQueryResult = {
  status: number | null;
  stdout: string | null;
  stderr: string | null;
  error?: Error;
};

const RUN_QUERY_TIMEOUT_MS = 5000;
const RUN_QUERY_MAX_BYTES = 16384;
const RUN_SUBKEY = WINDOWS_RUN_KEY.replace(/^HKCU\\/, '');
const READ_RUN_VALUE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VonvonRunReader {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  public static extern int RegOpenKeyExW(IntPtr key, string subkey, uint options, uint access, out IntPtr result);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  public static extern int RegQueryValueExW(IntPtr key, string name, IntPtr reserved, out uint type, [Out] byte[] data, ref uint size);
  [DllImport("advapi32.dll", ExactSpelling = true)]
  public static extern int RegCloseKey(IntPtr key);
}
'@
  $key = [IntPtr]::Zero
  $code = [VonvonRunReader]::RegOpenKeyExW([IntPtr]::new(-2147483647), '${RUN_SUBKEY}', 0, 1, [ref]$key)
  if ($code -ne 0) {
    @{ kind = 'native-error'; operation = 'open'; code = $code } | ConvertTo-Json -Compress
    exit 0
  }
  try {
    $data = [byte[]]::new(8192)
    $size = [uint32]$data.Length
    $type = [uint32]0
    $code = [VonvonRunReader]::RegQueryValueExW($key, '${WINDOWS_RUN_VALUE}', [IntPtr]::Zero, [ref]$type, $data, [ref]$size)
    if ($code -ne 0) {
      $response = @{ kind = 'native-error'; operation = 'query'; code = $code }
    } elseif ($type -ne 1 -and $type -ne 2) {
      $response = @{ kind = 'unavailable'; reason = 'unsupported registry value type' }
    } elseif ($size -gt $data.Length -or $size % 2 -ne 0) {
      $response = @{ kind = 'unavailable'; reason = 'registry value is not a string' }
    } else {
      $value = [System.Text.UnicodeEncoding]::new($false, $false, $true).GetString($data, 0, $size)
      if ($value.EndsWith([string][char]0)) { $value = $value.Substring(0, $value.Length - 1) }
      $response = @{ kind = 'value'; type = $(if ($type -eq 1) { 'REG_SZ' } else { 'REG_EXPAND_SZ' }); value = $value }
    }
  } finally { $closeCode = [VonvonRunReader]::RegCloseKey($key) }
  if ($closeCode -ne 0) { $response = @{ kind = 'native-error'; operation = 'close'; code = $closeCode } }
  $response | ConvertTo-Json -Compress -Depth 2
} catch {
  '{"kind":"unavailable","reason":"registry read failed"}'
}
`;

export function readVonvonRunValue(deps: {
  run?: (command: string, args: string[], options: { encoding: 'utf8'; timeout: number; maxBuffer: number; windowsHide: true }) => RunQueryResult;
} = {}): WindowsRunObservation {
  const run: NonNullable<typeof deps.run> = deps.run ?? ((command, args, options) => spawnSync(command, args, options));
  let result: RunQueryResult;
  try {
    result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', READ_RUN_VALUE_SCRIPT], {
      encoding: 'utf8', timeout: RUN_QUERY_TIMEOUT_MS, maxBuffer: RUN_QUERY_MAX_BYTES, windowsHide: true,
    });
  } catch {
    return { kind: 'unavailable', reason: 'Windows Run query failed' };
  }
  if (result.error) {
    return { kind: 'unavailable', reason: 'code' in result.error && result.error.code === 'ETIMEDOUT' ? 'Windows Run query timed out' : 'Windows Run query failed' };
  }
  if (result.status !== 0) return { kind: 'unavailable', reason: 'Windows Run query failed' };
  if (result.stderr?.trim()) return { kind: 'unavailable', reason: 'Windows Run query failed' };
  if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > RUN_QUERY_MAX_BYTES) {
    return { kind: 'unavailable', reason: 'Malformed Windows Run query response' };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout.trim()); }
  catch { return { kind: 'unavailable', reason: 'Malformed Windows Run query response' }; }
  if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) return { kind: 'unavailable', reason: 'Malformed Windows Run query response' };
  if (parsed.kind === 'native-error' && Object.keys(parsed).length === 3 && 'operation' in parsed && (parsed.operation === 'open' || parsed.operation === 'query' || parsed.operation === 'close') && 'code' in parsed && typeof parsed.code === 'number' && Number.isInteger(parsed.code) && parsed.code > 0 && parsed.code <= 2147483647) {
    if ((parsed.operation === 'open' && (parsed.code === 2 || parsed.code === 3)) || (parsed.operation === 'query' && parsed.code === 2)) return { kind: 'absent' };
    return { kind: 'unavailable', reason: `Windows Run ${parsed.operation} failed (Win32 ${parsed.code})` };
  }
  if (parsed.kind === 'unavailable' && Object.keys(parsed).length === 2 && 'reason' in parsed && typeof parsed.reason === 'string') {
    if (parsed.reason === 'permission denied' || parsed.reason === 'unsupported registry value type' || parsed.reason === 'registry value is not a string' || parsed.reason === 'registry read failed') {
      return { kind: 'unavailable', reason: parsed.reason };
    }
  }
  if (parsed.kind === 'value' && Object.keys(parsed).length === 3 && 'type' in parsed && (parsed.type === 'REG_SZ' || parsed.type === 'REG_EXPAND_SZ') && 'value' in parsed && typeof parsed.value === 'string') {
    return { kind: 'value', type: parsed.type, value: parsed.value };
  }
  return { kind: 'unavailable', reason: 'Malformed Windows Run query response' };
}
