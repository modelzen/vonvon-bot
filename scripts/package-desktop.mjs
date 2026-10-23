import { Arch, build, Platform } from 'electron-builder';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkedProductVersion, repositoryRoot } from './product-version.mjs';
import { updateConfiguration, verifyDmg, verifyUniversalApp, writeDesktopRelease } from './desktop-release-tools.mjs';
import { stageClaudeUniversal } from './stage-claude-universal.mjs';

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
await stageClaudeUniversal({ stage: join(desktop, 'stage/daemon'), root: repositoryRoot });
await build({
  projectDir: desktop,
  targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.universal),
  config: { extends: join(desktop, 'electron-builder-universal.yml'), buildVersion: version },
  publish: 'never',
});
const app = join(out, 'mac-universal/Vonvon Bot.app');
const dmg = join(out, `Vonvon-Bot-${version}-universal.dmg`);
const zip = join(out, `Vonvon-Bot-${version}-universal.zip`);
const verifiedApp = await verifyUniversalApp({ app, version, teamIdentifier });
await verifyDmg(dmg, teamIdentifier);
const inventory = await writeDesktopRelease({ out: metadataOut, version, config, dmg, zip, verifiedApp });
process.stdout.write(`Local universal artifacts verified (${inventory.state}); not notarized or published.\n`);
