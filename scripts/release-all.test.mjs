import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildRelease, collectRelease, inspectRunners, jobTimings, prepareRelease, releaseStatus, runReleaseChild, windowsRunTitle, workflowLabels } from './release-all.mjs';
import { linuxInstallCommand } from './install-command.mjs';

const sha = 'a'.repeat(40), version = '1.2.3', VERSION = version, hash = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value));
const runner = { id: 17, status: 'online', busy: false, labels: ['self-hosted', 'macOS', 'ARM64', 'modelzen-macos', 'modelzen-macos-isolated'].map(name => ({ name })) };

test('release orchestrator CLI executes through a symlinked directory instead of silently exiting', async t => {
  const root = await mkdtemp(join(tmpdir(), 'release-all-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(dirname(fileURLToPath(import.meta.url)), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const script = join(root, 'alias', 'release-all.mjs');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(help.status, 0); assert.match(help.stdout, /Usage: node scripts\/release-all.mjs/);
  const invalid = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Choose prepare/);
});

test('matches inherited organization runners only through a group authorized for this repository', async () => {
  const calls = [];
  const api = async path => {
    calls.push(path);
    if (path.startsWith('repos/') && path.includes('/runners')) return { runners: [] };
    if (path === 'repos/modelzen/vonvon-bot') return { private: true };
    if (path.includes('/runner-groups/3/repositories')) return { repositories: [{ full_name: 'modelzen/vonvon-bot' }] };
    if (path.includes('/runner-groups/3/runners')) return { runners: [runner] };
    if (path.includes('/runner-groups?')) return { runner_groups: [{ id: 3, visibility: 'selected' }] };
    return { runners: [runner] };
  };
  const report = await inspectRunners(['self-hosted', 'MACOS', 'arm64'], api);
  assert.equal(report.ready, true);
  assert.equal(report.inventories[0].count, 0);
  assert.equal(report.inventories[1].count, 1);
  assert.ok(calls.some(path => path.includes('/repositories')));
  const wrongLabels = await inspectRunners(['self-hosted', 'Windows'], api);
  assert.equal(wrongLabels.ready, false);
  const noAccess = await inspectRunners(['self-hosted', 'macOS'], async path => path.includes('/runner-groups/3/repositories') ? { repositories: [] } : api(path));
  assert.equal(noAccess.ready, false);
});

test('runner API permission failures remain unknown; hosted runners do not depend on a private inventory', async () => {
  const offline = await inspectRunners(['self-hosted', 'Windows'], async () => { throw new Error('403'); });
  assert.equal(offline.ready, false);
  assert.ok(offline.inventories.every(item => item.available === false));
  const hosted = await inspectRunners(['windows-2025'], async () => { throw new Error('403'); });
  assert.equal(hosted.ready, true);
  assert.deepEqual(workflowLabels('    runs-on: [self-hosted, Windows, X64]'), ['self-hosted', 'Windows', 'X64']);
  assert.throws(() => workflowLabels('    runs-on: ${{ inputs.runner }}'));
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-orchestration-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'seed'), out = join(root, 'evidence'), config = join(root, 'update.json'), cos = join(root, 'cos.json'), notes = join(root, 'notes.md');
  await mkdir(repo);
  await save(config, { manifestURL: 'https://dl.vonvon.cc/bot/mac/stable/manifest.json', teamIdentifier: 'ABCDEFGHIJ' });
  await save(cos, { bucket: 'fixture-123', region: 'ap-shanghai', prefix: 'bot/mac/stable/', publicManifestURL: 'https://dl.vonvon.cc/bot/mac/stable/manifest.json', ledgerFile: join(root, 'ledger.json'), secretIdEnv: 'READ_ID', secretKeyEnv: 'READ_KEY' });
  await writeFile(notes, 'Release notes');
  const options = { repo, out, sha, version, 'update-config': config, 'cos-config': cos, 'notes-file': notes };
  const calls = [], remote = { run: undefined, dispatches: 0, private: true }, helpers = [];
  const state = async () => JSON.parse(await readFile(join(out, 'release-orchestration.json'), 'utf8'));
  const api = async path => {
    calls.push(['api', path]);
    if (path === 'repos/modelzen/vonvon-bot') return { private: remote.private };
    if (path.includes('/check-runs')) return { check_runs: [{ name: 'linux', status: 'in_progress', conclusion: null }] };
    if (path.includes('/jobs?')) return { jobs: [{ name: 'package', status: 'in_progress', created_at: '2026-10-28T00:00:00Z', started_at: '2026-10-28T00:01:00Z', steps: [{ name: 'Build and check source', status: 'completed', started_at: '2026-10-28T00:01:00Z', completed_at: '2026-10-28T00:06:00Z' }, { name: 'Package unsigned NSIS installer and ZIP', status: 'in_progress' }] }] };
    if (path.includes('/actions/workflows/')) return { workflow_runs: remote.run ? [remote.run] : [] };
    if (path.includes('/actions/runs/')) return remote.run;
    if (path.includes('/runners')) return { runners: [runner] };
    throw new Error(`Unexpected API ${path}`);
  };
  const execute = async (command, args, opts = {}) => {
    calls.push([command, args, opts]);
    if (command === 'git' && args[0] === 'show') {
      if (args[1].endsWith('ci.yml')) return { stdout: await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8') };
      if (args[1].endsWith('windows-release.yml')) return { stdout: 'source_sha:\nrelease_id:\n runs-on: windows-2025\n' };
      return { stdout: JSON.stringify({ version }) };
    }
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: sha };
    if (command === 'git' && args[0] === 'worktree') {
      for (const name of ['daemon', 'desktop']) { await mkdir(join(args[3], 'packages', name), { recursive: true }); await save(join(args[3], 'packages', name, 'package.json'), { version }); }
      // The Mac helper leaves the web UI built; the server build reuses it.
      if (!remote.noWebUI) { await mkdir(join(args[3], 'packages', 'ui', 'dist'), { recursive: true }); await writeFile(join(args[3], 'packages', 'ui', 'dist', 'index.html'), '<html>'); }
    }
    if (command === 'security') return { stdout: 'Developer ID Application: Fixture (ABCDEFGHIJ)' };
    if (command === 'xcrun') assert.equal(opts.env.READ_KEY, undefined);
    if (command === 'gh') {
      remote.dispatches += 1;
      const saved = await state();
      remote.run = { id: 123, event: 'workflow_dispatch', head_branch: 'main', display_title: windowsRunTitle(saved), status: 'completed', conclusion: 'success', html_url: 'https://github.com/modelzen/vonvon-bot/actions/runs/123' };
      if (remote.loseResponse) { remote.loseResponse = false; throw new Error('network response lost after dispatch'); }
    }
    return { stdout: '', stderr: '' };
  };
  const run = async (command, args, opts) => {
    helpers.push([command, args, opts]);
    if (command === 'npm') {
      assert.equal(opts.env.READ_KEY, undefined); assert.notEqual(opts.env.HOME, process.env.HOME);
      if (args[0] === 'run') { assert.deepEqual(args, ['run', 'build']); await mkdir(join(opts.cwd, 'packages', 'ui', 'dist'), { recursive: true }); await writeFile(join(opts.cwd, 'packages', 'ui', 'dist', 'index.html'), '<html>'); return; }
      await mkdir(join(opts.cwd, 'node_modules')); return;
    }
    const script = args[0], at = flag => args[args.indexOf(flag) + 1];
    if (script.endsWith('release-mac.mjs')) {
      const architecture = at('--architecture'), output = at('--out');
      await mkdir(output, { recursive: true });
      const file = `Vonvon-Bot-${version}-${architecture}.dmg`;
      await writeFile(join(output, file), architecture);
      await save(join(output, 'notarization-state.json'), { context: { version, sourceCommit: sha, architecture }, complete: true,
        files: [{ file, sha256: hash(architecture) }], app: { id: 'existing-app-id', status: 'Accepted' }, dmg: { id: 'existing-dmg-id', status: 'Accepted' } });
      if (remote.cancelAfterArm64 && architecture === 'arm64') await writeFile(join(out, 'CANCEL'), 'stop');
      if (remote.failWindowsAfterArm64 && architecture === 'arm64') remote.run.conclusion = 'failure';
    } else if (script.endsWith('assemble-split-release.mjs')) {
      await mkdir(at('--out')); await writeFile(join(at('--out'), 'SHA256SUMS'), 'fixture');
      if (remote.failWindowsAfterAssembly) remote.run.conclusion = 'failure';
    } else if (script.endsWith('build-server.mjs')) {
      assert.equal(opts.env.READ_KEY, undefined); assert.notEqual(opts.env.HOME, process.env.HOME);
      // The orchestrator canonicalizes the output: on macOS the temporary root /var/folders is /private/var/folders (#667 macOS CI)
      const canonicalOut = await realpath(out);
      assert.equal(at('--targets'), 'linux-x64,linux-arm64'); assert.equal(at('--out'), join(canonicalOut, 'server')); assert.equal(at('--node-cache'), join(canonicalOut, 'node-cache'));
      await remote.serverBuild?.();
      await mkdir(at('--out'), { recursive: true });
      const files = {};
      for (const target of ['linux-x64', 'linux-arm64']) {
        const name = `vonvon-server-${remote.serverVersion ?? version}-${target}.tar.gz`, body = Buffer.from(name);
        await writeFile(join(at('--out'), name), body);
        files[target] = { name, size: body.length, sha256: hash(body), sha512: createHash('sha512').update(body).digest('hex') };
      }
      await save(join(at('--out'), `vonvon-server-${version}-build.json`), { version: remote.serverVersion ?? version, sourceHead: sha, sourceDirty: false, updateKey: 'release', files });
    } else if (script.endsWith('publish-windows.mjs')) {
      assert.ok(args.includes('--download-only')); assert.equal(at('--sha'), sha); assert.equal(at('--version'), version);
      await mkdir(at('--out'), { recursive: true });
      await save(join(at('--out'), 'github-build.json'), { sourceSha: sha, runId: 123 });
    } else throw new Error('Unexpected helper');
  };
  const dependencies = { execute, run, api, env: { READ_ID: 'private', READ_KEY: 'private', HOME: process.env.HOME }, platform: 'darwin', temporaryRoots: [],
    fetchImpl: async () => new Response(JSON.stringify({ version: '1.2.2', feedURL: 'https://dl.vonvon.cc/bot/mac/stable/feed-1.2.2.json' }), { headers: { 'content-type': 'application/json' } }), cosEvidence: { keys: [], versions: ['1.2.2'] },
    createTemporary: () => mkdtemp(join(root, 'source-temp-')), buildLockPath: join(root, 'build.lock'), progressMs: 0, log: () => {},
    validateCombined: async (path, input) => { assert.equal(input.sha, sha); assert.equal(input.version, version); await readFile(join(path, 'SHA256SUMS')); } };
  return { root, options, dependencies, calls, remote, helpers, state };
}

test('prepare fixes immutable inputs, checks both runner scopes, and never builds or submits', async t => {
  const h = await fixture(t), saved = await prepareRelease(h.options, h.dependencies);
  assert.equal(saved.sha, sha); assert.equal(saved.version, version);
  assert.equal(saved.windows.dispatch, 'not-requested');
  assert.equal(h.remote.dispatches, 0); assert.equal(h.helpers.length, 0);
  assert.ok(h.calls.some(call => call[1]?.includes?.('orgs/modelzen/actions/runners?per_page=100')));
  assert.equal(saved.ciRunners[0]?.kind, 'self-hosted');
  assert.equal(saved.ciRunners[0]?.ready, true);
  assert.equal(h.calls.filter(call => call[0] === 'xcrun').length, 1);
  await assert.rejects(prepareRelease(h.options, h.dependencies), /must be empty/);
});

test('public release preparation skips the private macOS runner inventory', async t => {
  const h = await fixture(t);
  h.remote.private = false;
  const saved = await prepareRelease(h.options, h.dependencies);
  assert.deepEqual(saved.ciRunners, []);
  assert.equal(saved.runners.kind, 'github-hosted');
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('concurrent prepare cannot overwrite the release ID or input tuple', async t => {
  const h = await fixture(t), entered = deferred(), release = deferred();
  let blocked = false;
  const dependencies = { ...h.dependencies, api: async (...args) => {
    if (!blocked && args[0].includes('/actions/runners')) { blocked = true; entered.resolve(); await release.promise; }
    return h.dependencies.api(...args);
  } };
  const first = prepareRelease(h.options, dependencies);
  await entered.promise;
  try { await assert.rejects(prepareRelease({ ...h.options, sha: 'b'.repeat(40) }, dependencies), /lock exists/); }
  finally { release.resolve(); }
  const saved = await first;
  assert.equal((await h.state()).windows.releaseId, saved.windows.releaseId);
  assert.equal((await h.state()).sha, sha);
});

test('prepare and a second build are excluded while a build owns the same output; collect never rewrites its state', async t => {
  const h = await fixture(t), entered = deferred(), release = deferred();
  await prepareRelease(h.options, h.dependencies);
  const dependencies = { ...h.dependencies, run: async (...args) => {
    if (args[0] === 'npm') { entered.resolve(); await release.promise; }
    return h.dependencies.run(...args);
  }, execute: async (...args) => {
    const result = await h.dependencies.execute(...args);
    if (args[0] === 'gh') h.remote.run.status = 'in_progress';
    return result;
  } };
  const first = buildRelease({ out: h.options.out, 'authorize-notarization': true }, dependencies);
  await entered.promise;
  try {
    await assert.rejects(prepareRelease(h.options, h.dependencies), /lock exists/);
    await assert.rejects(buildRelease({ out: h.options.out, 'authorize-notarization': true }, h.dependencies), /lock exists/);
    const before = await readFile(join(h.options.out, 'release-orchestration.json'), 'utf8');
    await collectRelease({ out: h.options.out }, h.dependencies);
    assert.equal(await readFile(join(h.options.out, 'release-orchestration.json'), 'utf8'), before);
  } finally { release.resolve(); }
  await first;
  assert.equal(h.remote.dispatches, 1);
});

test('source versions and notarization authorization fail before any build or workflow dispatch', async t => {
  const h = await fixture(t);
  await assert.rejects(prepareRelease({ ...h.options, version: '1.2.4' }, h.dependencies), /version differs/);
  await assert.rejects(buildRelease(h.options, h.dependencies), /authorize-notarization/);
  assert.equal(h.remote.dispatches, 0); assert.equal(h.helpers.length, 0);
});

test('live and historical version gates run before spending a Windows build or Apple submission', async t => {
  const h = await fixture(t);
  await assert.rejects(prepareRelease(h.options, { ...h.dependencies, cosEvidence: { keys: [], versions: [version] } }), /highest previously published/);
  assert.equal(h.remote.dispatches, 0); assert.equal(h.helpers.length, 0);
  assert.equal(h.calls.filter(call => call[0] === 'xcrun').length, 0);
});

test('build dispatches once, serializes Mac architectures, and resume reuses complete candidates', async t => {
  const h = await fixture(t);
  const result = await buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies);
  assert.equal(result.windows.conclusion, 'success');
  const architectures = () => h.helpers.filter(call => call[1][0]?.endsWith('release-mac.mjs')).map(call => call[1][call[1].indexOf('--architecture') + 1]);
  assert.deepEqual(architectures(), ['arm64', 'x64']);
  assert.equal(h.remote.dispatches, 1);
  await buildRelease({ out: h.options.out, 'authorize-notarization': true }, h.dependencies);
  assert.equal(h.remote.dispatches, 1); assert.deepEqual(architectures(), ['arm64', 'x64']);
  assert.equal(h.helpers.filter(call => call[1][0]?.endsWith('assemble-split-release.mjs')).length, 1);
  assert.equal(result.ci[0].status, 'in_progress');
  assert.equal(result.windows.jobs[0].queuedSeconds, 60);
  assert.equal(result.windows.jobs[0].steps[0].seconds, 300);
});

test('new and resumed helper invocations use canonical source paths when the temporary root is an alias', async t => {
  const h = await fixture(t), temporary = await mkdtemp(join(h.root, 'actual-source-')), alias = join(h.root, 'source-alias');
  await symlink(temporary, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const dependencies = { ...h.dependencies, createTemporary: async () => alias };
  await buildRelease({ ...h.options, 'authorize-notarization': true }, dependencies);
  const saved = await h.state();
  assert.equal(saved.source, await realpath(saved.source));
  assert.equal(saved.buildHome, await realpath(saved.buildHome));
  for (const call of h.helpers.filter(call => call[0] !== 'npm')) assert.ok(call[1][0].startsWith(join(saved.source, 'scripts')));
  // Simulate an older saved state that retained the alias spelling before the fix.
  saved.source = join(alias, 'source'); saved.buildHome = join(alias, 'home');
  await save(join(h.options.out, 'release-orchestration.json'), saved);
  await buildRelease({ out: h.options.out, 'authorize-notarization': true }, dependencies);
  const resumed = await h.state();
  assert.equal(resumed.source, await realpath(resumed.source));
  assert.equal(resumed.buildHome, await realpath(resumed.buildHome));
  assert.ok(h.helpers.at(-1)[1][0].startsWith(join(resumed.source, 'scripts')));
});

test('a lost dispatch response is recovered by request identity, never by dispatching twice', async t => {
  const h = await fixture(t); h.remote.loseResponse = true;
  await assert.rejects(buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies), /response lost/);
  assert.equal((await h.state()).windows.dispatch, 'requested');
  await buildRelease({ out: h.options.out, 'authorize-notarization': true }, h.dependencies);
  assert.equal(h.remote.dispatches, 1);
});

test('changed inputs, cancellation and a different resume SHA stop before dispatch', async t => {
  const h = await fixture(t); await prepareRelease(h.options, h.dependencies);
  await assert.rejects(buildRelease({ out: h.options.out, sha: 'b'.repeat(40), 'authorize-notarization': true }, h.dependencies), /fixes --sha/);
  await writeFile(h.options['notes-file'], 'changed');
  await assert.rejects(buildRelease({ out: h.options.out, 'authorize-notarization': true }, h.dependencies), /notesFile changed/);
  await writeFile(h.options['notes-file'], 'Release notes'); await writeFile(join(h.options.out, 'CANCEL'), 'stop');
  await assert.rejects(buildRelease({ out: h.options.out, 'authorize-notarization': true }, h.dependencies), /stopped by CANCEL/);
  assert.equal(h.remote.dispatches, 0);
});

test('Windows failure and cancellation stop before a second Mac architecture or collection', async t => {
  const h = await fixture(t); h.remote.failWindowsAfterArm64 = true;
  await assert.rejects(buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies), /Windows run 123 failed/);
  assert.equal(h.helpers.filter(call => call[1][0]?.endsWith('release-mac.mjs')).length, 1);
  const status = await releaseStatus({ out: h.options.out }, h.dependencies);
  assert.equal(status.windows.conclusion, 'failure');
  await assert.rejects(collectRelease({ out: h.options.out }, h.dependencies), /Windows run 123 failed/);
});

test('Windows failure during Mac assembly is not hidden by an earlier successful download', async t => {
  const h = await fixture(t); h.remote.failWindowsAfterAssembly = true;
  await assert.rejects(buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies), /Windows run 123 failed/);
  assert.equal(h.helpers.filter(call => call[1][0]?.endsWith('publish-windows.mjs')).length, 1);
});

test('the local cancel marker stops at a helper boundary and does not claim remote cancellation', async t => {
  const h = await fixture(t); h.remote.cancelAfterArm64 = true;
  await assert.rejects(buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies), /Existing|existing Apple/);
  assert.equal(h.remote.run.conclusion, 'success');
  assert.equal(h.helpers.filter(call => call[1][0]?.endsWith('release-mac.mjs')).length, 1);
});

async function receipts(h, stable = false, version = VERSION) {
  const state = await h.state(), objects = ['arm64', 'x64'].map(architecture => {
    const file = `Vonvon-Bot-${version}-${architecture}.dmg`;
    return { file, url: `https://dl.vonvon.cc/bot/mac/stable/${file}`, size: 10, sha256: hash(file) };
  });
  const mac = { version, sourceCommit: sha, planSHA256: 'c'.repeat(64), versionedVerification: { versionedObjectsVerified: true }, objects };
  await save(join(state.macRelease, 'upload-receipt.json'), mac);
  if (stable) await save(join(state.macRelease, 'publish-receipt.json'), { ...mac, status: 'published', publicVerification: { publiclyVerified: true } });
  await save(join(h.options.out, 'windows', 'windows-publish-receipt.json'), { version, sourceSha: sha, architecture: 'x64+arm64', signed: false, updatesEnabled: false,
    objects: ['x64', 'arm64'].flatMap(arch => [`Vonvon-Bot-Setup-${version}-${arch}.exe`, `Vonvon-Bot-${version}-windows-${arch}.zip`]).map(file => ({ file, url: `https://dl.vonvon.cc/bot/windows/${version}/${file}`, bytes: 20, sha256: hash(file) })) });
}

/** The server's part of a published 1.2.3 release: both receipts, the stable one bound to the publication plan (written when there is none). */
async function serverReceipts(h, version = VERSION) {
  const planPath = join(h.options.out, 'publication-plan.json');
  if (!(await readFile(planPath).catch(() => undefined))) await save(planPath, { format: 1, candidate: { server: { version } } });
  const objects = ['linux-x64', 'linux-arm64'].map(target => { const file = `vonvon-server-${version}-${target}.tar.gz`; return { file, url: `https://dl.vonvon.cc/bot/server/${version}/${file}`, bytes: 10, sha256: hash(file) }; });
  await save(join(h.options.out, 'server', 'server-publish-receipt.json'), { version, sourceSha: sha, objects });
  await save(join(h.options.out, 'server', 'server-stable-receipt.json'), { version, sourceSha: sha, planSHA256: hash(await readFile(planPath)), status: 'published' });
}

test('website handoff requires matching public receipts for both platforms and verified stable', async t => {
  const h = await fixture(t); await buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies);
  assert.equal((await collectRelease({ out: h.options.out }, h.dependencies)).readyForWebsite, false);
  await receipts(h);
  const held = await collectRelease({ out: h.options.out }, h.dependencies);
  assert.equal(held.readyForWebsite, false); assert.equal(held.downloads.length, 4);
  await receipts(h, true); await serverReceipts(h);
  const ready = await collectRelease({ out: h.options.out }, h.dependencies);
  assert.equal(ready.readyForWebsite, true);
  assert.equal(ready.sourceSha, sha);
  const saved = await h.state();
  const wrong = JSON.parse(await readFile(join(saved.macRelease, 'publish-receipt.json'), 'utf8')); wrong.sourceCommit = 'b'.repeat(40);
  await save(join(saved.macRelease, 'publish-receipt.json'), wrong);
  await assert.rejects(collectRelease({ out: h.options.out }, h.dependencies), /source SHA differs/);
});

test('job timing preserves queued, test and package stages and leaves ongoing duration unknown', () => {
  const result = jobTimings([{ name: 'package', status: 'queued', steps: [{ name: 'Package', status: 'in_progress' }] }]);
  assert.equal(result[0].seconds, null); assert.equal(result[0].queuedSeconds, null);
  assert.equal(result[0].steps[0].seconds, null);
});

test('dual Windows handoff requires both native Setup packages and omits ZIP choices', async t => {
  const h = await fixture(t); await buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies); await receipts(h, true); await serverReceipts(h);
  const file = join(h.options.out, 'windows', 'windows-publish-receipt.json');
  const receipt = JSON.parse(await readFile(file, 'utf8')); receipt.architecture = 'x64';
  await save(file, receipt);
  await assert.rejects(collectRelease({ out: h.options.out }, h.dependencies), /must cover both/);
  receipt.architecture = 'x64+arm64';
  receipt.objects = receipt.objects.filter(object => !object.file.includes('arm64'));
  await save(file, receipt);
  await assert.rejects(collectRelease({ out: h.options.out }, h.dependencies), /Windows receipt lacks/);
  for (const name of [`Vonvon-Bot-Setup-${version}-arm64.exe`, `Vonvon-Bot-${version}-windows-arm64.zip`])
    receipt.objects.push({ file: name, url: `https://dl.vonvon.cc/bot/windows/${version}/${name}`, bytes: 20, sha256: hash(name) });
  await save(file, receipt);
  const result = await collectRelease({ out: h.options.out }, h.dependencies);
  assert.equal(result.readyForWebsite, true); assert.equal(result.downloads.length, 4);
  assert.equal(result.downloads.filter(item => item.platform === 'windows' && item.architecture === 'arm64').length, 1);
});

test('Windows artifact download overlaps a running Mac helper and persists both concurrent completions', { timeout: 3000 }, async t => {
  const h = await fixture(t), downloadStarted = deferred();
  const reference = performance.now();
  for (const milliseconds of [50, 50, 80]) await new Promise(done => setTimeout(done, milliseconds));
  const sequentialMs = performance.now() - reference;
  const started = performance.now();
  const dependencies = { ...h.dependencies, windowsPollMs: 2, execute: async (...args) => {
    const result = await h.dependencies.execute(...args);
    if (args[0] === 'gh') h.remote.run.status = 'in_progress';
    return result;
  }, run: async (...args) => {
    const script = args[1][0];
    if (script?.endsWith('release-mac.mjs')) {
      if (args[1].includes('arm64')) {
        h.remote.run.status = 'completed';
        // The old scheduler cannot reach downloadStarted while this helper runs.
        await downloadStarted.promise;
      }
      await new Promise(done => setTimeout(done, 50));
      return h.dependencies.run(...args);
    }
    if (script?.endsWith('publish-windows.mjs')) {
      downloadStarted.resolve();
      await new Promise(done => setTimeout(done, 80));
    }
    return h.dependencies.run(...args);
  } };
  await buildRelease({ ...h.options, 'authorize-notarization': true }, dependencies);
  const saved = await h.state(), download = saved.timings.find(item => item.phase.startsWith('windows artifact'));
  const arm64 = saved.timings.find(item => item.phase.startsWith('mac-arm64'));
  assert.ok(Date.parse(download.startedAt) < Date.parse(arm64.completedAt));
  assert.equal(saved.windows.download, 'verified');
  assert.deepEqual(saved.timings.map(item => item.status), Array(saved.timings.length).fill('complete'));
  assert.equal(saved.mac.arm64, 'complete'); assert.equal(saved.mac.x64, 'complete');
  t.diagnostic(`Synthetic two 50 ms Mac waits + 80 ms download: sequential ${Math.round(sequentialMs)} ms; orchestrated overlap ${Math.round(performance.now() - started)} ms. Ordering, not timing ratios, is asserted.`);
});

test('a failed background download stops at the Mac boundary and resume reuses Apple work', { timeout: 3000 }, async t => {
  const h = await fixture(t), macStarted = deferred(), failed = deferred();
  const dependencies = { ...h.dependencies, run: async (...args) => {
    if (args[1][0]?.endsWith('publish-windows.mjs')) { await macStarted.promise; failed.resolve(); throw new Error('artifact verification failed'); }
    if (args[1][0]?.endsWith('release-mac.mjs')) { macStarted.resolve(); await failed.promise; }
    return h.dependencies.run(...args);
  } };
  await assert.rejects(buildRelease({ ...h.options, 'authorize-notarization': true }, dependencies), /artifact verification failed/);
  assert.equal((await h.state()).windows.download, 'failed-or-interrupted');
  assert.deepEqual(h.helpers.filter(call => call[1][0]?.endsWith('release-mac.mjs')).map(call => call[1][call[1].indexOf('--architecture') + 1]), ['arm64']);
  await buildRelease({ out: h.options.out, 'authorize-notarization': true }, h.dependencies);
  assert.equal(h.remote.dispatches, 1);
  assert.deepEqual(h.helpers.filter(call => call[1][0]?.endsWith('release-mac.mjs')).map(call => call[1][call[1].indexOf('--architecture') + 1]), ['arm64', 'x64']);
  assert.equal((await h.state()).windows.download, 'verified');
});

test('CANCEL aborts the active background download and joins it before returning', { timeout: 3000 }, async t => {
  const h = await fixture(t), downloadStarted = deferred(), stopped = deferred();
  let active = false;
  const dependencies = { ...h.dependencies, cancelPollMs: 2, run: async (...args) => {
    if (args[1][0]?.endsWith('publish-windows.mjs')) {
      active = true; downloadStarted.resolve();
      try { await new Promise((_, reject) => args[2].signal.addEventListener('abort', () => reject(args[2].signal.reason), { once: true })); }
      finally { active = false; stopped.resolve(); }
    }
    if (args[1][0]?.endsWith('release-mac.mjs')) {
      await downloadStarted.promise;
      await writeFile(join(h.options.out, 'CANCEL'), 'stop');
      await stopped.promise;
    }
    return h.dependencies.run(...args);
  } };
  await assert.rejects(buildRelease({ ...h.options, 'authorize-notarization': true }, dependencies), /CANCEL/);
  assert.equal(active, false);
  assert.equal((await h.state()).windows.download, 'failed-or-interrupted');
  assert.equal(h.helpers.filter(call => call[1][0]?.endsWith('release-mac.mjs')).length, 1);
});

test('a Mac helper failure aborts and joins a download already in progress', { timeout: 3000 }, async t => {
  const h = await fixture(t), downloadStarted = deferred();
  let joined = false;
  const dependencies = { ...h.dependencies, run: async (...args) => {
    if (args[1][0]?.endsWith('publish-windows.mjs')) {
      downloadStarted.resolve();
      try { await new Promise((_, reject) => args[2].signal.addEventListener('abort', () => reject(new Error('download aborted')), { once: true })); }
      finally { joined = true; }
    }
    if (args[1][0]?.endsWith('release-mac.mjs')) { await downloadStarted.promise; throw new Error('Mac helper failed'); }
    return h.dependencies.run(...args);
  } };
  await assert.rejects(buildRelease({ ...h.options, 'authorize-notarization': true }, dependencies), /Mac helper failed/);
  assert.equal(joined, true);
});

test('a queued Windows run returns pending after Mac completion without leaving a polling task', { timeout: 3000 }, async t => {
  const h = await fixture(t);
  const dependencies = { ...h.dependencies, windowsPollMs: 100000, execute: async (...args) => {
    const result = await h.dependencies.execute(...args);
    if (args[0] === 'gh') h.remote.run.status = 'queued';
    return result;
  } };
  const result = await buildRelease({ ...h.options, 'authorize-notarization': true }, dependencies);
  assert.equal(result.windows.status, 'queued');
  assert.equal(h.helpers.filter(call => call[1][0]?.endsWith('publish-windows.mjs')).length, 0);
  const saved = await h.state(); assert.equal(saved.mac.phase, 'candidate-complete');
});

test('aborting a release child terminates its process group, including a TERM-resistant grandchild', { timeout: 5000, skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'release-child-cancel-')), pidFile = join(root, 'pids.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const grandchild = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.ppid,child:process.pid}));setInterval(()=>{},1000);`;
  const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const work = runReleaseChild(process.execPath, ['-e', script], { cwd: root, env: process.env, signal: controller.signal });
  let pids;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { pids = JSON.parse(await readFile(pidFile, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(done => setTimeout(done, 5)); }
  }
  assert.ok(pids, 'child process must reach its ready marker');
  controller.abort();
  await assert.rejects(work, /stopped/);
  for (const pid of Object.values(pids)) {
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
      try { process.kill(pid, 0); await new Promise(done => setTimeout(done, 5)); }
      catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
    }
    assert.equal(alive, false, `spawned process ${pid} survived cancellation`);
  }
});


test('update-capable installers do not advertise application updates until both stable feeds are verified', async t => {
  const h = await fixture(t); await buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies); await receipts(h, true);
  const file = join(h.options.out, 'windows', 'windows-publish-receipt.json');
  const receipt = JSON.parse(await readFile(file, 'utf8')); receipt.updatesEnabled = true; receipt.objects = receipt.objects.filter(item => item.file.endsWith('.exe'));
  await save(file, receipt);
  const held = await collectRelease({ out: h.options.out }, h.dependencies);
  assert.equal(held.readyForWebsite, false); assert.equal(held.windows.updatesEnabled, false);
  const updateReceipt = { status: 'published', version, sourceSha: sha, updatesEnabled: true, feeds: ['x64', 'arm64'].map(architecture => ({ architecture,
    url: `https://dl.vonvon.cc/bot/windows/stable/${architecture}/update.json`, bytes: 100, sha256: hash(architecture) })) };
  const planFile = join(h.options.out, 'publication-plan.json');
  await save(planFile, {format:1,candidate:{version,sourceSha:sha,windows:{updates:updateReceipt.feeds}}});
  updateReceipt.planSHA256 = hash(await readFile(planFile));
  await save(join(h.options.out, 'windows', 'windows-update-publish-receipt.json'), updateReceipt);
  await serverReceipts(h);
  const ready = await collectRelease({ out: h.options.out }, h.dependencies);
  assert.equal(ready.readyForWebsite, true); assert.equal(ready.windows.updatesEnabled, true);
  for (const change of [
    {...updateReceipt,planSHA256:'a'.repeat(64)},
    {...updateReceipt,feeds:updateReceipt.feeds.map((feed,index)=>index ? feed : {...feed,sha256:'b'.repeat(64)})},
    {...updateReceipt,feeds:updateReceipt.feeds.map((feed,index)=>index ? feed : {...feed,bytes:101})},
  ]) {
    await save(join(h.options.out,'windows','windows-update-publish-receipt.json'),change);
    await assert.rejects(collectRelease({out:h.options.out},h.dependencies),/reviewed publication plan/);
  }
});

test('build makes the two Linux server packages after both Mac architectures; resume reuses them; status lists them', async t => {
  const h = await fixture(t);
  await buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies);
  const order = h.helpers.filter(call => call[0] !== 'npm').map(call => call[1][0].split('/').at(-1));
  assert.deepEqual(order.filter(name => name !== 'publish-windows.mjs'), ['release-mac.mjs', 'release-mac.mjs', 'build-server.mjs', 'assemble-split-release.mjs']);
  const saved = await h.state();
  assert.equal(saved.server.phase, 'complete');
  assert.equal(h.helpers.some(call => call[0] === 'npm' && call[1][0] === 'run'), false, 'the web UI the Mac helper built is reused');
  await buildRelease({ out: h.options.out, 'authorize-notarization': true }, h.dependencies);
  assert.equal(h.helpers.filter(call => call[1][0]?.endsWith('build-server.mjs')).length, 1);
  const status = await releaseStatus({ out: h.options.out }, h.dependencies);
  assert.equal(status.server.phase, 'complete');
  assert.equal(status.server.required, true, '1.2.3 is a three-platform release');
  assert.deepEqual(status.server.packages.map(item => item.file), [`vonvon-server-${version}-linux-x64.tar.gz`, `vonvon-server-${version}-linux-arm64.tar.gz`]);
});

test('a failed or mismatched server build stops before assembly and is retried on resume', async t => {
  const h = await fixture(t);
  h.remote.serverBuild = async () => { throw new Error('build-server failed'); };
  await assert.rejects(buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies), /build-server failed/);
  assert.equal((await h.state()).server.phase, 'failed-or-interrupted');
  assert.equal(h.helpers.some(call => call[1][0]?.endsWith('assemble-split-release.mjs')), false);
  h.remote.serverBuild = undefined; h.remote.serverVersion = '1.2.4';
  await assert.rejects(buildRelease({ out: h.options.out, 'authorize-notarization': true }, h.dependencies), /different release inputs|differs from the product version/);
  h.remote.serverVersion = undefined;
  await rm(join(h.options.out, 'server'), { recursive: true });
  await buildRelease({ out: h.options.out, 'authorize-notarization': true }, h.dependencies);
  assert.equal((await h.state()).server.phase, 'complete');
  assert.equal(h.helpers.filter(call => call[1][0]?.endsWith('release-mac.mjs')).length, 2, 'Apple work is not repeated');
  // Bytes changed after the build are refused, not rebuilt over.
  await writeFile(join(h.options.out, 'server', `vonvon-server-${version}-linux-x64.tar.gz`), 'changed');
  await assert.rejects(buildRelease({ out: h.options.out, 'authorize-notarization': true }, h.dependencies), /changed after the build/);
});

test('a resumed source without the built web UI builds it before the server packages', async t => {
  const h = await fixture(t);
  h.remote.noWebUI = true;
  await buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies);
  const names = h.helpers.map(call => call[0] === 'npm' ? `npm ${call[1][0]}` : call[1][0].split('/').at(-1));
  assert.ok(names.indexOf('npm run') >= 0 && names.indexOf('npm run') < names.indexOf('build-server.mjs'));
});

test('before 0.9.0 the website handoff waits for the server stable only when the reviewed plan has the server', async t => {
  const h = await fixture(t); await buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies);
  // The same output as a release before 0.9.0, when a release without cos-server.json was macOS and Windows only.
  const legacy = '0.8.3', state = await h.state();
  await save(join(h.options.out, 'release-orchestration.json'), { ...state, version: legacy });
  h.remote.run.display_title = windowsRunTitle({ ...state, version: legacy });
  await receipts(h, true, legacy);
  const status = await releaseStatus({ out: h.options.out }, h.dependencies);
  assert.equal(status.server.required, false);
  const plain = await collectRelease({ out: h.options.out }, h.dependencies);
  assert.equal(plain.readyForWebsite, true); assert.equal(plain.server, null); assert.equal(plain.evidence.server, null);
  await save(join(h.options.out, 'publication-plan.json'), { format: 1, candidate: { server: { version: legacy } } });
  const waiting = await collectRelease({ out: h.options.out }, h.dependencies);
  assert.equal(waiting.readyForWebsite, false); assert.deepEqual([waiting.server.published, waiting.server.stableVerified], [false, false]);
});

test('from 0.9.0 the website handoff always waits for the server stable, even when the plan left the server out', async t => {
  const h = await fixture(t); await buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies); await receipts(h, true);
  const plain = await collectRelease({ out: h.options.out }, h.dependencies);
  assert.equal(plain.readyForWebsite, false, 'macOS and Windows alone are not a 1.2.3 release');
  assert.deepEqual([plain.server.published, plain.server.stableVerified], [false, false]);
  assert.equal(plain.evidence.server, join(h.options.out, 'server', 'server-stable-receipt.json'));
  const planPath = join(h.options.out, 'publication-plan.json');
  // A plan without the server (made before the rule) does not let the handoff skip it either.
  await save(planPath, { format: 1, candidate: { server: null } });
  assert.equal((await collectRelease({ out: h.options.out }, h.dependencies)).readyForWebsite, false);
  await save(planPath, { format: 1, candidate: { server: { version } } });
  const waiting = await collectRelease({ out: h.options.out }, h.dependencies);
  assert.equal(waiting.readyForWebsite, false); assert.deepEqual([waiting.server.published, waiting.server.stableVerified], [false, false]);
  const objects = ['linux-x64', 'linux-arm64'].map(target => { const file = `vonvon-server-${version}-${target}.tar.gz`; return { file, url: `https://dl.vonvon.cc/bot/server/${version}/${file}`, bytes: 10, sha256: hash(file) }; });
  await save(join(h.options.out, 'server', 'server-publish-receipt.json'), { version, sourceSha: sha, objects });
  const planSHA256 = hash(await readFile(planPath));
  await save(join(h.options.out, 'server', 'server-stable-receipt.json'), { version, sourceSha: sha, planSHA256: '0'.repeat(64), status: 'published' });
  assert.equal((await collectRelease({ out: h.options.out }, h.dependencies)).readyForWebsite, false, 'a stable receipt for another plan does not count');
  await save(join(h.options.out, 'server', 'server-stable-receipt.json'), { version, sourceSha: sha, planSHA256, status: 'published' });
  const ready = await collectRelease({ out: h.options.out }, h.dependencies);
  assert.equal(ready.readyForWebsite, true);
  assert.equal(ready.server.installCommand, await linuxInstallCommand());
  assert.match(ready.server.installCommand, /^sh <<'VONVON_INSTALL'\n/);
  assert.match(ready.server.installCommand, /domestic='https:\/\/dl\.vonvon\.cc\/bot\/server'/);
  assert.match(ready.server.installCommand, /global='https:\/\/vonvon-linux-download\.amber2clay\.workers\.dev\/bot\/server'/);
  assert.equal(ready.evidence.linuxInstallCommand, join(h.options.out, 'linux-install-command.sh'));
  assert.equal(await readFile(ready.evidence.linuxInstallCommand, 'utf8'), ready.server.installCommand);
  assert.deepEqual(ready.server.packages.map(item => item.target), ['linux-x64', 'linux-arm64']);
  assert.equal(ready.downloads.some(item => item.platform === 'server'), false, 'the website download list stays macOS and Windows');
  objects[1].url = 'https://example.com/elsewhere';
  await save(join(h.options.out, 'server', 'server-publish-receipt.json'), { version, sourceSha: sha, objects });
  await assert.rejects(collectRelease({ out: h.options.out }, h.dependencies), /Server receipt lacks/);
});

test('website handoff with an R2 plan waits for matching stable mirror verification and rejects contradictory receipts', async t => {
  const h = await fixture(t); await buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies); await receipts(h, true);
  const mirror = 'https://vonvon-linux-download.amber2clay.workers.dev/bot/server';
  const stable = ['install.sh', 'uninstall.sh', 'stable-manifest.json'].map(file => ({ file, url: `${mirror}/${file === 'stable-manifest.json' ? 'stable/manifest.json' : file}`, bytes: 10, sha256: hash(file) }));
  const plan = { version, sourceSha: sha, stable };
  const nestedHash = hash(`${JSON.stringify(plan, null, 2)}\n`);
  const planPath = join(h.options.out, 'publication-plan.json');
  await save(planPath, { format: 1, candidate: { server: { version }, r2: { plan, planSHA256: nestedHash } } });
  await serverReceipts(h);
  const missing = await collectRelease({ out: h.options.out }, h.dependencies);
  assert.equal(missing.readyForWebsite, false); assert.equal(missing.server.mirrorVerified, false);
  const file = join(h.options.out, 'server', 'r2-stable-receipt.json');
  const receipt = { schemaVersion: 1, status: 'verified', version, sourceSha: sha, mode: 'stable', planSHA256: nestedHash, publicationPlanSHA256: hash(await readFile(planPath)), verification: stable };
  for (const status of ['sync-started', 'failed']) {
    await save(file, { ...receipt, status });
    assert.equal((await collectRelease({ out: h.options.out }, h.dependencies)).readyForWebsite, false);
  }
  await save(file, receipt);
  const ready = await collectRelease({ out: h.options.out }, h.dependencies);
  assert.equal(ready.readyForWebsite, true); assert.equal(ready.server.mirrorVerified, true); assert.equal(ready.evidence.r2, file);
  for (const change of [
    { publicationPlanSHA256: '0'.repeat(64) }, { planSHA256: '0'.repeat(64) }, { version: '1.2.2' }, { sourceSha: '0'.repeat(40) },
    { verification: stable.slice(1) }, { verification: [stable[0], stable[0], stable[2]] },
    { verification: stable.map((object, index) => index ? object : { ...object, sha256: '0'.repeat(64) }) },
    { verification: stable.map((object, index) => index ? object : { ...object, url: 'https://wrong.example/install.sh' }) },
  ]) {
    await save(file, { ...receipt, ...change });
    await assert.rejects(collectRelease({ out: h.options.out }, h.dependencies), /R2 stable receipt differs/);
  }
});
