import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const packages = Object.freeze(['protocol', 'client', 'daemon', 'ui', 'desktop']);
const packageSet = new Set(packages);
const scripts = ['typecheck', 'test', 'lint'];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const windowsRootTests = ['stage-daemon', 'package-windows', 'windows-runtime-smoke', 'windows-supervisor-runtime', 'publish-windows']
  .map(name => `scripts/${name}.test.mjs`);
const windowsPackageTests = {
  daemon: ['rich-recipe-files', 'environment-windows-launch', 'provider/windows-command-line', 'provider/windows-supervisor',
    'windows-owned-process', 'card-display-scripts', 'card-display-validation', 'card-display-render', 'data-compatibility', 'register-bot', 'locate', 'codex-version',
    'codex-managed-install', 'codex-source', 'appserver-pool', 'environment-rpc',
    'codex-environment-install', 'codex-windows-backend', 'admin-ipc', 'codex-catalog-cache', 'claude-model-discovery', 'codex-setup', 'provider-model-discovery', 'provider-models-rpc', 'codex-model-discovery', 'server-snapshot', 'dm-project', 'dm-upgrade', 'dm-directory-recovery', 'server-state', 'host-library-startup', 'atomic-file-windows', 'project-atomic-windows'].map(name => `test/${name}.test.ts`),
  desktop: ['windows-updates', 'updates', 'tray', 'daemon-dependencies', 'windows-cli-registration', 'windows-cli-path'].map(name => `test/${name}.test.ts`),
};

/**
 * Builds a Linux server package and runs install.sh for real in a temporary HOME (docs/plans/server-5-release.md 4.6).
 * Linux only: macOS runners would install a LaunchAgent under the CI account, and Windows has no server package.
 * Runs for full scope (which every server script and server-update.json select) and whenever the daemon is checked,
 * as the package is the daemon.
 */
export const installSmoke = 'scripts/install-smoke.mjs';
function withInstallSmoke(plan, scope, selected, root, platform) {
  if (platform !== 'linux' || (scope !== 'full' && !selected.includes('daemon'))) return plan;
  if (!existsSync(join(root, installSmoke))) throw new Error(`Missing install smoke: ${installSmoke}`);
  return [...plan, { executable: 'node', args: [installSmoke] }];
}

export function parseInputs(scope, rawPackages) {
  if (scope !== 'affected' && scope !== 'full') {
    throw new Error('CI_SCOPE must be affected or full');
  }
  let selected;
  try {
    selected = JSON.parse(rawPackages);
  } catch {
    throw new Error('CI_PACKAGES must be a JSON array');
  }
  if (!Array.isArray(selected) || selected.length === 0 ||
      selected.some(name => typeof name !== 'string' || !packageSet.has(name)) ||
      new Set(selected).size !== selected.length ||
      selected.some((name, index) => index > 0 && packages.indexOf(name) < packages.indexOf(selected[index - 1]))) {
    throw new Error('CI_PACKAGES must contain unique known package names in workspace order');
  }
  if (scope === 'full' && JSON.stringify(selected) !== JSON.stringify(packages)) {
    throw new Error('Full scope must select every workspace');
  }
  return { scope, selected };
}

export function createPlan(scope, selected, root = projectRoot, platform = process.platform) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const expectedWorkspaces = packages.map(name => `packages/${name}`);
  if (JSON.stringify(manifest.workspaces) !== JSON.stringify(expectedWorkspaces) ||
      manifest.scripts?.build !== 'npm run build --workspaces --if-present') {
    throw new Error('Root workspace build order differs from CI dependency order');
  }
  const plan = [{ executable: 'npm', args: ['run', 'build'] }];
  for (const name of selected) {
    const workspace = `packages/${name}`;
    const packageManifest = JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8'));
    if (typeof packageManifest.scripts?.['verify:built'] === 'string') {
      plan.push({ executable: 'npm', args: ['--workspace', workspace, 'run', 'verify:built'] });
    }
  }
  if (platform === 'win32') {
    for (const script of ['typecheck', 'lint']) {
      if (scope === 'full') plan.push({ executable: 'npm', args: ['run', script] });
      else for (const name of selected) plan.push({ executable: 'npm', args: ['--workspace', `packages/${name}`, 'run', script, '--if-present'] });
    }
    for (const path of windowsRootTests) if (!existsSync(join(root, path))) throw new Error(`Missing Windows test: ${path}`);
    plan.push({ executable: 'node', args: ['--test', ...windowsRootTests] });
    for (const name of selected) {
      const workspace = `packages/${name}`;
      const manifest = JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8'));
      if (typeof manifest.scripts?.test !== 'string') throw new Error(`${workspace} has no test script`);
      const paths = windowsPackageTests[name];
      if (paths) for (const path of paths) if (!existsSync(join(root, workspace, path))) throw new Error(`Missing Windows test: ${workspace}/${path}`);
      plan.push({ executable: 'npm', args: ['--workspace', workspace, 'run', 'test', ...(paths ? ['--', ...paths] : [])] });
    }
    return plan;
  }
  if (scope === 'full') {
    for (const script of scripts) {
      if (typeof manifest.scripts?.[script] !== 'string') {
        throw new Error(`Root ${script} script is missing`);
      }
      plan.push({ executable: 'npm', args: ['run', script] });
    }
    return withInstallSmoke(plan, scope, selected, root, platform);
  } else {
    for (const script of scripts) {
      for (const name of selected) {
        const workspace = `packages/${name}`;
        const packageManifest = JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8'));
        if (script === 'test' && typeof packageManifest.scripts?.test !== 'string') {
          throw new Error(`${workspace} has no test script`);
        }
        plan.push({ executable: 'npm', args: ['--workspace', workspace, 'run', script, '--if-present'] });
      }
    }
    const rootTests = readdirSync(join(root, 'scripts'))
      .filter(name => name.endsWith('.test.mjs'))
      .sort()
      .map(name => join('scripts', name));
    if (rootTests.length === 0) throw new Error('No root script tests found');
    plan.push({ executable: 'node', args: ['--test', ...rootTests] });
  }
  return withInstallSmoke(plan, scope, selected, root, platform);
}

export function runPlan(plan, root = projectRoot, spawn = spawnSync) {
  for (const command of plan) {
    const isNode = command.executable === 'node';
    const executable = isNode ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
    console.log(`> ${command.executable} ${command.args.join(' ')}`);
    const result = spawn(executable, command.args, {
      cwd: root,
      stdio: 'inherit',
      // Windows needs cmd.exe to launch npm.cmd. All arguments above are fixed or validated.
      shell: !isNode && process.platform === 'win32',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command.executable} ${command.args.join(' ')} failed (${result.status ?? result.signal})`);
  }
}

function main() {
  const { scope, selected } = parseInputs(process.env.CI_SCOPE, process.env.CI_PACKAGES);
  runPlan(createPlan(scope, selected));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
