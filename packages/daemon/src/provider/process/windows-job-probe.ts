import { execFile } from 'node:child_process';
import type { Probe, WindowsControl } from './ledger';
import { POWERSHELL } from './windows-supervisor';

const JOB_NAME = /^Local\\vonvon-[A-Za-z0-9-]{1,64}$/;

/** `Local\` Job names are per Windows session, so a record is probed only from the session that created it; the caller has sealed the supervisor first. */
export function probeWindowsJob(control: WindowsControl & { osSession: number }): Promise<Probe> {
  if (!JOB_NAME.test(control.jobName)) return Promise.resolve('unknown');
  const script = `
$sig = @'
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int length, IntPtr returned);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool ProcessIdToSessionId(uint pid, out uint session);
[StructLayout(LayoutKind.Sequential)] public struct Accounting { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
public static IntPtr Open(string name, out int error) { IntPtr handle = OpenJobObjectW(4, false, name); error = handle == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0; return handle; }
'@
$k = Add-Type -MemberDefinition $sig -Name JobProbe -Namespace Vonvon -PassThru
$session = [uint32]0
if (-not $k::ProcessIdToSessionId([uint32]$PID, [ref]$session) -or $session -ne ${control.osSession}) { 'unknown'; exit 0 }
$code = 0
$handle = $k::Open('${control.jobName}', [ref]$code)
if ($handle -eq [IntPtr]::Zero) { if ($code -eq 2) { 'empty' } else { 'unknown' }; exit 0 }
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
