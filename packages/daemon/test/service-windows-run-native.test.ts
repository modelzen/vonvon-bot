import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WINDOWS_RUN_KEY, WINDOWS_RUN_VALUE } from '../src/service/identity';
import { readVonvonRunValue } from '../src/service/win-startup';

const system32 = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const runSubkey = WINDOWS_RUN_KEY.slice('HKCU\\'.length);
const runSnapshot = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('key-absent') }),
  z.object({ kind: z.literal('value-absent') }),
  z.object({ kind: z.literal('value'), type: z.enum(['String', 'ExpandString']), value: z.string() }),
]);

function reg(args: string[]): void {
  execFileSync(win32.join(system32, 'reg.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
}

function powershell(script: string, input = ''): string {
  return execFileSync(win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${script}`, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000, input });
}

function snapshotRun(): z.infer<typeof runSnapshot> {
  return runSnapshot.parse(JSON.parse(powershell(`
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${runSubkey}');
    try {
      $snapshot = if ($null -eq $key) { @{kind='key-absent'} }
      elseif ($key.GetValueNames() -notcontains '${WINDOWS_RUN_VALUE}') { @{kind='value-absent'} }
      else { @{kind='value'; type=$key.GetValueKind('${WINDOWS_RUN_VALUE}').ToString(); value=$key.GetValue('${WINDOWS_RUN_VALUE}', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)} }
      $snapshot | ConvertTo-Json -Compress;
    } finally { if ($null -ne $key) { $key.Dispose() } }
  `)));
}

function restoreRun(saved: z.infer<typeof runSnapshot>): void {
  if (saved.kind === 'value') {
    powershell(`
      $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${runSubkey}');
      try { $key.SetValue('${WINDOWS_RUN_VALUE}', [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())), [Microsoft.Win32.RegistryValueKind]::${saved.type}) }
      finally { $key.Dispose() }
    `, Buffer.from(saved.value, 'utf16le').toString('base64'));
    return;
  }
  powershell(`
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${runSubkey}', $true);
    if ($null -ne $key) { try { $key.DeleteValue('${WINDOWS_RUN_VALUE}', $false) } finally { $key.Dispose() } }
  `);
}

describe.skipIf(process.platform !== 'win32')('Windows native Run reader', () => {
  it('reads the real HKCU Run value written and deleted by reg.exe', () => {
    const saved = snapshotRun();
    const setRun = (type: string, value: string) => reg(['add', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/t', type, '/d', value, '/f']);
    const launch = 'wscript.exe //B "C:\\Users\\测试 100%PATH%\\Vonvon Bot\\vonvon.vbs"';
    try {
      reg(['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/f']);
    } catch {
      expect(saved.kind, 'reg.exe delete fails only when the value is already absent').not.toBe('value');
    }
    try {
      expect(readVonvonRunValue()).toEqual({ kind: 'absent' });
      setRun('REG_SZ', launch);
      expect(readVonvonRunValue()).toEqual({ kind: 'value', type: 'REG_SZ', value: launch });
      setRun('REG_EXPAND_SZ', launch);
      expect(readVonvonRunValue()).toEqual({ kind: 'value', type: 'REG_EXPAND_SZ', value: launch });
      setRun('REG_DWORD', '1');
      expect(readVonvonRunValue()).toEqual({ kind: 'unavailable', reason: 'unsupported registry value type' });
      reg(['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/f']);
      expect(readVonvonRunValue()).toEqual({ kind: 'absent' });
    } finally {
      restoreRun(saved);
      const value = (snapshot: z.infer<typeof runSnapshot>) => snapshot.kind === 'value' ? snapshot : undefined;
      expect(value(snapshotRun()), 'Original Run value restored exactly').toEqual(value(saved));
    }
  }, 60_000);
});
