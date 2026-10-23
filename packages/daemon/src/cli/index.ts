// first: sets the connection defaults of every daemon process (the supervisor, each `--bot` child and each command)
import './tune-network';
import { Command, Option } from 'commander';
import { commandFailure } from './command-error';
import { mkdir } from 'node:fs/promises';
import { formatErrorTree } from '../core/error-parts';
import { bridgeVersion } from '../core/version';
import { paths } from '../config/paths';
import { enterDataAccess, type DataLease } from '../config/data-access';
import { inBotSession } from '../config/session-env';
import { observeShutdown, type ShutdownControl } from '../host/lifecycle';
import type { LingerChoice } from './commands/service';

const program = new Command().name('vonvon').description('Vonvon Bot daemon').version(bridgeVersion());
const structured = ['settings', 'feishu'].includes(process.argv[2] ?? '');
const jsonFailure = structured && process.argv.includes('--json');
if (structured) program.exitOverride();
if (jsonFailure) program.configureOutput({ writeErr: () => undefined });
let lease: DataLease | undefined;
let control: ShutdownControl | undefined;
program.hook('preAction', async (_command, action) => {
  // bot, group and settings only talk RPC to a running daemon, so they never create the data root or take a lease;
  // bot repair-dir writes bots.json itself, under the daemon's own lock, and takes one.
  const parent = action.parent?.name();
  // The exec provider runs in sandboxes that refuse admission sockets and data-root writes.
  // Like daemon getSecret, it only reads the atomically published keystore and takes no lease.
  if (parent === 'secrets' && action.name() === 'get') return;
  if (parent === 'service' || (parent === 'bot' && action.name() !== 'repair-dir') || parent === 'group' || parent === 'settings' || parent === 'feishu' || action.name() === '__daemon-control') return;
  // project list only reads files published with tmp + rename (the library, bots.json, each projects.json), like secrets get
  if (parent === 'project') return;
  // memory reads and writes the entry files under their own kernel mutex, so it takes no lease either; in a Bot's session its writes refuse in the handler (commands/memory.ts)
  if (parent === 'memory') return;
  // in a Bot's session secrets list, set and remove only refuse (s23g): before the lease, whose socket a sandbox may forbid, and the data root
  if (parent === 'secrets' && action.name() !== 'get' && inBotSession(process.env)) return;
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
  if (wanted !== undefined && options.bot !== undefined && wanted !== options.bot) throw new Error(`Bot 填了两次（${wanted} 和 --bot ${options.bot}），只留一个。`);
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
  .option('--conversation <mode>', 'Required. multi (@ me opens a topic, one session per topic), single (one session for the main area) or smart (the Bot reads the group and replies when it fits)')
  .option('--response <reply>', 'mention (reply only when @-ed) or all (no @ needed); defaults: multi all, single mention; not with smart')
  .option(...BOT).option('--json', 'Print JSON')
  .action(async (groupId: string, options: Json & { folder: string; name?: string; tool: string; conversation?: string; response?: string; bot?: string }) => {
    await (await import('./commands/group')).runGroupBind(groupId, options, io(options));
  });
const project = program.command('project').description('List projects: the folders and memory groups share');
project.command('list').description('List projects with their folders and the groups that use them').option('--json', 'Print JSON').action(async (options: Json) => {
  await (await import('./commands/project')).runProjectList(io(options));
});
const memory = program.command('memory').description('Read and change memory entries: a project\'s or a bot\'s');
const memoryScope = (command: Command) => command.option('--project <project>', 'Project name or id (prj_…)').option('--bot <appId>', 'Bot id: its own memory').option('--json', 'Print JSON');
const memoryContext = async (options: Json) => (await import('./commands/memory')).terminalMemoryContext(io(options));
type MemoryOptions = Json & { project?: string; bot?: string; branch?: string; revision: string; text?: string };
memoryScope(memory.command('list').description('List the entries by branch')).action(async (options: MemoryOptions) => {
  await (await import('./commands/memory')).runMemoryList(options, await memoryContext(options));
});
memoryScope(memory.command('export').description('One markdown document per branch')).action(async (options: MemoryOptions) => {
  await (await import('./commands/memory')).runMemoryExport(options, await memoryContext(options));
});
memoryScope(memory.command('add <text>').description('Add an entry (refused in a Bot session)').option('--branch <name>', 'Branch; a new name opens one, none means 其他'))
  .action(async (text: string, options: MemoryOptions) => { await (await import('./commands/memory')).runMemoryAdd(text, options, await memoryContext(options)); });
memoryScope(memory.command('edit <itemId>').description('Change an entry (refused in a Bot session)').requiredOption('--revision <n>', 'The revision vonvon memory list shows').option('--text <text>', 'New text').option('--branch <name>', 'Move to this branch'))
  .action(async (itemId: string, options: MemoryOptions) => { await (await import('./commands/memory')).runMemoryEdit(itemId, options, await memoryContext(options)); });
memoryScope(memory.command('forget <itemId>').description('Archive an entry (refused in a Bot session)').requiredOption('--revision <n>', 'The revision vonvon memory list shows'))
  .action(async (itemId: string, options: MemoryOptions) => { await (await import('./commands/memory')).runMemoryForget(itemId, options, await memoryContext(options)); });
memoryScope(memory.command('branch-rename <from> <to>').description('Rename a branch (refused in a Bot session)'))
  .action(async (from: string, to: string, options: MemoryOptions) => { await (await import('./commands/memory')).runMemoryBranch('rename', from, to, options, await memoryContext(options)); });
memoryScope(memory.command('branch-merge <from> <into>').description('Merge a branch into another (refused in a Bot session)'))
  .action(async (from: string, into: string, options: MemoryOptions) => { await (await import('./commands/memory')).runMemoryBranch('merge', from, into, options, await memoryContext(options)); });
const settings = program.command('settings').description('Read and change bot, group and session settings');
type Target = Json & { bot?: string; group?: string; session?: string; revision?: string; reason?: string };
const scoped = (command: Command) => command.option(...BOT).option('--group <group>', 'Group id (oc_…) or project name').option('--session <threadId>', 'Session thread id').option('--json', 'Print JSON');
scoped(settings.command('get [section]').description('Show settings, or one section; `get judge` also prints the whole judge prompt')).action(async (section: string | undefined, options: Target) => {
  await (await import('./commands/settings')).runSettingsGet(section, options, io(options));
});
scoped(settings.command('access').description('Show access to the requested settings')).action(async (options: Target) => {
  await (await import('./commands/settings')).runSettingsAccess(options, io(options));
});
scoped(settings.command('set <section.key=value...>').description('Change fields of one section; values are JSON or plain text'))
  .option('--revision <revision>', 'Revision held by the caller; stale revisions are rejected')
  .option('--reason <text>', 'Explanation retained with the committed result')
  .addHelpText('after', `
Examples:
  vonvon settings set --group oc_xxx permission.mode=full
  vonvon settings set --group oc_xxx permission.mode=write permission.network=true
  vonvon settings set cards.showToolCalls=false
  vonvon settings set --group oc_xxx model.selection='{"kind":"explicit","model":"gpt-5.5","effort":"medium"}'
  vonvon settings set judge.selection='{"kind":"llm","model":"gpt-6-luna","effort":"low"}'
  vonvon settings set judge.selection='{"kind":"decision","provider":"typesafe","model":"jev-latest"}'   # 决策模型，各后端的群都用
  vonvon settings set --group oc_xxx judge.selection='{"kind":"default"}'   # 群里去掉覆盖，用 bot 的`)
  .action(async (assignments: string[], options: Target) => {
    await (await import('./commands/settings')).runSettingsSet(assignments, options, io(options));
  });
const feishu = program.command('feishu').description('Read Feishu groups and members');
feishu.command('groups').description('List joined groups, one page').option(...BOT).option('--cursor <cursor>', 'Next page cursor').option('--json', 'Print JSON')
  .action(async (options: Json & { bot?: string; cursor?: string }) => {
    await (await import('./commands/feishu')).runFeishu('groups', undefined, options, io(options));
  });
feishu.command('members <groupId>').description('List group members, one page').option(...BOT).option('--cursor <cursor>', 'Next page cursor').option('--json', 'Print JSON')
  .action(async (groupId: string, options: Json & { bot?: string; cursor?: string }) => {
    await (await import('./commands/feishu')).runFeishu('members', groupId, options, io(options));
  });
program.command('__daemon-control <action>', { hidden: true }).action(async (action: string) => {
  await (await import('./commands/daemon-control')).runDaemonControl(action);
});
program.command('__restart-after-exit <port> <oldPid> <oldStartedAt> [update]', { hidden: true }).action(async (port: string, oldPid: string, oldStartedAt: string, update?: string) => {
  const { updateStatusSchema } = await import('../service/update');
  await (await import('../host/restart')).runSamePortRestartHelper({ port: Number(port), oldPid: Number(oldPid), oldStartedAt, ...(update ? { update: updateStatusSchema.parse(JSON.parse(update)) } : {}) });
});

const secrets = program.command('secrets').description('本机的密钥库：决策模型等服务的 API key，整台电脑一份，所有 Bot 共用');
const secretsContext = async (options: Json = {}) => (await import('./commands/secrets')).terminalContext(io(options));
// The `secrets-getter` wrapper execs `secrets get` to resolve the App Secret from the keystore: internal, unlisted.
secrets.command('get', { hidden: true }).description('exec-provider 端点（从 stdin 读 JSON 请求）').action(async () => {
  await (await import('./commands/secrets')).secretsGet();
});
secrets.command('list').description('列出要 key 的服务：填没填、末四位、哪些 Bot 和飞书群选了它').option('--json', 'Print JSON').action(async (options: Json) => {
  await (await import('./commands/secrets')).runSecretsList(await secretsContext(options));
});
// --raw <id>: any entry by its id, for internal use and repairs; not in the help
// commander takes excess arguments silently and, allowed, unknown options too: a key typed after the name is then in
// command.args, refused in words; commander's own error would echo it
secrets.command('set <name>').description('填或换一个 key：终端里按提示粘贴（不回显），脚本里从标准输入传')
  .addOption(new Option('--raw').hideHelp()).allowUnknownOption()
  .addHelpText('after', `
Names:
  typesafe-api-key   TypeSafe（决策模型 Jev）

The key is never an argument: it would stay in the shell history. After saving, the key is tried once.

Examples:
  vonvon secrets set typesafe-api-key
  vonvon secrets set typesafe-api-key < key.txt   # 脚本里`)
  .action(async (name: string, options: { raw?: boolean }, command: Command) => {
    await (await import('./commands/secrets')).runSecretsSet(name, command.args.slice(1), options, await secretsContext());
  });
secrets.command('remove <name>').description('删掉一个 key；选了它的 Bot 和飞书群要判断的消息按出错处理').addOption(new Option('--raw').hideHelp()).allowUnknownOption()
  .addHelpText('after', `
删之前可以先运行 vonvon secrets list，看哪些 Bot 和飞书群选了它；删完也会列出还选着它的。`)
  .action(async (name: string, options: { raw?: boolean }, command: Command) => {
    await (await import('./commands/secrets')).runSecretsRemove(name, command.args.slice(1), options, await secretsContext());
  });

// `vonvon hook` is answered in bin/vonvon.mjs before this bundle loads.
program.parseAsync(process.argv).then(async () => {
  if (!control) return;
  await (await import('../core/logger')).flushLogs();
  process.exit(process.exitCode ?? 0);
}).catch(async (err) => {
  if (structured) {
    if (err?.code === 'commander.helpDisplayed' || err?.code === 'commander.version') return;
    const failure = commandFailure(err);
    if (jsonFailure) process.stdout.write(`${JSON.stringify(failure)}\n`);
    else console.error(failure.error.message);
    process.exitCode = failure.exitCode;
    return;
  }
  // s17b: an AggregateError (a failed shutdown) also prints each error inside it, one per line.
  console.error(formatErrorTree(err));
  await (await import('../core/logger')).flushLogs();
  // A service-managed host keeps a stop (0) or a requested restart (75) even when cleanup failed; anything else is 1.
  const code = process.exitCode;
  process.exit(control && process.env.VONVON_SERVICE && !process.send && (code === 0 || code === 75) ? code : 1);
});
