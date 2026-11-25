// first: sets the connection defaults of every daemon process (the supervisor, each `--bot` child and each command)
import './tune-network';
import { Command, CommanderError, Help, Option } from 'commander';
import { badArgs, commandFailure, CommandError } from './command-error';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { formatErrorTree } from '../core/error-parts';
import { bridgeVersion } from '../core/version';
import { paths } from '../config/paths';
import { enterDataAccess, type DataLease } from '../config/data-access';
import { inBotSession } from '../config/session-env';
import { interrupts } from './interrupt';
import { observeShutdown, type ShutdownControl } from '../host/lifecycle';
import type { LingerChoice } from './commands/service';
import type { ScheduleAction, ScheduleTarget } from './commands/schedule';
import { defaultCardDisplay, interpolate, type Scope } from '@vonvon/protocol';

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
 * talks to the daemon, or reads files published with tmp + rename, and takes none. clients, device rename and remote
 * write `devices/` themselves when no daemon runs (devices 4.5, D3 4.8); pair only asks the daemon. */
const LEASED = new Set(['daemon run', 'daemon start', 'daemon stop', 'daemon restart', 'bot repair-dir', 'secrets list', 'secrets set', 'secrets remove',
  'clients ls', 'clients rename', 'clients revoke', 'device rename', 'remote status', 'remote enable', 'remote disable', 'remote port',
  // with no daemon running, a standalone update takes update.lock and writes update-status.json itself (server-3 4.8)
  'update']);
/**
 * devices 8.3 and 5.3: what only the person at this computer runs (the trust root, file locks, the service manager,
 * remote access, pairing), refused in a Bot's session before anything runs. `service status` too (Codex review 256-1):
 * it reads the service manager and the files, not the daemon, so its definition and log paths went round a group's
 * whitelist (`machine.status` is no session's). `daemon status` stays: connectLocal finds the daemon through it, and in a
 * session it says only whether one runs and where (runStatus). `update` refuses in
 * runUpdateCommand too (I3-SEC-3); `__standalone-setup` and `__standalone-teardown` are the install scripts' (server-2 4.3):
 * the first switches `current` to a kept release, an update by another name.
 * `secrets get` is not here: the session's lark-cli resolves its App Secret through it (secrets-get.test.ts). Nor are the
 * hidden `__restart-after-exit` and `__daemon-control`: the host starts them with its own environment, which an older
 * daemon started inside a session still carries the markers in; refusing them there would leave a restart or an update
 * with no daemon. For the same reason a `daemon run` the supervisor starts (its IPC channel) is not refused.
 */
export const LOCAL_ONLY: ReadonlySet<string> = new Set(['daemon run', 'daemon start', 'daemon stop', 'daemon restart', 'service install', 'service uninstall', 'service status',
  'update', 'remote status', 'remote enable', 'remote disable', 'remote port', 'remote candidates', 'pair', 'clients ls', 'clients rename', 'clients revoke', 'device rename',
  'bot remove', 'bot repair-dir', 'open', '__standalone-setup', '__standalone-teardown']);
/** A command's full name without `vonvon`: `daemon restart`, `pair`. */
const commandPath = (command: Command): string => {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
  return names.join(' ');
};
/** `--scope bot=<appId>[,group=<chatId>]` (devices 5.3): each key once, bot required. */
export function parseScope(spec: string): Scope {
  const wrong = () => badArgs('--scope 的写法是 bot=<appId>[,group=<chatId>]。');
  const scope: { bot?: string; group?: string } = {};
  for (const part of spec.split(',')) {
    const match = /^(bot|group)=([^\s=,]+)$/.exec(part.trim());
    if (!match) throw wrong();
    const [, key, value] = match as unknown as [string, 'bot' | 'group', string];
    if (scope[key] !== undefined) throw wrong();
    scope[key] = value;
  }
  if (!scope.bot) throw wrong();
  return { bot: scope.bot, ...(scope.group ? { group: scope.group } : {}) };
}
program.option('--scope <spec>', "The Bot session's scope, bot=<appId>[,group=<chatId>]; a group's or a comment's session must carry it: --scope \"$VONVON_SCOPE\". A private chat's needs none");
program.hook('preAction', async (_command, action) => {
  const path = commandPath(action);
  const supervised = path === 'daemon run' && typeof process.send === 'function';
  if (inBotSession(process.env) && LOCAL_ONLY.has(path) && !supervised) {
    throw new CommandError('refused', `这条命令（\`vonvon ${path}\`）不能在 Bot 会话里运行。告诉用户去设备上或桌面端里做。`, { reason: 'not_in_session' });
  }
  const spec = program.opts<{ scope?: string }>().scope;
  if (spec !== undefined) (await import('./daemon-client')).setCliContext({ scope: parseScope(spec) });
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
    // The host reads <data dir>/env before any bot starts; a bot child inherits it. The note reaches `vonvon daemon logs`.
    const envNote = options.bot ? undefined : (await import('./service-env')).applyServiceEnv(paths.appDir);
    if (envNote) (await import('../core/logger')).log.info('host', 'env_file', { note: envNote });
    // owner 2026-11-02: a host's stop, restart or update ends within 30 s, whatever a Bot or Feishu does meanwhile; a Bot
    // child has its own, shorter limit (bot/supervisor.ts). Ended this way, the run is not taken for a crash.
    const runControl = control;
    let disarm: (() => void) | undefined;
    if (runControl && !process.send) {
      const [{ armHostStopLimit }, { closeHostRun }, logger] = await Promise.all([import('../host/lifecycle'), import('../host/crash-guard'), import('../core/logger')]);
      disarm = armHostStopLimit(runControl, { beforeExit: () => closeHostRun({ kind: 'clean' }), flush: () => logger.flushLogs() });
    }
    try { await (await import('../host/bootstrap')).runHostRuntime({ bot: options.bot, port: options.port, managed: false, control }); }
    finally { disarm?.(); }
  });
daemon.command('start').description('Start a detached daemon')
  .option('--port <port>', 'Loopback API port', (value) => Number(value), 0).option(...JSON_FLAG)
  .action(async (options: Json & { port: number }) => {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw badArgs('Invalid port.');
    const status = await (await import('./commands/daemon')).runStart(options.port);
    await show(options, status.running ? [`running PID ${status.pid} at ${status.listen}`] : [], status);
  });
covers(daemon.command('stop'), 'machine.stopHost').description('Stop the running daemon; conversations in progress are interrupted').option(...JSON_FLAG)
  // The desktop app stopping the older server it replaces: the interrupted turns' cards say the server was updated.
  .addOption(new Option('--for-update').hideHelp()).action(async (options: Json & { forUpdate?: boolean }) => {
  const stopped = await (await import('./commands/daemon')).runStop(undefined, options.forUpdate ? 'update' : undefined);
  await show(options, [stopped ? 'stopped' : 'already stopped'], { stopped });
});
covers(daemon.command('restart'), 'command.restartHost').description('Restart the daemon, interrupting conversations in progress (also resumes it after a crash pause)').option(...JSON_FLAG).action(async (options: Json) => {
  const { status, outcome } = await (await import('./commands/daemon')).runRestart();
  const note = outcome === 'resumed' ? '已恢复运行（之前因 10 分钟内崩溃 3 次暂停）。' : outcome === 'started' ? 'daemon 没在运行，已启动。' : undefined;
  await show(options, [`running PID ${status.pid} at ${status.listen}`, ...note ? [note] : []], { ...status, outcome });
});
covers(daemon.command('status'), 'admin.daemonStatus').description('Show daemon status').option(...JSON_FLAG).action(async (options: Json) => {
  await (await import('./commands/daemon')).runStatus(io(options));
});
covers(daemon.command('logs'), 'admin.logs', 'admin.followLogs').description('Read recent daemon logs').option('--tail <lines>', 'Line count', (value) => Number(value), 200)
  .option('--follow', 'Then print new lines as they come, until Ctrl-C; needs the daemon running').option(...JSON_FLAG)
  .action(async (options: Json & { tail: number; follow?: boolean }) => {
    if (!Number.isInteger(options.tail) || options.tail < 1) throw badArgs('Invalid tail count.');
    await (await import('./commands/daemon')).runLogs(options, io(options));
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
covers(service.command('skip'), 'machine.setServiceSkipped').description("跳过登录时启动: the checklist stops asking to install the service; --undo asks again")
  .option('--undo', '取消跳过').option(...JSON_FLAG)
  .action(async (options: Json & { undo?: boolean }) => {
    await (await import('./commands/service')).runServiceSkip(!options.undo, io(options));
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
const dir = program.command('dir').description("Browse folders on the daemon's computer, as the web page's folder picker");
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
const memory = program.command('memory').description("Read and change memory entries: a project's, a bot's, or a bot's private chat with one person")
  .addHelpText('after', `
Every command goes through the daemon, as the web page's memory page does; with no daemon running, list, export and
events read the files (--json says source: files) and the rest ask you to start it.

Examples:
  vonvon memory list --project 研发 --all
  vonvon memory add "周四发版" --project 研发 --branch 发版
  vonvon memory archive <itemId> --project 研发 --revision <r>     # r: memory list 里的 r 数字
  vonvon memory events <itemId> --project 研发                     # 每行最后是 memory undo 要的事件 id
  vonvon memory people --bot 小研                                  # 私聊过这个 Bot 的人，第一列是 --dm 要的 id
  vonvon memory list --bot 小研 --dm ou_xxx                        # 这个 Bot 和这个人的私聊记忆`);
const memoryScope = (command: Command) => command.option('--project <project>', 'Project name or id (prj_…)').option('--bot <bot>', "Bot name or appId: its own memory")
  .option('--dm <openId>', "With --bot: the bot's private chat memory with this person").option(...JSON_FLAG);
const memoryTerminal = async (options: Json) => (await import('./commands/memory')).terminalMemoryContext(io(options));
const memoryCommands = () => import('./commands/memory');
type MemoryOptions = Json & { project?: string; bot?: string; dm?: string; branch?: string; revision: string; text?: string; all?: boolean; to?: string; yes?: boolean; expected?: string };
const REVISION = ['--revision <n>', 'The revision vonvon memory list shows (r…)'] as const;
memoryScope(covers(memory.command('list'), 'memory.list').description('List the entries by branch')).option('--all', 'Also list the archived entries; --json always has them').action(async (options: MemoryOptions) => {
  await (await memoryCommands()).runMemoryList(options, await memoryTerminal(options));
});
covers(memory.command('people'), 'memory.dmPeople').description("Who has talked to a bot in private, with how much memory; the id is what --dm takes").requiredOption('--bot <bot>', 'Bot name or appId').option(...JSON_FLAG).action(async (options: MemoryOptions) => {
  await (await memoryCommands()).runMemoryPeople(options, await memoryTerminal(options));
});
memoryScope(covers(memory.command('export'), 'memory.export').description('One markdown document per branch')).action(async (options: MemoryOptions) => {
  await (await memoryCommands()).runMemoryExport(options, await memoryTerminal(options));
});
memoryScope(covers(memory.command('events <itemId>'), 'memory.events').description("An entry's history; each line ends with the event id memory undo takes"))
  .action(async (itemId: string, options: MemoryOptions) => { await (await memoryCommands()).runMemoryEvents(itemId, options, await memoryTerminal(options)); });
memoryScope(covers(memory.command('add <text>'), 'memory.add').description('Add an entry').option('--branch <name>', 'Branch; a new name opens one, none means 其他'))
  .action(async (text: string, options: MemoryOptions) => { await (await memoryCommands()).runMemoryAdd(text, options, await memoryTerminal(options)); });
memoryScope(covers(memory.command('edit <itemId>'), 'memory.edit').description('Change an entry').requiredOption(...REVISION).option('--text <text>', 'New text').option('--branch <name>', 'Move to this branch'))
  .action(async (itemId: string, options: MemoryOptions) => { await (await memoryCommands()).runMemoryEdit(itemId, options, await memoryTerminal(options)); });
// devices 8.1: the web page's word; `forget` stays as an alias for the scripts that used it
memoryScope(covers(memory.command('archive <itemId>').alias('forget'), 'memory.archive').description('Archive an entry; memory restore brings it back').requiredOption(...REVISION))
  .action(async (itemId: string, options: MemoryOptions) => { await (await memoryCommands()).runMemoryItem('archive', itemId, options, await memoryTerminal(options)); });
memoryScope(covers(memory.command('restore <itemId>'), 'memory.restore').description('Bring an archived entry back').requiredOption(...REVISION))
  .action(async (itemId: string, options: MemoryOptions) => { await (await memoryCommands()).runMemoryItem('restore', itemId, options, await memoryTerminal(options)); });
memoryScope(covers(memory.command('confirm <itemId>'), 'memory.confirm').description('Mark an entry trusted (待确认 → 可信)').requiredOption(...REVISION))
  .action(async (itemId: string, options: MemoryOptions) => { await (await memoryCommands()).runMemoryItem('confirm', itemId, options, await memoryTerminal(options)); });
memoryScope(covers(memory.command('promote <itemId>'), 'memory.promote').description("Move a project's entry to a bot's memory").requiredOption(...REVISION)
  .option('--to <bot>', 'Bot name or appId; defaults to the one bot the project is bound to').option('--branch <name>', "Branch in the bot's memory"))
  .action(async (itemId: string, options: MemoryOptions) => { await (await memoryCommands()).runMemoryPromote(itemId, options, await memoryTerminal(options)); });
memoryScope(covers(memory.command('move <itemId>'), 'memory.move').description("Move a bot's entry back to a project's memory").requiredOption(...REVISION)
  .requiredOption('--to <project>', 'Project name or id').option('--branch <name>', "Branch in the project's memory"))
  .action(async (itemId: string, options: MemoryOptions & { to: string }) => { await (await memoryCommands()).runMemoryMove(itemId, options, await memoryTerminal(options)); });
memoryScope(covers(memory.command('purge <itemId>'), 'memory.purge').description('Delete an entry for good, its text in the records too; asks for --yes').option('--yes', 'Yes, delete it for good'))
  .action(async (itemId: string, options: MemoryOptions) => { await (await memoryCommands()).runMemoryPurge(itemId, options, await memoryTerminal(options)); });
memoryScope(covers(memory.command('undo <eventId>'), 'memory.undo').description('Undo one change: an event id from memory events'))
  .action(async (eventId: string, options: MemoryOptions) => { await (await memoryCommands()).runMemoryUndo(eventId, options, await memoryTerminal(options)); });
memoryScope(covers(memory.command('reseal'), 'memory.reseal').description('Accept memory.json as it is now after it was changed outside the daemon'))
  .action(async (options: MemoryOptions) => { await (await memoryCommands()).runMemoryReseal(options, await memoryTerminal(options)); });
memoryScope(covers(memory.command('branch-rename <from> <to>'), 'memory.branchRename').description('Rename a branch'))
  .action(async (from: string, to: string, options: MemoryOptions) => { await (await memoryCommands()).runMemoryBranch('rename', from, to, options, await memoryTerminal(options)); });
memoryScope(covers(memory.command('branch-merge <from> <into>'), 'memory.branchMerge').description('Merge a branch into another'))
  .action(async (from: string, into: string, options: MemoryOptions) => { await (await memoryCommands()).runMemoryBranch('merge', from, into, options, await memoryTerminal(options)); });
memoryScope(covers(memory.command('branch-delete <name>'), 'memory.branchDelete').description('Archive every entry of a branch at once; each can be restored')
  .option('--expected <n>', 'The entry count you saw; a branch changed since is left as it is'))
  .action(async (name: string, options: MemoryOptions) => { await (await memoryCommands()).runMemoryBranchDelete(name, options, await memoryTerminal(options)); });
const settings = program.command('settings').description('Read and change bot, group and session settings');
async function withCardScriptInterrupts<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const interrupted = () => new CommandError('interrupted', '已中断消息卡检查，脚本进程已清理。');
  const ctrlC = interrupts(handler => {
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
    return () => { process.off('SIGINT', handler); process.off('SIGTERM', handler); };
  }, interrupted);
  try {
    const result = await work(ctrlC.signal);
    if (ctrlC.interrupted) throw interrupted();
    return result;
  } catch (error) {
    if (ctrlC.interrupted) throw interrupted();
    throw error;
  } finally { ctrlC.stop(); }
}
settings.command('card-template').description('Print the default message-card configuration as a starting template')
  .option(...JSON_FLAG)
  .action(async (options: Json) => {
    const cardDisplay = defaultCardDisplay();
    await show(options, [JSON.stringify(cardDisplay, null, 2)], { cardDisplay });
  });
settings.command('card-check <file>').description('Validate a complete message-card JSON file without saving it or running custom scripts')
  .option(...JSON_FLAG)
  .action(async (file: string, options: Json) => {
    let input: unknown;
    try { input = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { throw badArgs(error instanceof SyntaxError ? '消息卡文件不是有效 JSON' : `无法读取消息卡文件：${error instanceof Error ? error.message : String(error)}`); }
    await withCardScriptInterrupts(async signal => {
      try { await (await import('../card/card-display-validation')).assertValidCardDisplay(input, signal); }
      catch (error) { throw badArgs(error instanceof Error ? error.message : '消息卡配置无效'); }
    });
    await show(options, ['消息卡配置有效；尚未保存。'], { kind: 'valid' });
  });
settings.command('card-test <file>').description('Run up to four message-card scripts in a selected directory with sample card values; does not save')
  .requiredOption('--cwd <absolute-directory>', 'Absolute directory where the scripts will run')
  .option(...JSON_FLAG)
  .action(async (file: string, options: Json & { cwd: string }) => {
    if (!isAbsolute(options.cwd)) throw badArgs('--cwd 必须是绝对目录');
    try { if (!(await stat(options.cwd)).isDirectory()) throw new Error('不是目录'); }
    catch { throw badArgs('--cwd 目录不存在或不可访问'); }
    let input: unknown;
    try { input = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { throw badArgs(error instanceof SyntaxError ? '消息卡文件不是有效 JSON' : `无法读取消息卡文件：${error instanceof Error ? error.message : String(error)}`); }
    const result = await withCardScriptInterrupts(async signal => {
      const { assertValidCardDisplay } = await import('../card/card-display-validation');
      let config: Awaited<ReturnType<typeof assertValidCardDisplay>>;
      try { config = await assertValidCardDisplay(input, signal); }
      catch (error) { throw badArgs(error instanceof Error ? error.message : '消息卡配置无效'); }
      const scripts = config.blocks.filter(block => block.kind === 'custom' && block.source === 'script' && block.mode !== 'off');
      if (scripts.length > 4) throw badArgs('一次最多测试 4 个启用的卡片脚本');
      const { buildRunCardBase } = await import('../card/run-card');
      const { initialState } = await import('../card/run-state');
      const { values } = buildRunCardBase({
        rs: { ...initialState, footer: 'thinking', startedAt: Date.now() - 5_000, usage: { used: 25_000, window: 950_000 } },
        model: 'gpt-6.1-sol', effort: 'high', cardKey: 'card-display-test',
      });
      const { runCardDisplayScripts } = await import('../card/card-display-scripts');
      const result = await runCardDisplayScripts(config, { cwd: options.cwd, values, signal });
      if (result.errors.length) throw badArgs(result.errors.map(error => `${error.id}：${error.message}`).join('\n'));
      for (const block of scripts) {
        const missing = interpolate(block.template, { ...values, ...result.values[block.id] }).missing;
        if (missing.length) throw badArgs(`${block.id}：脚本输出缺少模板字段 ${missing.join('、')}`);
      }
      return result;
    });
    await show(options, ['消息卡脚本运行成功；尚未保存。'], { kind: 'valid', values: result.values });
  });
type Target = Json & { bot?: string; group?: string; session?: string; host?: boolean; dm?: boolean; revision?: string; reason?: string };
const READ = ['settings.read.agent', 'settings.read.project', 'settings.read.session', 'settings.read.host'];
const scoped = (command: Command) => command.option(...BOT).option('--group <group>', 'Group id (oc_…) or project name').option('--dm', "The bot's private chat (私聊), not with --group or --session").option('--session <threadId>', 'Session thread id')
  .option('--host', "This computer's own settings (the web page's 本机), for every bot; not with --bot, --group or --session").option('--json', 'Print JSON');
scoped(covers(settings.command('get [section]'), ...READ, 'settings.sessions').description('Show settings, or one section; `get judge` also prints the whole judge prompt')).action(async (section: string | undefined, options: Target) => {
  await (await import('./commands/settings')).runSettingsGet(section, options, io(options));
});
scoped(covers(settings.command('access'), ...READ).description('Show access to the requested settings')).action(async (options: Target) => {
  await (await import('./commands/settings')).runSettingsAccess(options, io(options));
});
scoped(covers(settings.command('set <section.key=value...>'), 'settings.save.agent', 'settings.save.project', 'settings.save.session', 'settings.save.host').description('Change fields of one section; values are JSON or plain text'))
  .option('--revision <revision>', 'Revision from settings get; required for a complete presentation.cardDisplay object. Stale revisions are rejected; other fields default to the current revision')
  .option('--reason <text>', 'Explanation retained with the committed result')
  .addHelpText('after', `
Examples:
  vonvon settings set --group oc_xxx permission.mode=full
  vonvon settings set --group oc_xxx permission.mode=write
  vonvon settings set --group oc_xxx permission.custom='{"sandbox":"read-only","network":true}'
  vonvon settings set --group oc_xxx permission.custom='{"permissionMode":"plan","sandbox":true,"network":"domains","domains":["github.com"]}'
  vonvon settings get presentation --group oc_xxx --json                      # 记录 view.sections.presentation.revision 与目标 Bot/群
  vonvon settings set --group oc_xxx --revision <读取时的版本> presentation.cardDisplay='<完整 JSON 对象>'  # 群消息卡
  vonvon settings set --dm --revision <读取时的版本> presentation.cardDisplay='<完整 JSON 对象>'            # 先 get presentation --dm --json
  vonvon settings set --group oc_xxx presentation.cardDisplay=null             # 群消息卡恢复固定默认
  vonvon settings set --dm presentation.cardDisplay=null                       # 私聊消息卡恢复固定默认
  vonvon settings set --group oc_xxx presentation.completionMode=long presentation.longTaskMinutes=10
  vonvon settings set --dm presentation.completionTemplate='{{task}}：{{status}}，用时 {{elapsed}}'
  vonvon settings card-check /path/to/card.json --json                # 只检查完整配置文件，不保存
  vonvon settings card-test /path/to/card.json --cwd /absolute/folder --json  # 显式运行最多 4 个脚本，不保存
  vonvon settings set --group oc_xxx model.selection='{"kind":"explicit","model":"gpt-5.5","effort":"medium"}'
  vonvon settings set judge.selection='{"kind":"llm","model":"gpt-6-luna","effort":"low"}'
  vonvon settings set judge.selection='{"kind":"decision","provider":"typesafe","model":"jev-latest"}'   # 决策模型，各后端的群都用
  vonvon settings set --group oc_xxx judge.selection='{"kind":"default"}'   # 群里去掉覆盖，用 bot 的
  vonvon settings set --dm model.selection='{"kind":"explicit","model":"gpt-5.5","effort":"medium"}'   # 私聊模型
  vonvon settings set --group oc_xxx smartRules.respond='"第一段\\n\\n第二段"'   # 文字要换行时写成带引号的 JSON，普通文字里的 \\n 不是换行
  vonvon settings set --host execution.codexBin=/usr/local/bin/codex      # 本机：Codex 可执行文件，null 回到自动找

完整消息卡对象必须带读取时的 --revision；发生冲突时，重新读取当前配置，只重做用户指定的修改。
不要仅替换 revision 后重提旧对象。保存后再次读取同一目标，核对用户要求的每一项。`)
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
  .option('--session <threadId>', 'Session thread id; needed for --purpose session').option('--refresh', 'Ask the Provider again now (刷新); without it the list it last read')
  .option('--dm', "The private chat's picker: its own Provider and --purpose project, unless given").option(...BOT).option(...JSON_FLAG)
  .addHelpText('after', `
These are what a bot's model picker offers for one use; every model a Provider reports is vonvon provider models <codex|claude>.`)
  .action(async (options: Json & { bot?: string; backend?: string; purpose?: string; session?: string; refresh?: boolean; dm?: boolean }) => {
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
  vonvon schedule runs st_xxx --group 研发群                # 总次数和最近 20 次
  vonvon schedule list --dm                               # 这个 Bot 私聊里的任务
  vonvon schedule add --dm --to ou_xxx --name 早报 --daily 09:00 "把今天的安排发给我"   # 只有一位管理员私聊过时可以不写 --to
  vonvon schedule pause st_xxx --dm`);
type ScheduleOptions = Json & Omit<ScheduleTarget, 'taskId' | 'instruction'>;
const inGroup = (command: Command) => command.option(...BOT).option('--group <group>', 'Group id (oc_…) or project name').option('--dm', "The bot's private chat (私聊), not with --group or --all").option('--json', 'Print JSON');
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
  .option('--to <openId>', 'With --dm: whose private chat the task posts to, an administrator who has talked to the bot')
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
// devices 4.3 and 8.1: the link another computer pairs with, the clients that did, and this device's name
const devices = async () => import('./commands/device');
covers(program.command('pair'), 'device.pair').description('Print a one-time link another computer pastes to manage this one')
  .option('--ttl <minutes>', 'Minutes the link stays valid, 1 to 10', '10').option(...JSON_FLAG)
  .action(async (options: Json & { ttl: string }) => { await (await devices()).runPair(options, io(options)); });
const clients = program.command('clients').description('The computers paired with this one');
covers(clients.command('ls'), 'device.clients').description('List paired clients, revoked ones too').option(...JSON_FLAG)
  .action(async (options: Json) => { await (await devices()).runClients('ls', {}, io(options)); });
covers(clients.command('rename <clientId> <name>'), 'device.renameClient').description('Rename a paired client').option(...JSON_FLAG)
  .action(async (clientId: string, name: string, options: Json) => { await (await devices()).runClients('rename', { clientId, name }, io(options)); });
covers(clients.command('revoke <clientId>'), 'device.revokeClient').description('Revoke a client at once; --cascade also the ones it invited').option('--cascade', 'Also revoke the clients it invited, down the line').option(...JSON_FLAG)
  .action(async (clientId: string, options: Json & { cascade?: boolean }) => { await (await devices()).runClients('revoke', { clientId, cascade: options.cascade }, io(options)); });
const device = program.command('device').description("This computer's device identity");
covers(device.command('rename <name>'), 'device.rename').description('Rename this computer as paired clients see it').option(...JSON_FLAG)
  .action(async (name: string, options: Json) => { await (await devices()).runDeviceRename(name, io(options)); });
// devices 4.2, D3 4.8 and A1: the one address other computers reach this one on, and the port
const remotes = async () => import('./commands/remote');
const remote = program.command('remote').description('Let other computers connect to this one: the address and the port');
covers(remote.command('status'), 'device.status').description('Show the opened address, whether it is listened on, and the clients').option(...JSON_FLAG)
  .action(async (options: Json) => { await (await remotes()).runRemote('status', {}, io(options)); });
covers(remote.command('enable [ip]'), 'device.enable').description('Accept paired clients on this address (a literal IP); one address only, another one replaces it. With no address, pick one in a terminal')
  .option('--allow-public', 'Confirm a public or carrier (CGNAT) address').addOption(new Option('--tailscale').hideHelp()).option(...JSON_FLAG)
  .addHelpText('after', `
Examples:
  vonvon remote enable                      # in a terminal: pick from this computer's addresses
  vonvon remote enable "$(tailscale ip -4)"
  vonvon remote enable 192.168.1.23`)
  .action(async (ip: string | undefined, options: Json & { allowPublic?: boolean; tailscale?: boolean }) => {
    await (await remotes()).runRemote('enable', { ...(ip === undefined ? {} : { host: ip }), allowPublic: Boolean(options.allowPublic), tailscale: Boolean(options.tailscale) }, io(options));
  });
remote.command('candidates').description('List the addresses other computers could reach this one on, the same list `remote enable` picks from')
  .option('--all', 'Also list virtual bridges, proxy fake IPs and self-assigned addresses').option(...JSON_FLAG)
  .action(async (options: Json & { all?: boolean }) => { await (await remotes()).runRemote('candidates', { all: Boolean(options.all) }, io(options)); });
covers(remote.command('disable [ip]'), 'device.disable').description('Stop accepting connections on this address, or the open one; its connections end').option(...JSON_FLAG)
  .action(async (ip: string | undefined, options: Json) => { await (await remotes()).runRemote('disable', ip === undefined ? {} : { host: ip }, io(options)); });
covers(remote.command('port <port>'), 'device.setPort').description('Change the remote port (default 7767); paired clients paste a new link once, no pairing again').option(...JSON_FLAG)
  .action(async (port: string, options: Json) => { await (await remotes()).runRemote('port', { port }, io(options)); });
const feishu = program.command('feishu').description("Read Feishu as a bot: groups, messages, documents. A bot sees what its app was granted and shared; --bot picks which one")
  .addHelpText('after', `
Without --bot: in a Bot session the session's bot, or for a group the bot bound to it; in a terminal the bot bound to the group, or the only bot.
A group's session reads only its own group's messages, files and members.`);
covers(feishu.command('groups'), 'command.listJoinedGroups').description('List joined groups, one page').option(...BOT).option('--cursor <cursor>', 'Next page cursor').option('--json', 'Print JSON')
  .action(async (options: Json & { bot?: string; cursor?: string }) => {
    await (await import('./commands/feishu')).runFeishuGroups(options, io(options));
  });
type FeishuOptions = Json & { bot?: string; cursor?: string; limit?: number; name?: string };
const FEISHU_CURSOR = ['--cursor <cursor>', 'Next page cursor'] as const;
const FEISHU_LIMIT = ['--limit <n>', 'How many at most', Number] as const;
const FEISHU_NAME = ['--name <name>', 'Save as this file name'] as const;
/** dm-agent 7.3: each read is its tool's, argument for argument (`command.feishuRead`). */
const feishuRead = (usage: string, description: string) => covers(feishu.command(usage), 'command.feishuRead').description(description).option(...BOT).option(...JSON_FLAG);
const readFeishu = async (tool: string, args: Record<string, unknown>, options: FeishuOptions): Promise<void> => {
  await (await import('./commands/feishu')).runFeishuRead(tool, args, options, io(options));
};
feishuRead('members [groupId]', 'List group members a bot can see, with their open_ids, one page').option(...FEISHU_CURSOR)
  .action((chat: string | undefined, options: FeishuOptions) => readFeishu('feishu_members', { chat, cursor: options.cursor }, options));
feishuRead('messages [groupId]', "Read a group's or a topic's messages, one page").option('--thread <id>', 'Read this topic (omt_…)').option('--start <time>', 'Earliest, YYYY-MM-DD HH:mm').option('--end <time>', 'Latest, YYYY-MM-DD HH:mm')
  .addOption(new Option('--order <order>', 'newest first, or oldest first').choices(['newest', 'oldest'])).option(...FEISHU_LIMIT).option(...FEISHU_CURSOR)
  .action((chat: string | undefined, options: FeishuOptions & { thread?: string; start?: string; end?: string; order?: string }) => readFeishu('feishu_messages',
    { chat, thread: options.thread, start: options.start, end: options.end, order: options.order, limit: options.limit, cursor: options.cursor }, options));
feishuRead('message <messageId>', 'Read one message whole; a merged forward is expanded').option(...FEISHU_CURSOR)
  .action((messageId: string, options: FeishuOptions) => readFeishu('feishu_message', { messageId, cursor: options.cursor }, options));
feishuRead('file <messageId> <fileKey>', "Download a message's image or file, and print where it went").addOption(new Option('--type <type>', 'image or file, as the message lists it').choices(['image', 'file']).makeOptionMandatory()).option(...FEISHU_NAME)
  .action((messageId: string, fileKey: string, options: FeishuOptions & { type: string }) => readFeishu('feishu_file', { messageId, fileKey, type: options.type, name: options.name }, options));
feishuRead('chat [groupId]', "Read a group's name, description and announcement").option(...FEISHU_CURSOR)
  .action((chat: string | undefined, options: FeishuOptions) => readFeishu('feishu_chat', { chat, cursor: options.cursor }, options));
feishuRead('doc <doc>', 'Read a document or a knowledge-base page; give its link or token').option(...FEISHU_CURSOR)
  .action((doc: string, options: FeishuOptions) => readFeishu('feishu_doc', { doc, cursor: options.cursor }, options));
feishuRead('sheet <sheet>', 'List a sheet\'s tabs, or read a range; give its link or token').option('--range <range>', 'What to read, like <sheetId>!A1:D20').option(...FEISHU_CURSOR)
  .action((sheet: string, options: FeishuOptions & { range?: string }) => readFeishu('feishu_sheet', { sheet, range: options.range, cursor: options.cursor }, options));
feishuRead('base <base>', "Read a multi-dimensional table's tables, fields, views or records; give its link or token")
  .addOption(new Option('--what <what>', 'What to read').choices(['tables', 'fields', 'views', 'records'])).option('--table <id>', 'The table (tbl…)').option('--view <id>', 'The view (vew…)')
  .option('--fields <names>', 'Only these fields, comma separated').option('--filter <json>', 'Records to keep, as JSON: {"conjunction":"and","conditions":[{"field":"…","operator":"is","value":["…"]}]}').option(...FEISHU_LIMIT).option(...FEISHU_CURSOR)
  .action(async (base: string, options: FeishuOptions & { what?: string; table?: string; view?: string; fields?: string; filter?: string }) => { await readFeishu('feishu_base',
    { base, what: options.what, table: options.table, view: options.view, fields: options.fields?.split(','), filter: options.filter === undefined ? undefined : await (await import('./commands/feishu')).jsonArgument('--filter', options.filter), limit: options.limit, cursor: options.cursor }, options); });
feishuRead('slides <slides>', 'Read a slide deck whole, as XML; give its link or token').option(...FEISHU_CURSOR)
  .action((slides: string, options: FeishuOptions) => readFeishu('feishu_slides', { slides, cursor: options.cursor }, options));
feishuRead('mindnote <mindnote>', 'Read a mind note, as indented text; give its link or token').option(...FEISHU_CURSOR)
  .action((mindnote: string, options: FeishuOptions) => readFeishu('feishu_mindnote', { mindnote, cursor: options.cursor }, options));
feishuRead('board <board>', "Read a whiteboard's text and links; give its link or token").option(...FEISHU_CURSOR)
  .action((board: string, options: FeishuOptions) => readFeishu('feishu_board', { board, cursor: options.cursor }, options));
feishuRead('minutes <minutes>', "Read a Minutes recording's details and transcript; give its link or token").option(...FEISHU_CURSOR)
  .action((minutes: string, options: FeishuOptions) => readFeishu('feishu_minutes', { minutes, cursor: options.cursor }, options));
feishuRead('drive <file>', 'Download a cloud-drive file, and print where it went; give its link or token').option(...FEISHU_NAME)
  .action((file: string, options: FeishuOptions) => readFeishu('feishu_drive_file', { file, name: options.name }, options));
feishuRead('folder [folder]', "List a cloud-drive folder; give its link or token, or none for the bot's own root").option(...FEISHU_LIMIT).option(...FEISHU_CURSOR)
  .action((folder: string | undefined, options: FeishuOptions) => readFeishu('feishu_folder', { folder, limit: options.limit, cursor: options.cursor }, options));
feishuRead('wiki [wiki]', 'List the knowledge bases a bot can see, or a base\'s or a page\'s pages; give a link or an id').option(...FEISHU_LIMIT).option(...FEISHU_CURSOR)
  .action((wiki: string | undefined, options: FeishuOptions) => readFeishu('feishu_wiki', { wiki, limit: options.limit, cursor: options.cursor }, options));
feishuRead('comments <doc>', "Read a document's comments and replies; give its link or token")
  .addOption(new Option('--type <type>', "A bare token's type, docx by default").choices(['doc', 'docx', 'sheet', 'file', 'slides', 'bitable'])).option('--comment <id>', "Only this comment's replies")
  .option('--solved', 'Only the solved ones').option('--unsolved', 'Only the unsolved ones').option(...FEISHU_LIMIT).option(...FEISHU_CURSOR)
  .action((doc: string, options: FeishuOptions & { type?: string; comment?: string; solved?: boolean; unsolved?: boolean }) => readFeishu('feishu_comments',
    { doc, type: options.type, comment: options.comment, solved: options.solved ? true : options.unsolved ? false : undefined, limit: options.limit, cursor: options.cursor }, options));
feishuRead('doc-media <token>', "Download a document's picture or attachment; its token is in what `feishu doc` reads").option(...FEISHU_NAME)
  .action((token: string, options: FeishuOptions) => readFeishu('feishu_doc_media', { token, name: options.name }, options));
feishuRead('search <query>', 'Search messages, one page').option('--group <groupId>', 'Only this group').option(...FEISHU_LIMIT).option(...FEISHU_CURSOR)
  .action((query: string, options: FeishuOptions & { group?: string }) => readFeishu('feishu_search', { query, chat: options.group, limit: options.limit, cursor: options.cursor }, options));
const env = program.command('env').description("This computer's tools and Provider components: the web page's 本机环境")
  .addHelpText('after', `
<tool> is codex, claude or lark-cli. vonvon signs in lark-cli only; Codex and Claude sign in with their own commands.

Examples:
  vonvon env scan
  vonvon env install lark-cli
  vonvon env login lark-cli
  printf %s "$APP_SECRET" | vonvon env profile add 研发 --app-id cli_xxx --use
  vonvon env backend install <id>          # ids: vonvon env backend list
  vonvon env cancel install`);
const JSON_LINES = ['--json', 'Print JSON Lines: the progress, then the result'] as const;
const envCommands = () => import('./commands/env');
covers(env.command('scan'), 'environment.scan', 'environment.authStatus').description('Show Codex, Claude and lark-cli: installed or not, the version, signed in or not').option(...JSON_FLAG)
  .action(async (options: Json) => { await (await envCommands()).runEnvScan(io(options)); });
for (const [name, update, description] of [['install', false, 'Install a managed copy of a tool'], ['update', true, 'Update the managed copy of a tool']] as const) {
  covers(env.command(`${name} <tool>`), `environment.${name}`, 'environment.toolInstallStatus', 'environment.cancelInstall').description(`${description}, following it to the end (Ctrl-C cancels it)`).option(...JSON_LINES)
    .action(async (tool: string, options: Json) => { await (await envCommands()).runEnvInstall(tool, update, io(options)); });
}
covers(env.command('uninstall <tool>'), 'environment.uninstall').description('Stop using the managed copy of a tool; other installs stay').option(...JSON_FLAG)
  .action(async (tool: string, options: Json) => { await (await envCommands()).runEnvUninstall(tool, io(options)); });
covers(env.command('login <tool>'), 'environment.startLogin', 'environment.loginStatus', 'environment.cancelLogin').description('Sign lark-cli in through the link it gives, following it to the end (Ctrl-C cancels it)').option(...JSON_LINES)
  .action(async (tool: string, options: Json) => { await (await envCommands()).runEnvLogin(tool, io(options)); });
const envProfile = env.command('profile').description("lark-cli's app profiles (应用配置)");
covers(envProfile.command('list'), 'environment.profileList').description('List the profiles; * marks the one in use').option(...JSON_FLAG)
  .action(async (options: Json) => { await (await envCommands()).runEnvProfileList(io(options)); });
covers(envProfile.command('use <name>'), 'environment.profileUse').description('Use this profile from now on').option(...JSON_FLAG)
  .action(async (name: string, options: Json) => { await (await envCommands()).runEnvProfileUse(name, io(options)); });
covers(envProfile.command('add <name>'), 'environment.profileAdd').description("Add an existing app's profile; the App Secret is pasted at a hidden prompt, or piped in")
  .requiredOption('--app-id <id>', "The app's id (cli_…)").option('--brand <brand>', 'feishu or lark', 'feishu').option('--use', 'Use it from now on').option(...JSON_FLAG)
  .addHelpText('after', `
The App Secret is never an argument: it would stay in the shell history.

Examples:
  vonvon env profile add 研发 --app-id cli_xxx
  printf %s "$APP_SECRET" | vonvon env profile add 研发 --app-id cli_xxx --use   # 脚本里`)
  .action(async (name: string, options: Json & { appId: string; brand?: string; use?: boolean }) => {
    await (await envCommands()).runEnvProfileAdd(name, options, io(options));
  });
covers(envProfile.command('init [name]'), 'environment.profileInit', 'environment.profileInitStatus', 'environment.profileInitCancel')
  .description('Make a new app through the link lark-cli gives, following it to the end (Ctrl-C cancels it); --status and --cancel need no name')
  .option('--status', 'Show the app profile being made, or how the last one ended').option('--cancel', 'Cancel the app profile being made').option(...JSON_LINES)
  .action(async (name: string | undefined, options: Json & { status?: boolean; cancel?: boolean }) => {
    if (options.status && options.cancel) throw badArgs('--status 和 --cancel 只给一个。');
    const commands = await envCommands();
    if (options.status || options.cancel) {
      if (name !== undefined) throw badArgs(`--${options.status ? 'status' : 'cancel'} 不带名字。`);
      await commands.runEnvProfileInitState(options.status ? 'status' : 'cancel', io(options));
    } else if (name === undefined) throw badArgs('要写新应用配置的名字，比如 vonvon env profile init 研发。');
    else await commands.runEnvProfileInit(name, io(options));
  });
const envBackend = env.command('backend').description('The Provider components (组件) the bots run on');
covers(envBackend.command('list'), 'environment.backendCatalog').description('List the components: installed or not, and which can be installed').option(...JSON_FLAG)
  .action(async (options: Json) => { await (await envCommands()).runEnvBackendList(io(options)); });
covers(envBackend.command('version <id>'), 'environment.backendVersion').description("Show a component's installed and latest version").option(...JSON_FLAG)
  .action(async (id: string, options: Json) => { await (await envCommands()).runEnvBackendVersion(id, io(options)); });
covers(envBackend.command('install <id>'), 'environment.backendInstall', 'environment.backendInstallStatus', 'environment.cancelBackendInstall')
  .description('Install a component, printing its output as it comes (Ctrl-C cancels it)').option('--update', 'Update it instead').option('--json', 'Print JSON Lines: the output, then the result')
  .action(async (id: string, options: Json & { update?: boolean }) => { await (await envCommands()).runEnvBackendInstall(id, Boolean(options.update), io(options)); });
covers(envBackend.command('uninstall <id>'), 'environment.backendUninstall').description('Uninstall a component').option(...JSON_FLAG)
  .action(async (id: string, options: Json) => { await (await envCommands()).runEnvBackendUninstall(id, io(options)); });
covers(envBackend.command('check <id>'), 'environment.backendLogin').description("Check a component's sign-in (检查登录)").option('--refresh', 'Check again now (重新检测); without it the last check').option(...JSON_FLAG)
  .action(async (id: string, options: Json & { refresh?: boolean }) => { await (await envCommands()).runEnvBackendCheck(id, Boolean(options.refresh), io(options)); });
covers(env.command('cancel <what> [id]'), 'environment.cancelInstall', 'environment.cancelLogin', 'environment.cancelBackendInstall')
  .description('Cancel what runs: install (a tool), login (lark-cli) or backend <id> (a component); an app profile: env profile init --cancel').option(...JSON_FLAG)
  .action(async (what: string, id: string | undefined, options: Json) => { await (await envCommands()).runEnvCancel(what, id, io(options)); });
const provider = program.command('provider').description('The Providers the bots run on: Codex and Claude');
covers(provider.command('models <provider>'), 'collaboration.providerModels').description('List every model a Provider reports: codex or claude')
  .option('--refresh', 'Ask the Provider again now (刷新); without it the list it last read').option(...JSON_FLAG)
  .addHelpText('after', `
These are all the models the Provider itself reports. The ones a bot's model picker offers for one use are
vonvon settings models --backend <codex|claude> --purpose <use>.`)
  .action(async (name: string, options: Json & { refresh?: boolean }) => { await (await import('./commands/provider')).runProviderModels(name, io(options), undefined, Boolean(options.refresh)); });
covers(program.command('update'), 'machine.checkCoreUpdate', 'machine.applyCoreUpdate', 'machine.coreUpdateStatus')
  .description('Update this server to the signed stable release; with the daemon running, it restarts it and interrupts conversations in progress')
  .option('--check', 'Only say whether a newer version is out')
  .option('--allow-downgrade', 'With --to: go back to a release still kept on this machine')
  .option('--to <version>', 'The version to go to')
  .option('--json', 'Print JSON Lines: each status change, then the result')
  .addHelpText('after', `
Exit codes: 0 updated (or already current), 1 failed (the server stays on or goes back to its version),
5 another update is running, 6 the daemon restarted but the outcome is not known yet.`)
  .action(async (options: Json & { check?: boolean; allowDowngrade?: boolean; to?: string }) => {
    await (await import('./commands/update')).runUpdateCommand(options, io(options));
  });
program.command('__daemon-control <action>', { hidden: true }).action(async (action: string) => {
  await (await import('./commands/daemon-control')).runDaemonControl(action);
});
// server-2 4.3: what the install scripts run from a release before `current` points at it. `--release`, not `--version`:
// the program's own --version would answer first.
program.command('__standalone-setup', { hidden: true }).requiredOption('--install-root <root>').requiredOption('--release <version>').option(...JSON_FLAG)
  .action(async (options: Json & { installRoot: string; release: string }) => {
    await (await import('./commands/standalone-setup')).runStandaloneSetup({ installRoot: options.installRoot, version: options.release }, io(options));
  });
program.command('__standalone-teardown', { hidden: true }).requiredOption('--install-root <root>').option(...JSON_FLAG).action(async (options: Json & { installRoot: string }) => {
  await (await import('./commands/standalone-setup')).runStandaloneTeardown({ installRoot: options.installRoot }, io(options));
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
covers(secrets.command('test <name>'), 'admin.testSecret').description('试一次存着的 key：busy 说明 key 是对的，只是服务忙').option(...JSON_FLAG).allowUnknownOption()
  .action(async (name: string, options: Json, command: Command) => {
    await (await import('./commands/secrets')).runSecretsTest(name, command.args.slice(1), await secretsContext(options));
  });

const mcp = program.command('mcp').description("MCP servers in Codex's or Claude's own user configuration (the web page's 本机 → MCP)")
  .addHelpText('after', `
Examples:
  vonvon mcp list --provider codex
  vonvon mcp add github --provider codex --command npx --arg -y --arg github-mcp --env GITHUB_TOKEN   # 值取自这个终端的环境变量
  vonvon mcp add docs --provider claude --url https://example.com/mcp --bearer-env DOCS_TOKEN
  vonvon mcp remove github --provider codex`);
const PROVIDER = ['--provider <provider>', 'codex or claude'] as const;
const repeat = (value: string, previous: string[]): string[] => [...previous, value];
type McpOptions = Json & { provider: string; command?: string; arg: string[]; env: string[]; url?: string; bearerEnv?: string };
covers(mcp.command('list'), 'machine.mcp.list').description('List the servers: names, commands and the variables they read, never values').requiredOption(...PROVIDER).option(...JSON_FLAG)
  .action(async (options: McpOptions) => { await (await import('./commands/mcp')).runMcp('list', undefined, options, io(options)); });
covers(mcp.command('add <name>'), 'machine.mcp.add').description('Add a server: --command (with --arg, --env) or --url (with --bearer-env)').requiredOption(...PROVIDER)
  .option('--command <command>', 'A local server: the command').option('--arg <arg>', 'One argument of --command; repeat, in order', repeat, [])
  .option('--env <NAME=VALUE|NAME>', "A variable of --command; NAME alone takes this shell's value, so a key stays out of the arguments; repeat", repeat, [])
  .option('--url <url>', 'A remote (http) server').option('--bearer-env <NAME>', 'The variable that holds the bearer token of --url; only its name is stored').option(...JSON_FLAG)
  .action(async (name: string, options: McpOptions) => { await (await import('./commands/mcp')).runMcp('add', name, options, io(options)); });
covers(mcp.command('remove <name>'), 'machine.mcp.remove').description('Remove a server').requiredOption(...PROVIDER).option(...JSON_FLAG)
  .action(async (name: string, options: McpOptions) => { await (await import('./commands/mcp')).runMcp('remove', name, options, io(options)); });
const bridgeImport = program.command('import').description("Bring the old Feishu Codex Bridge over, its bots, groups and settings (macOS; the web page's 从 Bridge 导入)");
for (const [action, description] of [
  ['detect', 'Look for the old bridge on this computer'], ['preflight', 'Check it and list what an import changes'], ['status', 'Show the import going on or the last one'],
] as const) {
  covers(bridgeImport.command(action), `machine.bridgeImport.${action}`).description(description).option(...JSON_FLAG)
    .action(async (options: Json) => { await (await import('./commands/import')).runImportRead(action, io(options)); });
}
covers(bridgeImport.command('start'), 'machine.bridgeImport.start', 'machine.bridgeImport.status').description('Import, after reading what changes; stops the old bridge. Without --accept it only lists the changes')
  .option('--accept', 'Import: you read the changes').option('--json', 'Print JSON Lines: each step, then the result')
  .action(async (options: Json & { accept?: boolean }) => { await (await import('./commands/import')).runImportStart(Boolean(options.accept), io(options)); });
covers(bridgeImport.command('rollback'), 'machine.bridgeImport.rollback').description('Undo an import that did not finish, or retry a rollback that failed').option('--json', 'Print JSON Lines: each step, then the result')
  .action(async (options: Json) => { await (await import('./commands/import')).runImportRollback(io(options)); });
const context = program.command('context').description("What the model is handed (the web page's 模型看到什么)");
covers(context.command('show'), 'contextPreview.get').description("vonvon's own parts a new session would get, and what the session was last handed")
  .option(...BOT).option('--group <group>', 'Group id (oc_…) or project name').option('--comment', 'Document comments instead of a group')
  .option('--dm <openId>', "One person's private chat instead of a group").option('--session <threadId>', "Which session; defaults to the group's latest").option(...JSON_FLAG)
  .action(async (options: Json & { bot?: string; group?: string; comment?: boolean; dm?: string; session?: string }) => { await (await import('./commands/context')).runContextShow(options, io(options)); });
covers(program.command('now'), 'snapshot.get').description("What each bot is doing now and which groups it attends to (the web page's 此刻)").option(...BOT).option(...JSON_FLAG)
  .action(async (options: Json & { bot?: string }) => { await (await import('./commands/now')).runNow(options.bot, io(options)); });
covers(program.command('snapshot'), 'snapshot.get').description("The web page's whole state: a summary, or all of it with --json").option(...JSON_FLAG)
  .action(async (options: Json) => { await (await import('./commands/now')).runSnapshot(io(options)); });
const template = program.command('template').description('Inspect, stage, extract and pack Vonvon Bot templates (.vonvon.zip)');
template.command('inspect <source>').description('Validate a .vonvon.zip file or template directory and print its summary')
  .option('--source-url <url>', 'Original repository or download URL for metadata context')
  .option(...JSON_FLAG)
  .action(async (source: string, options: Json & { sourceUrl?: string }) => {
    const mod = await import('./commands/template');
    await mod.verifyTemplateSessionAllowed(process.env, program.opts<{ scope?: string }>().scope);
    await mod.runTemplateInspect(source, options, io(options));
  });
template.command('extract <source>').description('Safely unpack a template into an empty temporary directory for review or merging')
  .requiredOption('--dest <dir>', 'Empty destination directory')
  .option('--source-url <url>', 'Original repository or download URL')
  .option(...JSON_FLAG)
  .action(async (source: string, options: Json & { dest?: string; sourceUrl?: string }) => {
    const mod = await import('./commands/template');
    await mod.verifyTemplateSessionAllowed(process.env, program.opts<{ scope?: string }>().scope);
    await mod.runTemplateExtract(source, options, io(options));
  });
template.command('stage <source>').description('Stage workspace files and dual-provider skills into a group workspace')
  .requiredOption('--dest <dir>', 'Target group primary workspace directory')
  .option('--mode <mode>', 'fresh (empty dir only) or merge (keep existing files, report conflicts)', 'fresh')
  .option('--update-skills', 'Overwrite existing skill files when upgrading a template')
  .option('--source-url <url>', 'Original repository or download URL recorded in .vonvon-template.json')
  .option('--no-telemetry', 'Disable anonymous public template install reporting for this run')
  .option(...JSON_FLAG)
  .action(async (source: string, options: Json & { dest?: string; mode?: string; updateSkills?: boolean; sourceUrl?: string; telemetry?: boolean }) => {
    const mod = await import('./commands/template');
    await mod.verifyTemplateSessionAllowed(process.env, program.opts<{ scope?: string }>().scope);
    await mod.runTemplateStage(source, options, io(options));
  });
template.command('pack <dir>').description('Validate, redact-check, sign and pack a template directory into a .vonvon.zip archive')
  .requiredOption('--out <file>', 'Output .vonvon.zip file path')
  .option('--publish', 'Publish public promo metadata (never skill/workspace content) to Vonvon 灵感 Club')
  .option(...JSON_FLAG)
  .action(async (dir: string, options: Json & { out?: string; publish?: boolean }) => {
    const mod = await import('./commands/template');
    await mod.verifyTemplateSessionAllowed(process.env, program.opts<{ scope?: string }>().scope);
    await mod.runTemplatePack(dir, options, io(options));
  });
template.command('draft-group <group>').description('Copy a bound group\'s real workspace, local skills, and config into a clean template draft directory')
  .requiredOption('--dest <dir>', 'Empty destination draft directory (must be outside the source group folder)')
  .option(...BOT)
  .option('--author <name>', 'Fallback author name when the group has no existing vonvon-bot.json')
  .option(...JSON_FLAG)
  .action(async (group: string, options: Json & { dest?: string; bot?: string; author?: string }) => {
    const mod = await import('./commands/template');
    mod.assertTemplateSessionAllowed(process.env, program.opts<{ scope?: string }>().scope);
    await mod.runTemplateDraftGroup(group, options, io(options));
  });
template.command('published').description('List your own public templates currently live on Vonvon 灵感 Club')
  .option(...JSON_FLAG)
  .action(async (options: Json) => {
    const mod = await import('./commands/template');
    await mod.verifyTemplateSessionAllowed(process.env, program.opts<{ scope?: string }>().scope);
    await mod.runTemplatePublished(io(options));
  });
template.command('unpublish <id>').description('Remove one of your own published templates from Vonvon 灵感 Club using your local author key')
  .option(...JSON_FLAG)
  .action(async (id: string, options: Json) => {
    const mod = await import('./commands/template');
    await mod.verifyTemplateSessionAllowed(process.env, program.opts<{ scope?: string }>().scope);
    await mod.runTemplateUnpublish(id, io(options));
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
