/**
 * devices 8.5: the RPC kinds (protocol `rpcKinds()`) that no command covers, each with why. test/cli-parity.test.ts
 * fails for a kind that is neither covered by a command (`covers` in cli/index.ts) nor listed here, so a new RPC
 * needs a command or a line here. A slice that adds the command moves the kind from here to its `covers`.
 *
 * - client-only: the web page's own state, nothing for a terminal to do
 * - desktop-only: the desktop shell sends it to itself through IPC (devices 8.4)
 * - internal: clients send it on their own, never a user
 * - superseded: an older request whose job a covered kind does now
 * - unused: declared and answered, but no client sends it
 * - dead: the daemon answers unsupported; `slice` deletes it (devices 8.4)
 * - pending: `slice` adds the command (devices 8.2)
 * `arrives`: registered before the kind exists; the slice that adds it to the protocol drops `arrives`.
 */
export type ParityReason = 'client-only' | 'desktop-only' | 'internal' | 'superseded' | 'unused' | 'dead' | 'pending';
export type ParitySlice = 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8' | 'D1' | 'D3' | 'I3' | 'U2';
export type ParityEntry = { reason: ParityReason; note: string; slice?: ParitySlice; arrives?: ParitySlice };

const pending = (slice: ParitySlice, note: string): ParityEntry => ({ reason: 'pending', slice, note });
const dead = (slice: ParitySlice, note = 'the daemon answers unsupported'): ParityEntry => ({ reason: 'dead', slice, note });

export const CLI_PARITY_ALLOWLIST: Readonly<Record<string, ParityEntry>> = {
  'command.openEventSettings': dead('D1'),
  'command.openJobAuthorization': dead('D1'),
  'command.copyJobAuthorization': dead('D1'),
  'command.installCodex': dead('U2', 'the old Codex install panel; managed installs are environment.install'),
  'command.startCodexLogin': dead('U2', 'vonvon does not start a login (3.1, 2026-10-28)'),
  'command.setResponse': { reason: 'superseded', note: 'settings.save.project response (settings set)' },
  'command.setPermission': { reason: 'superseded', note: 'settings.save.project permission (settings set)' },

  'library.previous': { reason: 'unused', note: 'no client sends it' },

  'collaboration.startGoal': { reason: 'unused', note: 'goals start in the group chat; no client sends it' },
  'collaboration.openGroup': dead('D1'),

  'memory.restore': pending('C5', 'memory restore'),
  'memory.promote': pending('C5', 'memory promote'),
  'memory.move': pending('C5', 'memory move'),
  'memory.confirm': pending('C5', 'memory confirm'),
  'memory.purge': pending('C5', 'memory purge'),
  'memory.undo': pending('C5', 'memory undo'),
  'memory.events': pending('C5', 'memory events'),
  'memory.seen': { reason: 'client-only', note: "the web page's read marks" },
  'memory.newCounts': { reason: 'client-only', note: "the web page's unread counts" },

  'settings.chooseExecutable': dead('D1'),
  'settings.saveExecutable': dead('D1'),

  'collaboration.providerModels': pending('C7', 'provider models'),
  'environment.scan': pending('C7', 'env scan'),
  'environment.install': pending('C7', 'env install'),
  'environment.update': pending('C7', 'env update'),
  'environment.uninstall': pending('C7', 'env uninstall'),
  'environment.toolInstallStatus': pending('C7', 'env install (waits on it)'),
  'environment.cancelInstall': pending('C7', 'env cancel'),
  'environment.backendCatalog': pending('C7', 'env backend list'),
  'environment.backendVersion': pending('C7', 'env backend version'),
  'environment.backendInstall': pending('C7', 'env backend install'),
  'environment.backendInstallStatus': pending('C7', 'env backend install (waits on it)'),
  'environment.cancelBackendInstall': pending('C7', 'env cancel'),
  'environment.backendUninstall': pending('C7', 'env backend uninstall'),
  'environment.backendLogin': pending('C7', 'env backend check'),
  'environment.authStatus': pending('C7', 'env scan'),
  'environment.startLogin': pending('C7', 'env login lark-cli'),
  'environment.loginStatus': pending('C7', 'env login lark-cli (waits on it)'),
  'environment.cancelLogin': pending('C7', 'env cancel'),
  'environment.profileList': pending('C7', 'env profile list'),
  'environment.profileUse': pending('C7', 'env profile use'),
  'environment.profileAdd': pending('C7', 'env profile add'),
  'environment.profileInit': pending('C7', 'env profile init'),
  'environment.profileInitStatus': pending('C7', 'env profile init --status'),
  'environment.profileInitCancel': pending('C7', 'env profile init --cancel'),
  'environment.openVerification': dead('D1'),

  'machine.logs': { reason: 'superseded', note: 'admin.logs (daemon logs; it takes maxBytes)' },
  'admin.switchBackend': { reason: 'superseded', note: 'settings.save.project modelAccess.backend (settings set)' },
  'admin.state': { reason: 'unused', note: 'no client sends it; snapshot.get has the state' },
  'admin.diagnosis': { reason: 'unused', note: 'no client sends it' },
  'admin.hostDoctor': { reason: 'unused', note: 'no client sends it' },
  'admin.codexSetup': { reason: 'unused', note: 'no client sends it' },

  'machine.startHost': { reason: 'desktop-only', note: 'the shell starts the daemon (vonvon daemon start in a terminal)' },
  'machine.service.start': { reason: 'desktop-only', note: "the shell's 启动服务" },
  'machine.service.stop': { reason: 'desktop-only', note: "the shell's 停止服务" },
  'machine.repairCli': dead('D1'),
  'machine.checkDesktopUpdate': dead('D1'),
  'machine.openReleases': dead('D1'),
  'machine.installDesktopUpdate': dead('D1'),
  'machine.checkCoreUpdate': pending('I3', 'vonvon update --check'),
  'machine.applyCoreUpdate': pending('I3', 'vonvon update'),
  'machine.coreUpdateStatus': pending('I3', 'vonvon update (waits on it)'),

  // devices 4 and 12: not in the protocol yet
  'device.pair': { ...pending('D1', 'vonvon pair'), arrives: 'D1' },
  'device.clients': { ...pending('D1', 'vonvon clients ls'), arrives: 'D1' },
  'device.renameClient': { ...pending('D1', 'vonvon clients rename'), arrives: 'D1' },
  'device.revokeClient': { ...pending('D1', 'vonvon clients revoke'), arrives: 'D1' },
  'device.rename': { ...pending('D1', 'vonvon device rename'), arrives: 'D1' },
  'device.status': { ...pending('D3', 'vonvon remote status'), arrives: 'D1' },
  'device.enable': { ...pending('D3', 'vonvon remote enable'), arrives: 'D1' },
  'device.disable': { ...pending('D3', 'vonvon remote disable'), arrives: 'D1' },
  'admin.negotiate': { reason: 'internal', note: 'each client sends it after the handshake', arrives: 'D1' },
};
