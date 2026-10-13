import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WindowsCodexJob } from '../../src/agent/codex-appserver/windows-job';

const breakawaySource = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Breakaway {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint size; public string reserved,desktop,title; public uint x,y,xsize,ysize,xchars,ychars,fill,flags;
    public ushort show,reservedSize; public IntPtr reservedData,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder args,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo process);
  public static string Try(string app,string line) {
    var startup=new Startup(); startup.size=(uint)Marshal.SizeOf(typeof(Startup)); ProcessInfo child;
    const uint CREATE_BREAKAWAY_FROM_JOB=0x01000000, CREATE_NO_WINDOW=0x08000000;
    if(CreateProcess(app,new StringBuilder(line),IntPtr.Zero,IntPtr.Zero,false,CREATE_BREAKAWAY_FROM_JOB|CREATE_NO_WINDOW,IntPtr.Zero,null,ref startup,out child)) return "created "+child.pid;
    return "error "+Marshal.GetLastWin32Error();
  }
}`;
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

describe.skipIf(process.platform !== 'win32')('today\'s WindowsCodexJob', () => {
  it('denies breakaway to a grandchild and drains to zero members on kill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vonvon-breakaway-'));
    const result = join(dir, 'result');
    const job = new WindowsCodexJob();
    let escaped: number | undefined;
    let exited: Promise<unknown> | undefined;
    try {
      const sleeper = `"${process.execPath}" -e "setInterval(()=>{},1000)"`;
      const script = [
        "$ErrorActionPreference='Stop'",
        `Add-Type -TypeDefinition ${literal(breakawaySource)}`,
        `[IO.File]::WriteAllText(${literal(result + '.tmp')}, [Breakaway]::Try(${literal(process.execPath)}, ${literal(sleeper)}))`,
        `[IO.File]::Move(${literal(result + '.tmp')}, ${literal(result)})`,
        'Start-Sleep -Seconds 600',
      ].join('\n');
      const scriptFile = join(dir, 'breakaway.ps1');
      writeFileSync(scriptFile, script, 'utf8');
      const child = spawn(job.executable, job.launch(job.executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile]), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr.on('data', data => { stderr += String(data); });
      child.stdout.resume();
      exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });

      await vi.waitFor(() => expect(existsSync(result), stderr).toBe(true), { timeout: 45_000, interval: 100 });
      const outcome = readFileSync(result, 'utf8');
      if (outcome.startsWith('created ')) escaped = Number(outcome.slice('created '.length));
      expect(outcome, 'CREATE_BREAKAWAY_FROM_JOB must fail with ERROR_ACCESS_DENIED').toBe('error 5');

      job.requestStop();
      await exited;
      expect(job.verifiedEmpty, stderr).toBe(true);
    } finally {
      if (escaped !== undefined) try { process.kill(escaped); } catch {}
      job.requestStop();
      await exited?.catch(() => undefined);
      job.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
