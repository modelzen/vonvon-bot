import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDistribution, nearestPackageRoot } from '../service/distribution';

/**
 * The npm CLI (`npm-cli.js`) this daemon may trust: `VONVON_NPM_CLI` when it is an absolute path to a file; otherwise the
 * copy the desktop app ships at `Resources/npm` next to the bundled daemon, or the npm of the Node a standalone server
 * release ships (devices 7.2), but only while this process runs on that very Node. Either one is run with this process's
 * own Node, which in the desktop app is Electron in Node mode, so a Mac without Node can still install. `undefined`
 * means none: callers fall back to `npm` on PATH, which is what the npm-installed CLI uses.
 */
export function bundledNpmCli(env: NodeJS.ProcessEnv = process.env, daemonRoot = nearestPackageRoot(fileURLToPath(import.meta.url)), execPath = process.execPath, platform: NodeJS.Platform = process.platform): string | undefined {
  const override = env.VONVON_NPM_CLI;
  if (override && isAbsolute(override) && isFile(override)) return override;
  const distribution = classifyDistribution(daemonRoot);
  try {
    if (distribution.kind === 'bundled') {
      const cli = join(dirname(realpathSync(daemonRoot)), 'npm', 'bin', 'npm-cli.js');
      return isFile(cli) ? cli : undefined;
    }
    if (distribution.kind !== 'standalone') return undefined;
    const node = join(dirname(realpathSync(daemonRoot)), 'node');
    const windows = platform === 'win32';
    if (realpathSync(execPath) !== realpathSync(windows ? join(node, 'node.exe') : join(node, 'bin', 'node'))) return undefined;
    const cli = windows ? join(node, 'node_modules', 'npm', 'bin', 'npm-cli.js') : join(node, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return isFile(cli) ? cli : undefined;
  } catch { return undefined; }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * How to run npm: the trusted CLI under this process's Node in Node mode, or `npm` from PATH.
 * The trusted CLI's update notice is off: users cannot update the npm inside the app.
 */
export function npmInvocation(cli = bundledNpmCli()): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return cli
    ? { command: process.execPath, args: [cli], env: { ELECTRON_RUN_AS_NODE: '1', npm_config_update_notifier: 'false' } }
    : { command: 'npm', args: [], env: {} };
}
