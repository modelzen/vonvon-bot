import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildRelease, collectRelease, inspectRunners, jobTimings, prepareRelease, releaseStatus, windowsRunTitle, workflowLabels } from './release-all.mjs';

const sha = 'a'.repeat(40), version = '1.2.3', hash = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value));
const runner = { id: 17, status: 'online', busy: false, labels: ['self-hosted', 'macOS', 'ARM64', 'modelzen-macos', 'modelzen-macos-isolated'].map(name => ({ name })) };

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
  const calls = [], remote = { run: undefined, dispatches: 0 }, helpers = [];
  const state = async () => JSON.parse(await readFile(join(out, 'release-orchestration.json'), 'utf8'));
  const api = async path => {
    calls.push(['api', path]);
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
      if (args[1].endsWith('ci.yml')) return { stdout: ' runs-on: [self-hosted, macOS, ARM64, modelzen-macos, modelzen-macos-isolated]' };
      if (args[1].endsWith('windows-release.yml')) return { stdout: 'source_sha:\nrelease_id:\n runs-on: windows-2025\n' };
      return { stdout: JSON.stringify({ version }) };
    }
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: sha };
    if (command === 'git' && args[0] === 'worktree') {
      for (const name of ['daemon', 'desktop']) { await mkdir(join(args[3], 'packages', name), { recursive: true }); await save(join(args[3], 'packages', name, 'package.json'), { version }); }
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
    if (command === 'npm') { assert.equal(opts.env.READ_KEY, undefined); assert.notEqual(opts.env.HOME, process.env.HOME); await mkdir(join(opts.cwd, 'node_modules')); return; }
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
  assert.equal(h.calls.filter(call => call[0] === 'xcrun').length, 1);
  await assert.rejects(prepareRelease(h.options, h.dependencies), /must be empty/);
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

test('Windows failure during Mac assembly returns failure and does not download or report candidate success', async t => {
  const h = await fixture(t); h.remote.failWindowsAfterAssembly = true;
  await assert.rejects(buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies), /Windows run 123 failed/);
  assert.equal(h.helpers.filter(call => call[1][0]?.endsWith('publish-windows.mjs')).length, 0);
});

test('the local cancel marker stops at a helper boundary and does not claim remote cancellation', async t => {
  const h = await fixture(t); h.remote.cancelAfterArm64 = true;
  await assert.rejects(buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies), /Existing|existing Apple/);
  assert.equal(h.remote.run.conclusion, 'success');
  assert.equal(h.helpers.filter(call => call[1][0]?.endsWith('release-mac.mjs')).length, 1);
});

async function receipts(h, stable = false) {
  const state = await h.state(), objects = ['arm64', 'x64'].map(architecture => {
    const file = `Vonvon-Bot-${version}-${architecture}.dmg`;
    return { file, url: `https://dl.vonvon.cc/bot/mac/stable/${file}`, size: 10, sha256: hash(file) };
  });
  const mac = { version, sourceCommit: sha, planSHA256: 'c'.repeat(64), versionedVerification: { versionedObjectsVerified: true }, objects };
  await save(join(state.macRelease, 'upload-receipt.json'), mac);
  if (stable) await save(join(state.macRelease, 'publish-receipt.json'), { ...mac, status: 'published', publicVerification: { publiclyVerified: true } });
  await save(join(h.options.out, 'windows', 'windows-publish-receipt.json'), { version, sourceSha: sha, signed: false, updatesEnabled: false,
    objects: [`Vonvon-Bot-Setup-${version}-x64.exe`, `Vonvon-Bot-${version}-windows-x64.zip`].map(file => ({ file, url: `https://dl.vonvon.cc/bot/windows/${version}/${file}`, bytes: 20, sha256: hash(file) })) });
}

test('website handoff requires matching public receipts for both platforms and verified stable', async t => {
  const h = await fixture(t); await buildRelease({ ...h.options, 'authorize-notarization': true }, h.dependencies);
  assert.equal((await collectRelease({ out: h.options.out }, h.dependencies)).readyForWebsite, false);
  await receipts(h);
  const held = await collectRelease({ out: h.options.out }, h.dependencies);
  assert.equal(held.readyForWebsite, false); assert.equal(held.downloads.length, 4);
  await receipts(h, true);
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
