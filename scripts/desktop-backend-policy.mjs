import { Arch } from 'builder-util';
import { buildRecipeFiles } from './build-recipe-files.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

const isClaudePackage = name => /^@anthropic-ai\/(?:claude-agent-sdk|claude-code)(?:-|$)/.test(name);

/** Desktop backends are installed into user storage only after an explicit choice. */
export async function assertNoBundledClaude(daemon) {
  const metadata = JSON.parse(await readFile(join(daemon, 'package.json'), 'utf8'));
  if (metadata.bundledBackends?.includes('claude-agent')
    || Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies }).some(isClaudePackage)) {
    throw new Error('Claude must be user-installed; desktop metadata must not bundle its SDK or runtime');
  }
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (basename(directory) === '@anthropic-ai' && isClaudePackage(`@anthropic-ai/${entry.name}`)) {
        throw new Error(`Claude must be user-installed; found bundled package ${entry.name}`);
      }
      if (entry.isDirectory()) await walk(join(directory, entry.name));
    }
  }
  await walk(daemon);
}

/** Also inspect actual packaged bytes, including package:dir and stale staging trees. */
export default async function afterPack({ appOutDir, electronPlatformName, packager, arch }) {
  const resources = electronPlatformName === 'darwin'
    ? join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents/Resources')
    : join(appOutDir, 'resources');
  await assertNoBundledClaude(join(resources, 'daemon'));
  // Electron merges the two packaged Mach-O files for its universal build.
  if (arch !== Arch.universal) buildRecipeFiles(join(resources, 'daemon/dist'), `${electronPlatformName}-${Arch[arch]}`);
}
