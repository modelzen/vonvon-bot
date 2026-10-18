import { Command } from 'commander';
import { mkdir } from 'node:fs/promises';
import { formatErrorTree } from '../core/error-parts';
import { bridgeVersion } from '../core/version';
import { paths } from '../config/paths';
import { enterDataAccess, type DataLease } from '../config/data-access';
import { observeShutdown, type ShutdownControl } from '../host/lifecycle';
import type { LingerChoice } from './commands/service';

const program = new Command().name('vonvon').description('Vonvon Bot daemon').version(bridgeVersion());
let lease: DataLease | undefined;
let control: ShutdownControl | undefined;
program.hook('preAction', async (_command, action) => {
  // bot, group and settings only talk RPC to a running daemon, so they never create the data root or take a lease;
  // bot repair-dir writes bots.json itself, under the daemon's own lock, and takes one.
  const parent = action.parent?.name();
  if (parent === 'service' || (parent === 'bot' && action.name() !== 'repair-dir') || parent === 'group' || parent === 'settings' || action.name() === '__daemon-control') return;
  if (action.name() === 'run') {
    const runControl = control = observeShutdown(Boolean(action.opts().parentControl));
    (await import('../host/crash-guard')).installCrashHandlers({ intent: () => runControl.intent ?? (runControl.requested ? 'stop' : 'running') });
  }
  if (action.name() === 'open' || action.name() === 'status' || action.name() === 'logs' || action.name() === '__restart-after-exit') return;
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
daemon.command('restart').description('Restart the daemon (also resumes it after a crash pause)').action(async () => {
  const { status, outcome } = await (await import('./commands/daemon')).runRestart();
  process.stdout.write(`running PID ${status.pid} at ${status.listen}\n`);
  if (outcome === 'resumed') process.stdout.write('已恢复运行（之前因 10 分钟内崩溃 3 次暂停）。\n');
  else if (outcome === 'started') process.stdout.write('daemon 没在运行，已启动。\n');
});
daemon.command('status').description('Show daemon status').option('--json', 'Print JSON').action(async (options: { json?: boolean }) => {
  await (await import('./commands/daemon')).runStatus(Boolean(options.json));
});
daemon.command('logs').description('Read recent daemon logs').option('--tail <lines>', 'Approximate line count', (value) => Number(value), 200)
  .action(async (options: { tail: number }) => {
    if (!Number.isInteger(options.tail) || options.tail < 1) throw new Error('Invalid tail count.');
    await (await import('./commands/daemon')).runLogs(options.tail);
  });
program.command('open').description('Open the local web UI')
  .option('--print', '打印网页地址和 SSH 转发的办法，不打开浏览器（带凭据的链接只打印到终端）')
  .action(async (options: { print?: boolean }) => {
    await (await import('./commands/open')).runOpen(Boolean(options.print));
  });
const service = program.command('service').description('Manage the OS background service');
const KEEP_RUNNING = ['--keep-running', '结束时之前在跑的 daemon 没了，就按原来的端口起一个分离的 daemon', false] as const;
service.command('install').description('Install and start the OS service; a running detached daemon is handed over')
  .option('--port <port>', 'Loopback API port', (value) => Number(value))
  .option(...KEEP_RUNNING)
  .option('--linger', 'Linux：linger 没开就直接开，不问')
  .option('--no-linger', 'Linux：linger 没开也不开，只打印命令')
  .action(async (options: { port?: number; keepRunning: boolean; linger?: boolean }) => {
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw new Error('Invalid port.');
    let linger: LingerChoice = 'ask';
    if (options.linger === true) linger = 'on';
    else if (options.linger === false) linger = 'off';
    await (await import('./commands/service')).runServiceCommand('install', undefined, { ...(options.port ? { port: options.port } : {}), keepRunning: options.keepRunning, linger });
  });
service.command('uninstall').description('Stop and remove the OS service').option(...KEEP_RUNNING).action(async (options: { keepRunning: boolean }) => {
  await (await import('./commands/service')).runServiceCommand('uninstall', undefined, { keepRunning: options.keepRunning });
});
service.command('status').description('Show the OS service and whether it runs the daemon').option('--json', 'Print JSON').action(async (options: { json?: boolean }) => {
  await (await import('./commands/service')).runServiceStatus(Boolean(options.json));
});
type Json = { json?: boolean };
const io = (options: Json) => ({ json: Boolean(options.json), write: (text: string) => { process.stdout.write(text); } });
const BOT = ['--bot <bot>', 'Bot id (cli_…) or name'] as const;
const bot = program.command('bot').description('Show bots through the running daemon');
bot.command('add').description('Register a bot by scanning a QR code in this terminal').action(async () => {
  await (await import('./commands/bot')).runBotAdd(io({}));
});
bot.command('list').description('List bots and their connection state').option('--json', 'Print JSON').action(async (options: Json) => {
  await (await import('./commands/bot')).runBotList(io(options));
});
bot.command('status [bot]').description("Show a bot's setup checklist").option(...BOT).option('--json', 'Print JSON').action(async (wanted: string | undefined, options: Json & { bot?: string }) => {
  if (wanted !== undefined && options.bot !== undefined && wanted !== options.bot) throw new Error(`bot 填了两次（${wanted} 和 --bot ${options.bot}），只留一个。`);
  await (await import('./commands/bot')).runBotStatus(options.bot ?? wanted, io(options));
});
bot.command('repair-dir <bot>').description("Record a bot's directories again where they are now, after a move or a restore")
  .option('--json', 'Print JSON')
  .addHelpText('after', `
The bot's directory, its groups folder and each group's folder keep their paths, but a move to another computer,
a restore from a backup or a copy back changes what the files are on disk, and binding a group then fails with a
hint to run this. Check the folders first. The paths themselves cannot change. A folder that is gone stays
recorded and is made again, empty, when it is next used. Run it once for each bot; it names the other bots under
the same projects root that need it too. Works with or without the daemon running.

Example:
  vonvon bot repair-dir 研发助手`)
  .action(async (wanted: string, options: Json) => {
    await (await import('./commands/bot')).runBotRepairDir(wanted, io(options));
  });
const group = program.command('group').description('List and bind Feishu groups');
group.command('list').description('List bound groups').option(...BOT).option('--json', 'Print JSON').action(async (options: Json & { bot?: string }) => {
  await (await import('./commands/group')).runGroupList(options, io(options));
});
group.command('joined').description('List the groups a bot is in, from Feishu').option(...BOT).option('--json', 'Print JSON').action(async (options: Json & { bot?: string }) => {
  await (await import('./commands/group')).runGroupJoined(options, io(options));
});
group.command('pending').description('List groups that added the bot and wait to be bound').option(...BOT).option('--json', 'Print JSON').action(async (options: Json & { bot?: string }) => {
  await (await import('./commands/group')).runGroupPending(options, io(options));
});
group.command('bind <groupId>').description('Bind a group (oc_…) to a folder')
  .requiredOption('--folder <path>', 'Working folder')
  .option('--name <name>', 'Project name; defaults to the group name')
  .option('--tool <tool>', 'codex or claude', 'codex')
  .option('--conversation <mode>', 'Required. multi (@ me opens a topic, one session per topic) or single (one session for the main area)')
  .option('--response <reply>', 'mention (reply only when @-ed) or all (no @ needed); defaults: multi all, single mention')
  .option(...BOT).option('--json', 'Print JSON')
  .action(async (groupId: string, options: Json & { folder: string; name?: string; tool: string; conversation?: string; response?: string; bot?: string }) => {
    await (await import('./commands/group')).runGroupBind(groupId, options, io(options));
  });
const settings = program.command('settings').description('Read and change bot, group and session settings');
type Target = Json & { bot?: string; group?: string; session?: string };
const scoped = (command: Command) => command.option(...BOT).option('--group <group>', 'Group id (oc_…) or project name').option('--session <threadId>', 'Session thread id').option('--json', 'Print JSON');
scoped(settings.command('get [section]').description('Show settings, or one section; `get judge` also prints the whole judge prompt')).action(async (section: string | undefined, options: Target) => {
  await (await import('./commands/settings')).runSettingsGet(section, options, io(options));
});
scoped(settings.command('set <section.key=value...>').description('Change fields of one section; values are JSON or plain text'))
  .addHelpText('after', `
Examples:
  vonvon settings set --group oc_xxx permission.mode=full
  vonvon settings set --group oc_xxx permission.mode=write permission.network=true
  vonvon settings set cards.showToolCalls=false
  vonvon settings set --group oc_xxx model.selection='{"kind":"explicit","model":"gpt-5.5","effort":"medium"}'
  vonvon settings set judge.selection='{"kind":"llm","model":"gpt-6-luna","effort":"low"}'
  vonvon settings set --group oc_xxx judge.selection='{"kind":"default"}'   # 群里去掉覆盖，用 bot 的`)
  .action(async (assignments: string[], options: Target) => {
    await (await import('./commands/settings')).runSettingsSet(assignments, options, io(options));
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

// `vonvon hook` is answered in bin/vonvon.mjs before this bundle loads.
program.parseAsync(process.argv).then(async () => {
  if (!control) return;
  await (await import('../core/logger')).flushLogs();
  process.exit(process.exitCode ?? 0);
}).catch(async (err) => {
  // s17b: an AggregateError (a failed shutdown) also prints each error inside it, one per line.
  console.error(formatErrorTree(err));
  await (await import('../core/logger')).flushLogs();
  // A service-managed host keeps a stop (0) or a requested restart (75) even when cleanup failed; anything else is 1.
  const code = process.exitCode;
  process.exit(control && process.env.VONVON_SERVICE && !process.send && (code === 0 || code === 75) ? code : 1);
});
