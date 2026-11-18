import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPath, checkVersionGate, compareVersions, manifestURL, releaseMetadata, validateConfig } from './release-mac.mjs';

test('release version comparisons are numeric and reject ambiguous values', () => {
  assert.equal(compareVersions('0.7.10', '0.7.9'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.7.0', '0.7.14'), -1);
  for (const v of ['0.7', '0.7.0-beta.1', '0.07.0', '0.7.-1', '9007199254740992.0.0']) {
    assert.throws(() => compareVersions(v, '0.7.0'));
  }
});

test('formal releases cannot promote an equal or lower version', () => {
  for (const version of ['0.7.9', '0.7.10']) {
    assert.throws(() => checkVersionGate({ version, mode: 'release', liveVersion: '0.7.10' }));
  }
  checkVersionGate({ version: '0.7.11', mode: 'release', liveVersion: '0.7.10' });
  assert.throws(() => checkVersionGate({ version: '0.7.11', mode: 'release' }));
});

test('rehearsals require and obey their next-release version ceiling', () => {
  checkVersionGate({ version: '0.7.0', mode: 'rehearsal', nextVersion: '0.7.0' });
  checkVersionGate({ version: '0.6.9', mode: 'rehearsal', nextVersion: '0.7.0' });
  assert.throws(() => checkVersionGate({ version: '0.7.14', mode: 'rehearsal', nextVersion: '0.7.0' }));
  assert.throws(() => checkVersionGate({ version: '0.7.0', mode: 'rehearsal' }));
  assert.throws(() => checkVersionGate({ version: '0.7.0', mode: 'unknown' }));
});

test('only the explicit stable endpoint and two config fields are permitted', () => {
  const valid = { manifestURL, teamIdentifier: 'AAAAAAAAAA' };
  assert.equal(validateConfig(valid), valid);
  for (const config of [null, {}, { ...valid, extra: true }, { ...valid, teamIdentifier: 'invalid' }, { ...valid, manifestURL: 'http://dl.vonvon.cc/bot/mac/stable/manifest.json' }, { ...valid, manifestURL: manifestURL + '?token=secret' }]) {
    assert.throws(() => validateConfig(config));
  }
});

test('Squirrel manifest, feed and ZIP share a stable HTTPS directory', () => {
  const { manifest, feed } = releaseMetadata('0.7.0', '2026-10-26T00:00:00Z', 'Release notes');
  assert.equal(manifest.version, '0.7.0');
  assert.equal(new URL('.', manifest.feedURL).href, new URL('.', manifestURL).href);
  assert.equal(new URL('.', feed.url).href, new URL('.', manifestURL).href);
  assert.equal(new URL(feed.url).pathname, '/bot/mac/stable/Vonvon-Bot-0.7.0-universal.zip');
  assert.deepEqual(Object.keys(manifest).sort(), ['feedURL', 'version']);
  assert.equal(feed.notes, 'Release notes');
});

test('canonicalization resolves existing parents before testing nonexistent output paths', async () => {
  const canonicalRoot = dirname(fileURLToPath(import.meta.url));
  const alias = canonicalRoot.replace(/^\/private\/var\//, '/var/');
  assert.equal(await canonicalPath(alias), canonicalRoot);
  assert.equal(await canonicalPath(join(alias, 'not-created-output', 'release')), join(canonicalRoot, 'not-created-output', 'release'));
});

// Native commands are replaced by a recorder. These tests never invoke signing,
// packaging, Apple services, mounting, or the public update endpoint.
const { createHash } = await import('node:crypto');
const { execFileSync } = await import('node:child_process');
const { mkdir, mkdtemp, readFile, writeFile } = await import('node:fs/promises');
const { basename } = await import('node:path');
const { tmpdir } = await import('node:os');
const { releaseMac } = await import('./release-mac.mjs');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceSHA = 'a'.repeat(40);
const submissionIDs = { app: '11111111-1111-4111-8111-111111111111', dmg: '22222222-2222-4222-8222-222222222222' };
let fixtureRoot;
let fixtureNumber = 0;
async function releaseFixture(settings = {}) {
  // The surrounding test command can own cleanup by supplying RELEASE_TEST_ROOT; each run
  // takes a fresh directory below it, so reruns never meet an earlier run's scenarios.
  // Standalone runs preserve their small fixtures for failure diagnosis.
  const supplied = process.env.RELEASE_TEST_ROOT;
  fixtureRoot ??= supplied ? await mkdir(supplied, { recursive: true }).then(() => mkdtemp(join(supplied, 'release-mac-')))
    : execFileSync('/bin/sh', ['-c', 'T=$(mktemp -d)\nprintf "%s" "$T"'], { encoding: 'utf8' });
  const root = join(await canonicalPath(fixtureRoot), `scenario-${++fixtureNumber}`);
  const repo = join(root, 'source'), out = join(root, 'evidence'), buildHome = join(root, 'build-home');
  const configPath = join(root, 'desktop-update.json');
  const config = { manifestURL, teamIdentifier: 'AAAAAAAAAA' };
  const write = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); };
  const writeJSON = (path, value) => write(path, JSON.stringify(value));
  await mkdir(repo, { recursive: true });
  await mkdir(buildHome, { recursive: true });
  await writeJSON(configPath, config);
  await writeJSON(join(repo, 'package.json'), {});
  for (const path of ['packages/daemon/package.json', 'packages/desktop/package.json', 'packages/desktop/stage/package.json']) {
    await writeJSON(join(repo, path), { version: '0.7.0' });
  }
  await writeJSON(join(repo, 'packages/desktop/stage/dist/update-config.json'), settings.stageConfig ?? config);
  const calls = [];
  const arch = settings.architecture ?? 'universal';
  const appDir = arch === 'universal' ? 'mac-universal' : arch === 'arm64' ? 'mac-arm64' : 'mac';
  const archiveFor = kind => join(out, kind === 'app' ? 'app-notary-upload.zip' : `Vonvon-Bot-0.7.0-${arch}.dmg`);
  const artifactRecord = async path => {
    const bytes = await readFile(path);
    return { file: basename(path), size: bytes.length, sha256: sha256(bytes) };
  };
  // settings.realTools runs the real desktop-release-tools checks, which read these files.
  const populateApp = async app => {
    if (!settings.realTools) return;
    const core = join(app, 'Contents/Resources/daemon');
    await write(join(core, 'package.json'), JSON.stringify({ version: '0.7.0', license: 'Apache-2.0' }));
    for (const name of ['LICENSE', 'LICENSE.bridge', 'LICENSE.paseo', 'NOTICE', 'PROVENANCE.md']) await write(join(core, name), name);
    for (const path of ['Contents/MacOS/Vonvon Bot', 'Contents/Frameworks/Electron Framework.framework/Electron Framework']) await write(join(app, path), Buffer.from('cafebabe00000000', 'hex'));
  };
  const realTools = settings.realTools ? await import('./desktop-release-tools.mjs') : undefined;
  const deps = {
    platform: 'darwin', temporaryRoots: [],
    // Hermetic: the host's own TLS or COS variables never leak into the scenario.
    env: { PATH: process.env.PATH ?? '', VONVON_DESKTOP_UPDATE_CONFIG: configPath, FIXTURE_COS_SECRET_ID: 'SENTINEL-COS-ID', FIXTURE_COS_SECRET_KEY: 'SENTINEL-COS-KEY' },
    tools: realTools ? { artifactRecord, verifyUniversalApp: realTools.verifyUniversalApp, verifyDmg: realTools.verifyDmg }
      : { artifactRecord, verifyUniversalApp: async () => ({ architectures: ['arm64', 'x86_64'] }), verifyDmg: async () => {} },
    asar: { extractFile: () => Buffer.from(JSON.stringify(settings.embeddedConfig ?? config)) },
    plist: { parse: () => ({ 'system-entities': [{ 'mount-point': join(root, 'mounted-volume') }] }) },
    execFile: async (command, args, options) => {
      calls.push({ command, args: [...args], options });
      const output = { stdout: '', stderr: '' };
      if (command === 'git') {
        if (args[0] === 'rev-parse') output.stdout = sourceSHA;
        if (args[0] === 'merge-base' && settings.notOnMain) throw new Error('fixture commit is not on origin/main');
        const built = calls.some(call => call.command === 'npm');
        if (args[0] === 'status') output.stdout = settings.dirty || (settings.dirtyAfterBuild && built) ? '?? packages/ui/public/injected.txt\n' : '';
      } else if (command === 'security') {
        output.stdout = `1) ${'B'.repeat(40)} "Developer ID Application: Fixture (${config.teamIdentifier})"`;
      } else if (command === 'npm') {
        assert.equal(args.join(' '), 'run build');
        assert.equal(options.env.HOME, buildHome);
        assert.equal(options.env.VONVON_DESKTOP_UPDATE_CONFIG, configPath);
      } else if (command === process.execPath && args.includes('--input-type=module')) {
        const phase = args.at(-1);
        if (phase === 'app') {
          await mkdir(join(out, appDir, 'Vonvon Bot.app/Contents/Resources'), { recursive: true });
          await populateApp(join(out, appDir, 'Vonvon Bot.app'));
        }
        else if (phase === 'dmg') await write(archiveFor('dmg'), 'signed dmg');
        else assert.fail('Unexpected packaging phase');
      } else if (command === 'ditto') {
        if (args.includes('-c')) await write(args.at(-1), args.at(-1).includes('notary') ? 'App transport bytes' : 'stapled App ZIP bytes');
        else { await mkdir(join(args.at(-1), 'Vonvon Bot.app'), { recursive: true }); await populateApp(join(args.at(-1), 'Vonvon Bot.app')); }
      } else if (command === 'xattr') {
        if (settings.quarantineWhere === 'app' || (settings.quarantineWhere === 'zip' && args.at(-1).includes('zip-verification'))) output.stdout = `${args.at(-1)}: com.apple.quarantine\n`;
      } else if (command === 'codesign' || command === '/usr/bin/codesign') {
        if (args.includes('--entitlements')) output.stdout = '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>';
        else if (args.includes('--display')) output.stderr = `Authority=Developer ID Application: Fixture\nTeamIdentifier=${config.teamIdentifier}\nflags=0x10000(runtime)\nCDHash=${'c'.repeat(40)}\n`;
      } else if (command === '/usr/libexec/PlistBuddy') {
        output.stdout = '0.7.0\n';
      } else if (command === '/usr/bin/lipo') {
        output.stdout = arch === 'universal' ? 'x86_64 arm64\n' : arch === 'x64' ? 'x86_64\n' : 'arm64\n';
      } else if (command === 'hdiutil' && args[0] === 'attach') {
        await populateApp(join(root, 'mounted-volume', 'Vonvon Bot.app'));
      } else if (command === 'xcrun' && args[0] === 'notarytool') {
        const action = args[1];
        const kind = args[2] === submissionIDs.dmg || args[2]?.endsWith('.dmg') ? 'dmg' : 'app';
        if (action === 'history') {
          if (settings.historyFailure) throw new Error('fixture credentials rejected');
          output.stdout = JSON.stringify({ history: [] });
        } else if (action === 'submit') {
          if (settings.submitFailure === kind) throw new Error('fixture upload interrupted');
          output.stdout = JSON.stringify({ id: submissionIDs[kind] });
        } else if (action === 'wait' || action === 'info') {
          if (action === 'wait' && settings.waitFailure) throw new Error('fixture wait timeout');
          output.stdout = JSON.stringify({ status: settings.status ?? 'Accepted' });
        } else if (action === 'log') {
          output.stdout = JSON.stringify({ jobId: settings.logJobId ?? submissionIDs[kind], sha256: settings.logSHA256 ?? (await artifactRecord(archiveFor(kind))).sha256, issues: settings.issues ?? [] });
        } else assert.fail(`Unexpected notary action ${action}`);
      } else if (command === 'xcrun' && args[0] === 'stapler' && args[1] === 'staple' && args[2].endsWith('.dmg')) {
        await write(args[2], 'signed dmg with staple');
        if (settings.dmgStapleFailure) throw new Error('fixture crash immediately after staple');
      } else if (!['xattr', 'spctl', 'hdiutil', 'xcrun'].includes(command)) {
        assert.fail(`Unexpected native command ${command}`);
      }
      return output;
    },
  };
  const options = { repo, out, version: '0.7.0', sha: sourceSHA, mode: 'rehearsal', 'next-version': '0.7.0', 'keychain-profile': 'fixture-profile', 'build-home': buildHome, timeout: '1s' };
  return { root, repo, out, settings, calls, options, deps, write, writeJSON, artifactRecord, readState: async () => JSON.parse(await readFile(join(out, 'notarization-state.json'), 'utf8')), run: extra => releaseMac({ ...options, ...extra }, deps) };
}
const isSubmit = call => call.command === 'xcrun' && call.args[0] === 'notarytool' && call.args[1] === 'submit';
const isBuildOrPack = call => call.command === 'npm' || call.command === process.execPath;
const isStaple = call => call.command === 'xcrun' && call.args[0] === 'stapler' && call.args[1] === 'staple';

test('release orchestration staples the App before creating either final container and separates rehearsal metadata', async () => {
  const fixture = await releaseFixture();
  const state = await fixture.run();
  assert.equal(state.complete, true);
  const appStaple = fixture.calls.findIndex(call => isStaple(call) && call.args[2].endsWith('.app'));
  const finalZIP = fixture.calls.findIndex(call => call.command === 'ditto' && call.args.includes('-c') && call.args.at(-1).endsWith('universal.zip'));
  const finalDMG = fixture.calls.findIndex(call => call.command === process.execPath && call.args.at(-1) === 'dmg');
  assert.ok(appStaple >= 0 && finalZIP > appStaple && finalDMG > appStaple);
  const history = fixture.calls.findIndex(call => call.args[0] === 'notarytool' && call.args[1] === 'history');
  const build = fixture.calls.findIndex(call => call.command === 'npm');
  assert.ok(history >= 0 && build > history);
  assert.equal(fixture.calls.filter(isSubmit).length, 2);
  const app = join(fixture.out, 'mac-universal/Vonvon Bot.app');
  const zips = fixture.calls.filter(call => call.command === 'ditto' && call.args.includes('-c')).map(call => call.args);
  assert.deepEqual(zips, [
    ['-c', '-k', '--keepParent', app, join(fixture.out, 'app-notary-upload.zip')],
    ['-c', '-k', '--sequesterRsrc', '--noqtn', '--keepParent', app, join(fixture.out, 'Vonvon-Bot-0.7.0-universal.zip')],
  ], 'Apple transport form for notarization; the final update ZIP keeps its signature-preserving flags');
  const inventory = JSON.parse(await readFile(join(fixture.out, 'release-inventory.json'), 'utf8'));
  assert.equal(inventory.mode, 'rehearsal');
  assert.ok(inventory.files.every(record => record.file !== 'manifest.json' && !record.file.startsWith('feed-')));
  const timings = (await readFile(join(fixture.out, 'logs/timings.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(['source-build', 'app-submit', 'app-wait', 'final-dmg', 'dmg-submit', 'dmg-wait'].every(label => timings.some(item => item.label === label)));
  assert.ok(timings.every(item => item.status === 'complete' && item.seconds >= 0 && Date.parse(item.startedAt) <= Date.parse(item.completedAt)));
  assert.ok(timings.every(item => !Object.hasOwn(item, 'stdout') && !Object.hasOwn(item, 'args')));
  await readFile(join(fixture.out, 'DO-NOT-PUBLISH'));
});

test('Invalid notarization is saved and never staples the rejected App', async () => {
  const fixture = await releaseFixture({ status: 'Invalid' });
  await assert.rejects(fixture.run(), /Invalid/);
  assert.equal((await fixture.readState()).app.status, 'Invalid');
  assert.equal(fixture.calls.some(isStaple), false);
  await readFile(join(fixture.out, 'app-notary-log.json'));
});

test('unknown notarization warnings stop before stapling even when Apple accepted', async () => {
  const fixture = await releaseFixture({ issues: [{ severity: 'warning', code: 99999, path: 'Vonvon Bot.app/unknown', message: 'new unexpected warning' }] });
  await assert.rejects(fixture.run(), /warning/i);
  assert.equal(fixture.calls.some(isStaple), false);
});

test('credential preflight failure occurs before build or packaging', async () => {
  const fixture = await releaseFixture({ historyFailure: true });
  await assert.rejects(fixture.run(), /failed|credential/i);
  assert.equal(fixture.calls.some(call => call.command === 'npm' || call.command === process.execPath), false);
});

test('untracked source and mismatched stage or packaged configuration fail closed', async t => {
  for (const settings of [
    { dirty: true },
    { stageConfig: { manifestURL, teamIdentifier: 'CCCCCCCCCC' } },
    { embeddedConfig: { manifestURL, teamIdentifier: 'CCCCCCCCCC' } },
  ]) await t.test(JSON.stringify(settings), async () => {
    const fixture = await releaseFixture(settings);
    await assert.rejects(fixture.run(), /modification|untracked|configuration|config|certificate/i);
    assert.equal(fixture.calls.some(isSubmit), false);
  });
});

test('unrecorded preexisting App is preserved and rejected', async () => {
  const fixture = await releaseFixture();
  const app = join(fixture.out, 'mac-universal/Vonvon Bot.app');
  await mkdir(app, { recursive: true });
  await fixture.write(join(app, 'preserved.txt'), 'existing candidate');
  await assert.rejects(fixture.run(), /Unrecorded|nonempty|fresh output|must be empty/i);
  assert.equal(await readFile(join(app, 'preserved.txt'), 'utf8'), 'existing candidate');
  assert.equal(fixture.calls.some(isSubmit), false);
});

test('ambiguous upload is not resubmitted and recovered submission must match archive hash', async () => {
  const fixture = await releaseFixture({ submitFailure: 'app' });
  await assert.rejects(fixture.run(), /failed/i);
  const saved = await fixture.readState();
  assert.equal(saved.app.uploadAttempted, true);
  assert.equal(saved.app.id, undefined);
  fixture.settings.submitFailure = undefined;
  const before = fixture.calls.filter(isSubmit).length;
  await assert.rejects(fixture.run(), /Recover|recover/);
  assert.equal(fixture.calls.filter(isSubmit).length, before);
  fixture.settings.logSHA256 = 'f'.repeat(64);
  await assert.rejects(fixture.run({ 'recover-submission': `app=${submissionIDs.app}` }), /hash|sha.?256|bytes/i);
  assert.equal((await fixture.readState()).app.id, undefined);
  fixture.settings.logSHA256 = undefined;
  await fixture.run({ 'recover-submission': `app=${submissionIDs.app}` });
  assert.equal((await fixture.readState()).app.id, submissionIDs.app);
  assert.equal(fixture.calls.filter(isSubmit).length, before + 1, 'only the subsequent DMG is submitted');
});

test('DMG staple crash recovers the ticket and signed content without another submission', async () => {
  const fixture = await releaseFixture({ dmgStapleFailure: true });
  await assert.rejects(fixture.run(), /failed/i);
  assert.equal((await fixture.readState()).dmg.status, 'Accepted');
  const before = fixture.calls.filter(isSubmit).length;
  fixture.settings.dmgStapleFailure = false;
  assert.equal((await fixture.run()).complete, true);
  assert.equal(fixture.calls.filter(isSubmit).length, before);
});

test('completed output is reusable only while every recorded artifact still matches', async () => {
  const fixture = await releaseFixture();
  await fixture.run();
  const before = fixture.calls.filter(isSubmit).length;
  await fixture.run();
  assert.equal(fixture.calls.filter(isSubmit).length, before);
  await fixture.write(join(fixture.out, 'Vonvon-Bot-0.7.0-universal.zip'), 'tampered update');
  await assert.rejects(fixture.run(), /bytes changed|hash/i);
  assert.equal(fixture.calls.filter(isSubmit).length, before);
});


test('In Progress after wait timeout saves the ID and resumes without another App upload', async () => {
  const fixture = await releaseFixture({ status: 'In Progress', waitFailure: true });
  await assert.rejects(fixture.run(), /In Progress/);
  const state = await fixture.readState();
  assert.equal(state.app.id, submissionIDs.app);
  assert.equal(state.app.status, 'In Progress');
  assert.equal(fixture.calls.some(isStaple), false);
  assert.equal(fixture.calls.some(call => call.args[0] === 'notarytool' && call.args[1] === 'info'), true);
  fixture.settings.status = undefined;
  fixture.settings.waitFailure = false;
  assert.equal((await fixture.run()).complete, true);
  assert.equal(fixture.calls.filter(call => isSubmit(call) && !call.args[2].endsWith('.dmg')).length, 1);
});

test('quarantine on the source App or extracted final ZIP fails release verification', async t => {
  for (const quarantineWhere of ['app', 'zip']) await t.test(quarantineWhere, async () => {
    const fixture = await releaseFixture({ quarantineWhere });
    await assert.rejects(fixture.run(), /quarantine/i);
    if (quarantineWhere === 'app') assert.equal(fixture.calls.some(isSubmit), false);
    else assert.notEqual((await fixture.readState()).complete, true);
  });
});

async function formalFixture(settings = {}) {
  const fixture = await releaseFixture(settings);
  const notes = join(fixture.root, 'notes.txt');
  await fixture.write(notes, 'Test release notes');
  const cosConfig = join(fixture.root, 'cos-readonly.json');
  await fixture.writeJSON(cosConfig, { bucket: 'release-1234567890', region: 'ap-shanghai', prefix: 'bot/mac/stable/', publicManifestURL: manifestURL,
    secretIdEnv: 'FIXTURE_COS_SECRET_ID', secretKeyEnv: 'FIXTURE_COS_SECRET_KEY', ledgerFile: join(fixture.root, 'ledger.json') });
  fixture.deps.cosEvidence = { versions: [], keys: [], checkedAt: new Date().toISOString() };
  return { ...fixture, cosConfig, run: extra => releaseMac({ ...fixture.options, mode: 'release', 'notes-file': notes, 'cos-config': cosConfig, ...extra }, fixture.deps) };
}

test('explicit first release accepts only verified absence and records the empty baseline', async () => {
  const fixture = await formalFixture();
  fixture.deps.fetchImpl = async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response('Not Found', { status: 404 });
  };
  assert.equal((await fixture.run({ 'first-release': true })).baseline, 'none');
  const inventory = JSON.parse(await readFile(join(fixture.out, 'release-inventory.json'), 'utf8'));
  assert.equal(inventory.baseline, 'none');
  assert.equal(inventory.mode, 'release');
});

test('first-release gate rejects implicit absence, old COS objects, and a publication ledger', async t => {
  for (const scenario of [
    { options: {}, evidence: { versions: [], keys: [] }, error: /First release requires/ },
    { options: { 'no-live-manifest': true }, evidence: { versions: [], keys: [] }, error: /First release requires/ },
    { options: { 'first-release': true }, evidence: { versions: ['0.6.0'], keys: ['bot/mac/stable/Vonvon-Bot-0.6.0-universal.zip'] }, error: /--no-live-manifest/ },
    { options: { 'first-release': true }, evidence: { versions: ['0.6.0'], keys: ['bot/mac/stable/feed-0.6.0.json'] }, error: /--no-live-manifest/ },
    { options: { 'first-release': true }, evidence: { versions: ['0.6.0'], keys: [] }, error: /--no-live-manifest/ },
    { options: { 'first-release': true, 'no-live-manifest': true }, evidence: { versions: [], keys: [] }, error: /either/ },
  ]) await t.test(JSON.stringify(scenario), async () => {
    const fixture = await formalFixture();
    fixture.deps.fetchImpl = async () => new Response('', { status: 404 });
    fixture.deps.cosEvidence = scenario.evidence;
    await assert.rejects(fixture.run(scenario.options), scenario.error);
    assert.equal(fixture.calls.some(isBuildOrPack), false);
  });
});

const published069 = {
  keys: ['bot/mac/stable/feed-0.6.9.json', 'bot/mac/stable/Vonvon-Bot-0.6.9-universal.zip', 'bot/mac/stable/Vonvon-Bot-0.6.9-universal.dmg'],
  versions: ['0.6.9', '0.6.9', '0.6.9'],
};

test('missing manifest with COS manifest.json still listed always stops', async t => {
  for (const options of [{}, { 'first-release': true }, { 'no-live-manifest': true }]) await t.test(JSON.stringify(options), async () => {
    const fixture = await formalFixture();
    fixture.deps.fetchImpl = async () => new Response('', { status: 404 });
    fixture.deps.cosEvidence = { keys: [...published069.keys, 'bot/mac/stable/manifest.json'], versions: published069.versions };
    await assert.rejects(fixture.run(options), /still lists manifest\.json/);
    assert.equal(fixture.calls.some(isBuildOrPack), false);
  });
});

test('missing manifest with published history needs --no-live-manifest and gates above the highest version', async t => {
  for (const [name, evidence] of [['versioned COS objects', published069], ['ledger only', { keys: [], versions: ['0.6.9'] }]]) await t.test(name, async () => {
    for (const options of [{}, { 'first-release': true }]) {
      const refused = await formalFixture();
      refused.deps.fetchImpl = async () => new Response('', { status: 404 });
      refused.deps.cosEvidence = evidence;
      await assert.rejects(refused.run(options), /--no-live-manifest/);
      assert.equal(refused.calls.some(isBuildOrPack), false);
    }
    const fixture = await formalFixture();
    fixture.deps.fetchImpl = async () => new Response('', { status: 404 });
    fixture.deps.cosEvidence = evidence;
    const state = await fixture.run({ 'no-live-manifest': true });
    assert.equal(state.complete, true);
    assert.deepEqual(state.baseline, { live: 'none', highestPublished: '0.6.9' });
    const inventory = JSON.parse(await readFile(join(fixture.out, 'release-inventory.json'), 'utf8'));
    assert.deepEqual(inventory.baseline, { live: 'none', highestPublished: '0.6.9' });
    await assert.rejects(readFile(join(fixture.out, 'previous-manifest.json')), { code: 'ENOENT' });
  });
  await t.test('a fix must exceed the withdrawn first release', async () => {
    const fixture = await formalFixture();
    fixture.deps.fetchImpl = async () => new Response('', { status: 404 });
    fixture.deps.cosEvidence = { keys: ['bot/mac/stable/feed-0.7.0.json'], versions: ['0.6.9', '0.7.0'] };
    await assert.rejects(fixture.run({ 'no-live-manifest': true }), /highest previously published/);
    assert.equal(fixture.calls.some(isBuildOrPack), false);
  });
  await t.test('history without a derivable version is investigated, not ignored', async () => {
    const fixture = await formalFixture();
    fixture.deps.fetchImpl = async () => new Response('', { status: 404 });
    fixture.deps.cosEvidence = { keys: ['bot/mac/stable/archive/feed-0.9.0.json'], versions: [] };
    await assert.rejects(fixture.run({ 'no-live-manifest': true }), /no published version could be derived/);
  });
});

const liveManifest = version => new Response(JSON.stringify({ version, feedURL: new URL(`feed-${version}.json`, manifestURL).href }), { status: 200, headers: { 'content-type': 'application/json' } });

test('existing stable manifest is snapshotted, gates the version and refuses missing-manifest flags', async t => {
  await t.test('orchestration with a live manifest', async () => {
    const fixture = await formalFixture();
    fixture.deps.fetchImpl = async () => liveManifest('0.6.9');
    fixture.deps.cosEvidence = published069;
    const state = await fixture.run();
    assert.equal(state.complete, true);
    assert.equal(state.baseline, '0.6.9');
    assert.deepEqual(JSON.parse(await readFile(join(fixture.out, 'previous-manifest.json'), 'utf8')), { version: '0.6.9', feedURL: new URL('feed-0.6.9.json', manifestURL).href });
  });
  for (const options of [{ 'first-release': true }, { 'no-live-manifest': true }, {}]) await t.test(JSON.stringify(options), async () => {
    const fixture = await formalFixture();
    fixture.deps.fetchImpl = async () => liveManifest(Object.keys(options).length ? '0.6.9' : '0.7.0');
    fixture.deps.cosEvidence = published069;
    await assert.rejects(fixture.run(options), /cannot replace|requires the public stable manifest to be missing|greater than the highest/);
    assert.equal(fixture.calls.some(isBuildOrPack), false);
    await assert.rejects(readFile(join(fixture.out, 'previous-manifest.json')), { code: 'ENOENT' }, 'snapshot is written only after every gate passes');
  });
});

test('network, TLS, forbidden, server errors and redirects never become a first-release baseline', async t => {
  for (const scenario of ['network', 'TLS', 'redirect', 400, 403, 500]) await t.test(String(scenario), async () => {
    const fixture = await formalFixture();
    fixture.deps.fetchImpl = async () => {
      if (scenario === 'network' || scenario === 'TLS') throw new Error(`fixture ${scenario} failure`);
      if (scenario === 'redirect') return new Response('', { status: 302, headers: { location: 'https://example.invalid/manifest.json' } });
      return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: scenario });
    };
    await assert.rejects(fixture.run({ 'first-release': true }));
    assert.equal(fixture.calls.some(call => call.command === 'npm' || call.command === process.execPath), false);
  });
});

test('the recorded baseline is the numerically highest published version, not the first listed', async () => {
  const { validateFirstRelease } = await import('./release-mac.mjs');
  const evidence = { keys: ['bot/mac/stable/feed-0.6.9.json'], versions: ['0.6.9', '0.6.10', '0.6.2'] };
  assert.deepEqual(validateFirstRelease({ noLiveManifest: true, live: { kind: 'missing' }, evidence }), { live: 'none', highestPublished: '0.6.10' });
});

test('formal release version gate stays above every previously published version after rollback', async () => {
  assert.throws(() => checkVersionGate({ version: '0.7.1', mode: 'release', liveVersion: '0.7.0', historicalVersions: ['0.8.0'] }), /highest previously published/);
  checkVersionGate({ version: '0.8.1', mode: 'release', liveVersion: '0.7.0', historicalVersions: ['0.8.0'] });
  checkVersionGate({ version: '0.7.0', mode: 'release', firstRelease: true });
  assert.throws(() => checkVersionGate({ version: '0.7.0', mode: 'release', firstRelease: true, historicalVersions: ['0.8.0'] }));
});

test('output gate rejects temporary roots and either direction of source overlap', async () => {
  const { assertOutputLocation } = await import('./release-mac.mjs');
  assert.throws(() => assertOutputLocation('/work/source', '/work/source/output', ['/tmp']));
  assert.throws(() => assertOutputLocation('/work/source', '/work', ['/tmp']));
  assert.throws(() => assertOutputLocation('/work/source', '/tmp/evidence', ['/tmp']));
  assert.doesNotThrow(() => assertOutputLocation('/work/source', '/evidence/release', ['/tmp']));
});

test('CLI entry runs through a symlinked directory', async t => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtemp, rm, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'release-cli-'));
  assert.ok(basename(root).startsWith('release-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(dirname(fileURLToPath(import.meta.url)), join(root, 'alias'), 'dir');
  const result = spawnSync(process.execPath, [join(root, 'alias', 'release-mac.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Supply --version/);
});

test('read-only COS credentials never reach build, signing, notary or archive child processes', async () => {
  // Real desktop-release-tools, not stubs: their codesign, PlistBuddy and lipo children are checked too.
  const fixture = await formalFixture({ realTools: true });
  fixture.deps.fetchImpl = async () => liveManifest('0.6.9');
  fixture.deps.cosEvidence = published069;
  assert.equal((await fixture.run()).complete, true);
  assert.ok(fixture.calls.length > 30);
  for (const tool of ['/usr/bin/codesign', '/usr/libexec/PlistBuddy', '/usr/bin/lipo']) assert.ok(fixture.calls.some(call => call.command === tool), `${tool} ran through the recorder`);
  for (const call of fixture.calls) {
    assert.equal('FIXTURE_COS_SECRET_ID' in call.options.env || 'FIXTURE_COS_SECRET_KEY' in call.options.env, false, `${call.command} received a COS credential variable`);
    assert.equal(Object.values(call.options.env).some(value => String(value).includes('SENTINEL-COS')), false);
  }
  assert.equal(fixture.calls.find(call => call.command === 'npm').options.env.VONVON_DESKTOP_UPDATE_CONFIG, fixture.deps.env.VONVON_DESKTOP_UPDATE_CONFIG);
});

test('formal release refuses a missing or malformed COS configuration before writing evidence', async t => {
  for (const [name, extra] of [['missing', { 'cos-config': undefined }], ['relative', { 'cos-config': 'cos.json' }]]) await t.test(name, async () => {
    const fixture = await formalFixture();
    fixture.deps.fetchImpl = async () => liveManifest('0.6.9');
    await assert.rejects(fixture.run(extra), /cos-config/);
    assert.equal(fixture.calls.length, 0);
    await assert.rejects(readFile(join(fixture.out, 'logs', 'source-head.log')), { code: 'ENOENT' });
  });
});

test('TLS trust-store overrides in the release environment stop before any command', async t => {
  for (const extra of [{ NODE_EXTRA_CA_CERTS: '/fixture/ca.pem' }, { SSL_CERT_FILE: '/fixture/ca.pem' }, { SSL_CERT_DIR: '/fixture/certs' }, { NODE_OPTIONS: '--use-openssl-ca' }, { NODE_OPTIONS: '--import ./hook.mjs' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }]) await t.test(JSON.stringify(extra), async () => {
    const fixture = await formalFixture();
    Object.assign(fixture.deps.env, extra);
    fixture.deps.fetchImpl = async () => assert.fail('no request may be made');
    await assert.rejects(fixture.run(), /TLS verification/);
    assert.equal(fixture.calls.length, 0);
  });
});

test('a gate failure leaves only logs, so the same OUT reruns with corrected flags', async () => {
  const fixture = await formalFixture();
  fixture.deps.fetchImpl = async () => new Response('', { status: 404 });
  await assert.rejects(fixture.run(), /First release requires/);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(fixture.out), ['logs']);
  assert.equal((await fixture.run({ 'first-release': true })).complete, true);
  const stray = await formalFixture();
  await mkdir(join(stray.out, 'logs'), { recursive: true });
  await stray.write(join(stray.out, 'Vonvon-Bot-0.7.0-universal.zip'), 'unexplained bytes');
  await assert.rejects(stray.run({ 'first-release': true }), /must be empty/);
  assert.equal(stray.calls.length, 0);
});

test('source must stay unchanged through the build before any packaging', async () => {
  const fixture = await releaseFixture({ dirtyAfterBuild: true });
  await assert.rejects(fixture.run(), /Source changed while building/);
  assert.equal(fixture.calls.some(call => call.command === 'npm'), true);
  assert.equal(fixture.calls.some(call => call.command === process.execPath), false);
});

test('source commit must be on origin/main before any build', async () => {
  const fixture = await releaseFixture({ notOnMain: true });
  await assert.rejects(fixture.run(), /source-on-main failed/);
  assert.ok(fixture.calls.some(call => call.command === 'git' && call.args.join(' ') === `merge-base --is-ancestor ${sourceSHA} origin/main`));
  assert.equal(fixture.calls.some(isBuildOrPack), false);
});

test('build HOME must be temporary and outside both source and evidence', async t => {
  for (const [name, pick] of [
    ['outside temporary roots', () => '/release-mac-test-not-temporary/home'],
    ['the temporary root itself', () => tmpdir()],
    ['/tmp itself', () => '/tmp'],
    ['inside evidence', fixture => join(fixture.out, 'home')],
    ['inside source', fixture => join(fixture.repo, 'home')],
  ]) await t.test(name, async () => {
    const fixture = await releaseFixture();
    await assert.rejects(fixture.run({ 'build-home': pick(fixture) }), /Build HOME must be temporary/);
    assert.equal(fixture.calls.some(isBuildOrPack), false);
  });
});

test('releaseMac itself rejects evidence inside the source or a temporary root', async t => {
  await t.test('inside source', async () => {
    const fixture = await releaseFixture();
    await assert.rejects(releaseMac({ ...fixture.options, out: join(fixture.repo, 'evidence') }, fixture.deps), /persistent/);
    assert.equal(fixture.calls.length, 0);
    assert.equal(await import('node:fs/promises').then(fs => fs.access(join(fixture.repo, 'evidence')).then(() => true, () => false)), false);
  });
  await t.test('inside a temporary root', async () => {
    const fixture = await releaseFixture();
    await assert.rejects(releaseMac(fixture.options, { ...fixture.deps, temporaryRoots: [fixture.root] }), /persistent/);
    assert.equal(fixture.calls.length, 0);
  });
});

test('submission recovery requires the Apple job ID as well as the archive hash', async () => {
  const fixture = await releaseFixture({ submitFailure: 'app' });
  await assert.rejects(fixture.run(), /failed/i);
  fixture.settings.submitFailure = undefined;
  fixture.settings.logJobId = '33333333-3333-4333-8333-333333333333';
  await assert.rejects(fixture.run({ 'recover-submission': `app=${submissionIDs.app}` }), /job ID/);
  assert.equal((await fixture.readState()).app.id, undefined);
  assert.equal(fixture.calls.filter(isSubmit).length, 1, 'no blind re-upload');
});

for (const architecture of ['arm64', 'x64']) {
  test(`${architecture} candidate signs, notarizes and verifies only its own architecture`, async () => {
    const fixture = await releaseFixture({architecture, realTools: true});
    const result = await fixture.run({architecture});
    assert.equal(result.complete, true);
    assert.equal(result.context.architecture, architecture);
    const calls = fixture.calls.filter(call => call.command === process.execPath && call.args.includes('--input-type=module'));
    assert.ok(calls.every(call => call.args.at(-2) === architecture));
    assert.ok(result.files.some(file => file.file === `Vonvon-Bot-0.7.0-${architecture}.zip`));
    assert.ok(result.files.some(file => file.file === `Vonvon-Bot-0.7.0-${architecture}.dmg`));
    assert.ok(fixture.calls.some(call => call.command === 'codesign' && call.args.includes('--architecture') && call.args.includes(architecture === 'x64' ? 'x86_64' : 'arm64')));
  });
}

test('single architecture resumes an accepted notarization without submitting the App twice', async () => {
  const fixture = await releaseFixture({ architecture: 'arm64', dmgStapleFailure: true });
  await assert.rejects(fixture.run({architecture:'arm64'}), /failed/);
  const before = fixture.calls.filter(isSubmit).length;
  fixture.settings.dmgStapleFailure = false;
  assert.equal((await fixture.run({architecture:'arm64'})).complete, true);
  assert.equal(fixture.calls.filter(isSubmit).length, before);
  await assert.rejects(fixture.run({architecture:'x64'}), /different release inputs/);
});
