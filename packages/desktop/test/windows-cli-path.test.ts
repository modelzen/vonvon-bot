import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { windowsCliPath } from '../src/windows-cli-path.js';

describe('Windows CLI user PATH', () => {
  it('distinguishes persisted absence from presence and passes the directory outside the script', async () => {
    const execute = vi.fn(async (_script: string, _bin: string) => 'false');
    const path = windowsCliPath(execute);
    const bin = 'C:\\中文 & !\\resources\\cli';
    expect(await path.contains(bin)).toBe(false);
    expect(execute.mock.calls[0]).toEqual([expect.any(String), bin]);
    expect(execute.mock.calls[0][0]).not.toContain(bin);
    execute.mockResolvedValueOnce('true');
    await path.add(bin);
    execute.mockResolvedValueOnce('true');
    expect(await path.contains(bin)).toBe(true);
    execute.mockResolvedValueOnce('false');
    await expect(path.add(bin)).rejects.toThrow('无法注册');
    execute.mockResolvedValueOnce('unexpected output');
    await expect(path.contains(bin)).rejects.toThrow('无法确认');
    execute.mockRejectedValueOnce(new Error('access denied'));
    await expect(path.add(bin)).rejects.toThrow('access denied');
  });

  it('refuses PATH separators and malformed paths without invoking PowerShell', async () => {
    const execute = vi.fn(async () => 'true');
    const path = windowsCliPath(execute);
    for (const bin of ['', 'C:\\one;C:\\two', 'C:\\bad\npath', 'C:\\bad"path']) await expect(path.add(bin)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('preserves long expandable user values and avoids duplicates using an isolated registry key', async () => {
    const key = `Software\\VonvonBotCliTests\\${randomUUID()}`;
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const run = async (script: string, bin = '') => {
      const { stdout } = await promisify(execFile)(executable,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n' + script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 15000, env: { ...process.env, VONVON_CLI_BIN: bin } });
      return stdout.trim();
    };
    // Exercise the production PowerShell against our own throwaway key, never HKCU\Environment or Explorer.
    const path = windowsCliPath((script, bin) => run(script
      .replace("CreateSubKey('Environment')", `CreateSubKey('${key}')`)
      .replace("OpenSubKey('Environment')", `OpenSubKey('${key}')`)
      .replace('if ($changed)', 'if ($false)'), bin));
    const raw = '%SystemRoot%\\System32;' + Array.from({ length: 160 }, (_, i) => `C:\\Tool ${i}`).join(';');
    const bin = 'C:\\中文 & !\\resources\\cli';
    const read = () => run(`$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}'); try {
      @{ value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); kind = $key.GetValueKind('Path').ToString() } | ConvertTo-Json -Compress
    } finally { $key.Dispose() }`);
    try {
      expect(await path.contains(bin)).toBe(false);
      await run(`$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}'); try { $key.SetValue('Path', '${raw}', [Microsoft.Win32.RegistryValueKind]::ExpandString) } finally { $key.Dispose() }`);
      await path.add(bin);
      const saved = JSON.parse(await read());
      expect(saved).toEqual({ value: `${raw};${bin}`, kind: 'ExpandString' });
      expect(await path.contains(bin.toUpperCase().replaceAll('\\', '/') + '/')).toBe(true);
      await path.add(bin.toUpperCase());
      expect(JSON.parse(await read())).toEqual(saved);
      await path.add(join(process.env.SystemRoot || 'C:\\Windows', 'System32'));
      expect(JSON.parse(await read())).toEqual(saved);
      await run(`$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}', $true); try { $key.SetValue('Path', 'C:\\original;', [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }`);
      await path.add(bin);
      expect(JSON.parse(await read())).toEqual({ value: `C:\\original;${bin}`, kind: 'String' });
      await run(`$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}', $true); try { $key.SetValue('Path', '%SystemRoot%\\System32', [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }`);
      const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
      expect(await path.contains(system32)).toBe(false);
      await path.add(system32);
      expect(JSON.parse(await read())).toEqual({ value: `%SystemRoot%\\System32;${system32}`, kind: 'String' });
      await run(`$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}', $true); try { $key.SetValue('Path', '%SystemRoot%\\System32', [Microsoft.Win32.RegistryValueKind]::ExpandString) } finally { $key.Dispose() }`);
      const literal = 'C:\\literal-%VONVON_UNDEFINED_VARIABLE%\\cli';
      await expect(path.add(literal)).rejects.toThrow('literal %variable%');
      expect(JSON.parse(await read())).toEqual({ value: '%SystemRoot%\\System32', kind: 'ExpandString' });
      await run(`$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}', $true); try { $key.DeleteValue('Path') } finally { $key.Dispose() }`);
      await path.add(literal);
      expect(JSON.parse(await read())).toEqual({ value: literal, kind: 'String' });
    } finally {
      await run(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${key}', $false)`);
    }
  }, 60000);
});
