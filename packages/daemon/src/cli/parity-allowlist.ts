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
  'recipeInstall.prepare': {reason: 'desktop-only', note: 'the signed-in desktop prepares an existing Bot/group role installation'},
  'recipeInstall.commit': {reason: 'desktop-only', note: 'the desktop hands over a scoped cloud operation ticket'},
  'recipeInstall.status': {reason: 'desktop-only', note: 'the desktop recovers the durable installation receipt'},
  'recipeInstall.cancel': {reason: 'desktop-only', note: 'the desktop cancels its prepared installation'},
  'recipeInstall.issuing': {reason: 'desktop-only', note: 'the desktop durably marks authorization dispatch before contacting the account API'},
  'recipeInstall.reconcile': {reason: 'desktop-only', note: 'the daemon verifies a negative cloud outcome before closing an uncertain dispatch'},
  'command.setAgentBadgeNumber': { reason: 'client-only', note: 'the printed employee number on the home page badge' },
  'command.setResponse': { reason: 'superseded', note: 'settings.save.project response (settings set)' },
  'command.setPermission': { reason: 'superseded', note: 'settings.save.project permission (settings set)' },

  'command.listGroupMembers': { reason: 'superseded', note: 'command.feishuRead feishu_members (feishu members), which picks the Bot; the web page sends this one' },

  'library.previous': { reason: 'unused', note: 'no client sends it' },

  'collaboration.startGoal': { reason: 'unused', note: 'goals start in the group chat; no client sends it' },

  'memory.seen': { reason: 'client-only', note: "the web page's read marks" },
  'memory.newCounts': { reason: 'client-only', note: "the web page's unread counts" },

  'machine.logs': { reason: 'superseded', note: 'admin.logs (daemon logs; it takes maxBytes)' },
  'admin.switchBackend': { reason: 'superseded', note: 'settings.save.project modelAccess.backend (settings set)' },
  'admin.state': { reason: 'unused', note: 'no client sends it; snapshot.get has the state' },
  'admin.diagnosis': { reason: 'unused', note: 'no client sends it' },
  'admin.hostDoctor': { reason: 'unused', note: 'no client sends it' },
  'admin.codexSetup': { reason: 'unused', note: 'no client sends it' },

  'machine.startHost': { reason: 'desktop-only', note: 'the shell starts the daemon (vonvon daemon start in a terminal)' },
  'machine.service.start': { reason: 'desktop-only', note: "the shell's 启动服务" },
  'machine.service.stop': { reason: 'desktop-only', note: "the shell's 停止服务" },
  'machine.desktopUpdateReport': { reason: 'desktop-only', note: "the shell's report on the update it runs for the server it carries (devices 7.5)" },

  'admin.negotiate': { reason: 'internal', note: 'each client sends it after the handshake' },
};
