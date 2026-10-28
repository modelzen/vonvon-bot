import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(repo, 'package.json'));
const [mode, ...args] = process.argv.slice(2);
async function child(file, argv, options = {}) {
  const code = await new Promise((resolve, reject) => {
    const p = spawn(file, argv, { stdio: 'inherit', windowsHide: true, ...options });
    p.once('error', reject); p.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`Build subprocess failed (${code})`);
}
if (mode === 'electron') {
  const [arch, destination] = args;
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported Windows architecture');
  const { downloadArtifact } = require('@electron/get');
  const extract = require('extract-zip');
  const { devDependencies } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  const archive = await downloadArtifact({ version: devDependencies.electron, artifactName: 'electron', platform: 'win32', arch });
  await mkdir(destination, { recursive: true });
  await extract(archive, { dir: destination });
} else if (mode === 'probe') {
  const [executable, architecture] = args;
  const result = spawnSync(executable, ['-p', 'process.arch'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  if (result.error || result.status !== 0 || result.stdout.trim() !== architecture) throw new Error('Packaged runtime architecture probe failed');
} else if (mode === 'npm' || mode === 'package') {
  const [envFile, ...rest] = args;
  const config = JSON.parse(await readFile(envFile, 'utf8'));
  const env = { ...process.env, HOME: config.home, ELECTRON_SKIP_BINARY_DOWNLOAD: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  if (mode === 'npm') {
    const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    await child(process.execPath, [npm, ...rest], { cwd: repo, env });
  } else {
    const [builderConfig, arch] = rest;
    await child(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', builderConfig, '--win', 'nsis', 'zip', `--${arch}`, '--publish', 'never'], { cwd: join(repo, 'packages/desktop'), env });
  }
} else throw new Error('Expected npm, electron or package mode');
