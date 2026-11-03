/**
 * devices-4a 6, Linux self-test 2: the daemon's API in this process on a temporary data root, with one Bot session
 * token issued for a made-up bot and group, as a bot process would ask the host for it. It prints
 * `{ listen, token, appId, chatId }` on one line and serves until SIGTERM or SIGINT; then run the CLI with
 * `VONVON_SESSION=<token>` in front of each command. Not a vitest file (no `.test.ts`), and nothing real is touched:
 *
 *   T=$(mktemp -d)
 *   npx esbuild test/manual/session-probe.ts --bundle --platform=node --format=esm --packages=external --outfile="$T/probe.mjs"
 *   HOME="$T/home" VONVON_HOME="$T/vh" node "$T/probe.mjs"
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdminService } from '../../src/admin/service';
import { paths } from '../../src/config/paths';
import { createSessionTokens } from '../../src/host/session-tokens';
import { startApi } from '../../src/server/http';

const APP_ID = 'cli_probe';
const CHAT_ID = 'oc_probe';
const project = { name: 'probe', chatId: CHAT_ID, cwd: '/probe', blank: false, kind: 'multi', origin: 'joined', noMention: false, mode: 'qa', guestMode: 'qa',
  network: false, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 0, createdAt: 1 };
/** What the requests of the self-test reach; a settings write never gets here from a group session. */
const service = {
  listBots: async () => [{ appId: APP_ID, name: 'Probe', tenant: 'feishu', active: true, current: true, running: true, completionReminder: { mode: 'failures', longTaskMinutes: 3 } }],
  listProjects: async (botId: string) => botId === APP_ID ? [project] : [],
  executeSchedule: async () => ({ kind: 'tasks', tasks: [], now: Date.now(), timeZone: 'UTC' }),
  getDaemonStatus: async () => ({ installed: false, running: true, selfHosted: true, version: 'probe', supported: false }),
  updateStatus: () => null,
} as unknown as AdminService;

await mkdir(paths.appDir, { recursive: true, mode: 0o700 });
const sessionTokens = createSessionTokens();
const api = await startApi({ service, port: 0, sessionTokens });
await writeFile(join(paths.appDir, 'daemon.pid'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), listen: api.listen }));
const token = sessionTokens.issue({ appId: APP_ID, place: 'group', chatId: CHAT_ID, sessionId: 'ses_0000000000000001' });
process.stdout.write(`${JSON.stringify({ listen: api.listen, token, appId: APP_ID, chatId: CHAT_ID })}\n`);
const stop = (): void => { void api.close().finally(() => process.exit(0)); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
