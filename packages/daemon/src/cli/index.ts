// first: sets the connection defaults of every daemon process (the supervisor, each `--bot` child and each command)
import './tune-network';
import { Command, CommanderError, Help, Option } from 'commander';
import { badArgs, commandFailure } from './command-error';
import { mkdir } from 'node:fs/promises';
import { formatErrorTree } from '../core/error-parts';
import { bridgeVersion } from '../core/version';
import { paths } from '../config/paths';
import { enterDataAccess, type DataLease } from '../config/data-access';
import { inBotSession } from '../config/session-env';
import { observeShutdown, type ShutdownControl } from '../host/lifecycle';
import type { LingerChoice } from './commands/service';
import type { ScheduleAction, ScheduleTarget } from './commands/schedule';

/** devices 8.1: every command takes --json and fails through `commandFailure` (the runner at the bottom). */
export const program = new Command().name('vonvon').description('Vonvon Bot daemon').version(bridgeVersion());
/** --json: stdout has JSON only, one line (`bot add`: one per step), a failure's too; commander's usage errors stay off stderr. */
const jsonOutput = process.argv.includes('--json');
// Before the subcommands, which copy both: commander's usage errors, --help and --version come back as a CommanderError.
program.exitOverride();
if (jsonOutput) program.configureOutput({ writeErr: () => undefined });
let lease: DataLease | undefined;
let control: ShutdownControl | undefined;

const coverage = new WeakMap<Command, readonly string[]>();
/** devices 8.5: the RPC kinds (protocol `rpcKinds()`) whose feature this command gives the terminal. */
const covers = <C extends Command>(command: C, ...kinds: string[]): C => { coverage.set(command, kinds); return command; };
export type CommandInfo = { path: string; hidden: boolean; covers: readonly string[]; options: string[] };
/** Each command that runs something (a leaf), with what test/cli-parity.test.ts checks. */
export function commandList(root: Command = program, prefix = '', hidden = false): CommandInfo[] {
  const visible = new Set(new Help().visibleCommands(root));
  return root.commands.flatMap(command => {
    const path = `${prefix}${command.name()}`;
    if (command.commands.length) return commandList(command, `${path} `, hidden || !visible.has(command));
    return [{ path, hidden: hidden || !visible.has(command), covers: coverage.get(command) ?? [], options: command.options.flatMap(option => option.long ?? []) }];
  });
}
type Json = { json?: boolean };
const JSON_FLAG = ['--json', 'Print JSON'] as const;
const io = (options: Json) => ({ json: Boolean(options.json), write: (text: string) => { process.stdout.write(text); } });
const show = async <T extends object>(options: Json, human: string[], json: T & { ok?: never }): Promise<void> => (await import('./daemon-client')).print(io(options), human, json);
const FRESH = ['--fresh', 'Have the daemon probe the tools and rebuild its state first (it does every 5 s)'] as const;
const daemonFor = async (options: { fresh?: boolean }) => {
  const client = await import('./daemon-client');
  return options.fresh ? client.freshDaemon : client.withDaemon;
};
/** The commands that write the data root themselves, so they hold the data lease (cli-2-bot 4.6); every other command
 * talks to the daemon, or reads files published with tmp + rename, and takes none. */
const LEASED = new Set(['daemon run', 'daemon start', 'daemon stop', 'daemon restart', 'bot repair-dir', 'secrets list', 'secrets set', 'secrets remove']);
program.hook('preAction', async (_command, action) => {
  const path = `${action.parent?.name() ?? ''} ${action.name()}`;
  if (path === 'daemon run') {
    const runControl = control = observeShutdown(Boolean(action.opts().parentControl));
    (await import('../host/crash-guard')).installCrashHandlers({ intent: () => runControl.intent ?? (runControl.requested ? 'stop' : 'running') });
  }
  if (!LEASED.has(path)) return;
  // in a Bot's session secrets list, set and remove only refuse (s23g): before the lease, whose socket a sandbox may forbid
  if (action.parent?.name() === 'secrets' && inBotSession(process.env)) return;
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
  .option('--port <port>', 'Loopback API port', (value) => Number(value), 0).option(...JSON_FLAG)
  .action(async (options: Json & { port: number }) => {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw badArgs('Invalid port.');
    const status = await (await import('./commands/daemon')).runStart(options.port);
    await show(options, status.running ? [`running PID ${status.pid} at ${status.listen}`] : [], status);
  });
covers(daemon.command('stop'), 'machine.stopHost').description('Stop the running daemon').option(...JSON_FLAG).action(async (options: Json) => {
  const stopped = await (await import('./commands/daemon')).runStop();
  await show(options, [stopped ? 'stopped' : 'already stopped'], { stopped });
});
covers(daemon.command('restart'), 'command.restartHost').description('Restart the daemon (also resumes it after a crash pause)').option(...JSON_FLAG).action(async (options: Json) => {
  const { status, outcome } = await (await import('./commands/daemon')).runRestart();
  const note = outcome === 'resumed' ? '已恢复运行（之前因 10 分钟内崩溃 3 次暂停）。' : outcome === 'started' ? 'daemon 没在运行，已启动。' : undefined;
  await show(options, [`running PID ${status.pid} at ${status.listen}`, ...note ? [note] : []], { ...status, outcome });
});
covers(daemon.command('status'), 'admin.daemonStatus').description('Show daemon status').option(...JSON_FLAG).action(async (options: Json) => {
  await (await import('./commands/daemon')).runStatus(Boolean(options.json));
});
covers(daemon.command('logs'), 'machine.logs').description('Read recent daemon logs').option('--tail <lines>', 'Approximate line count', (value) => Number(value), 200).option(...JSON_FLAG)
  .action(async (options: Json & { tail: number }) => {
    if (!Number.isInteger(options.tail) || options.tail < 1) throw badArgs('Invalid tail count.');
    await (await import('./commands/daemon')).runLogs(options.tail, io(options));
  });
program.command('open').description('Open the local web UI')
  .option('--print', '打印网页地址和 SSH 转发的办法，不打开浏览器（带凭据的链接只打印到终端）')
  .option('--json', 'Print JSON: the address, never the credential')
  .action(async (options: Json & { print?: boolean }) => {
    await (await import('./commands/open')).runOpen(Boolean(options.print), { json: Boolean(options.json) });
  });
const service = program.command('service').description('Manage the OS background service');
const KEEP_RUNNING = ['--keep-running', '结束时之前在跑的 daemon 没了，就按原来的端口起一个分离的 daemon', false] as const;
covers(service.command('install'), 'machine.service.install').description('Install and start the OS service; a running detached daemon is handed over')
  .option('--port <port>', 'Loopback API port', (value) => Number(value))
  .option(...KEEP_RUNNING)
  .option('--linger', 'Linux：linger 没开就直接开，不问')
  .option('--no-linger', 'Linux：linger 没开也不开，只打印命令')
  .option(...JSON_FLAG)
  .action(async (options: Json & { port?: number; keepRunning: boolean; linger?: boolean }) => {
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw badArgs('Invalid port.');
    let linger: LingerChoice = 'ask';
    if (options.linger === true) linger = 'on';
    else if (options.linger === false) linger = 'off';
    await (await import('./commands/service')).runServiceCommand('install', undefined, { ...(options.port ? { port: options.port } : {}), keepRunning: options.keepRunning, linger }, {}, io(options));
  });
covers(service.command('uninstall'), 'machine.service.uninstall').description('Stop and remove the OS service').option(...KEEP_RUNNING).option(...JSON_FLAG).action(async (options: Json & { keepRunning: boolean }) => {
  await (await import('./commands/service')).runServiceCommand('uninstall', undefined, { keepRunning: options.keepRunning }, {}, io(options));
});
covers(service.command('status'), 'machine.status').description('Show the OS service and whether it runs the daemon').option(...JSON_FLAG).action(async (options: Json) => {
  await (await import('./commands/service')).runServiceStatus(Boolean(options.json));
});
const BOT = ['--bot <bot>', 'Bot id (cli_…) or name'] as const;
const bot = program.command('bot').description('Add, show and change bots through the running daemon');
covers(bot.command('add'), 'command.registerAgent', 'command.cancelJob').description('Register a bot by scanning a QR code in this terminal')
  .option('--json', 'Print JSON Lines: the QR link and its expiry, each step, then the result')
  .action(async (options: Json) => {
    await (await import('./commands/bot')).runBotAdd(io(options));
  });
covers(bot.command('list'), 'snapshot.get', 'command.refresh').description('List bots and their connection state').option(...JSON_FLAG).option(...FRESH).action(async (options: Json & { fresh?: boolean }) => {
  await (await import('./commands/bot')).runBotList(io(options), await daemonFor(options));
});
covers(bot.command('status [bot]'), 'admin.setupStatus', 'command.refresh').description("Show a bot's setup checklist").option(...BOT).option(...JSON_FLAG).option(...FRESH)
  .action(async (wanted: string | undefined, options: Json & { bot?: string; fresh?: boolean }) => {
    if (wanted !== undefined && options.bot !== undefined && wanted !== options.bot) throw badArgs(`Bot 填了两次（${wanted} 和 --bot ${options.bot}），只留一个。`);
    await (await import('./commands/bot')).runBotStatus(options.bot ?? wanted, io(options), await daemonFor(options));
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
/** `[bot]` or --bot; both given, they must be the same (as `bot status`). */
const oneBot = (wanted: string | undefined, option: string | undefined): string | undefined => {
  if (wanted !== undefined && option !== undefined && wanted !== option) throw badArgs(`Bot 填了两次（${wanted} 和 --bot ${option}），只留一个。`);
  return option ?? wanted;
};
for (const [name, enabled, description] of [
  ['enable', true, 'Enable a bot: it connects to Feishu and answers; also resumes a bot paused after crashing (恢复运行)'],
  ['disable', false, 'Disable a bot: it leaves Feishu and stops answering'],
] as const) {
  covers(bot.command(`${name} [bot]`), 'command.setAgentEnabled').description(description).option(...BOT).option(...JSON_FLAG)
    .action(async (wanted: string | undefined, options: Json & { bot?: string }) => {
      await (await import('./commands/bot')).runBotEnable(enabled, oneBot(wanted, options.bot), io(options));
    });
}
covers(bot.command('remove <bot>'), 'command.deleteAgent').description("Remove a disabled bot from this computer: its registration, credentials, group bindings, settings and sessions")
  .option('--yes', 'Remove it; without --yes nothing is removed and the command says what would go')
  .option(...JSON_FLAG)
  .addHelpText('after', `
The projects' memory and folders stay, and so does the app on the Feishu developer console. Disable the bot first
(vonvon bot disable) and wait for it to stop.

Example:
  vonvon bot remove 研发助手 --yes`)
  .action(async (wanted: string, options: Json & { yes?: boolean }) => {
    await (await import('./commands/bot')).runBotRemove(wanted, { yes: options.yes }, io(options));
  });
covers(bot.command('rescan [bot]'), 'command.refreshAgentCredentials', 'command.cancelJob').description("Scan a QR code again for a bot's new Feishu credentials; its groups, sessions and settings stay")
  .option(...BOT).option('--json', 'Print JSON Lines: the QR link and its expiry, each step, then the result')
  .action(async (wanted: string | undefined, options: Json & { bot?: string }) => {
    await (await import('./commands/bot')).runBotRescan(oneBot(wanted, options.bot), io(options));
  });
const callback = bot.command('callback').description("A bot's card callback (卡片回调): the web page's 我已配置 and 撤销确认");
covers(callback.command('status [bot]'), 'admin.cardCallbackStatus').description('Show whether a real card callback came and whether you confirmed the setup')
  .option(...BOT).option(...JSON_FLAG)
  .action(async (wanted: string | undefined, options: Json & { bot?: string }) => {
    await (await import('./commands/bot')).runBotCallback('status', oneBot(wanted, options.bot), io(options));
  });
for (const [name, description] of [['confirm', 'Confirm the card callback is set up (我已配置)'], ['unconfirm', 'Take the confirmation back (撤销确认)']] as const) {
  covers(callback.command(`${name} [bot]`), 'admin.confirmCardCallback').description(description).option(...BOT).option(...JSON_FLAG)
    .action(async (wanted: string | undefined, options: Json & { bot?: string }) => {
      await (await import('./commands/bot')).runBotCallback(name, oneBot(wanted, options.bot), io(options));
    });
}
const group =program.command('group').description('List, create, bind and change Feishu groups');
covers(group.command('list'), 'snapshot.get', 'command.refresh').description('List bound groups').option(...BOT).option(...JSON_FLAG).option(...FRESH).action(async (options: Json & { bot?: string; fresh?: boolean }) => {
  await (await import('./commands/group')).runGroupList(options, io(options), await daemonFor(options));
});
covers(group.command('joined'), 'command.listJoinedGroups').description('List the groups a bot is in, from Feishu').option(...BOT).option('--json', 'Print JSON').action(async (options: Json & { bot?: string }) => {
  await (await import('./commands/group')).runGroupJoined(options, io(options));
});
covers(group.command('pending'), 'command.listPendingGroups').description('List groups that added the bot and wait to be bound').option(...BOT).option('--json', 'Print JSON').action(async (options: Json & { bot?: string }) => {
  await (await import('./commands/group')).runGroupPending(options, io(options));
});
const FOLDER = ['--folder <path>', "Working folder on the daemon's computer (~ and relative paths are taken from here); default, or none, is a new folder the daemon makes"] as const;
const JOIN_PROJECT = ['--project <project>', "Join this project (name or prj_…) and use its folder instead of making one; not with --folder <path>"] as const;
const CONVERSATION = ['--conversation <mode>', 'Required. multi (@ me opens a topic, one session per topic), single (one session for the main area) or smart (the Bot reads the group and replies when it fits)'] as const;
const RESPONSE = ['--response <reply>', 'mention (reply only when @-ed) or all (no @ needed); defaults: multi all, single mention; not with smart'] as const;
covers(group.command('bind <groupId>'), 'command.bindGroup', 'directory.choose', 'library.list').description('Bind a group (oc_…) to a folder')
  .option(...FOLDER)
  .option(...JOIN_PROJECT)
  .option('--name <name>', 'Project name; defaults to the group name')
  .option('--tool <tool>', 'codex or claude', 'codex')
  .option(...CONVERSATION)
  .option(...RESPONSE)
  .option(...BOT).option('--json', 'Print JSON')
  .action(async (groupId: string, options: Json & { folder?: string; project?: string; name?: string; tool: string; conversation?: string; response?: string; bot?: string }) => {
    await (await import('./commands/group')).runGroupBind(groupId, options, io(options));
  });
covers(group.command('create <name>'), 'collaboration.createProject', 'directory.choose').description('Create a Feishu group with the bot in it and bind it, as the web page\'s 创建群聊; the group is full access')
  .option(...FOLDER).option(...JOIN_PROJECT)
  .option('--tool <tool>', 'codex or claude', 'codex')
  .option(...CONVERSATION).option(...RESPONSE)
  .option(...BOT).option(...JSON_FLAG)
  .addHelpText('after', `
Feishu makes the group, so this takes up to 75 s. Choose the judge model afterwards with
vonvon settings set --group <name> judge.selection=….

Example:
  vonvon group create 研发 --conversation multi --folder ~/work/app`)
  .action(async (name: string, options: Json & { folder?: string; project?: string; tool: string; conversation?: string; response?: string; bot?: string }) => {
    await (await import('./commands/group')).runGroupCreate(name, options, io(options));
  });
covers(group.command('show <group>'), 'collaboration.project').description("Show a bound group (oc_… or its name) as the daemon has it, with the revision group set --revision takes")
  .option(...BOT).option(...JSON_FLAG)
  .action(async (wanted: string, options: Json & { bot?: string }) => {
    await (await import('./commands/group')).runGroupShow(wanted, options, io(options));
  });
covers(group.command('set <group>'), 'collaboration.editProject').description("Change a bound group: enable or disable it, its 会话方式, its folder or its project")
  .option('--enable', 'Use the bot in this group again')
  .option('--disable', 'Stop using the bot in this group; the binding stays')
  .option('--conversation <mode>', 'multi, single or smart')
  .option('--folder <path>', "Another working folder on the daemon's computer (~ and relative paths are taken from here)")
  .option('--project <project>', 'Move the group to this project (name or prj_…)')
  .option('--revision <revision>', 'The revision group show --json printed; a change made since is refused. Defaults to the current one')
  .option(...BOT).option(...JSON_FLAG)
  .action(async (wanted: string, options: Json & { enable?: boolean; disable?: boolean; conversation?: string; folder?: string; project?: string; revision?: string; bot?: string }) => {
    await (await import('./commands/group')).runGroupSet(wanted, options, io(options));
  });
covers(group.command('unbind <group>'), 'collaboration.removeProject').description('Unbind a group: the bot leaves it (or hands a group it made to you); the folder, files and project stay')
  .option('--yes', 'Unbind it; without --yes nothing changes and the command says what would')
  .option(...BOT).option(...JSON_FLAG)
  .action(async (wanted: string, options: Json & { yes?: boolean; bot?: string }) => {
    await (await import('./commands/group')).runGroupUnbind(wanted, options, io(options));
  });
const dir = program.command('dir').description("Browse folders on the daemon's computer, inside its user's home, as the web page's folder picker");
covers(dir.command('list [path]'), 'directory.list').description('List the folders in a folder; no path: the home folder')
  .option('--all', 'Also list hidden folders; --json always has them').option(...JSON_FLAG)
  .action(async (path: string | undefined, options: Json & { all?: boolean }) => {
    await (await import('./commands/dir')).runDirList(path, options, io(options));
  });
covers(dir.command('suggest <query>'), 'directory.suggest').description('Find folders by what was typed, as the web page\'s folder box completes it')
  .option(...JSON_FLAG)
  .action(async (query: string, options: Json) => {
    await (await import('./commands/dir')).runDirSuggest(query, io(options));
  });
const project = program.command('project').description('List and change projects: the folders and memory groups share');
covers(project.command('list'), 'library.list').description('List projects with their folders and the groups that use them').option('--json', 'Print JSON').action(async (options: Json) => {
  await (await import('./commands/project')).runProjectList(io(options));
});
covers(project.command('rename <project> <name>'), 'library.rename').description("Rename a project (name or prj_…); its groups keep their names").option(...JSON_FLAG)
  .action(async (wanted: string, name: string, options: Json) => {
    await (await import('./commands/project')).runProjectRename(wanted, name, io(options));
  });
covers(project.command('remove <project>'), 'library.delete').description('Delete a project no group uses, with its memory and records; the files in its folders stay')
  .option('--yes', 'Delete it; without --yes nothing is deleted and the command says what would go').option(...JSON_FLAG)
  .action(async (wanted: string, options: Json & { yes?: boolean }) => {
    await (await import('./commands/project')).runProjectRemove(wanted, options, io(options));
  });
const more = (value: string, previous: string[] = []): string[] => [...previous, value];
covers(project.command('workspace <project>'), 'library.workspace').description("Change a project's folders; each of its groups follows and starts new sessions")
  .option('--primary <path>', 'The main folder')
  .option('--add <path>', 'Add an extra folder (repeatable)', more)
  .option('--remove <path>', 'Take an extra folder out (repeatable)', more)
  .option('--repos <path>', 'Set the repositories, all of them (repeatable)', more)
  .option('--default-repos', "Drop the project's repositories: each bot uses its own default")
  .option(...JSON_FLAG)
  .addHelpText('after', `
Paths are folders on the daemon's computer; ~ and relative paths are taken from here.

Example:
  vonvon project workspace 研发 --add ~/work/docs --default-repos`)
  .action(async (wanted: string, options: Json & { primary?: string; add?: string[]; remove?: string[]; repos?: string[]; defaultRepos?: boolean }) => {
    await (await import('./commands/project')).runProjectWorkspace(wanted, options, io(options));
  });
const memory = program.command('memory').description('Read and change memory entries: a project\'s or a bot\'s');
const memoryScope = (command: Command) => command.option('--project <project>', 'Project name or id (prj_…)').option('--bot <appId>', 'Bot id: its own memory').option('--json', 'Print JSON');
const memoryContext = async (options: Json) => (await import('./commands/memory')).terminalMemoryContext(io(options));
type MemoryOptions = Json & { project?: string; bot?: string; branch?: string; revision: string; text?: string; all?: boolean };
memoryScope(covers(memory.command('list'), 'memory.list').description('List the entries by branch')).option('--all', 'Also list the archived entries; --json always has them').action(async (options: MemoryOptions) => {
  await (await import('./commands/memory')).runMemoryList(options, await memoryContext(options));
});
memoryScope(covers(memory.command('export'), 'memory.export').description('One markdown document per branch')).action(async (options: MemoryOptions) => {
  await (await import('./commands/memory')).runMemoryExport(options, await memoryContext(options));
});
memoryScope(covers(memory.command('add <text>'), 'memory.add').description('Add an entry (refused in a Bot session)').option('--branch <name>', 'Branch; a new name opens one, none means 其他'))
  .action(async (text: string, options: MemoryOptions) => { await (await import('./commands/memory')).runMemoryAdd(text, options, await memoryContext(options)); });
memoryScope(covers(memory.command('edit <itemId>'), 'memory.edit').description('Change an entry (refused in a Bot session)').requiredOption('--revision <n>', 'The revision vonvon memory list shows').option('--text <text>', 'New text').option('--branch <name>', 'Move to this branch'))
  .action(async (itemId: string, options: MemoryOptions) => { await (await import('./commands/memory')).runMemoryEdit(itemId, options, await memoryContext(options)); });
memoryScope(covers(memory.command('forget <itemId>'), 'memory.archive').description('Archive an entry (refused in a Bot session)').requiredOption('--revision <n>', 'The revision vonvon memory list shows'))
  .action(async (itemId: string, options: MemoryOptions) => { await (await import('./commands/memory')).runMemoryForget(itemId, options, await memoryContext(options)); });
memoryScope(covers(memory.command('reseal'), 'memory.reseal').description('Accept memory.json as it is now after it was changed outside the daemon (refused in a Bot session)'))
  .action(async (options: MemoryOptions) => { await (await import('./commands/memory')).runMemoryReseal(options, await memoryContext(options)); });
memoryScope(covers(memory.command('branch-rename <from> <to>'), 'memory.branchRename').description('Rename a branch (refused in a Bot session)'))
  .action(async (from: string, to: string, options: MemoryOptions) => { await (await import('./commands/memory')).runMemoryBranch('rename', from, to, options, await memoryContext(options)); });
memoryScope(covers(memory.command('branch-merge <from> <into>'), 'memory.branchMerge').description('Merge a branch into another (refused in a Bot session)'))
  .action(async (from: string, into: string, options: MemoryOptions) => { await (await import('./commands/memory')).runMemoryBranch('merge', from, into, options, await memoryContext(options)); });
const settings = program.command('settings').description('Read and change bot, group and session settings');
type Target = Json & { bot?: string; group?: string; session?: string; host?: boolean; revision?: string; reason?: string };
const READ = ['settings.read.agent', 'settings.read.project', 'settings.read.session', 'settings.read.host'];
const scoped = (command: Command) => command.option(...BOT).option('--group <group>', 'Group id (oc_…) or project name').option('--session <threadId>', 'Session thread id')
  .option('--host', "This computer's own settings (the web page's 本机), for every bot; not with --bot, --group or --session").option('--json', 'Print JSON');
scoped(covers(settings.command('get [section]'), ...READ, 'settings.sessions').description('Show settings, or one section; `get judge` also prints the whole judge prompt')).action(async (section: string | undefined, options: Target) => {
  await (await import('./commands/settings')).runSettingsGet(section, options, io(options));
});
scoped(covers(settings.command('access'), ...READ).description('Show access to the requested settings')).action(async (options: Target) => {
  await (await import('./commands/settings')).runSettingsAccess(options, io(options));
});
scoped(covers(settings.command('set <section.key=value...>'), 'settings.save.agent', 'settings.save.project', 'settings.save.session', 'settings.save.host').description('Change fields of one section; values are JSON or plain text'))
  .option('--revision <revision>', 'Revision held by the caller; stale revisions are rejected')
  .option('--reason <text>', 'Explanation retained with the committed result')
  .addHelpText('after', `
Examples:
  vonvon settings set --group oc_xxx permission.mode=full
  vonvon settings set --group oc_xxx permission.mode=write
  vonvon settings set --group oc_xxx permission.custom='{"sandbox":"read-only","network":true}'
  vonvon settings set --group oc_xxx permission.custom='{"permissionMode":"plan","sandbox":true,"network":"domains","domains":["github.com"]}'
  vonvon settings set cards.showToolCalls=false
  vonvon settings set --group oc_xxx model.selection='{"kind":"explicit","model":"gpt-5.5","effort":"medium"}'
  vonvon settings set judge.selection='{"kind":"llm","model":"gpt-6-luna","effort":"low"}'
  vonvon settings set judge.selection='{"kind":"decision","provider":"typesafe","model":"jev-latest"}'   # 决策模型，各后端的群都用
  vonvon settings set --group oc_xxx judge.selection='{"kind":"default"}'   # 群里去掉覆盖，用 bot 的
  vonvon settings set --host execution.codexBin=/usr/local/bin/codex      # 本机：Codex 可执行文件，null 回到自动找`)
  .action(async (assignments: string[], options: Target) => {
    await (await import('./commands/settings')).runSettingsSet(assignments, options, io(options));
  });
const settingsAct = settings.command('act').description("Do what the settings page's buttons do: voice checks, administrators, response members, comment instructions")
  .addHelpText('after', `
Examples:
  vonvon settings act voice test                      # 测一次语音识别；refresh 重新检测飞书语音权限
  vonvon settings act admin add ou_xxx                # 本机管理员；remove 去掉
  vonvon settings act member add ou_xxx --group 研发群  # 这个群只回名单里的人；member all 清空名单，所有成员都能用
  vonvon settings act comment-instructions --text "只回和代码有关的评论"
  cat 说明.md | vonvon settings act comment-instructions --stdin
  vonvon settings act comment-instructions --default`);
type ActOptions = Json & { bot?: string; group?: string; revision?: string };
const ACT_REVISION = ['--revision <revision>', 'The revision settings get --json shows; without it the current one is read first'] as const;
covers(settingsAct.command('voice <action>'), 'settings.act.voice').description('Voice: test tries recognition once, refresh checks the Feishu voice permission again').option(...BOT).option(...JSON_FLAG)
  .action(async (what: string, options: ActOptions) => { await (await import('./commands/settings')).runSettingsVoice(what, options, io(options)); });
covers(settingsAct.command('admin <op> <openId>'), 'settings.act.adminMember').description("Add or remove one of the bot's administrators on this computer").option(...BOT).option(...ACT_REVISION).option(...JSON_FLAG)
  .action(async (op: string, openId: string, options: ActOptions) => { await (await import('./commands/settings')).runSettingsAdmin(op, openId, options, io(options)); });
covers(settingsAct.command('member <op> [openId]'), 'settings.act.projectMember', 'settings.act.projectAudience').description('Add or remove whom a group responds to; all: every member, the list emptied')
  .option(...BOT).option('--group <group>', 'Group id (oc_…) or project name').option(...ACT_REVISION).option(...JSON_FLAG)
  .action(async (op: string, openId: string | undefined, options: ActOptions) => { await (await import('./commands/settings')).runSettingsMember(op, openId, options, io(options)); });
covers(settingsAct.command('comment-instructions'), 'settings.act.commentInstructions').description('How the bot answers document comments: --default, --text or --stdin')
  .option('--default', 'Back to the built-in instructions').option('--text <text>', 'Your own instructions').option('--stdin', 'Your own instructions, read from a pipe')
  .option(...BOT).option(...ACT_REVISION).option(...JSON_FLAG)
  .action(async (options: ActOptions & { default?: boolean; text?: string; stdin?: boolean }) => {
    await (await import('./commands/settings')).runSettingsCommentInstructions(options, options, io(options));
  });
covers(settings.command('models'), 'settings.models').description("List the models a settings page's model picker offers")
  .option('--backend <backend>', 'codex, claude, or an id like codex-appserver').option('--purpose <purpose>', 'project, session, comments, titles or judge')
  .option('--session <threadId>', 'Session thread id; needed for --purpose session').option(...BOT).option(...JSON_FLAG)
  .action(async (options: Json & { bot?: string; backend?: string; purpose?: string; session?: string }) => {
    await (await import('./commands/settings')).runSettingsModels(options, io(options));
  });
const schedule = program.command('schedule').description('List and change the scheduled tasks of a group (定时任务)')
  .addHelpText('after', `
Examples:
  vonvon schedule list --group 研发群
  vonvon schedule list --all                              # 这个 Bot 所有群的任务
  vonvon schedule add --group 研发群 --name 日报 --weekly mon,tue,wed,thu,fri@09:00 "汇总昨天合入的 PR"
  vonvon schedule add --group 研发群 --name 巡检 --every 30m --new-topic "看一眼 CI 有没有红"
  vonvon schedule add --group 研发群 --name 发版提醒 --at "2026-11-01 14:00" --tz Asia/Tokyo "提醒大家 15:00 发版"
  vonvon schedule edit st_xxx --group 研发群 --revision <r> --daily 10:00   # revision 见 list --json
  vonvon schedule pause st_xxx --group 研发群
  vonvon schedule runs st_xxx --group 研发群                # 总次数和最近 20 次`);
type ScheduleOptions = Json & Omit<ScheduleTarget, 'taskId' | 'instruction'>;
const inGroup = (command: Command) => command.option(...BOT).option('--group <group>', 'Group id (oc_…) or project name').option('--json', 'Print JSON');
const timing = (command: Command) => command
  .option('--every <interval>', 'Every 30m or 2h').option('--daily <HH:mm>', 'Every day at this time').option('--weekly <days@HH:mm>', 'mon,wed@10:00; days mon to sun')
  .option('--at <time>', 'Once, "YYYY-MM-DD HH:mm" in --tz, else in the task\'s time zone on edit and the daemon\'s on add').option('--cron <expr>', 'Standard 5 fields, like "0 9 * * 1-5"')
  .option('--tz <zone>', 'IANA time zone, like Asia/Tokyo; add defaults to the daemon\'s, edit keeps the task\'s').option('--name <name>', 'Task name, up to 40 characters');
const runSchedule = async (action: ScheduleAction, target: Json & ScheduleTarget) => {
  await (await import('./commands/schedule')).runSchedule(action, target, io(target));
};
inGroup(covers(schedule.command('list'), 'schedule.list', 'schedule.listBot').description("List a group's tasks, or with --all every group's")).option('--all', "Every group's tasks of the bot")
  .action(async (options: ScheduleOptions) => { await runSchedule('list', options); });
timing(inGroup(covers(schedule.command('add <instruction>'), 'schedule.create').description('Add a task: --name, one time option and what to do'))).option('--new-topic', 'Post each run in a new topic')
  .action(async (instruction: string, options: ScheduleOptions) => { await runSchedule('add', { ...options, instruction }); });
timing(inGroup(covers(schedule.command('edit <taskId> [instruction]'), 'schedule.edit').description('Change a task; give only what changes'))).requiredOption('--revision <revision>', 'The revision schedule list --json shows')
  .option('--new-topic', 'Post each run in a new topic').option('--follow', "Post each run the way the group's conversation mode does")
  .action(async (taskId: string, instruction: string | undefined, options: ScheduleOptions) => { await runSchedule('edit', { ...options, taskId, ...(instruction === undefined ? {} : { instruction }) }); });
inGroup(covers(schedule.command('delete <taskId>'), 'schedule.delete').description('Delete a task and its run records')).option('--revision <revision>', 'Defaults to the current one')
  .action(async (taskId: string, options: ScheduleOptions) => { await runSchedule('delete', { ...options, taskId }); });
for (const [action, description, kinds] of [['pause', 'Pause a task', ['schedule.pause']], ['resume', 'Resume a task; runs missed while paused are not made up', ['schedule.resume']], ['run', 'Run a task now; the next scheduled run stays', ['schedule.runNow']], ['runs', 'Show the run count and the last 20 runs', []]] as const) {
  inGroup(covers(schedule.command(`${action} <taskId>`), ...kinds).description(description)).action(async (taskId: string, options: ScheduleOptions) => { await runSchedule(action, { ...options, taskId }); });
}
const session = program.command('session').description("A group's sessions, as the web page's 会话管理: context, compact, clear, stop, resume")
  .addHelpText('after', `
Examples:
  vonvon session list --group 研发群 --resumable
  vonvon session context --group 研发群                       # 上下文用量和在跑的任务
  vonvon session stop --group 研发群
  vonvon session compact --group 研发群 --session <threadId>   # 多会话群有几条会话时要指定`);
type SessionOptions = Json & { bot?: string; group: string; session?: string };
const inSessionGroup = (command: Command) => command.option(...BOT).requiredOption('--group <group>', 'Group id (oc_…) or project name').option('--json', 'Print JSON');
const oneSession = (command: Command) => inSessionGroup(command).option('--session <threadId>', "Which session; needed when the group has more than one (session list shows them)");
inSessionGroup(covers(session.command('list'), 'collaboration.history').description("List the group's sessions; --resumable also the provider's older ones that resume can bind"))
  .option('--resumable', "Also list the provider's sessions that can be resumed here; --json always has them")
  .action(async (options: SessionOptions & { resumable?: boolean }) => { await (await import('./commands/session')).runSessionList(options, io(options)); });
oneSession(covers(session.command('context'), 'collaboration.context').description("Show a session's context use, what runs in it and the commands that act on it"))
  .action(async (options: SessionOptions) => { await (await import('./commands/session')).runSessionContext(options, io(options)); });
oneSession(covers(session.command('clear'), 'collaboration.clear').description('Start the main-area session over (not in a 多会话 group); resume brings the old one back'))
  .action(async (options: SessionOptions) => { await (await import('./commands/session')).runSessionReset('clear', options, io(options)); });
oneSession(covers(session.command('compact'), 'collaboration.compact').description("Compact a session's context"))
  .action(async (options: SessionOptions) => { await (await import('./commands/session')).runSessionReset('compact', options, io(options)); });
inSessionGroup(covers(session.command('resume <sessionId>'), 'collaboration.resume').description('Bind an older provider session to the group again (ids from session list --resumable)'))
  .action(async (sessionId: string, options: SessionOptions) => { await (await import('./commands/session')).runSessionResume(sessionId, options, io(options)); });
oneSession(covers(session.command('stop'), 'collaboration.stop').description('Stop the running task; nothing running exits 0'))
  .action(async (options: SessionOptions) => { await (await import('./commands/session')).runSessionStop('stop', options, io(options)); });
oneSession(covers(session.command('end-goal'), 'collaboration.endGoal').description('End the running goal (自主目标); nothing running exits 0'))
  .action(async (options: SessionOptions) => { await (await import('./commands/session')).runSessionStop('endGoal', options, io(options)); });
oneSession(covers(session.command('stop-subagent <subagentId>'), 'collaboration.stopSubagent').description('Stop one subagent of the running task (ids from session context)'))
  .action(async (subagentId: string, options: SessionOptions) => { await (await import('./commands/session')).runSessionStopSubagent(subagentId, options, io(options)); });
oneSession(covers(session.command('reminder'), 'collaboration.reminder').description("Turn the running task's 完成时提醒 on or off"))
  .option('--on', 'Remind when it finishes').option('--off', 'Do not remind')
  .action(async (options: SessionOptions & { on?: boolean; off?: boolean }) => { await (await import('./commands/session')).runSessionReminder(options, options, io(options)); });
const usage = program.command('usage').description("The Codex account's usage and the decision model's, as the web page's 用量");
covers(usage.command('show'), 'collaboration.usage').description('Show the plan, its quota windows and token totals; all bots share the account')
  .option('--refresh', 'Read the account again instead of the daemon\'s cache (the web page\'s 刷新)').option('--json', 'Print JSON')
  .action(async (options: Json & { refresh?: boolean }) => { await (await import('./commands/usage')).runUsageShow(options, io(options)); });
covers(usage.command('share'), 'collaboration.shareUsage').description('Post a usage card in a group, to forward in Feishu')
  .option(...BOT).requiredOption('--group <group>', 'Group id (oc_…) or project name')
  .option('--sections <list>', 'Comma-separated, of stats, heatmap, insights, limits, plan; none means the whole card').option('--json', 'Print JSON')
  .action(async (options: Json & { bot?: string; group: string; sections?: string }) => { await (await import('./commands/usage')).runUsageShare(options, io(options)); });
covers(usage.command('judge'), 'admin.judgeUsage').description('Show how often smart groups asked the decision model, per day and bot (last 14 days)').option('--json', 'Print JSON')
  .action(async (options: Json) => { await (await import('./commands/usage')).runUsageJudge(io(options)); });
const feishu = program.command('feishu').description('Read Feishu groups and members');
covers(feishu.command('groups'), 'command.listJoinedGroups').description('List joined groups, one page').option(...BOT).option('--cursor <cursor>', 'Next page cursor').option('--json', 'Print JSON')
  .action(async (options: Json & { bot?: string; cursor?: string }) => {
    await (await import('./commands/feishu')).runFeishu('groups', undefined, options, io(options));
  });
covers(feishu.command('members <groupId>'), 'command.listGroupMembers').description('List group members, one page').option(...BOT).option('--cursor <cursor>', 'Next page cursor').option('--json', 'Print JSON')
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
covers(secrets.command('list'), 'admin.secrets').description('列出要 key 的服务：填没填、末四位、哪些 Bot 和飞书群选了它').option('--json', 'Print JSON').action(async (options: Json) => {
  await (await import('./commands/secrets')).runSecretsList(await secretsContext(options));
});
// --raw <id>: any entry by its id, for internal use and repairs; not in the help
// commander takes excess arguments silently and, allowed, unknown options too: a key typed after the name is then in
// command.args, refused in words; commander's own error would echo it
covers(secrets.command('set <name>'), 'admin.setSecret', 'admin.testSecret').description('填或换一个 key：终端里按提示粘贴（不回显），脚本里从标准输入传')
  .addOption(new Option('--raw').hideHelp()).option(...JSON_FLAG).allowUnknownOption()
  .addHelpText('after', `
Names:
  typesafe-api-key   TypeSafe（决策模型 Jev）

The key is never an argument: it would stay in the shell history. After saving, the key is tried once.

Examples:
  vonvon secrets set typesafe-api-key
  vonvon secrets set typesafe-api-key < key.txt   # 脚本里`)
  .action(async (name: string, options: Json & { raw?: boolean }, command: Command) => {
    await (await import('./commands/secrets')).runSecretsSet(name, command.args.slice(1), options, await secretsContext(options));
  });
covers(secrets.command('remove <name>'), 'admin.removeSecret').description('删掉一个 key；选了它的 Bot 和飞书群要判断的消息按出错处理').addOption(new Option('--raw').hideHelp()).option(...JSON_FLAG).allowUnknownOption()
  .addHelpText('after', `
删之前可以先运行 vonvon secrets list，看哪些 Bot 和飞书群选了它；删完也会列出还选着它的。`)
  .action(async (name: string, options: Json & { raw?: boolean }, command: Command) => {
    await (await import('./commands/secrets')).runSecretsRemove(name, command.args.slice(1), options, await secretsContext(options));
  });

/**
 * Exits once the JSON line, and whatever was written before it, is out: process.exit would cut a pipe's pending output
 * short on macOS. A failure can leave a handle behind (the data lease, a socket being closed), so it does not wait for the loop.
 */
function exitAfterJson(failure: object & { exitCode: number }): void {
  process.exitCode = failure.exitCode;
  process.stdout.write(`${JSON.stringify(failure)}\n`, () => process.exit(failure.exitCode));
}
const flushLogs = async (): Promise<void> => (await import('../core/logger')).flushLogs();

// `vonvon hook` is answered in bin/vonvon.mjs before this bundle loads.
program.parseAsync(process.argv).then(async () => {
  if (!control) return;
  await flushLogs();
  process.exit(process.exitCode ?? 0);
}).catch(async (err) => {
  if (control) {
    // s17b: an AggregateError (a failed shutdown) also prints each error inside it, one per line.
    console.error(formatErrorTree(err));
    await flushLogs();
    // A service-managed host keeps a stop (0) or a requested restart (75) even when cleanup failed; anything else is 1.
    const code = process.exitCode;
    return process.exit(process.env.VONVON_SERVICE && !process.send && (code === 0 || code === 75) ? code : 1);
  }
  // --help and --version end here too, through exitOverride.
  if (err instanceof CommanderError && err.exitCode === 0) return;
  // devices 8.1: every command fails the same way, with its kind's exit code.
  const failure = commandFailure(err);
  // commander has printed its own usage error
  if (!jsonOutput && !(err instanceof CommanderError)) console.error(formatErrorTree(err));
  await flushLogs();
  if (jsonOutput) exitAfterJson(failure);
  else process.exit(failure.exitCode);
});
