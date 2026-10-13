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
  [DllImport("kernel32.dll", EntryPoint="OpenJobObjectW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Member(IntPtr process,IntPtr job) {
    bool member;
    return IsProcessInJob(process,job,out member) ? (member ? "in" : "out") : "query-error-"+Marshal.GetLastWin32Error();
  }
  public static string Try(string app,string line,string name) {
    const uint JOB_OBJECT_QUERY=0x0004, CREATE_BREAKAWAY_FROM_JOB=0x01000000, CREATE_NO_WINDOW=0x08000000;
    IntPtr job=OpenJobObject(JOB_OBJECT_QUERY,false,name);
    if(job==IntPtr.Zero) return "open-error "+Marshal.GetLastWin32Error();
    var child=new ProcessInfo();
    try {
      string caller=Member(GetCurrentProcess(),job);
      var startup=new Startup(); startup.size=(uint)Marshal.SizeOf(typeof(Startup));
      if(CreateProcess(app,new StringBuilder(line),IntPtr.Zero,IntPtr.Zero,false,CREATE_BREAKAWAY_FROM_JOB|CREATE_NO_WINDOW,IntPtr.Zero,null,ref startup,out child))
        return "caller "+caller+" created "+child.pid+" "+Member(child.process,job);
      return "caller "+caller+" error "+Marshal.GetLastWin32Error();
    } finally {
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
      if(child.process!=IntPtr.Zero) CloseHandle(child.process);
      CloseHandle(job);
    }
  }
}`;
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function liveness(pid: number): 'alive' | 'gone' | 'unknown' {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'ESRCH' ? 'gone' : 'unknown'; }
}

describe.skipIf(process.platform !== 'win32')('today\'s WindowsCodexJob', () => {
  // CreateProcess with CREATE_BREAKAWAY_FROM_JOB fails with 5 when the Vonvon Job is the caller's immediate Job,
  // and succeeds when a nested Job that allows breakaway sits below it, such as a libuv Job under the `node -e` wrapper;
  // either way the new process must stay a member of the Vonvon Job, which is the guarantee.
  it('keeps a grandchild that asks for breakaway inside the Job and drains it on kill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vonvon-breakaway-'));
    const result = join(dir, 'result');
    const job = new WindowsCodexJob();
    let createdPid: number | undefined;
    let exited: Promise<unknown> | undefined;
    try {
      const sleeper = `"${process.execPath}" -e "setInterval(()=>{},1000)"`;
      const script = [
        "$ErrorActionPreference='Stop'",
        `Add-Type -TypeDefinition ${literal(breakawaySource)}`,
        `[IO.File]::WriteAllText(${literal(result + '.tmp')}, [Breakaway]::Try(${literal(process.execPath)}, ${literal(sleeper)}, ${literal(job.name)}))`,
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
      const created = / created ([1-9]\d*) /.exec(outcome);
      if (created) createdPid = Number(created[1]);
      expect(outcome, 'the probe runs inside the Job, and a breakaway request is refused or stays a Job member')
        .toMatch(/^caller in (error 5|created [1-9]\d* in)$/);

      job.requestStop();
      await exited;
      expect(job.verifiedEmpty, stderr).toBe(true);
      if (createdPid !== undefined) expect(liveness(createdPid), 'the grandchild ended with the Job').toBe('gone');
    } finally {
      if (createdPid !== undefined) try { process.kill(createdPid); } catch {}
      job.requestStop();
      await exited?.catch(() => undefined);
      job.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
