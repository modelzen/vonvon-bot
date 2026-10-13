import { execFile } from 'node:child_process';
import type { Probe, WindowsControl } from './ledger';
import { POWERSHELL } from './windows-supervisor';

const JOB_NAME = /^Local\\vonvon-[A-Za-z0-9-]{1,64}$/;

/** What the probe process reported, kept whole so a recovery that stays `unknown` can be explained from the log. */
export interface JobProbeResult { probe: Probe; code: number | null; stdout: string; stderr: string; lastError?: number }

/** `Local\` Job names are per Windows session, so a record is probed only from the session that created it; the caller has sealed the supervisor first. */
export async function probeWindowsJob(control: WindowsControl & { osSession: number }): Promise<JobProbeResult> {
  if (!JOB_NAME.test(control.jobName)) return { probe: 'unknown', code: null, stdout: '', stderr: `job name rejected: ${control.jobName}` };
  const script = `
$source = @'
using System;
using System.Runtime.InteropServices;
namespace Vonvon {
  public static class JobProbe {
    [StructLayout(LayoutKind.Sequential)] public struct Accounting { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int length, IntPtr returned);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ProcessIdToSessionId(uint pid, out uint session);
    public static int Session() { uint session; return ProcessIdToSessionId((uint)System.Diagnostics.Process.GetCurrentProcess().Id, out session) ? (int)session : -1; }
    // Opens the Job and reads the last error in the same call, so no PowerShell statement can sit between them.
    public static string Probe(string name) {
      IntPtr handle = OpenJobObjectW(4, false, name);
      if (handle == IntPtr.Zero) { int error = Marshal.GetLastWin32Error(); return (error == 2 ? "empty " : "unknown ") + error; }
      Accounting info;
      bool ok = QueryInformationJobObject(handle, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero);
      int queryError = ok ? 0 : Marshal.GetLastWin32Error();
      CloseHandle(handle);
      if (!ok) return "unknown " + queryError;
      return (info.ActiveProcesses == 0 ? "empty " : "live ") + info.ActiveProcesses;
    }
  }
}
'@
Add-Type -TypeDefinition $source
$session = [Vonvon.JobProbe]::Session()
if ($session -ne ${control.osSession}) { "unknown session $session" ; exit 0 }
[Vonvon.JobProbe]::Probe('${control.jobName}')
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise(resolve => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      const [answer, detail] = stdout.trim().split(/\s+/);
      const probe: Probe = code === 0 && (answer === 'empty' || answer === 'live') ? answer : 'unknown';
      const lastError = detail !== undefined && /^\d+$/.test(detail) ? Number(detail) : undefined;
      resolve({ probe, code, stdout: stdout.trim(), stderr: stderr.trim(), lastError });
    });
  });
}
