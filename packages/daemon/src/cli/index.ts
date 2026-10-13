import { Command } from 'commander';
import { mkdir } from 'node:fs/promises';
import { bridgeVersion } from '../core/version';
import { paths } from '../config/paths';
import { enterDataAccess, type DataLease } from '../config/data-access';
import { observeShutdown, type ShutdownControl } from '../host/lifecycle';
import { SERVICE_UNAVAILABLE } from '../host/service';

const program = new Command().name('vonvon').description('Vonvon Bot daemon').version(bridgeVersion());
let lease: DataLease | undefined;
let control: ShutdownControl | undefined;
program.hook('preAction', async (_command, action) => {
  if (action.parent?.name() === 'service' || action.name() === '__daemon-control') return;
  if (action.name() === 'run') control = observeShutdown(Boolean(action.opts().parentControl));
  if (action.name() === 'open' || action.name() === 'status' || action.name() === 'logs' || action.name() === '__restart-after-exit' || action.name() === '__win-relaunch') return;
  await mkdir(paths.appDir, { recursive: true, mode: 0o700 });
  lease = await enterDataAccess(paths.appDir);
});
program.hook('postAction', () => { lease?.release(); control?.dispose(); });
const daemon = program.command('daemon').description('Run the local daemon');
daemon.command('run').description('Run in the foreground')
  .option('--bot <appId>', 'Run one bot')
  .option('--parent-control', 'Accept shutdown through stdin', false)
  .option('--port <port>', 'Loopback API port', (value) => Number(value), 0)
  .action(async (options: { bot?: string; port: number; parentControl?: boolean }) => {
    await (await import('../host/bootstrap')).runHostRuntime({ bot: options.bot, port: options.port, managed: false, control });
  });
daemon.command('start').description('Start a detached daemon')
  .option('--port <port>', 'Loopback API port', (value) => Number(value), 0)
  .action(async (options: { port: number }) => {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid port.');
    const status = await (await import('./commands/daemon')).runStart(options.port);
    if (status.running) process.stdout.write(`running PID ${status.pid} at ${status.listen}\n`);
  });
daemon.command('stop').description('Stop the running daemon').action(async () => {
  const stopped = await (await import('./commands/daemon')).runStop();
  process.stdout.write(stopped ? 'stopped\n' : 'already stopped\n');
});
daemon.command('status').description('Show daemon status').option('--json', 'Print JSON').action(async (options: { json?: boolean }) => {
  await (await import('./commands/daemon')).runStatus(Boolean(options.json));
});
daemon.command('logs').description('Read recent daemon logs').option('--tail <lines>', 'Approximate line count', (value) => Number(value), 200)
  .action(async (options: { tail: number }) => {
    if (!Number.isInteger(options.tail) || options.tail < 1) throw new Error('Invalid tail count.');
    await (await import('./commands/daemon')).runLogs(options.tail);
  });
program.command('open').description('Open the local web UI').action(async () => {
  await (await import('./commands/open')).runOpen();
});
const service = program.command('service').description('Manage the OS background service');
service.command('install').description('Install and start the OS service').action(async () => {
  await (await import('./commands/service')).runServiceCommand('install');
});
service.command('uninstall').description('Stop and remove the OS service').action(async () => {
  await (await import('./commands/service')).runServiceCommand('uninstall');
});
program.command('__win-relaunch <requestPath>', { hidden: true }).action(() => {
  throw new Error(SERVICE_UNAVAILABLE);
});
program.command('__daemon-control <action>', { hidden: true }).action(async (action: string) => {
  await (await import('./commands/daemon-control')).runDaemonControl(action);
});
program.command('__restart-after-exit <port> <oldPid> <oldStartedAt> [update]', { hidden: true }).action(async (port: string, oldPid: string, oldStartedAt: string, update?: string) => {
  const { updateStatusSchema } = await import('../service/update');
  await (await import('../host/restart')).runSamePortRestartHelper({ port: Number(port), oldPid: Number(oldPid), oldStartedAt, ...(update ? { update: updateStatusSchema.parse(JSON.parse(update)) } : {}) });
});

// Internal plumbing — the `secrets-getter` wrapper execs `secrets get` to
// resolve the App Secret from the keystore. Users never call it, so hide it
// from --help (still fully functional, just unlisted).
const secrets = program.command('secrets', { hidden: true }).description('本地加密密钥库（内部）');
secrets
  .command('get')
  .description('exec-provider 端点（从 stdin 读 JSON 请求）')
  .action(async () => {
    await (await import('./commands/secrets')).secretsGet();
  });
secrets
  .command('set <id>')
  .description('存储密钥（值从 stdin 读）')
  .action(async (id: string) => {
    await (await import('./commands/secrets')).secretsSet(id);
  });
secrets
  .command('list')
  .description('列出密钥 id')
  .action(async () => {
    await (await import('./commands/secrets')).secretsList();
  });
secrets
  .command('remove <id>')
  .description('删除密钥')
  .action(async (id: string) => {
    await (await import('./commands/secrets')).secretsRemove(id);
  });

program
  .command('hook', { hidden: true })
  .requiredOption('--agent <agent>', 'claude or codex')
  .option('--bot <nameOrAppId>', 'target bot name or appId')
  .action(async (options: { agent: string; bot?: string }) => {
    const { runHookCommand } = await import('../cli-bridge');
    await runHookCommand(options.agent, options.bot);
  });

program.parseAsync(process.argv).then(async () => {
  if (!control) return;
  await (await import('../core/logger')).flushLogs();
  process.exit(process.exitCode ?? 0);
}).catch(async (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  await (await import('../core/logger')).flushLogs();
  process.exit(control && process.env.VONVON_SERVICE && !process.send && (process.exitCode === 0 || process.exitCode === 75) ? 0 : 1);
});
