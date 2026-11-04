import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

export interface WindowsCliPath {
  contains(bin: string): Promise<boolean>;
  add(bin: string): Promise<void>;
}

type Execute = (script: string, bin: string) => Promise<string>;

async function powershell(script: string, bin: string): Promise<string> {
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024, env: { ...process.env, VONVON_CLI_BIN: bin } });
  return stdout.trim();
}

// Read the persisted USER Path, never the app's inherited (machine + user) PATH. Keep expandable entries and
// the registry value's type intact. Do the read/modify/write together, and notify Explorer for future terminals.
function script(register: boolean): string {
  return `$ErrorActionPreference = 'Stop'
try {
  $key = [Microsoft.Win32.Registry]::CurrentUser.${register ? "CreateSubKey('Environment')" : "OpenSubKey('Environment')"}
  $found = $false
  $changed = $false
  if ($null -ne $key) {
    try {
      $path = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($null -ne $path -and $path -isnot [string]) { throw 'User Path is not a string; it was not changed.' }
      $kind = if ($null -eq $path) { [Microsoft.Win32.RegistryValueKind]::String } else { $key.GetValueKind('Path') }
      if ($kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString -and $env:VONVON_CLI_BIN -match '%[^%]+%') { throw 'The install directory contains a literal %variable% that Windows would expand in user Path. Choose another install directory.' }
      $normalize = { param([string]$value, [bool]$expand)
        $value = $value.Trim().Trim('"')
        if ($expand) { $value = [Environment]::ExpandEnvironmentVariables($value) }
        $value.Replace('/', '\\').TrimEnd('\\')
      }
      $target = & $normalize $env:VONVON_CLI_BIN $false
      foreach ($entry in ([string]$path).Split(';')) {
        if ((& $normalize $entry ($kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString)) -ieq $target) { $found = $true; break }
      }
      ${register ? `if (-not $found) {
        $separator = if ([string]::IsNullOrEmpty($path) -or $path.EndsWith(';')) { '' } else { ';' }
        $key.SetValue('Path', ([string]$path + $separator + $env:VONVON_CLI_BIN), $kind)
        $found = $true
        $changed = $true
      }` : ''}
    } finally { $key.Dispose() }
  }
  if ($changed) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VonvonCliEnvironment {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
    $result = [UIntPtr]::Zero
    [void][VonvonCliEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$result)
  }
  [Console]::Write($found.ToString().ToLowerInvariant())
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;
}

export function windowsCliPath(execute: Execute = powershell): WindowsCliPath {
  async function run(bin: string, register: boolean): Promise<boolean> {
    if (!bin || /[;\r\n"]/u.test(bin)) throw new Error('命令行目录不能包含分号、换行或双引号。');
    const result = (await execute(script(register), bin)).trim();
    if (result !== 'true' && result !== 'false') throw new Error('无法确认 Windows 用户 PATH。');
    return result === 'true';
  }
  return {
    contains: bin => run(bin, false),
    async add(bin) { if (!await run(bin, true)) throw new Error('无法注册 Windows 用户 PATH。'); },
  };
}
