import { Arch, build, Platform } from 'electron-builder';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkedProductVersion, repositoryRoot } from './product-version.mjs';
import { updateConfiguration, verifyDmg, verifyUniversalApp, writeDesktopRelease, writeSplitFeeds } from './desktop-release-tools.mjs';
import { assertNoBundledClaude } from './desktop-backend-policy.mjs';

const desktop = join(repositoryRoot, 'packages/desktop');
const version = await checkedProductVersion();
const config = updateConfiguration(JSON.parse(await readFile(process.env.VONVON_DESKTOP_UPDATE_CONFIG || join(desktop, 'desktop-update.json'), 'utf8')));
const staged = JSON.parse(await readFile(join(desktop, 'stage/package.json'), 'utf8'));
const stagedConfig = updateConfiguration(JSON.parse(await readFile(join(desktop, 'stage/dist/update-config.json'), 'utf8')));
if (staged.version !== version || JSON.stringify(stagedConfig) !== JSON.stringify(config)) throw new Error('Desktop stage is stale; rebuild before packaging');
const teamIdentifier = config.teamIdentifier ?? process.env.VONVON_DESKTOP_SIGNING_TEAM;
if (!/^[A-Z0-9]{10}$/.test(teamIdentifier ?? '')) throw new Error('Set VONVON_DESKTOP_SIGNING_TEAM to the expected existing Developer ID team');
const out = join(desktop, 'dist/package');
const metadataOut = join(out, `release-${version}`);
// Preserve prior evidence; a retry must deliberately choose a fresh output directory.
try {
  await lstat(metadataOut);
  throw new Error('Release metadata already exists; preserve it and use a fresh packaging worktree');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await assertNoBundledClaude(join(desktop, 'stage/daemon'));
await build({
  projectDir: desktop,
  targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.universal, Arch.arm64, Arch.x64),
  config: { extends: join(desktop, 'electron-builder-universal.yml'), buildVersion: version },
  publish: 'never',
});
const releases = {};
for (const architecture of ['universal', 'arm64', 'x64']) {
  const directory = architecture === 'universal' ? 'mac-universal' : architecture === 'arm64' ? 'mac-arm64' : 'mac';
  const app = join(out, directory, 'Vonvon Bot.app');
  const dmg = join(out, `Vonvon-Bot-${version}-${architecture}.dmg`);
  const zip = join(out, `Vonvon-Bot-${version}-${architecture}.zip`);
  const verifiedApp = await verifyUniversalApp({ app, version, teamIdentifier, architecture });
  await verifyDmg(dmg, teamIdentifier);
  const target = architecture === 'universal' ? metadataOut : join(metadataOut, architecture);
  releases[architecture] = await writeDesktopRelease({ out: target, version, config, dmg, zip, verifiedApp, architecture });
}
await writeSplitFeeds({ out: metadataOut, version, config, releases });
process.stdout.write('Universal compatibility and separate arm64/x64 artifacts verified; not notarized or published.\n');
