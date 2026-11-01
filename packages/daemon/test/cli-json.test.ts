import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadCommands } from './helpers/cli-commands';

/**
 * devices 8.1, run as a user would: each command with --json prints one JSON line on stdout and nothing on stderr,
 * `{ ok: true, … }` on exit 0 and `{ ok: false, error: { kind, message }, exitCode }` with the same exit code
 * otherwise. No daemon runs and the data root is a temporary one, so the RPC commands answer 3 (or 2 for bad input).
 */
const SAMPLES: ReadonlyArray<readonly [string[], number]> = [
  [['daemon', 'start', '--port', '70000'], 2], [['daemon', 'stop'], 0], [['daemon', 'status'], 0], [['daemon', 'logs'], 0],
  [['service', 'install'], 1], [['service', 'uninstall'], 0], [['service', 'status'], 0],
  [['bot', 'add'], 3], [['bot', 'list'], 3], [['bot', 'status'], 3], [['bot', 'repair-dir', 'nope'], 1],
  [['bot', 'enable'], 3], [['bot', 'disable'], 3], [['bot', 'remove', 'x'], 3], [['bot', 'rescan'], 3],
  [['bot', 'callback', 'status'], 3], [['bot', 'callback', 'confirm'], 3], [['bot', 'callback', 'unconfirm'], 3],
  [['group', 'list'], 3], [['group', 'joined'], 3], [['group', 'pending'], 3], [['group', 'bind', 'oc_x', '--folder', '.'], 2],
  [['project', 'list'], 0],
  [['memory', 'list'], 2], [['memory', 'export'], 2], [['memory', 'add', 'x'], 2], [['memory', 'edit', 'x', '--revision', '1'], 2],
  [['memory', 'forget', 'x', '--revision', '1'], 2], [['memory', 'reseal'], 2], [['memory', 'branch-rename', 'a', 'b'], 2], [['memory', 'branch-merge', 'a', 'b'], 2],
  [['settings', 'get'], 3], [['settings', 'access'], 3], [['settings', 'set', 'cards.showToolCalls=false'], 3],
  [['schedule', 'list', '--all'], 3], [['schedule', 'add', '--group', 'g', '--name', 'n', '--every', '30m', 'x'], 3], [['schedule', 'edit', 'st_x', '--group', 'g', '--revision', 'r', '--name', 'n'], 3],
  [['schedule', 'delete', 'st_x', '--group', 'g'], 3], [['schedule', 'pause', 'st_x', '--group', 'g'], 3], [['schedule', 'resume', 'st_x', '--group', 'g'], 3],
  [['schedule', 'run', 'st_x', '--group', 'g'], 3], [['schedule', 'runs', 'st_x', '--group', 'g'], 3],
  [['feishu', 'groups'], 3], [['feishu', 'members', 'oc_x'], 3],
  [['secrets', 'list'], 0], [['secrets', 'set', 'typesafe-api-key'], 2], [['secrets', 'remove', 'typesafe-api-key'], 0],
  // argument errors from commander itself
  [['nope'], 2], [['bot', 'list', '--nope'], 2], [['group'], 2],
];
/** These start a daemon when they succeed; test/daemon-cli.test.ts runs them. `daemon run` takes no --json. */
const STARTS_A_DAEMON = ['daemon run', 'daemon restart', 'open'];

let dir: string;
let entry: string;
beforeAll(async () => {
  await mkdir(resolve('node_modules/.cache'), { recursive: true });
  dir = await mkdtemp(resolve('node_modules/.cache/vonvon-cli-json-'));
  entry = join(dir, 'cli.mjs');
  await build({ entryPoints: [resolve('src/cli/index.ts')], outfile: entry, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

function run(home: string, root: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), VONVON_HOME: root, VONVON_SESSION: '', FEISHU_CODEX_BRIDGE: '' };
  delete env.VONVON_SERVICE;
  const child = spawn(process.execPath, [entry, ...args, '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); });
  return new Promise((done, fail) => { child.once('error', fail); child.once('close', code => done({ code, stdout, stderr })); });
}

// main 必败: most commands had no --json, and failures went to stderr as text
it('every command prints one JSON line with --json, its exit code inside a failure', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vonvon-cli-json-'));
  try {
    const home = join(base, 'home'); await mkdir(home);
    const root = join(base, 'data');
    const leaves = (await loadCommands()).filter(command => !command.hidden).map(command => command.path);
    const sampled = (path: string) => SAMPLES.some(([args]) => path.split(' ').every((word, i) => args[i] === word));
    expect(leaves.filter(path => !sampled(path) && !STARTS_A_DAEMON.includes(path))).toEqual([]);
    // one at a time: service and secrets take locks a second caller would be refused
    for (const [args, code] of SAMPLES) {
      const result = await run(home, root, args);
      const what = `vonvon ${args.join(' ')} --json: ${result.stdout}${result.stderr}`;
      expect(result.code, what).toBe(code);
      expect(result.stderr, what).toBe('');
      expect(result.stdout.endsWith('\n') && result.stdout.indexOf('\n') === result.stdout.length - 1, what).toBe(true);
      const json = JSON.parse(result.stdout) as { ok: boolean; exitCode?: number; error?: { kind: string; message: string } };
      expect(json.ok, what).toBe(code === 0);
      if (code !== 0) expect(json, what).toMatchObject({ exitCode: code, error: { kind: expect.any(String), message: expect.any(String) } });
    }
  } finally { await rm(base, { recursive: true, force: true }); }
}, 180_000);

// cli-2-bot 4.6: only the commands named in LEASED take the data lease, and with it make the data root
it('takes the data lease for the commands that write the data root only', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vonvon-cli-lease-'));
  try {
    const home = join(base, 'home'); await mkdir(home);
    const root = join(base, 'data');
    expect((await run(home, root, ['bot', 'enable'])).code).toBe(3);
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await run(home, root, ['daemon', 'stop'])).code).toBe(0);
    expect((await stat(root)).isDirectory()).toBe(true);
  } finally { await rm(base, { recursive: true, force: true }); }
}, 60_000);
