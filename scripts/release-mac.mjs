import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, open, readFile, realpath, writeFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const manifestURL = 'https://dl.vonvon.cc/bot/mac/stable/manifest.json';
export function compareVersions(a, b) {
  const parse = v => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) throw new Error('Expected a three-part release version');
    const parts = v.split('.').map(Number);
    if (!parts.every(Number.isSafeInteger)) throw new Error('Version component is too large');
    return parts;
  };
  const aa = parse(a), bb = parse(b);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).sort().join(',') !== 'manifestURL,teamIdentifier'
    || config.manifestURL !== manifestURL || typeof config.teamIdentifier !== 'string' || !/^[A-Z0-9]{10}$/.test(config.teamIdentifier)) {
    throw new Error('External update configuration must contain exactly the stable manifestURL and certificate teamIdentifier');
  }
  return config;
}
export function checkVersionGate({ version, mode, nextVersion, liveVersion }) {
  compareVersions(version, version);
  if (mode === 'rehearsal') {
    if (!nextVersion || compareVersions(version, nextVersion) > 0) throw new Error('Rehearsal version exceeds the explicitly supplied version ceiling');
  } else if (mode === 'release') {
    if (compareVersions(version, liveVersion) <= 0) throw new Error('Release version must be greater than the public stable version');
  } else throw new Error('Mode must be rehearsal or release');
}
export function releaseMetadata(version, publishedAt, notes = '') {
  const base = new URL('.', manifestURL);
  return {
    manifest: { version, feedURL: new URL(`feed-${version}.json`, base).href },
    feed: { url: new URL(`Vonvon-Bot-${version}-universal.zip`, base).href, name: `Vonvon Bot ${version}`, notes, pub_date: publishedAt },
  };
}
export async function canonicalPath(path) {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (e) {
    if (e.code !== 'ENOENT' || dirname(absolute) === absolute) throw e;
    return join(await canonicalPath(dirname(absolute)), basename(absolute));
  }
}

const exec = promisify(execFile);
const exists = async p => { try { await access(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const digest = data => createHash('sha256').update(data).digest('hex');
const inside = (parent, child) => { const r = relative(parent, child); return !r || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
const packCode = `
import { Arch, build, Platform } from 'electron-builder';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const [repo, out, identity, phase] = process.argv.slice(1);
const version = JSON.parse(await readFile(join(repo, 'packages/desktop/stage/package.json'), 'utf8')).version;
process.chdir(join(repo, 'packages/desktop'));
await build({
  projectDir: join(repo, 'packages/desktop'),
  targets: Platform.MAC.createTarget([phase === 'app' ? 'dir' : 'dmg'], Arch.universal),
  ...(phase === 'dmg' ? { prepackaged: join(out, 'mac-universal/Vonvon Bot.app') } : {}),
  config: { extends: join(repo, 'packages/desktop/electron-builder-universal.yml'), buildVersion: version,
    directories: { output: out }, mac: { identity } },
  publish: 'never',
});`;

export async function releaseMac(options) {
  if (process.platform !== 'darwin') throw new Error('Run release-mac on macOS with the user signing keychain');
  // mktemp commonly returns /var/... on macOS; builder resolves its workspace to /private/var/....
  const repo = await realpath(resolve(options.repo)), out = await canonicalPath(options.out), version = options.version;
  if (inside(repo, out)) throw new Error('Release evidence must be outside the source worktree');
  if (!/^[a-f0-9]{40}$/.test(options.sha ?? '')) throw new Error('Supply the full, exact main commit SHA');
  const suppliedConfigPath = process.env.VONVON_DESKTOP_UPDATE_CONFIG;
  if (!suppliedConfigPath || !isAbsolute(suppliedConfigPath)) throw new Error('Set VONVON_DESKTOP_UPDATE_CONFIG to an absolute external file');
  const configPath = await realpath(suppliedConfigPath);
  if (inside(repo, configPath)) throw new Error('Update configuration must be outside the source worktree');
  const configBytes = await readFile(configPath), config = validateConfig(JSON.parse(configBytes));
  const redact = s => String(s).replaceAll(config.teamIdentifier, '<TEAM_ID>').replace(/\/Users\/[^/\s"']+/g, '/Users/<u>');
  const logs = join(out, 'logs');
  await mkdir(logs, { recursive: true });
  const run = async (label, command, args) => {
    try {
      const r = await exec(command, args, { cwd: repo, env: process.env, timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 });
      await writeFile(join(logs, `${label}.log`), redact(r.stdout + r.stderr));
      return r;
    } catch (e) {
      await writeFile(join(logs, `${label}.log`), redact((e.stdout ?? '') + (e.stderr ?? '') + '\n' + e.message));
      throw new Error(`${label} failed; inspect its redacted log`, { cause: e });
    }
  };
  const lockPath = join(out, '.release.lock');
  const lock = await open(lockPath, 'wx').catch(() => { throw new Error('Output is locked; check the recorded process before recovering a stale lock'); });
  await lock.writeFile(String(process.pid));
  try {
    const head = (await run('source-head', 'git', ['rev-parse', 'HEAD'])).stdout.trim();
    if (head !== options.sha) throw new Error('Worktree HEAD differs from the supplied main SHA');
    await run('source-on-main', 'git', ['merge-base', '--is-ancestor', head, 'origin/main']);
    if ((await run('source-status', 'git', ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()) throw new Error('Release source has tracked modifications');
    const desktop = join(repo, 'packages/desktop');
    for (const p of ['packages/daemon/package.json', 'packages/desktop/package.json', 'packages/desktop/stage/package.json']) {
      if ((await json(join(repo, p))).version !== version) throw new Error(`Version differs from input in ${p}`);
    }
    validateConfig(await json(join(desktop, 'stage/dist/update-config.json')));
    if (JSON.stringify(await json(join(desktop, 'stage/dist/update-config.json'))) !== JSON.stringify(config)) throw new Error('Build did not use the supplied external update configuration');
    let live;
    if (options.mode === 'release') {
      const response = await fetch(manifestURL, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`Stable manifest HTTP ${response.status}; do not bypass TLS or invent a baseline`);
      live = await response.json();
      await writeFile(join(out, 'previous-manifest.json'), JSON.stringify(live, null, 2) + '\n', { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    }
    checkVersionGate({ version, mode: options.mode, nextVersion: options['next-version'], liveVersion: live?.version });
    const notes = options['notes-file'] ? (await readFile(resolve(options['notes-file']), 'utf8')).trim() : '';
    if (options.mode === 'release' && !notes) throw new Error('Formal releases require nonempty release notes via --notes-file');
    const statePath = join(out, 'notarization-state.json');
    const context = { version, sourceCommit: head, mode: options.mode, nextVersion: options['next-version'] ?? null, configSHA256: digest(configBytes), keychainProfile: options['keychain-profile'], notesSHA256: digest(notes) };
    const state = await exists(statePath) ? await json(statePath) : { context, startedAt: new Date().toISOString() };
    if (JSON.stringify(state.context) !== JSON.stringify(context)) throw new Error('Output belongs to different release inputs; choose a fresh output directory');
    const save = () => writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
    await save();
    const { artifactRecord, verifyUniversalApp, verifyDmg } = await import(pathToFileURL(join(repo, 'scripts/desktop-release-tools.mjs')));
    const require = createRequire(join(repo, 'package.json'));
    const asar = require('@electron/asar');
    const app = join(out, 'mac-universal/Vonvon Bot.app');
    const zip = join(out, `Vonvon-Bot-${version}-universal.zip`);
    const dmg = join(out, `Vonvon-Bot-${version}-universal.dmg`);
    if (state.complete) {
      for (const record of state.files) {
        if ((await artifactRecord(join(out, record.file))).sha256 !== record.sha256) throw new Error('Completed release bytes changed; refusing to reuse this output');
      }
      console.log('Previously completed release bytes match; no new submission made.');
      return state;
    }
    const identities = (await run('signing-identities', 'security', ['find-identity', '-v', '-p', 'codesigning'])).stdout;
    const cert = identities.split('\n').find(line => line.includes('Developer ID Application:') && line.includes(`(${config.teamIdentifier})`))?.match(/\b[A-F0-9]{40}\b/)?.[0];
    if (!cert) throw new Error('No valid Developer ID Application identity matches the configured certificate team');
    if (!state.appBuilt) {
      if (await exists(app)) throw new Error('Unrecorded app output exists; preserve it and use a fresh output directory');
      console.log('Building and signing universal App');
      await run('universal-app', process.execPath, ['--input-type=module', '-e', packCode, repo, out, cert, 'app']);
      state.appBuilt = true; await save();
    }
    let verification = await verifyUniversalApp({ app, version, teamIdentifier: config.teamIdentifier });
    const embedded = JSON.parse(asar.extractFile(join(app, 'Contents/Resources/app.asar'), 'dist/update-config.json').toString());
    validateConfig(embedded);
    if (embedded.teamIdentifier !== config.teamIdentifier) throw new Error('Packaged update configuration differs from the certificate');
    const profileArgs = ['--keychain-profile', options['keychain-profile']];
    async function signedSeal(label, path, architectures = ['default']) {
      const seal = {};
      for (const arch of architectures) {
        const result = await run(`${label}-seal-${arch}`, 'codesign', ['--display', '--verbose=4', ...(arch === 'default' ? [] : ['--architecture', arch]), path]);
        const hash = result.stderr.match(/^CDHash=([a-f0-9]+)$/mi)?.[1];
        if (!hash) throw new Error(`Cannot identify ${label} signed content`);
        seal[arch] = hash;
      }
      return seal;
    }
    async function bindSeal(kind, path, architectures) {
      const seal = await signedSeal(kind, path, architectures);
      const key = `${kind}Seal`;
      if (!state[key]) {
        if (state[kind]?.uploadAttempted) throw new Error(`Submission lacks its original ${kind} content fingerprint; preserve and investigate`);
        state[key] = seal; await save();
      } else if (JSON.stringify(state[key]) !== JSON.stringify(seal)) throw new Error(`${kind} signed content differs from the recorded candidate`);
    }
    await bindSeal('app', app, ['arm64', 'x86_64']);
    async function notarize(kind, archive) {
      const record = await artifactRecord(archive);
      let submission = state[kind];
      if (submission?.status === 'Accepted' && submission.logVerified) {
        if (record.sha256 !== submission.sha256 && record.sha256 !== submission.stapledSHA256) {
          if (kind !== 'dmg') throw new Error('Accepted App transport archive bytes changed');
          // A crash can occur after DMG stapling but before its final-byte receipt is saved.
          // Its signed content was already matched above; require the actual ticket as well.
          await run('dmg-recovered-ticket', 'xcrun', ['stapler', 'validate', archive]);
          submission.stapledSHA256 = record.sha256; await save();
        }
        return;
      }
      if (submission && submission.sha256 !== record.sha256) throw new Error(`${kind} submission bytes changed`);
      if (submission?.uploadAttempted && !submission.id) throw new Error(`Recover ${kind} submission ID using notarytool history before retrying; do not upload again blindly`);
      if (!submission?.id) {
        submission = state[kind] = { sha256: record.sha256, file: record.file, uploadAttempted: true, startedAt: new Date().toISOString() };
        await save();
        console.log(`Submitting ${kind} to Apple`);
        const result = await run(`${kind}-submit`, 'xcrun', ['notarytool', 'submit', archive, ...profileArgs, '--output-format', 'json']);
        submission.id = JSON.parse(result.stdout).id;
        if (!submission.id) throw new Error(`Apple did not return a ${kind} submission ID; recover from history`);
        await save();
      }
      console.log(`Waiting for ${kind} notarization: ${submission.id}`);
      let wait;
      try { wait = await run(`${kind}-wait`, 'xcrun', ['notarytool', 'wait', submission.id, ...profileArgs, '--timeout', options.timeout, '--output-format', 'json']); }
      catch {
        wait = await run(`${kind}-info`, 'xcrun', ['notarytool', 'info', submission.id, ...profileArgs, '--output-format', 'json']);
      }
      submission.status = JSON.parse(wait.stdout).status; await save();
      if (submission.status !== 'In Progress') {
        const log = await run(`${kind}-notary`, 'xcrun', ['notarytool', 'log', submission.id, ...profileArgs]);
        const report = JSON.parse(log.stdout);
        await writeFile(join(out, `${kind}-notary-log.json`), redact(JSON.stringify(report, null, 2)) + '\n');
        submission.issues = report.issues ?? [];
        submission.logVerified = true; await save();
      }
      if (submission.status !== 'Accepted') throw new Error(`${kind}: ${submission.status}; submission ID is saved, rerun this output to resume only when appropriate`);
    }
    const transport = join(out, 'app-notary-upload.zip');
    if (!state.transport) {
      if (await exists(transport)) throw new Error('Unrecorded transport ZIP exists; preserve it rather than submitting potentially incomplete bytes');
      await run('app-transport', 'ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, transport]);
      state.transport = await artifactRecord(transport); await save();
    }
    if ((await artifactRecord(transport)).sha256 !== state.transport.sha256) throw new Error('App transport ZIP bytes changed');
    await notarize('app', transport);
    await run('app-staple', 'xcrun', ['stapler', 'staple', app]);
    await run('app-ticket', 'xcrun', ['stapler', 'validate', app]);
    await run('app-gatekeeper', 'spctl', ['-a', '-vv', '-t', 'exec', app]);
    verification = await verifyUniversalApp({ app, version, teamIdentifier: config.teamIdentifier });
    if (!state.zip) {
      if (await exists(zip)) throw new Error('Unrecorded final ZIP exists; preserve it and investigate');
      console.log('Creating final update ZIP from the stapled App');
      await run('final-zip', 'ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
      state.zip = await artifactRecord(zip); await save();
    }
    if ((await artifactRecord(zip)).sha256 !== state.zip.sha256) throw new Error('Final ZIP bytes changed');
    if (!state.dmgBuilt) {
      if (await exists(dmg)) throw new Error('Unrecorded final DMG exists; preserve it and investigate');
      console.log('Creating and signing DMG from the stapled App');
      await run('final-dmg', process.execPath, ['--input-type=module', '-e', packCode, repo, out, cert, 'dmg']);
      state.dmgBuilt = true; await save();
    }
    await verifyDmg(dmg, config.teamIdentifier);
    await bindSeal('dmg', dmg);
    await notarize('dmg', dmg);
    await run('dmg-staple', 'xcrun', ['stapler', 'staple', dmg]);
    state.dmg.stapledSHA256 = (await artifactRecord(dmg)).sha256; await save();
    await run('dmg-ticket', 'xcrun', ['stapler', 'validate', dmg]);
    await run('dmg-signature', 'codesign', ['--verify', '--deep', '--strict', dmg]);
    await run('dmg-gatekeeper', 'spctl', ['-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', dmg]);
    await verifyDmg(dmg, config.teamIdentifier);
    // Check the ZIP's actual App and the read-only DMG's actual App, not just the source bundle.
    const extracted = join(out, 'zip-verification');
    if (state.zipVerification && state.zipVerification.archiveSHA256 !== state.zip.sha256) throw new Error('ZIP extraction receipt refers to different archive bytes');
    if (!state.zipVerification) {
      if (await exists(extracted)) throw new Error('Unrecorded ZIP extraction exists; preserve it and investigate before reuse');
      await run('zip-extract', 'ditto', ['-x', '-k', zip, extracted]);
    }
    const extractedApp = join(extracted, 'Vonvon Bot.app');
    await verifyUniversalApp({ app: extractedApp, version, teamIdentifier: config.teamIdentifier });
    if (JSON.stringify(await signedSeal('zip-app', extractedApp, ['arm64', 'x86_64'])) !== JSON.stringify(state.appSeal)) throw new Error('ZIP contains a different signed App');
    await run('zip-app-ticket', 'xcrun', ['stapler', 'validate', extractedApp]);
    await run('zip-app-gatekeeper', 'spctl', ['-a', '-vv', '-t', 'exec', extractedApp]);
    state.zipVerification = { archiveSHA256: state.zip.sha256 }; await save();
    const mounted = await run('dmg-attach', 'hdiutil', ['attach', '-readonly', '-nobrowse', '-plist', dmg]);
    const entities = require('plist').parse(mounted.stdout)['system-entities'];
    const volume = entities.find(e => e['mount-point'])?.['mount-point'];
    if (!volume) throw new Error('DMG did not mount an inspectable filesystem');
    try {
      const mountedApp = join(volume, 'Vonvon Bot.app');
      await verifyUniversalApp({ app: mountedApp, version, teamIdentifier: config.teamIdentifier });
      if (JSON.stringify(await signedSeal('dmg-app', mountedApp, ['arm64', 'x86_64'])) !== JSON.stringify(state.appSeal)) throw new Error('DMG contains a different signed App');
      await run('dmg-app-ticket', 'xcrun', ['stapler', 'validate', mountedApp]);
      await run('dmg-app-gatekeeper', 'spctl', ['-a', '-vv', '-t', 'exec', mountedApp]);
    } finally { await run('dmg-detach', 'hdiutil', ['detach', volume]); }
    const metadata = releaseMetadata(version, state.startedAt, notes);
    for (const [file, value] of [['manifest.json', metadata.manifest], [`feed-${version}.json`, metadata.feed]]) {
      await writeFile(join(out, file), JSON.stringify(value, null, 2) + '\n');
    }
    const files = [];
    for (const file of [basename(zip), basename(dmg), 'manifest.json', `feed-${version}.json`]) files.push(await artifactRecord(join(out, file)));
    const inventory = { version, sourceCommit: head, mode: options.mode, publiclyPublished: false, files, verification, notarization: { app: state.app.id, dmg: state.dmg.id }, warnings: [...(state.app.issues ?? []), ...(state.dmg.issues ?? [])].filter(issue => issue.severity === 'warning'), checks: { appStapled: true, dmgStapled: true, gatekeeperApp: true, gatekeeperDmg: true, zipContainsStapledApp: true, dmgContainsStapledApp: true } };
    await writeFile(join(out, 'release-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
    files.push(await artifactRecord(join(out, 'release-inventory.json')));
    await writeFile(join(out, 'SHA256SUMS'), files.map(f => `${f.sha256}  ${f.file}`).join('\n') + '\n');
    state.files = files; state.complete = true; state.completedAt = new Date().toISOString(); await save();
    console.log(`Notarized ${version} (${options.mode}); final hashes saved. No public upload or installation performed.`);
    return state;
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    repo: { type: 'string', default: resolve(dirname(fileURLToPath(import.meta.url)), '..') },
    version: { type: 'string' }, sha: { type: 'string' }, out: { type: 'string' }, mode: { type: 'string', default: 'rehearsal' },
    'next-version': { type: 'string' }, 'notes-file': { type: 'string' }, 'keychain-profile': { type: 'string', default: 'notelet-notary' }, timeout: { type: 'string', default: '10m' }, help: { type: 'boolean' },
  } });
  if (values.help) console.log('VONVON_DESKTOP_UPDATE_CONFIG=/absolute/external/config.json node scripts/release-mac.mjs --version X.Y.Z --sha FULL_MAIN_SHA --out /absolute/evidence --mode rehearsal --next-version CEILING [--repo /absolute/source-worktree] [--keychain-profile notelet-notary]\nFor --mode release, supply --notes-file /absolute/release-notes.txt; the public version is verified first. This script never uploads to COS, refreshes CDN, publishes, or installs.');
  else if (!values.version || !values.sha || !values.out) { console.error('Supply --version, --sha and --out; see --help'); process.exitCode = 1; }
  else try { await releaseMac(values); } catch (e) { console.error(e.message.replace(/\/Users\/[^/\s"']+/g, '/Users/<u>')); process.exitCode = 1; }
}
