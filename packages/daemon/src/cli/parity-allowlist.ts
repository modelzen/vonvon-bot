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
export type ParitySlice = 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8' | 'D3' | 'I3' | 'U2';
export type ParityEntry = { reason: ParityReason; note: string; slice?: ParitySlice; arrives?: ParitySlice };

const pending = (slice: ParitySlice, note: string): ParityEntry => ({ reason: 'pending', slice, note });
const dead = (slice: ParitySlice, note = 'the daemon answers unsupported'): ParityEntry => ({ reason: 'dead', slice, note });

export const CLI_PARITY_ALLOWLIST: Readonly<Record<string, ParityEntry>> = {
  'command.installCodex': dead('U2', 'the old Codex install panel; managed installs are environment.install'),
  'command.startCodexLogin': dead('U2', 'vonvon does not start a login (3.1, 2026-10-28)'),
  'command.setResponse': { reason: 'superseded', note: 'settings.save.project response (settings set)' },
  'command.setPermission': { reason: 'superseded', note: 'settings.save.project permission (settings set)' },

  'library.previous': { reason: 'unused', note: 'no client sends it' },

  'collaboration.startGoal': { reason: 'unused', note: 'goals start in the group chat; no client sends it' },

  'memory.restore': pending('C5', 'memory restore'),
  'memory.promote': pending('C5', 'memory promote'),
  'memory.move': pending('C5', 'memory move'),
  'memory.confirm': pending('C5', 'memory confirm'),
  'memory.purge': pending('C5', 'memory purge'),
  'memory.undo': pending('C5', 'memory undo'),
  'memory.events': pending('C5', 'memory events'),
  'memory.seen': { reason: 'client-only', note: "the web page's read marks" },
  'memory.newCounts': { reason: 'client-only', note: "the web page's unread counts" },

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

  'machine.mcp.list': pending('C8', 'mcp list'),
  'machine.mcp.add': pending('C8', 'mcp add'),
  'machine.mcp.remove': pending('C8', 'mcp remove'),
  'machine.bridgeImport.detect': pending('C8', 'import detect'),
  'machine.bridgeImport.preflight': pending('C8', 'import preflight'),
  'machine.bridgeImport.start': pending('C8', 'import start'),
  'machine.bridgeImport.status': pending('C8', 'import status'),
  'machine.bridgeImport.rollback': pending('C8', 'import rollback'),
  'machine.setServiceSkipped': pending('C8', 'service skip'),
  'admin.followLogs': pending('C8', 'daemon logs --follow'),
  'contextPreview.get': pending('C8', 'context show'),
  'admin.logs': { reason: 'superseded', note: 'machine.logs (daemon logs)' },
  'admin.switchBackend': { reason: 'superseded', note: 'settings.save.project modelAccess.backend (settings set)' },
  'admin.state': { reason: 'unused', note: 'no client sends it; snapshot.get has the state' },
  'admin.diagnosis': { reason: 'unused', note: 'no client sends it' },
  'admin.hostDoctor': { reason: 'unused', note: 'no client sends it' },
  'admin.codexSetup': { reason: 'unused', note: 'no client sends it' },

  'machine.startHost': { reason: 'desktop-only', note: 'the shell starts the daemon (vonvon daemon start in a terminal)' },
  'machine.service.start': { reason: 'desktop-only', note: "the shell's 启动服务" },
  'machine.service.stop': { reason: 'desktop-only', note: "the shell's 停止服务" },
  'machine.checkCoreUpdate': pending('I3', 'vonvon update --check'),
  'machine.applyCoreUpdate': pending('I3', 'vonvon update'),
  'machine.coreUpdateStatus': pending('I3', 'vonvon update (waits on it)'),

  // devices 4: the remote listeners and their commands come with D3
  'device.status': pending('D3', 'vonvon remote status'),
  'device.enable': pending('D3', 'vonvon remote enable'),
  'device.disable': pending('D3', 'vonvon remote disable'),
  'device.setPort': pending('D3', 'vonvon remote port'),
  'admin.negotiate': { reason: 'internal', note: 'each client sends it after the handshake' },
};
