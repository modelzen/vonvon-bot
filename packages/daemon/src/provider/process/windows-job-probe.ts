import { execFile } from 'node:child_process';
import type { Probe, WindowsControl } from './ledger';
import { POWERSHELL } from './windows-supervisor';

const JOB_NAME = /^Local\\vonvon-[A-Za-z0-9-]{1,64}$/;

/**
 * The read-only Windows recovery probe of providers.md *Empty-group proof and sealing*: opens the Job by name with
 * `JOB_OBJECT_QUERY` and reads its active-process count. Only meaningful after the supervisor is sealed, which the caller
 * establishes; in another Windows session, or without `osSession`, the answer is `unknown` because `Local\` names are per session.
 */
export function probeWindowsJob(control: WindowsControl): Promise<Probe> {
  if (control.osSession === undefined || !JOB_NAME.test(control.jobName)) return Promise.resolve('unknown');
  const script = `
$sig = @'
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int length, IntPtr returned);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool ProcessIdToSessionId(uint pid, out uint session);
[StructLayout(LayoutKind.Sequential)] public struct Accounting { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
'@
$k = Add-Type -MemberDefinition $sig -Name JobProbe -Namespace Vonvon -PassThru
$session = [uint32]0
if (-not $k::ProcessIdToSessionId([uint32]$PID, [ref]$session) -or $session -ne ${control.osSession}) { 'unknown'; exit 0 }
$handle = $k::OpenJobObjectW(4, $false, '${control.jobName}')
if ($handle -eq [IntPtr]::Zero) {
  if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 2) { 'empty' } else { 'unknown' }
  exit 0
}
$info = New-Object Vonvon.JobProbe+Accounting
$ok = $k::QueryInformationJobObject($handle, 1, [ref]$info, [Runtime.InteropServices.Marshal]::SizeOf($info), [IntPtr]::Zero)
[void]$k::CloseHandle($handle)
if (-not $ok) { 'unknown' } elseif ($info.ActiveProcesses -eq 0) { 'empty' } else { 'live' }
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise(resolve => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 30_000, windowsHide: true }, (error, stdout) => {
      const answer = stdout.trim();
      resolve(!error && (answer === 'empty' || answer === 'live') ? answer : 'unknown');
    });
  });
}
