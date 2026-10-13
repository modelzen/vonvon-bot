import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { channelOver, exitOf, killAndReject, type HolderChannel } from './holder-channel';
import { startTokenFromFileTime } from './identity';

/**
 * The Windows holder: a C# supervisor compiled by `powershell.exe` from a content-addressed temp directory. It is the
 * provider's direct parent, holds the only Job handle, speaks the holder protocol over the daemon's named pipe, and
 * logs to the file named on its command line. Compiles as C# 5, which is what Windows PowerShell 5.1's `Add-Type` has.
 */
export const SUPERVISOR_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class VonvonSupervisor {
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong readOperations,writeOperations,otherOperations,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long processTime,jobTime; public uint flags; public UIntPtr minWorkingSet,maxWorkingSet; public uint active;
    public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Limits basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long userTime,kernelTime,periodUserTime,periodKernelTime; public uint faults,total,active,terminated; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint size; public string reserved,desktop,title; public uint x,y,xsize,ysize,xchars,ychars,fill,flags;
    public ushort show,reservedSize; public IntPtr reservedData,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }

  [DllImport("kernel32.dll", EntryPoint="CreateJobObjectW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Extended info,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,uint size,IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", EntryPoint="CreateProcessW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder args,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetStdHandle(int id,IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ProcessIdToSessionId(uint pid,out uint session);
  [DllImport("kernel32.dll")] static extern void SetLastError(uint code);

  const int CODE_OK=0, CODE_INTERNAL=1, CODE_NEVER_LAUNCHED=10, CODE_LAUNCH_FAILED=11;
  const uint ERROR_ALREADY_EXISTS=183, KILL_ON_JOB_CLOSE=0x2000, STARTF_USESTDHANDLES=0x100;
  const uint CREATE_UNICODE_ENVIRONMENT=0x400, EXTENDED_STARTUPINFO_PRESENT=0x80000, CREATE_NO_WINDOW=0x8000000;
  const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST=0x20002, PROC_THREAD_ATTRIBUTE_JOB_LIST=0x2000D;
  const int MAX_FIELD=16*1024*1024, MAX_COUNT=65536;

  // Every receipt and every state change goes through this one lock; the reader (main) thread and the wait thread share it.
  static readonly object gate=new object();
  static Stream pipe; static StreamWriter log;
  static IntPtr job=IntPtr.Zero, provider=IntPtr.Zero; static uint providerPid;
  static bool created, cancelled, exitObserved, reaped;

  sealed class ByteReader {
    readonly Stream stream; readonly byte[] buffer=new byte[65536]; int length, position;
    public ByteReader(Stream s) { stream=s; }
    bool Fill() {
      try { length=stream.Read(buffer,0,buffer.Length); position=0; return length>0; }
      catch(IOException) { return false; } catch(ObjectDisposedException) { return false; }
    }
    public string ReadLine() {
      var line=new MemoryStream();
      for(;;) {
        if(position==length && !Fill()) return null;
        byte b=buffer[position++];
        if(b==10) return Encoding.ASCII.GetString(line.ToArray());
        if(line.Length>=4096) return null;
        line.WriteByte(b);
      }
    }
    public byte[] ReadBytes(int count) {
      var bytes=new byte[count]; int have=0;
      while(have<count) {
        if(position==length && !Fill()) return null;
        int take=Math.Min(count-have,length-position);
        Array.Copy(buffer,position,bytes,have,take); position+=take; have+=take;
      }
      return bytes;
    }
  }

  static void Log(string text) { lock(gate) { try { log.WriteLine(DateTime.UtcNow.ToString("o")+" "+text); } catch(Exception) {} } }
  static void Emit(string line) {
    lock(gate) {
      Log("> "+line);
      try { byte[] bytes=Encoding.ASCII.GetBytes(line+"\n"); pipe.Write(bytes,0,bytes.Length); pipe.Flush(); }
      catch(Exception error) { Log("receipt write failed: "+error.Message); }
    }
  }
  static void Finish(int code) {
    Log("exit "+code);
    try { log.Flush(); } catch(Exception) {}
    Environment.Exit(code);
  }
  static bool IsNonce(string s) {
    if(s.Length<1 || s.Length>32) return false;
    foreach(char c in s) if(!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='-')) return false;
    return true;
  }
  static bool ParseCount(string line,int max,out int value) {
    value=0;
    if(line.Length==0 || line.Length>10) return false;
    foreach(char c in line) if(c<'0'||c>'9') return false;
    long parsed=long.Parse(line);
    if(parsed>max) return false;
    value=(int)parsed; return true;
  }
  static string Frame(ByteReader reader) {
    string line=reader.ReadLine(); if(line==null) OnEof();
    int length; if(!ParseCount(line,MAX_FIELD,out length)) { Log("malformed launch length: "+line); return null; }
    byte[] bytes=reader.ReadBytes(length); if(bytes==null) OnEof();
    return Encoding.UTF8.GetString(bytes);
  }
  static List<string> Frames(ByteReader reader) {
    string line=reader.ReadLine(); if(line==null) OnEof();
    int count; if(!ParseCount(line,MAX_COUNT,out count)) { Log("malformed launch count: "+line); return null; }
    var list=new List<string>(count);
    for(int i=0;i<count;i++) { string frame=Frame(reader); if(frame==null) return null; list.Add(frame); }
    return list;
  }

  public static int Run(string pipeName,string jobName,string logPath) {
    log=new StreamWriter(new FileStream(logPath,FileMode.Append,FileAccess.Write,FileShare.ReadWrite)); log.AutoFlush=true;
    try { return Serve(pipeName,jobName); }
    catch(Exception error) { Log("internal: "+error); Finish(CODE_INTERNAL); return CODE_INTERNAL; }
  }

  static int Serve(string pipeName,string jobName) {
    string token=Environment.GetEnvironmentVariable("VONVON_CONTROL_TOKEN");
    Environment.SetEnvironmentVariable("VONVON_CONTROL_TOKEN",null);
    if(string.IsNullOrEmpty(token)) { Log("no control token"); Finish(CODE_NEVER_LAUNCHED); }
    IntPtr handle=CreateFile(pipeName,0x80000000|0x40000000,0,IntPtr.Zero,3,0,IntPtr.Zero);
    if(handle==IntPtr.Zero || handle==new IntPtr(-1)) { Log("pipe open failed: "+Marshal.GetLastWin32Error()); Finish(CODE_NEVER_LAUNCHED); }
    pipe=new FileStream(new SafeFileHandle(handle,true),FileAccess.ReadWrite,1,false);
    var reader=new ByteReader(pipe);
    long creation,exitTime,kernel,user; uint session;
    if(!GetProcessTimes(GetCurrentProcess(),out creation,out exitTime,out kernel,out user)) { Log("GetProcessTimes failed"); Finish(CODE_INTERNAL); }
    uint pid=(uint)Process.GetCurrentProcess().Id;
    if(!ProcessIdToSessionId(pid,out session)) { Log("ProcessIdToSessionId failed"); Finish(CODE_INTERNAL); }
    Emit("hello "+token+" "+pid+" "+session+" "+((ulong)creation).ToString());
    string ok=reader.ReadLine();
    if(ok!="ok") { Log("not authenticated: "+(ok==null?"EOF":ok)); Finish(CODE_NEVER_LAUNCHED); }
    Log("authenticated; job "+jobName);
    for(;;) {
      string line=reader.ReadLine();
      if(line==null) OnEof();
      string[] parts=line.Split(' ');
      if(parts.Length!=2 || !IsNonce(parts[1])) { Log("malformed command: "+line); continue; }
      string nonce=parts[1];
      switch(parts[0]) {
        case "launch": OnLaunch(nonce,reader,jobName); break;
        case "go": Emit("refused go "+nonce+(cancelled?" cancelled":created?" already-sent":" not-launched")); break;
        case "abandon": cancelled=true; if(!created) Finish(CODE_NEVER_LAUNCHED); break;
        case "term": case "kill": OnRung(parts[0],nonce); break;
        case "reap": OnReap(nonce); break;
        case "probe": OnProbe(nonce); break;
        case "exit": if(job!=IntPtr.Zero) CloseHandle(job); Finish(CODE_OK); break;
        default: Log("unknown command: "+parts[0]); break;
      }
    }
  }

  static void OnLaunch(string nonce,ByteReader reader,string jobName) {
    string file=Frame(reader); if(file==null) return;
    List<string> args=Frames(reader); if(args==null) return;
    List<string> env=Frames(reader); if(env==null) return;
    string cwd=Frame(reader); if(cwd==null) return;
    if(cancelled) { Emit("refused launch "+nonce+" cancelled"); return; }
    if(created) { Emit("refused launch "+nonce+" already-created"); return; }
    if(args.Count!=1) { Log("launch needs exactly one argument frame, the command line; got "+args.Count); return; }
    created=true;
    SetLastError(0);
    job=CreateJobObject(IntPtr.Zero,jobName);
    int error=Marshal.GetLastWin32Error();
    if(job==IntPtr.Zero) LaunchFailed(nonce,error);
    if(error==ERROR_ALREADY_EXISTS) { CloseHandle(job); job=IntPtr.Zero; Emit("job-collision "+nonce); Finish(CODE_LAUNCH_FAILED); }
    var limits=new Extended(); limits.basic.flags=KILL_ON_JOB_CLOSE;
    if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended)))) LaunchFailed(nonce,Marshal.GetLastWin32Error());

    IntPtr[] std=new IntPtr[] { GetStdHandle(-10),GetStdHandle(-11),GetStdHandle(-12) };
    foreach(IntPtr h in std) if(!SetHandleInformation(h,1,1)) LaunchFailed(nonce,Marshal.GetLastWin32Error());
    IntPtr size=IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
    IntPtr list=Marshal.AllocHGlobal(size);
    if(!InitializeProcThreadAttributeList(list,2,0,ref size)) LaunchFailed(nonce,Marshal.GetLastWin32Error());
    IntPtr handles=Marshal.AllocHGlobal(IntPtr.Size*3);
    for(int i=0;i<3;i++) Marshal.WriteIntPtr(handles,i*IntPtr.Size,std[i]);
    if(!UpdateProcThreadAttribute(list,0,(IntPtr)PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,(IntPtr)(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero)) LaunchFailed(nonce,Marshal.GetLastWin32Error());
    IntPtr jobs=Marshal.AllocHGlobal(IntPtr.Size);
    Marshal.WriteIntPtr(jobs,job);
    if(!UpdateProcThreadAttribute(list,0,(IntPtr)PROC_THREAD_ATTRIBUTE_JOB_LIST,jobs,(IntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero)) LaunchFailed(nonce,Marshal.GetLastWin32Error());

    var block=new StringBuilder();
    foreach(string entry in env) block.Append(entry).Append('\0');
    if(env.Count==0) block.Append('\0');
    block.Append('\0');
    IntPtr envBlock=Marshal.StringToHGlobalUni(block.ToString());
    var startup=new StartupEx();
    startup.startup.size=(uint)Marshal.SizeOf(typeof(StartupEx));
    startup.startup.flags=STARTF_USESTDHANDLES;
    startup.startup.input=std[0]; startup.startup.output=std[1]; startup.startup.error=std[2];
    startup.attributes=list;
    ProcessInfo child;
    bool ok=CreateProcess(file.Length==0?null:file,new StringBuilder(args[0]),IntPtr.Zero,IntPtr.Zero,true,
      CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,envBlock,cwd.Length==0?null:cwd,ref startup,out child);
    error=Marshal.GetLastWin32Error();
    DeleteProcThreadAttributeList(list);
    Marshal.FreeHGlobal(list); Marshal.FreeHGlobal(handles); Marshal.FreeHGlobal(jobs); Marshal.FreeHGlobal(envBlock);
    if(!ok) LaunchFailed(nonce,error);
    CloseHandle(child.thread);
    lock(gate) { provider=child.process; providerPid=child.pid; }
    Emit("ready "+nonce+" "+child.pid);
    // The provider now owns the daemon's pipes; closing our copies makes stdout EOF mean what it means on POSIX.
    int[] ids=new int[] { -10,-11,-12 };
    for(int i=0;i<3;i++) { SetStdHandle(ids[i],IntPtr.Zero); CloseHandle(std[i]); }
    var waiter=new Thread(WaitProvider); waiter.IsBackground=true; waiter.Start();
  }

  static void LaunchFailed(string nonce,int error) {
    Emit("launch-failed "+nonce+" "+error);
    if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; }
    Finish(CODE_LAUNCH_FAILED);
  }

  static void WaitProvider() {
    WaitForSingleObject(provider,0xFFFFFFFF);
    uint code; bool ok=GetExitCodeProcess(provider,out code);
    lock(gate) { exitObserved=true; }
    Emit(ok ? "provider-exit "+code+" -" : "provider-exit - -");
  }

  static void OnRung(string rung,string nonce) {
    if(!created) { Emit("refused "+rung+" "+nonce+" not-launched"); cancelled=true; return; }
    if(reaped) { Emit("refused "+rung+" "+nonce+" reaped"); return; }
    if(rung=="term") { Emit("accepted term "+nonce); return; }
    if(TerminateJobObject(job,1)) Emit("sent kill "+nonce); else Emit("refused kill "+nonce+" "+Marshal.GetLastWin32Error());
  }

  static void OnReap(string nonce) {
    if(!created) { Emit("refused reap "+nonce+" not-launched"); return; }
    bool observed; lock(gate) { observed=exitObserved; }
    if(!observed) { Emit("not-ready "+nonce); return; }
    reaped=true;
    Emit("reaped "+nonce);
  }

  static void OnProbe(string nonce) {
    if(!created) { Emit("refused probe "+nonce+" not-launched"); return; }
    Accounting info;
    if(!QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) { Emit("probe-unknown "+nonce+" "+Marshal.GetLastWin32Error()); return; }
    Emit(info.active==0 ? "empty "+nonce : "live "+nonce);
  }

  /** Daemon death: nothing more is authorized; end what exists and leave only when the Job is empty. */
  static void OnEof() {
    Log("command EOF");
    if(!created) Finish(CODE_NEVER_LAUNCHED);
    if(!TerminateJobObject(job,1)) Log("daemon-death TerminateJobObject: "+Marshal.GetLastWin32Error());
    for(;;) {
      Accounting info;
      if(!QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) { Log("daemon-death probe: "+Marshal.GetLastWin32Error()); Finish(CODE_INTERNAL); }
      if(info.active==0) { CloseHandle(job); Finish(CODE_OK); }
      Thread.Sleep(10);
    }
  }
}
`;

export const SUPERVISOR_LOADER = [
  'param([string]$Pipe, [string]$Job, [string]$Log)',
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -Path (Join-Path $PSScriptRoot 'supervisor.cs')",
  'exit [VonvonSupervisor]::Run($Pipe, $Job, $Log)',
  '',
].join('\r\n');

export const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const newPipeName = (): string => `\\\\.\\pipe\\vonvon-${randomUUID()}`;
const HELLO = /^hello ([0-9a-f]{64}) ([1-9]\d{0,9}) (\d{1,10}) (\d{1,20})$/;
const DEFAULT_SPAWN_DEADLINE_MS = 60_000;

/** Writes the source and loader once under a directory named by their hash; a concurrent writer converges on the same bytes. */
export function ensureSupervisorFiles(): { dir: string; loader: string } {
  const hash = createHash('sha256').update(SUPERVISOR_SOURCE).update('\0').update(SUPERVISOR_LOADER).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), `vonvon-supervisor-${hash}`);
  const files: Array<[string, string]> = [[join(dir, 'supervisor.cs'), SUPERVISOR_SOURCE], [join(dir, 'supervisor.ps1'), SUPERVISOR_LOADER]];
  for (const [path, content] of files) {
    if (existsSync(path)) continue;
    mkdirSync(dir, { recursive: true });
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, content, 'utf8');
    renameSync(temp, path);
  }
  return { dir, loader: join(dir, 'supervisor.ps1') };
}

export interface WindowsSupervisorOptions {
  /** `Local\vonvon-<id>`, durable in the ledger before this call. */
  jobName: string;
  /** `\\.\pipe\vonvon-<id>`; a fresh one when absent. */
  pipeName?: string;
  logPath: string;
  spawnDeadlineMs?: number;
}

type Hello = { token: string; pid: number; session: number; start: string };

/**
 * Listens on the pipe, spawns the supervisor with the token in its environment, accepts exactly one connection, checks the
 * token and that the hello pid is the child's, answers `ok`, and returns the channel. Any failure kills the child and rejects.
 */
export async function spawnWindowsSupervisor(options: WindowsSupervisorOptions): Promise<HolderChannel> {
  const files = ensureSupervisorFiles();
  const pipeName = options.pipeName ?? newPipeName();
  const token = randomBytes(32).toString('hex');
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipeName, resolve); });
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', files.loader, pipeName, options.jobName, options.logPath], {
    env: { ...process.env, VONVON_CONTROL_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  (child.stdin as Writable).on('error', () => { /* the provider's end may close first */ });
  try {
    const { socket, hello, rest } = await authenticate(server, child, token, options.spawnDeadlineMs ?? DEFAULT_SPAWN_DEADLINE_MS);
    socket.write('ok\n');
    return channelOver({
      platform: 'win32', child, commands: socket, receipts: socket, initial: rest, close: () => socket.destroy(),
      stdio: { stdin: child.stdin as Writable, stdout: child.stdout as Readable, stderr: child.stderr as Readable },
      start: startTokenFromFileTime(hello.start), osSession: hello.session,
    });
  } finally {
    server.close();
  }
}

function authenticate(server: Server, child: ChildProcess, token: string, deadlineMs: number): Promise<{ socket: Socket; hello: Hello; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let first: Socket | undefined;
    let settled = false;
    const fail = (socket: Socket | undefined, message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      killAndReject(child, message).catch(reject);
    };
    const timer = setTimeout(() => fail(first, `windows supervisor: no hello within ${deadlineMs} ms`), deadlineMs);
    void exitOf(child).then(exit => fail(first, `windows supervisor exited before hello (${exit.code ?? exit.signal})`));
    server.on('connection', socket => {
      if (first) { socket.destroy(); return; }
      first = socket;
      let pending = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        const end = pending.indexOf(0x0a);
        if (end === -1) { if (pending.length > 256) fail(socket, 'windows supervisor: hello too long'); return; }
        socket.off('data', onData);
        const hello = parseHello(pending.subarray(0, end).toString('latin1'));
        if (!hello || !sameToken(hello.token, token)) return fail(socket, 'windows supervisor: wrong token or malformed hello');
        if (hello.pid !== child.pid) return fail(socket, `windows supervisor: hello pid ${hello.pid} is not the child ${child.pid}`);
        settled = true;
        clearTimeout(timer);
        resolve({ socket, hello, rest: pending.subarray(end + 1) });
      };
      socket.on('data', onData);
      socket.once('close', () => fail(socket, 'windows supervisor: control socket closed before hello'));
    });
  });
}

function parseHello(line: string): Hello | undefined {
  const match = HELLO.exec(line);
  if (!match) return undefined;
  const [, token, pid, session, start] = match as unknown as [string, string, string, string, string];
  return { token, pid: Number(pid), session: Number(session), start };
}

const sameToken = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
