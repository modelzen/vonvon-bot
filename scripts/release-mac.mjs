import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, open, readFile, realpath, readdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { assertSecureTransport, readStableManifest } from './verify-public-release.mjs';
import { readCosReleaseEvidence } from './release-cos-evidence.mjs';
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
export function checkVersionGate({ version, mode, nextVersion, liveVersion, firstRelease = false, historicalVersions = [] }) {
  compareVersions(version, version);
  if (mode === 'rehearsal') {
    if (!nextVersion || compareVersions(version, nextVersion) > 0) throw new Error('Rehearsal version exceeds the explicitly supplied version ceiling');
  } else if (mode === 'release') {
    const baselines = [liveVersion, ...historicalVersions].filter(v => v !== undefined);
    if (!baselines.length && !firstRelease) throw new Error('No verified baseline; explicit first release is required');
    for (const baseline of baselines) if (compareVersions(version, baseline) <= 0) throw new Error('Release version must be greater than the highest previously published version');
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
const json = async p => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { throw new Error('Cannot read release JSON; inspect the file privately'); } };
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

export function assertOutputLocation(repo, out, temporaryRoots) {
  if (inside(repo, out) || inside(out, repo) || temporaryRoots.some(root => inside(root, out))) throw new Error('Release evidence must be persistent, outside temporary roots, and neither contain nor be contained by the source worktree');
}
/**
 * Decide the formal-release baseline. A missing public manifest has three distinct meanings:
 * COS still holds manifest.json (stop), only history exists (explicit --no-live-manifest,
 * gate on the highest published version), or nothing was ever published (explicit --first-release).
 */
export function validateFirstRelease({ firstRelease = false, noLiveManifest = false, live, evidence }) {
  if (!evidence || !Array.isArray(evidence.keys) || !Array.isArray(evidence.versions)) throw new Error('Complete COS enumeration and publication ledger are required');
  if (firstRelease && noLiveManifest) throw new Error('Use either --first-release or --no-live-manifest, not both');
  if (live.kind !== 'missing') {
    if (firstRelease) throw new Error('--first-release cannot replace an existing stable manifest');
    if (noLiveManifest) throw new Error('--no-live-manifest requires the public stable manifest to be missing');
    return live.manifest.version;
  }
  if (evidence.keys.some(key => /(?:^|\/)manifest\.json$/.test(key))) throw new Error('Public manifest is missing but COS still lists manifest.json; investigate the endpoint before any release');
  const history = evidence.versions.length > 0 || evidence.keys.some(key => /(?:^|\/)(?:feed-|Vonvon-Bot-)/.test(key));
  if (!history) {
    if (!firstRelease) throw new Error('First release requires explicit --first-release, missing manifest and no historical COS packages or ledger versions');
    return 'none';
  }
  if (!noLiveManifest) throw new Error('Public manifest is missing but COS or the ledger has published versions; use --no-live-manifest (not --first-release) to gate above them');
  if (!evidence.versions.length) throw new Error('Historical COS objects exist but no published version could be derived; investigate before release');
  const highestPublished = evidence.versions.reduce((high, v) => compareVersions(v, high) > 0 ? v : high);
  return { live: 'none', highestPublished };
}
export function checkNotaryWarnings(issues) {
  // Empty allowlist intentionally: each future exception needs a reviewed, narrow rule.
  if (!Array.isArray(issues) || issues.length) throw new Error('Notarization issues require owner investigation; no warnings are allowlisted');
}
export async function releaseMac(options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  assertSecureTransport(env);
  const execute = dependencies.execFile ?? exec;
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error('Run release-mac on macOS with the user signing keychain');
  // mktemp commonly returns /var/... on macOS; builder resolves its workspace to /private/var/....
  const repo = await realpath(resolve(options.repo)), out = await canonicalPath(options.out), version = options.version;
  const temporaryRoots = dependencies.temporaryRoots ?? await Promise.all([tmpdir(), '/tmp', '/private/tmp'].map(canonicalPath));
  assertOutputLocation(repo, out, temporaryRoots);
  if (await exists(out) && !(await exists(join(out, 'notarization-state.json'))) && (await readdir(out)).length) throw new Error('Fresh output directory must be empty');
  if (!/^[a-f0-9]{40}$/.test(options.sha ?? '')) throw new Error('Supply the full, exact main commit SHA');
  const suppliedConfigPath = env.VONVON_DESKTOP_UPDATE_CONFIG;
  if (!suppliedConfigPath || !isAbsolute(suppliedConfigPath)) throw new Error('Set VONVON_DESKTOP_UPDATE_CONFIG to an absolute external file');
  const configPath = await realpath(suppliedConfigPath);
  if (inside(repo, configPath)) throw new Error('Update configuration must be outside the source worktree');
  const configBytes = await readFile(configPath), config = validateConfig(await json(configPath));
  const redact = s => String(s).replaceAll(config.teamIdentifier, '<TEAM_ID>').replace(/\/Users\/[^/\s"']+/g, '/Users/<u>');
  const logs = join(out, 'logs');
  await mkdir(logs, { recursive: true });
  const run = async (label, command, args) => {
    try {
      const r = await execute(command, args, { cwd: repo, env: label === 'source-build' ? { ...env, HOME: options['build-home'] } : env, timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 });
      await writeFile(join(logs, `${label}.log`), label === 'notary-credentials' ? 'Credentials verified; history omitted.\n' : redact(r.stdout + r.stderr));
      return r;
    } catch (e) {
      await writeFile(join(logs, `${label}.log`), redact((e.stdout ?? '') + (e.stderr ?? '') + '\n' + e.message));
      throw new Error(`${label} failed; inspect its redacted log`, { cause: e });
    }
  };
  const lockPath = join(out, '.release.lock');
  const lock = await open(lockPath, 'wx').catch(() => { throw new Error('Output is locked; check the recorded process before recovering a stale lock'); });
  try {
    await lock.writeFile(String(process.pid));
    const head = (await run('source-head', 'git', ['rev-parse', 'HEAD'])).stdout.trim();
    if (head !== options.sha) throw new Error('Worktree HEAD differs from the supplied main SHA');
    await run('source-on-main', 'git', ['merge-base', '--is-ancestor', head, 'origin/main']);
    if ((await run('source-status', 'git', ['status', '--porcelain', '--untracked-files=normal'])).stdout.trim()) throw new Error('Release source has tracked or untracked modifications');
    const desktop = join(repo, 'packages/desktop');
    for (const p of ['packages/daemon/package.json', 'packages/desktop/package.json']) {
      if ((await json(join(repo, p))).version !== version) throw new Error(`Version differs from input in ${p}`);
    }
    let live, evidence, baseline;
    if (options.mode === 'release') {
      live = await readStableManifest({ fetchImpl: dependencies.fetchImpl ?? fetch, url: manifestURL });
      evidence = dependencies.cosEvidence ?? await readCosReleaseEvidence(options['cos-config'], { env });
      baseline = validateFirstRelease({ firstRelease: !!options['first-release'], noLiveManifest: !!options['no-live-manifest'], live, evidence });
    } else if (options['first-release'] || options['no-live-manifest']) throw new Error('--first-release and --no-live-manifest require release mode');
    checkVersionGate({ version, mode: options.mode, nextVersion: options['next-version'], liveVersion: live?.manifest?.version, firstRelease: baseline === 'none', historicalVersions: evidence?.versions });
    const notes = options['notes-file'] ? (await readFile(resolve(options['notes-file']), 'utf8')).trim() : '';
    if (options.mode === 'release' && !notes) throw new Error('Formal releases require nonempty release notes via --notes-file');
    if (live?.kind === 'present') await writeFile(join(out, 'previous-manifest.json'), JSON.stringify(live.manifest, null, 2) + '\n', { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const statePath = join(out, 'notarization-state.json');
    const context = { version, sourceCommit: head, mode: options.mode, nextVersion: options['next-version'] ?? null, configSHA256: digest(configBytes), keychainProfile: options['keychain-profile'], notesSHA256: digest(notes), firstRelease: !!options['first-release'], ...(options['no-live-manifest'] ? { noLiveManifest: true } : {}) };
    const state = await exists(statePath) ? await json(statePath) : { context, baseline, startedAt: new Date().toISOString() };
    if (JSON.stringify(state.context) !== JSON.stringify(context)) throw new Error('Output belongs to different release inputs; choose a fresh output directory');
    const save = () => writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
    await save();
    const { artifactRecord, verifyUniversalApp, verifyDmg } = dependencies.tools ?? await import(pathToFileURL(join(repo, 'scripts/desktop-release-tools.mjs')));
    const require = createRequire(join(repo, 'package.json'));
    const asar = dependencies.asar ?? require('@electron/asar');
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
    const profileArgs = ['--keychain-profile', options['keychain-profile']];
    await run('notary-credentials', 'xcrun', ['notarytool', 'history', ...profileArgs, '--output-format', 'json']);
    const identities = (await run('signing-identities', 'security', ['find-identity', '-v', '-p', 'codesigning'])).stdout;
    const cert = identities.split('\n').find(line => line.includes('Developer ID Application:') && line.includes(`(${config.teamIdentifier})`))?.match(/\b[A-F0-9]{40}\b/)?.[0];
    if (!cert) throw new Error('No valid Developer ID Application identity matches the configured certificate team');
    if (!state.appBuilt) {
      if (await exists(app)) throw new Error('Unrecorded app output exists; preserve it and use a fresh output directory');
      if (!isAbsolute(options['build-home'] ?? '')) throw new Error('Supply an isolated absolute --build-home');
      const buildHome = await canonicalPath(options['build-home']);
      const homeRoots = await Promise.all([tmpdir(), '/tmp', '/private/tmp'].map(canonicalPath));
      if (!homeRoots.some(root => inside(root, buildHome)) || inside(repo, buildHome) || inside(out, buildHome)) throw new Error('Build HOME must be temporary and outside source and evidence');
      await mkdir(buildHome, { recursive: true });
      await run('source-build', 'npm', ['run', 'build']);
      if ((await run('built-head', 'git', ['rev-parse', 'HEAD'])).stdout.trim() !== head || (await run('built-status', 'git', ['status', '--porcelain', '--untracked-files=normal'])).stdout.trim()) throw new Error('Source changed while building');
      state.build = { sourceCommit: head }; await save();
      if (state.build?.sourceCommit !== head) throw new Error('App lacks its source-build binding');
      if ((await json(join(desktop, 'stage/package.json'))).version !== version) throw new Error('Built stage version differs');
      if (JSON.stringify(validateConfig(await json(join(desktop, 'stage/dist/update-config.json')))) !== JSON.stringify(config)) throw new Error('Built stage did not use the supplied update configuration');
      console.log('Building and signing universal App');
      await run('universal-app', process.execPath, ['--input-type=module', '-e', packCode, repo, out, cert, 'app']);
      state.appBuilt = true; await save();
    }
    if (state.build?.sourceCommit !== head) throw new Error('App lacks its source-build binding');
    let verification = await verifyUniversalApp({ app, version, teamIdentifier: config.teamIdentifier });
    const embedded = JSON.parse(asar.extractFile(join(app, 'Contents/Resources/app.asar'), 'dist/update-config.json').toString());
    validateConfig(embedded);
    if (embedded.teamIdentifier !== config.teamIdentifier) throw new Error('Packaged update configuration differs from the certificate');
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
        checkNotaryWarnings(submission.issues ?? []);
        return;
      }
      if (submission && submission.sha256 !== record.sha256) throw new Error(`${kind} submission bytes changed`);
      const recovery = options['recover-submission']?.match(/^(app|dmg)=([a-f0-9-]{36})$/i);
      if (options['recover-submission'] && !recovery) throw new Error('Use --recover-submission app=<UUID> or dmg=<UUID>');
      if (recovery?.[1] === kind && submission?.uploadAttempted && !submission.id) {
        const recovered = JSON.parse((await run(`${kind}-recover`, 'xcrun', ['notarytool', 'log', recovery[2], ...profileArgs])).stdout);
        if (recovered.sha256 !== record.sha256 || recovered.jobId !== recovery[2]) throw new Error('Recovered submission does not match the recorded archive SHA-256 and job ID');
        submission.id = recovery[2]; await save();
      }
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
        submission.issues = JSON.parse(redact(JSON.stringify(report.issues ?? [])));
        if (report.sha256 !== submission.sha256) throw new Error('Apple notarization log SHA-256 differs from submitted archive');
        submission.logVerified = true; await save();
      }
      if (submission.status !== 'Accepted') throw new Error(`${kind}: ${submission.status}; inspect the saved notary log; Invalid requires a corrected build in a fresh output, In Progress can resume`);
      checkNotaryWarnings(submission.issues ?? []);
    }
    async function noQuarantine(label, path) {
      const attrs = (await run(label, 'xattr', ['-r', path])).stdout;
      if (/(?:^|: )com\.apple\.quarantine(?:\s|$)/m.test(attrs)) throw new Error('Quarantine attribute found; investigate before release');
    }
    await noQuarantine('app-attributes', app);
    const transport = join(out, 'app-notary-upload.zip');
    if (!state.transport) {
      if (await exists(transport)) throw new Error('Unrecorded transport ZIP exists; preserve it rather than submitting potentially incomplete bytes');
      await run('app-transport', 'ditto', ['-c', '-k', '--sequesterRsrc', '--noqtn', '--keepParent', app, transport]);
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
      await run('final-zip', 'ditto', ['-c', '-k', '--sequesterRsrc', '--noqtn', '--keepParent', app, zip]);
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
    await noQuarantine('zip-attributes', extractedApp);
    await verifyUniversalApp({ app: extractedApp, version, teamIdentifier: config.teamIdentifier });
    if (JSON.stringify(await signedSeal('zip-app', extractedApp, ['arm64', 'x86_64'])) !== JSON.stringify(state.appSeal)) throw new Error('ZIP contains a different signed App');
    await run('zip-app-ticket', 'xcrun', ['stapler', 'validate', extractedApp]);
    await run('zip-app-gatekeeper', 'spctl', ['-a', '-vv', '-t', 'exec', extractedApp]);
    state.zipVerification = { archiveSHA256: state.zip.sha256 }; await save();
    const mounted = await run('dmg-attach', 'hdiutil', ['attach', '-readonly', '-nobrowse', '-plist', dmg]);
    const entities = (dependencies.plist ?? require('plist')).parse(mounted.stdout)['system-entities'];
    const volume = entities.find(e => e['mount-point'])?.['mount-point'];
    if (!volume) throw new Error('DMG did not mount an inspectable filesystem');
    try {
      const mountedApp = join(volume, 'Vonvon Bot.app');
      await noQuarantine('dmg-attributes', mountedApp);
      await verifyUniversalApp({ app: mountedApp, version, teamIdentifier: config.teamIdentifier });
      if (JSON.stringify(await signedSeal('dmg-app', mountedApp, ['arm64', 'x86_64'])) !== JSON.stringify(state.appSeal)) throw new Error('DMG contains a different signed App');
      await run('dmg-app-ticket', 'xcrun', ['stapler', 'validate', mountedApp]);
      await run('dmg-app-gatekeeper', 'spctl', ['-a', '-vv', '-t', 'exec', mountedApp]);
    } finally { await run('dmg-detach', 'hdiutil', ['detach', volume]); }
    const metadata = releaseMetadata(version, new Date().toISOString(), notes);
    const manifestFile = options.mode === 'rehearsal' ? 'REHEARSAL-manifest.json' : 'manifest.json';
    const feedFile = options.mode === 'rehearsal' ? `REHEARSAL-feed-${version}.json` : `feed-${version}.json`;
    if (options.mode === 'rehearsal') await writeFile(join(out, 'DO-NOT-PUBLISH'), 'Local rehearsal only. Never upload this directory.\n');
    for (const [file, value] of [[manifestFile, metadata.manifest], [feedFile, metadata.feed]]) {
      await writeFile(join(out, file), JSON.stringify(value, null, 2) + '\n');
    }
    const files = [];
    for (const file of [basename(zip), basename(dmg), manifestFile, feedFile]) files.push(await artifactRecord(join(out, file)));
    const inventory = { version, sourceCommit: head, mode: options.mode, complete: true, baseline: state.baseline, baselineEvidence: evidence, publiclyPublished: false, files, verification, notarization: { app: state.app.id, dmg: state.dmg.id }, warnings: [...(state.app.issues ?? []), ...(state.dmg.issues ?? [])].filter(issue => issue.severity === 'warning'), checks: { appStapled: true, dmgStapled: true, gatekeeperApp: true, gatekeeperDmg: true, quarantineAbsent: true, zipContainsStapledApp: true, dmgContainsStapledApp: true } };
    await writeFile(join(out, 'release-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
    files.push(await artifactRecord(join(out, 'release-inventory.json')));
    await writeFile(join(out, 'SHA256SUMS'), files.map(f => `${f.sha256}  ${f.file}`).join('\n') + '\n');
    state.files = files; state.complete = true; state.completedAt = new Date().toISOString(); await save();
    console.log(`Notarized ${version} (${options.mode}); final hashes saved. No public upload or installation performed.`);
    return state;
  } finally { await lock.close(); await unlink(lockPath); }
}

const invokedPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (invokedPath && invokedPath === await realpath(fileURLToPath(import.meta.url))) {
  const { values } = parseArgs({ options: {
    repo: { type: 'string', default: resolve(dirname(fileURLToPath(import.meta.url)), '..') },
    version: { type: 'string' }, sha: { type: 'string' }, out: { type: 'string' }, mode: { type: 'string', default: 'rehearsal' },
    'first-release': { type: 'boolean' }, 'no-live-manifest': { type: 'boolean' }, 'cos-config': { type: 'string' }, 'build-home': { type: 'string' }, 'recover-submission': { type: 'string' },
    'next-version': { type: 'string' }, 'notes-file': { type: 'string' }, 'keychain-profile': { type: 'string', default: 'notelet-notary' }, timeout: { type: 'string', default: '10m' }, help: { type: 'boolean' },
  } });
  if (values.help) console.log('VONVON_DESKTOP_UPDATE_CONFIG=/absolute/external/config.json node scripts/release-mac.mjs --version X.Y.Z --sha FULL_MAIN_SHA --out /absolute/evidence --build-home /temporary/isolated-home --mode rehearsal --next-version CEILING [--repo /absolute/source-worktree] [--keychain-profile notelet-notary]\nFor --mode release, supply --notes-file /absolute/release-notes.txt; the public version, COS prefix and local ledger are verified first with --cos-config /absolute/external/cos-readonly.json. Only an HTTPS 404 manifest plus an empty COS prefix and ledger allows --first-release; a 404 manifest with published versions in COS or the ledger needs --no-live-manifest and gates above the highest of them. Recover an uncertain submission with --recover-submission app=<UUID> or dmg=<UUID>. This script never uploads to COS, refreshes CDN, publishes, or installs.');
  else if (!values.version || !values.sha || !values.out) { console.error('Supply --version, --sha and --out; see --help'); process.exitCode = 1; }
  else try { await releaseMac(values); } catch (e) { console.error(e.message.replace(/\/Users\/[^/\s"']+/g, '/Users/<u>')); process.exitCode = 1; }
}
