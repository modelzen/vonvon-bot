import { ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import crossSpawn from 'cross-spawn';
import { spawnWindowsSupervisor } from '../provider/process/windows-supervisor';
import type { HolderChannel } from '../provider/process/holder-channel';
import { newNonce, type HolderCommand, type ReceiptLine } from '../provider/process/holder-protocol';
import { quoteCmdArg } from '../provider/process/windows-command-line';

/** A ChildProcess-shaped stream facade; the supervisor owns the actual process in a Job from its first instruction. */
export class WindowsOwnedProcess {
  readonly child = new ChildProcess();
  private readonly input = new PassThrough();
  private readonly output = new PassThrough();
  private readonly errors = new PassThrough();
  private readonly ready: Promise<HolderChannel>;
  private stopping?: Promise<void>;
  private closing?: Promise<void>;
  private exitObserved = false;
  private containmentConfirmed = true;
  private readonly streamsClosed = Promise.all([this.output, this.errors].map(stream => new Promise<void>(resolve => {
    stream.once('end', resolve);
    stream.once('close', resolve);
  })));

  get cleanupUnconfirmed(): boolean { return !this.containmentConfirmed; }

  constructor(command: string, args: string[], options: SpawnOptions) {
    const piped = (index: number) => options.stdio === undefined || options.stdio === 'pipe' || Array.isArray(options.stdio) && options.stdio[index] === 'pipe';
    Object.assign(this.child, { stdin: piped(0) ? this.input : null, stdout: piped(1) ? this.output : null, stderr: piped(2) ? this.errors : null });
    Object.assign(this.child, { stdio: [this.child.stdin, this.child.stdout, this.child.stderr], spawnfile: command, spawnargs: [command, ...args] });
    if (!piped(0)) this.input.end();
    if (!piped(1)) this.output.resume();
    if (!piped(2)) this.errors.resume();
    this.input.on('error', () => undefined);
    this.child.kill = () => {
      Object.defineProperty(this.child, 'killed', { value: true, configurable: true });
      void this.stop().catch(error => this.child.emit('error', error));
      return true;
    };
    this.ready = this.start(command, args, options);
    void this.ready.catch(error => {
      this.input.destroy(); this.output.end(); this.errors.end();
      this.child.emit('error', error);
      void this.finishClose();
    });
  }

  private async start(command: string, args: string[], options: SpawnOptions): Promise<HolderChannel> {
    if (options.shell || (options.stdio !== undefined && options.stdio !== 'pipe' && options.stdio !== 'ignore' &&
      !(Array.isArray(options.stdio) && options.stdio.length === 3 && options.stdio.every(slot => slot === 'pipe' || slot === 'ignore')))) {
      throw new Error('Windows owned processes require direct execution and pipe/ignore stdio');
    }
    // Reuse exactly the executable resolution and .cmd escaping used by spawnProcess.
    const parse = (crossSpawn as typeof crossSpawn & { _parse(command: string, args: string[], options: SpawnOptions): { command: string; args: string[]; options: SpawnOptions; file?: string } })._parse;
    const parsed = parse(command, args, options);
    if (!parsed.file) throw new Error(`Windows provider executable was not found: ${command}`);
    // CreateProcessW does not search the supplied child PATH. Resolve the parsed
    // executable (including a shebang interpreter) before entering the holder.
    const executable = parse(parsed.command, [], options).file;
    if (!executable) throw new Error(`Windows provider executable was not found: ${command}`);
    const line = parsed.options.windowsVerbatimArguments
      ? [quoteCmdArg(parsed.command), ...parsed.args].join(' ')
      : [parsed.command, ...parsed.args].map(quoteCmdArg).join(' ');
    const id = randomUUID();
    const channel = await spawnWindowsSupervisor({ jobName: `Local\\vonvon-owned-${id}`, logPath: join(tmpdir(), `vonvon-owned-${id}.log`) });
    this.input.pipe(channel.stdin);
    channel.stdout.pipe(this.output);
    channel.stderr.pipe(this.errors);
    channel.onReceipt(receipt => {
      if (receipt.kind !== 'provider-exit' || this.exitObserved) return;
      this.exitObserved = true;
      Object.assign(this.child, { exitCode: receipt.code, signalCode: receipt.signal });
      this.child.emit('exit', this.child.exitCode, this.child.signalCode);
    });
    try {
      this.containmentConfirmed = false;
      const receipt = await this.request(channel, {
        command: 'launch', nonce: newNonce(), file: executable, args: [line],
        env: Object.fromEntries(Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        cwd: options.cwd?.toString(),
      });
      if (receipt.kind !== 'ready' || receipt.pid === undefined) {
        if (receipt.kind === 'launch-failed' || receipt.kind === 'job-collision') this.containmentConfirmed = true;
        throw new Error(`Windows provider launch failed: ${JSON.stringify(receipt)}`);
      }
      Object.defineProperty(this.child, 'pid', { value: receipt.pid, configurable: true });
      void channel.exited.then(() => {
        if (!this.exitObserved) this.child.emit('error', new Error('Windows process supervisor exited without a provider exit receipt'));
        void this.finishClose();
      });
      this.child.emit('spawn');
      return channel;
    } catch (error) { channel.close(); await channel.exited; throw error; }
  }

  private finishClose(): Promise<void> {
    return this.closing ??= (async () => {
      this.input.destroy();
      // Like ChildProcess, drain streams nobody has read. An explicitly paused
      // consumer retains its buffered output and must resume before close.
      for (const stream of [this.output, this.errors]) if (stream.readableFlowing === null) stream.resume();
      await this.streamsClosed;
      this.child.emit('close', this.child.exitCode, this.child.signalCode);
    })();
  }

  private request(channel: HolderChannel, command: HolderCommand): Promise<ReceiptLine> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, receipt?: ReceiptLine) => { clearTimeout(timer); off(); error ? reject(error) : resolve(receipt!); };
      const off = channel.onReceipt(receipt => { if ('nonce' in receipt && receipt.nonce === command.nonce) finish(undefined, receipt); });
      const timer = setTimeout(() => finish(new Error(`Windows supervisor ${command.command} timed out`)), 10_000);
      void channel.closed.then(() => finish(new Error('Windows supervisor control channel closed')));
      if (!channel.send(command)) finish(new Error('Windows supervisor rejected command'));
    });
  }

  stop(): Promise<void> {
    return this.stopping ??= this.stopTree();
  }

  private async stopTree(): Promise<void> {
    const channel = await this.ready;
    try {
      const killed = await this.request(channel, { command: 'kill', nonce: newNonce() });
      if (killed.kind !== 'sent') throw new Error(`Windows Job termination was not confirmed: ${JSON.stringify(killed)}`);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const probe = await this.request(channel, { command: 'probe', nonce: newNonce() });
        if (probe.kind === 'empty') { this.containmentConfirmed = true; break; }
        if (probe.kind !== 'live' || Date.now() >= deadline) throw new Error('Windows Job did not confirm an empty process tree');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      // The holder emits provider-exit from a separate waiter. Wait for that receipt before closing control.
      while (!this.exitObserved) {
        if (Date.now() >= deadline) throw new Error('Windows provider exit receipt timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      channel.send({ command: 'exit', nonce: newNonce() });
      await channel.exited;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([this.finishClose(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Windows provider output pipes did not close')), 500);
        })]);
      } finally { clearTimeout(timer); }
    } finally { channel.close(); }
  }
}
