import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const source = fileURLToPath(new URL('../packages/daemon/native/recipe-files/', import.meta.url));
const systems = {darwin: 'darwin', linux: 'linux', win32: 'windows'};
const architectures = {x64: 'amd64', arm64: 'arm64'};
export const recipeFileTargets = Object.keys(systems).flatMap(platform => Object.keys(architectures).map(arch => `${platform}-${arch}`));
export function buildRecipeFiles(dist, target, universalLayout = false) {
  if (!recipeFileTargets.includes(target)) throw new Error(`Unsupported recipe file reader target ${target}`);
  const [platform, arch] = target.split('-');
  const directory = resolve(dist, 'native', ...(universalLayout ? [target] : []));
  const output = join(directory, `recipe-files${platform === 'win32' ? '.exe' : ''}`);
  mkdirSync(directory, {recursive: true});
  const env = {...process.env, CGO_ENABLED: '0', GOOS: systems[platform], GOARCH: architectures[arch]};
  // go determines its own root. An inherited GVM root may refer to a different compiler.
  delete env.GOROOT;
  try {
    execFileSync('go', ['build', '-mod=readonly', '-buildvcs=false', '-trimpath', '-ldflags=-s -w', '-o', output, '.'], {
      cwd: source, stdio: 'inherit', env,
    });
  } catch (cause) {throw new Error(`Could not build recipe-files for ${target}. The build host needs Go 1.22 or newer and the module pinned in go.sum.`, {cause});}
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildRecipeFiles(fileURLToPath(new URL('../packages/daemon/dist/', import.meta.url)), `${process.platform}-${process.arch}`);
}
