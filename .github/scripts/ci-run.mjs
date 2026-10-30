import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const packages = Object.freeze(['protocol', 'client', 'daemon', 'ui', 'desktop']);
const packageSet = new Set(packages);
const scripts = ['typecheck', 'test', 'lint'];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

export function createPlan(scope, selected, root = projectRoot) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const expectedWorkspaces = packages.map(name => `packages/${name}`);
  if (JSON.stringify(manifest.workspaces) !== JSON.stringify(expectedWorkspaces) ||
      manifest.scripts?.build !== 'npm run build --workspaces --if-present') {
    throw new Error('Root workspace build order differs from CI dependency order');
  }
  const plan = [{ executable: 'npm', args: ['run', 'build'] }];
  if (scope === 'full') {
    for (const script of scripts) {
      if (typeof manifest.scripts?.[script] !== 'string') {
        throw new Error(`Root ${script} script is missing`);
      }
      plan.push({ executable: 'npm', args: ['run', script] });
    }
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
  return plan;
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
