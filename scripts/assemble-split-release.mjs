import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import plist from 'plist';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { artifactRecord, verifyDmg, verifyUniversalApp } from './desktop-release-tools.mjs';
import { assertOutputLocation, canonicalPath, releaseMetadata, manifestURL, validateConfig } from './release-mac.mjs';
import { validateReleaseInventory } from './verify-public-release.mjs';

const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const sameRecord = (a, b) => a?.file === b?.file && a?.size === b?.size && a?.sha256 === b?.sha256;

const execute = promisify(execFile);
async function verifyArtifact({architecture, version, input, state, directory, teamIdentifier}) {
  const run = async (command, args) => execute(command, args, {timeout: 60000, maxBuffer: 1024 * 1024});
  const appCheck = async (app, label) => {
    const slices = architecture === 'universal' ? ['arm64', 'x86_64'] : [architecture === 'x64' ? 'x86_64' : 'arm64'];
    const attrs = (await run('xattr', ['-r', app])).stdout;
    if (/(?:^|: )com\.apple\.quarantine(?:\s|$)/m.test(attrs)) throw new Error(`${label} contains quarantine attributes`);
    await verifyUniversalApp({app, version, architecture, teamIdentifier, execute:run});
    for (const slice of slices) {
      const output = await run('codesign', ['--display', '--verbose=4', '--architecture', slice, app]);
      const hash = output.stderr.match(/^CDHash=([a-f0-9]+)$/mi)?.[1];
      if (!hash || hash !== state.appSeal[slice]) throw new Error(`${label} differs from the notarized signed App`);
    }
    await run('xcrun', ['stapler', 'validate', app]);
    await run('spctl', ['-a', '-vv', '-t', 'exec', app]);
  };
  const zip = join(input, `Vonvon-Bot-${version}-${architecture}.zip`);
  const dmg = join(input, `Vonvon-Bot-${version}-${architecture}.dmg`);
  await mkdir(directory, {recursive: false});
  await run('ditto', ['-x', '-k', zip, directory]);
  await appCheck(join(directory, 'Vonvon Bot.app'), `${architecture} ZIP`);
  await verifyDmg(dmg, teamIdentifier, run);
  const dmgDisplay = await run('codesign', ['--display', '--verbose=4', dmg]);
  const dmgSeal = dmgDisplay.stderr.match(/^CDHash=([a-f0-9]+)$/mi)?.[1];
  if (!dmgSeal || dmgSeal !== state.dmgSeal.default) throw new Error(`${architecture} DMG differs from notarized signed content`);
  await run('xcrun', ['stapler', 'validate', dmg]);
  await run('spctl', ['-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', dmg]);
  const mounted = await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-plist', dmg]);
  const volume = plist.parse(mounted.stdout)['system-entities'].find(entry => entry['mount-point'])?.['mount-point'];
  if (!volume) throw new Error('DMG did not mount an inspectable filesystem');
  try { await appCheck(join(volume, 'Vonvon Bot.app'), `${architecture} DMG`); }
  finally { await run('hdiutil', ['detach', volume]); }
}

/** Assemble three separately notarized candidates. This never builds, signs, uploads, or publishes. */
export async function assembleSplitRelease({ out, universal, arm64, x64, version, sha, repo }, {temporaryRoots, verify = verifyArtifact, configPath = process.env.VONVON_DESKTOP_UPDATE_CONFIG} = {}) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '') || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Supply version and exact source SHA');
  if (!repo) throw new Error('Supply the exact source worktree with --repo');
  const source = await realpath(resolve(repo));
  const output = await canonicalPath(out);
  const roots = temporaryRoots ?? await Promise.all([tmpdir(), '/tmp', '/private/tmp'].map(canonicalPath));
  assertOutputLocation(source, output, roots);
  const inputs = { universal: await realpath(universal), arm64: await realpath(arm64), x64: await realpath(x64) };
  if (new Set(Object.values(inputs)).size !== 3 || Object.values(inputs).some(path => output === path || output.startsWith(path + '/') || path.startsWith(output + '/'))) throw new Error('Use distinct, non-overlapping evidence directories');
  if (await readdir(output).then(files => files.length > 0).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error))) throw new Error('Split release output must be empty');
  const releases = {};
  for (const [architecture, path] of Object.entries(inputs)) {
    const inventory = await readJSON(join(path, 'release-inventory.json'));
    const state = await readJSON(join(path, 'notarization-state.json'));
    if (inventory.complete !== true || state.complete !== true || inventory.mode !== 'release' || state.context?.mode !== 'release' || inventory.version !== version || state.context.version !== version || inventory.sourceCommit !== sha || state.context.sourceCommit !== sha || (state.context.architecture ?? 'universal') !== architecture) throw new Error(`${architecture} candidate is incomplete or belongs to different inputs`);
    if (!state.app?.id || !state.dmg?.id || state.app.status !== 'Accepted' || state.dmg.status !== 'Accepted' || !state.app.logVerified || !state.dmg.logVerified || inventory.notarization?.app !== state.app.id || inventory.notarization?.dmg !== state.dmg.id) throw new Error(`${architecture} notarization evidence is incomplete`);
    if (!inventory.checks || ['appStapled', 'dmgStapled', 'gatekeeperApp', 'gatekeeperDmg', 'quarantineAbsent', 'zipContainsStapledApp', 'dmgContainsStapledApp'].some(key => inventory.checks[key] !== true)) throw new Error(`${architecture} verification evidence is incomplete`);
    if (!Array.isArray(state.files) || !Array.isArray(inventory.files)) throw new Error('Missing artifact evidence');
    const expectedSlices = architecture === 'universal' ? ['arm64', 'x86_64'] : [architecture === 'x64' ? 'x86_64' : 'arm64'];
    const seal = state.appSeal;
    if (!seal || Object.keys(seal).sort().join(',') !== [...expectedSlices].sort().join(',') || Object.values(seal).some(hash => !/^[a-f0-9]+$/i.test(hash)) || !/^[a-f0-9]+$/i.test(state.dmgSeal?.default ?? '')) throw new Error(`${architecture} signed content fingerprints are incomplete`);
    if (!state.transport?.sha256 || state.transport.sha256 !== state.app.sha256 || !state.zipVerification?.archiveSHA256 || !state.dmg.stapledSHA256) throw new Error(`${architecture} notarization or verification receipts are incomplete`);
    if (!inventory.verification?.architectures?.length || inventory.verification.architectures.some(item => !Array.isArray(item.archs) || [...item.archs].sort().join(',') !== [...expectedSlices].sort().join(','))) throw new Error(`${architecture} Mach-O verification is missing or inconsistent`);
    const stateNames = state.files.map(file => file.file);
    const feedName = `feed-${version}${architecture === 'universal' ? '' : `-${architecture}`}.json`;
    const required = ['manifest.json', feedName, `Vonvon-Bot-${version}-${architecture}.zip`, `Vonvon-Bot-${version}-${architecture}.dmg`].sort();
    if (inventory.files.map(file => file.file).sort().join(',') !== required.join(',') || [...stateNames].sort().join(',') !== [...required, 'release-inventory.json'].sort().join(',')) throw new Error(`${architecture} candidate does not bind exactly its expected files`);
    const sums = (await readFile(join(path, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    if (new Set(stateNames).size !== stateNames.length || sums.length !== stateNames.length) throw new Error('Candidate checksums are incomplete');
    for (const record of state.files) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.file) || !sameRecord(await artifactRecord(join(path, record.file)), record) || !sums.includes(`${record.sha256}  ${record.file}`)) throw new Error(`${architecture} state or checksum differs from recorded bytes`);
    }
    if (!sameRecord(await artifactRecord(join(path, feedName)), inventory.files.find(file => file.file === feedName))) throw new Error(`${architecture} feed differs from recorded bytes`);
    for (const kind of ['zip', 'dmg']) {
      const name = `Vonvon-Bot-${version}-${architecture}.${kind}`;
      const actual = await artifactRecord(join(path, name));
      if (!sameRecord(actual, state.files.find(file => file.file === name)) || !sameRecord(actual, inventory.files.find(file => file.file === name))) throw new Error(`${architecture} ${kind} differs from notarized evidence`);
      if (kind === 'zip' && (actual.sha256 !== state.zip?.sha256 || actual.sha256 !== state.zipVerification.archiveSHA256)) throw new Error(`${architecture} ZIP differs from the verified archive`);
      if (kind === 'dmg' && actual.sha256 !== state.dmg.stapledSHA256) throw new Error(`${architecture} DMG differs from the stapled image`);
    }
    releases[architecture] = { inventory, state, path };
  }
  const baseline = releases.universal.state.context;
  let teamIdentifier;
  if (verify === verifyArtifact) {
    if (!configPath) throw new Error('Supply the original external update configuration');
    const bytes = await readFile(configPath);
    const config = validateConfig(JSON.parse(bytes.toString('utf8')));
    if (createHash('sha256').update(bytes).digest('hex') !== baseline.configSHA256) throw new Error('Update configuration differs from the recorded release');
    teamIdentifier = config.teamIdentifier;
  }
  for (const architecture of ['arm64', 'x64']) {
    const { architecture: ignored, ...other } = releases[architecture].state.context;
    if (JSON.stringify(other) !== JSON.stringify(baseline)) throw new Error(`${architecture} release inputs differ from universal`);
    if (JSON.stringify(releases[architecture].inventory.baseline) !== JSON.stringify(releases.universal.inventory.baseline)) throw new Error('Release baselines differ');
  }
  await mkdir(output, { recursive: true });
  const lock = join(output, '.assemble.lock');
  await writeFile(lock, String(process.pid), {flag: 'wx'});
  try {
    for (const architecture of ['universal', 'arm64', 'x64']) await verify({architecture, version, input: inputs[architecture], state: releases[architecture].state, directory: join(output, `verification-${architecture}`), teamIdentifier});
    const files = [];
    for (const architecture of ['universal', 'arm64', 'x64']) {
      for (const ext of ['zip', 'dmg']) {
        const name = `Vonvon-Bot-${version}-${architecture}.${ext}`;
        await copyFile(join(inputs[architecture], name), join(output, name), constants.COPYFILE_EXCL);
        const record = await artifactRecord(join(output, name));
        if (!sameRecord(record, releases[architecture].inventory.files.find(file => file.file === name))) throw new Error('Copied artifact changed');
        files.push(record);
      }
      const feed = await readJSON(join(inputs[architecture], `feed-${version}${architecture === 'universal' ? '' : `-${architecture}`}.json`));
      const expected = releaseMetadata(version, feed.pub_date, feed.notes, architecture).feed;
      if (JSON.stringify(feed) !== JSON.stringify(expected)) throw new Error(`${architecture} feed does not match its release`);
      const name = `feed-${version}${architecture === 'universal' ? '' : `-${architecture}`}.json`;
      await writeFile(join(output, name), JSON.stringify(feed, null, 2) + '\n', {flag: 'wx'});
      files.push(await artifactRecord(join(output, name)));
    }
    const metadata = releaseMetadata(version, new Date().toISOString());
    metadata.manifest.feedURLs = Object.fromEntries(['arm64', 'x64'].map(architecture => [architecture, new URL(`feed-${version}-${architecture}.json`, manifestURL).href]));
    await writeFile(join(output, 'manifest.json'), JSON.stringify(metadata.manifest, null, 2) + '\n', {flag: 'wx'});
    files.push(await artifactRecord(join(output, 'manifest.json')));
    const original = releases.universal.inventory;
    const inventory = { ...original, files, verification: Object.fromEntries(Object.entries(releases).map(([key, release]) => [key, release.inventory.verification])), notarization: Object.fromEntries(Object.entries(releases).map(([key, release]) => [key, release.inventory.notarization])) };
    await writeFile(join(output, 'release-inventory.json'), JSON.stringify(inventory, null, 2) + '\n', {flag: 'wx'});
    const recorded = [...files, await artifactRecord(join(output, 'release-inventory.json'))];
    const state = { context: baseline, complete: true, files: recorded, architectureEvidence: Object.fromEntries(Object.entries(releases).map(([key, release]) => [key, { zipSHA256: release.state.zip.sha256, zipVerifiedSHA256: release.state.zipVerification.archiveSHA256, dmgStapledSHA256: release.state.dmg.stapledSHA256, appSeal: release.state.appSeal, dmgSeal: release.state.dmgSeal, appSubmission: release.state.app.id, dmgSubmission: release.state.dmg.id }])) };
    await writeFile(join(output, 'notarization-state.json'), JSON.stringify(state, null, 2) + '\n', {flag: 'wx'});
    await writeFile(join(output, 'SHA256SUMS'), recorded.map(file => `${file.sha256}  ${file.file}`).join('\n') + '\n', {flag: 'wx'});
    await validateReleaseInventory(output, {version, sha});
    return {version, sourceCommit: sha, files};
  } finally {
    const { unlink } = await import('node:fs/promises');
    await unlink(lock);
  }
}

const invoked = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (invoked && invoked === await realpath(fileURLToPath(import.meta.url))) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['out', 'universal', 'arm64', 'x64', 'version', 'sha', 'repo'].map(name => [name, {type: 'string'}])) });
    if (['out', 'universal', 'arm64', 'x64', 'version', 'sha', 'repo'].some(name => !values[name])) throw new Error('Supply --repo, --out, --universal, --arm64, --x64, --version and --sha');
    console.log(JSON.stringify(await assembleSplitRelease(values), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
