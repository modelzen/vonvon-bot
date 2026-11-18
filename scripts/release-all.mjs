import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertOutputLocation, canonicalPath, checkVersionGate, compareVersions, validateConfig, validateFirstRelease } from './release-mac.mjs';
import { cosCredentialEnvNames, readCosConfig, readCosReleaseEvidence } from './release-cos-evidence.mjs';
import { checkedProductVersion } from './product-version.mjs';
import { STABLE_RECEIPT, UPLOAD_RECEIPT } from './publish-server.mjs';
import { PUBLISHED_TARGETS, SERVER_BASE_URL, archiveName, serverRequired } from './server-constants.mjs';
import { linuxInstallCommand } from './install-command.mjs';
import { assertSecureTransport, readStableManifest, validateReleaseInventory } from './verify-public-release.mjs';

const repository = 'modelzen/vonvon-bot', workflow = 'windows-release.yml';
const stateName = 'release-orchestration.json';
const exec = promisify(execFile);
const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => access(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const inside = (parent, child) => { const path = relative(parent, child); return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)); };
const redact = value => String(value).replace(/\/Users\/[^/\s"']+/g, '/Users/<u>');
async function atomicJSON(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, json(value), { mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function ghAPI(path, env, paginate = false) {
  const args = ['api', path, ...(paginate ? ['--paginate', '--slurp'] : [])];
  return JSON.parse((await exec('gh', args, { env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout);
}
const pages = (value, key) => (Array.isArray(value) ? value : [value]).flatMap(page => page[key] ?? []);
function runtime(dependencies = {}) {
  const env = dependencies.env ?? process.env;
  return { env, execute: dependencies.execute ?? exec, api: dependencies.api ?? ((path, paginate) => ghAPI(path, env, paginate)),
    run: dependencies.run ?? runReleaseChild, platform: dependencies.platform ?? process.platform,
    log: dependencies.log ?? console.log, temporaryRoots: dependencies.temporaryRoots,
    validateCombined: validateReleaseInventory, buildLockPath: join(tmpdir(), 'vonvon-release-build.lock'),
    createTemporary: () => mkdtemp(join(tmpdir(), 'vonvon-release-')), progressMs: dependencies.progressMs ?? 45000,
    windowsPollMs: 15000, cancelPollMs: 1000, ...dependencies };
}

/** Inherited organization runners are checked with their group access, not counted as offline. */
export async function inspectRunners(labels, api) {
  const results = await Promise.allSettled([
    api(`repos/${repository}/actions/runners?per_page=100`, true),
    api('orgs/modelzen/actions/runners?per_page=100', true),
  ]);
  const inventories = results.map((result, index) => ({ scope: index ? 'organization' : 'repository',
    available: result.status === 'fulfilled', runners: result.status === 'fulfilled' ? pages(result.value, 'runners') : [] }));
  const matches = runner => labels.every(label => runner.labels?.some(item => item.name.toLowerCase() === label.toLowerCase()));
  const repoRunners = inventories[0].runners;
  const orgOnly = inventories[1].runners.filter(runner => !repoRunners.some(item => item.id === runner.id) && matches(runner));
  const eligible = [...repoRunners];
  const hosted = labels.length === 1 && /^(?:windows|ubuntu|macos)-[\w.-]+$/.test(labels[0]);
  let groupAccess = 'not needed';
  if (!hosted && orgOnly.length) {
    try {
      const groups = pages(await api('orgs/modelzen/actions/runner-groups?per_page=100', true), 'runner_groups');
      const repo = await api(`repos/${repository}`);
      for (const group of groups) {
        if (group.restricted_to_workflows) continue; // Do not guess workflow allowlist access.
        if (!repo.private && !group.allows_public_repositories) continue;
        if (group.visibility === 'private' && !repo.private) continue;
        if (!['all', 'private', 'selected'].includes(group.visibility)) continue;
        if (group.visibility === 'selected') {
          const allowed = pages(await api(`orgs/modelzen/actions/runner-groups/${group.id}/repositories?per_page=100`, true), 'repositories');
          if (!allowed.some(item => item.full_name === repository)) continue;
        }
        const members = pages(await api(`orgs/modelzen/actions/runner-groups/${group.id}/runners?per_page=100`, true), 'runners');
        eligible.push(...orgOnly.filter(runner => members.some(item => item.id === runner.id)));
      }
      groupAccess = 'checked';
    } catch { groupAccess = 'unknown (group access unavailable)'; }
  }
  const matching = [...new Map(eligible.filter(matches).map(runner => [runner.id, runner])).values()];
  return { labels, kind: hosted ? 'github-hosted' : 'self-hosted', groupAccess,
    inventories: inventories.map(item => ({ scope: item.scope, available: item.available, count: item.runners.length })),
    matching: matching.map(item => ({ id: item.id, status: item.status, busy: item.busy })),
    ready: hosted || matching.some(item => item.status === 'online' && !item.busy) };
}

export function workflowLabels(text) {
  const value = text.match(/^\s+runs-on:\s*([^\n#]+)$/m)?.[1]?.trim();
  if (!value || value.includes('${{')) throw new Error('Windows runner labels must be explicit; inspect the workflow before dispatch');
  return value.replace(/^\[|\]$/g, '').split(',').map(label => label.trim().replace(/^['"]|['"]$/g, ''));
}

async function cleanSource(repo, sha, r) {
  const options = { cwd: repo, env: r.childEnv };
  if ((await r.execute('git', ['rev-parse', 'HEAD'], options)).stdout.trim() !== sha) throw new Error('Source HEAD differs from the fixed release SHA');
  await r.execute('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], options);
  if ((await r.execute('git', ['status', '--porcelain', '--untracked-files=normal'], options)).stdout.trim()) throw new Error('Release source has tracked or untracked modifications');
}

/** Read-only preflight except fetching origin/main; no build, signing, Apple submission or upload. */
export async function prepareRelease(options, dependencies = {}) {
  const r = runtime(dependencies);
  assertSecureTransport(r.env);
  if (r.platform !== 'darwin') throw new Error('Run release orchestration on the signing Mac');
  compareVersions(options.version, options.version);
  if (!/^[a-f0-9]{40}$/.test(options.sha ?? '')) throw new Error('Supply the complete 40-character main SHA');
  if (!isAbsolute(options.out ?? '') || !isAbsolute(options.repo ?? '')) throw new Error('Supply absolute --repo and dedicated persistent --out paths');
  const repo = await realpath(options.repo), out = await canonicalPath(options.out);
  const roots = r.temporaryRoots ?? await Promise.all([tmpdir(), '/tmp', '/private/tmp'].map(canonicalPath));
  assertOutputLocation(repo, out, roots);
  if (out === await canonicalPath(homedir())) throw new Error('Use a dedicated output directory, not the home directory');
  await mkdir(out, { recursive: true });
  return lock(join(out, '.orchestration.lock'), async () => {
    const entries = (await readdir(out)).filter(name => name !== '.orchestration.lock');
    if (entries.length) throw new Error('New release output must be empty; use resume for an existing release');
    const paths = { updateConfig: options['update-config'], cosConfig: options['cos-config'], notesFile: options['notes-file'] };
    for (const [key, path] of Object.entries(paths)) {
      if (!isAbsolute(path ?? '')) throw new Error(`Supply an absolute ${key} file`);
      paths[key] = await realpath(path);
      if (inside(out, paths[key])) throw new Error('Input files must be outside the output directory');
      if (key !== 'notesFile' && inside(repo, paths[key])) throw new Error('Release configuration must be external to the source checkout');
    }
    const update = validateConfig(await readJSON(paths.updateConfig));
    const readConfig = await readCosConfig(paths.cosConfig);
    for (const name of cosCredentialEnvNames(readConfig)) if (!r.env[name]) throw new Error('Required read-only COS credential environment variable is unavailable');
    const childEnv = Object.fromEntries(Object.entries(r.env).filter(([name]) => !cosCredentialEnvNames(readConfig).includes(name)));
    if (!dependencies.api) r.api = (path, paginate) => ghAPI(path, childEnv, paginate);
    const gitOptions = { cwd: repo, env: childEnv };
    await r.execute('git', ['fetch', 'origin', 'main'], gitOptions);
    await r.execute('git', ['merge-base', '--is-ancestor', options.sha, 'origin/main'], gitOptions);
    for (const file of ['packages/daemon/package.json', 'packages/desktop/package.json']) {
      const value = JSON.parse((await r.execute('git', ['show', `${options.sha}:${file}`], gitOptions)).stdout);
      if (value.version !== options.version) throw new Error(`Fixed source version differs from --version in ${file}`);
    }
    const workflowText = (await r.execute('git', ['show', `origin/main:.github/workflows/${workflow}`], gitOptions)).stdout;
    const sourceWorkflow = (await r.execute('git', ['show', `${options.sha}:.github/workflows/${workflow}`], gitOptions)).stdout;
    if ([workflowText, sourceWorkflow].some(text => !text.includes('source_sha:') || !text.includes('release_id:'))) throw new Error('Pinned-source release tooling must be included in the selected main SHA and current main');
    const live = await readStableManifest({ env: r.env, fetchImpl: dependencies.fetchImpl ?? fetch });
    const evidence = dependencies.cosEvidence ?? await readCosReleaseEvidence(paths.cosConfig, { env: r.env, config: readConfig });
    const baseline = validateFirstRelease({ live, evidence, firstRelease: !!options['first-release'], noLiveManifest: !!options['no-live-manifest'] });
    checkVersionGate({ version: options.version, mode: 'release', liveVersion: live.manifest?.version, firstRelease: baseline === 'none', historicalVersions: evidence.versions });
    if (!(await readFile(paths.notesFile, 'utf8')).trim()) throw new Error('Release notes must be nonempty');
    const runners = await inspectRunners(workflowLabels(workflowText), r.api);
    if (!runners.ready) throw new Error(`No eligible idle Windows runner with labels ${runners.labels.join(', ')}; repository and inherited organization access were checked (${runners.groupAccess})`);
    const ciText = (await r.execute('git', ['show', 'origin/main:.github/workflows/ci.yml'], gitOptions)).stdout;
    const ciLabels = [
      ...[...ciText.matchAll(/^\s+runs-on:\s*(\[[^\n]+\])\s*$/gm)].map(match => workflowLabels(` runs-on: ${match[1]}`)),
      ...[...ciText.matchAll(/'(\["self-hosted",[^\n\]]+\])'/g)].map(match => JSON.parse(match[1])),
    ].filter(labels => labels.includes('self-hosted'));
    const ciRunners = ciLabels.length > 0 && (await r.api(`repos/${repository}`)).private
      ? await Promise.all(ciLabels.map(labels => inspectRunners(labels, r.api)))
      : [];
    const profile = options['keychain-profile'] ?? 'notelet-notary';
    try { await r.execute('xcrun', ['notarytool', 'history', '--keychain-profile', profile, '--output-format', 'json'], { env: childEnv }); }
    catch { throw new Error('Notary credentials unavailable for the configured profile; inspect the account privately'); }
    const identities = (await r.execute('security', ['find-identity', '-v', '-p', 'codesigning'], { env: childEnv })).stdout;
    if (!identities.split('\n').some(line => line.includes('Developer ID Application:') && line.includes(`(${update.teamIdentifier})`))) throw new Error('No valid Developer ID Application identity matches the external update configuration');
    const hashes = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, digest(await readFile(path))])));
    const state = { format: 1, version: options.version, sha: options.sha, seedRepo: repo, out, paths, hashes, keychainProfile: profile,
      flags: { firstRelease: !!options['first-release'], noLiveManifest: !!options['no-live-manifest'] },
      createdAt: new Date().toISOString(), baseline, runners, ciRunners, windows: { releaseId: randomUUID(), dispatch: 'not-requested' }, mac: {}, assemblyAttempts: 0, timings: [] };
    if (state.flags.firstRelease && state.flags.noLiveManifest) throw new Error('Choose --first-release or --no-live-manifest');
    await atomicJSON(join(out, stateName), state);
    r.log(`Prepared ${state.version} ${state.sha}; no builds or publication started.`);
    return state;
  });
}

async function loadState(out) {
  if (!isAbsolute(out ?? '')) throw new Error('Supply absolute --out');
  const state = await readJSON(join(out, stateName));
  if (state.format !== 1 || state.out !== await realpath(out) || !/^[a-f0-9]{40}$/.test(state.sha ?? '')) throw new Error('Invalid release orchestration state');
  return state;
}
// Mac work and the Windows downloader share this object. Serialize snapshots so
// a slower write cannot replace a newer completion with an older partial state.
const stateWrites = new WeakMap();
const saveState = state => {
  const next = (stateWrites.get(state) ?? Promise.resolve()).catch(() => {}).then(() => atomicJSON(join(state.out, stateName), state));
  stateWrites.set(state, next);
  return next;
};
async function checkInputs(state) {
  for (const [key, path] of Object.entries(state.paths)) if (digest(await readFile(path)) !== state.hashes[key]) throw new Error(`Release ${key} changed; restore the original input before resuming`);
}
async function checkCancelled(state) {
  if (await exists(join(state.out, 'CANCEL'))) throw new Error('Release stopped by CANCEL; existing Apple and GitHub jobs remain queryable');
}
async function lock(path, work) {
  const handle = await open(path, 'wx').catch(() => { throw new Error(`Release lock exists (${basename(path)}); inspect its recorded PID, do not bypass a live task`); });
  await handle.writeFile(String(process.pid));
  try { return await work(); } finally { await handle.close(); await unlink(path); }
}
async function sourceWorktree(state, r) {
  if (!state.source || !(await exists(state.source))) {
    const temporary = await realpath(await r.createTemporary());
    state.source = join(temporary, 'source'); state.buildHome = join(temporary, 'home');
    await mkdir(state.buildHome);
    await r.execute('git', ['worktree', 'add', '--detach', state.source, state.sha], { cwd: state.seedRepo, env: r.childEnv });
    state.dependenciesInstalled = false;
    await saveState(state);
  }
  const source = await realpath(state.source), buildHome = await canonicalPath(state.buildHome);
  if (source !== state.source || buildHome !== state.buildHome) {
    state.source = source; state.buildHome = buildHome;
    await saveState(state);
  }
  await cleanSource(state.source, state.sha, r);
  if (await checkedProductVersion(state.source) !== state.version) throw new Error('Source product versions differ');
}

export const windowsRunTitle = state => `windows-release ${state.version} ${state.sha} ${state.windows.releaseId}`;
async function findWindowsRun(state, r) {
  if (state.windows.runId) {
    const run = await r.api(`repos/${repository}/actions/runs/${state.windows.runId}`);
    if (run.display_title !== windowsRunTitle(state) || run.event !== 'workflow_dispatch' || run.head_branch !== 'main') throw new Error('Saved Windows run does not match the pinned release request');
    return run;
  }
  const runs = pages(await r.api(`repos/${repository}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100`, true), 'workflow_runs')
    .filter(run => run.display_title === windowsRunTitle(state) && run.head_branch === 'main');
  if (runs.length > 1) throw new Error('Multiple Windows dispatches match this release; inspect them before continuing');
  return runs[0];
}
async function dispatchWindows(state, r, env) {
  if (state.windows.dispatch === 'not-requested') {
    await checkCancelled(state);
    state.windows.dispatch = 'requested'; state.windows.requestedAt = new Date().toISOString(); await saveState(state);
    // Persist intent before the network write: a lost response must not cause a duplicate build.
    await r.execute('gh', ['workflow', 'run', workflow, '--repo', repository, '--ref', 'main',
      '-f', `source_sha=${state.sha}`, '-f', `version=${state.version}`, '-f', `release_id=${state.windows.releaseId}`], { env });
  }
  const run = await findWindowsRun(state, r);
  if (run) { state.windows.runId = run.id; state.windows.status = run.status; state.windows.conclusion = run.conclusion; await saveState(state); }
  r.log(run ? `Windows run ${run.id}: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}` : 'Windows dispatch requested; waiting for GitHub to expose its run. Resume queries it without dispatching again.');
  await assertWindowsHealthy(state, r, run);
}
async function assertWindowsHealthy(state, r, knownRun, persist = true) {
  const run = knownRun ?? await findWindowsRun(state, r);
  if (run) {
    state.windows.runId = run.id; state.windows.status = run.status; state.windows.conclusion = run.conclusion; if (persist) await saveState(state);
    if (run.status === 'completed' && run.conclusion !== 'success') throw new Error(`Windows run ${run.id} failed (${run.conclusion}); stop this candidate and inspect GitHub before continuing`);
  }
  return run;
}

export async function runReleaseChild(command, args, { cwd, env, signal }) {
  signal?.throwIfAborted();
  await new Promise((resolvePromise, reject) => {
    // The helper can spawn gh/notarytool. Kill its process group as well on
    // interruption, rather than leaving a credentialed download behind.
    const detached = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', detached });
    let killTimer, stopped, spawnFailed = false;
    const send = name => {
      try { if (detached && child.pid) process.kill(-child.pid, name); else child.kill(name); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const kill = name => {
      send(name);
      // A helper may exit before a grandchild that ignored SIGTERM. Keep the
      // escalation alive through close, and join it before releasing the lock.
      stopped ??= new Promise(done => { killTimer = setTimeout(() => { send('SIGKILL'); done(); }, 1000); });
    };
    const abort = () => kill('SIGTERM');
    const signals = new Map(['SIGINT', 'SIGTERM'].map(name => [name, () => kill(name)]));
    const cleanup = () => { clearTimeout(killTimer); signal?.removeEventListener('abort', abort); for (const [name, forward] of signals) process.off(name, forward); };
    for (const [signal, forward] of signals) process.on(signal, forward);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', error => { spawnFailed = true; cleanup(); reject(error); });
    child.once('close', async (code, signal) => {
      if (spawnFailed) return;
      await stopped;
      cleanup();
      if (code === 0 && !stopped) resolvePromise(); else reject(new Error(`${basename(args[0] ?? command)} stopped (${signal ?? code}); evidence was retained`));
    });
  });
}
async function timed(state, phase, work) {
  const record = { phase, startedAt: new Date().toISOString(), status: 'running' };
  state.timings ??= []; state.timings.push(record); await saveState(state);
  try { const result = await work(); record.status = 'complete'; return result; }
  catch (error) { record.status = 'failed-or-interrupted'; throw error; }
  finally { record.completedAt = new Date().toISOString(); record.seconds = (Date.parse(record.completedAt) - Date.parse(record.startedAt)) / 1000; await saveState(state); }
}
async function completedMac(state, architecture) {
  const out = join(state.out, `mac-${architecture}`), path = join(out, 'notarization-state.json');
  if (!(await exists(path))) return false;
  const saved = await readJSON(path);
  if (!saved.complete) return false;
  if (saved.context?.version !== state.version || saved.context?.sourceCommit !== state.sha || saved.context?.architecture !== architecture) throw new Error('Completed macOS candidate belongs to different release inputs');
  for (const file of saved.files ?? []) {
    if (basename(file.file) !== file.file || digest(await readFile(join(out, file.file))) !== file.sha256) throw new Error('Completed macOS candidate bytes changed');
  }
  if (!saved.files?.length) throw new Error('Completed macOS candidate lacks artifact evidence');
  return true;
}
async function appleProgress(state, architecture) {
  const path = join(state.out, `mac-${architecture}`, 'notarization-state.json');
  const saved = await readJSON(path).catch(() => ({}));
  const timingBytes = await readFile(join(state.out, `mac-${architecture}`, 'logs', 'timings.jsonl'), 'utf8').catch(() => '');
  const timings = timingBytes.trim().split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  return { architecture, complete: saved.complete === true, app: saved.app?.status ?? (saved.app?.id ? 'submitted; waiting for Apple' : 'building / checking'),
    dmg: saved.dmg?.status ?? (saved.dmg?.id ? 'submitted; waiting for Apple' : 'not submitted'), timings };
}

function pause(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolvePromise => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolvePromise(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Download as soon as GitHub succeeds, while Mac work is waiting for Apple. */
async function windowsArtifacts(state, r, env, polling, downloads) {
  while (!downloads.signal.aborted) {
    await checkCancelled(state);
    const run = await assertWindowsHealthy(state, r);
    if (run?.status === 'completed') {
      await checkCancelled(state);
      state.windows.download = 'running'; await saveState(state);
      try {
        await timed(state, 'windows artifact network download / verification', () => r.run(process.execPath,
          [join(state.source, 'scripts/publish-windows.mjs'), '--run-id', String(run.id), '--out', join(state.out, 'windows'),
            '--sha', state.sha, '--version', state.version, '--download-only'], { cwd: state.source, env, signal: downloads.signal }));
        await checkCancelled(state);
        downloads.signal.throwIfAborted();
        state.windows.download = 'verified'; await saveState(state);
      } catch (error) { state.windows.download = 'failed-or-interrupted'; await saveState(state); throw error; }
      return;
    }
    // One final query after Mac finishes keeps the previous pending-run behavior:
    // a queued remote build does not make this command wait indefinitely.
    if (polling.signal.aborted) return;
    await pause(r.windowsPollMs, polling.signal);
  }
}

const serverReport = state => join(state.out, 'server', `vonvon-server-${state.version}-build.json`);
/** The two Linux server packages of this release are built, from this exact clean source, and unchanged since. */
async function completedServer(state) {
  if (!(await exists(serverReport(state)))) return false;
  const summary = await readJSON(serverReport(state));
  if (summary.version !== state.version || summary.sourceHead !== state.sha || summary.sourceDirty !== false) throw new Error('Server packages in this output belong to different release inputs');
  for (const target of PUBLISHED_TARGETS) {
    const entry = summary.files?.[target];
    if (entry?.name !== archiveName(state.version, target) || digest(await readFile(join(state.out, 'server', entry.name))) !== entry.sha256) throw new Error('Server package bytes changed after the build');
  }
  return summary;
}
/**
 * The Linux server packages (devices 7.6), after both Mac architectures: build-server.mjs needs the built web UI and
 * the clean source the Mac helper leaves behind. Node comes from a cache kept in the output, checked against the pins.
 */
async function buildServerPackages(state, r, env) {
  if (await completedServer(state)) { state.server = { phase: 'complete', report: serverReport(state) }; await saveState(state); return; }
  state.server = { phase: 'running' }; await saveState(state);
  const childEnv = { ...env, HOME: state.buildHome };
  // A resumed release may have a new source worktree whose web UI is not built yet.
  if (!(await exists(join(state.source, 'packages/ui/dist/index.html')))) await r.run('npm', ['run', 'build'], { cwd: state.source, env: childEnv });
  await timed(state, 'server packages build', () => r.run(process.execPath, [join(state.source, 'scripts/build-server.mjs'), '--out', join(state.out, 'server'),
    '--targets', PUBLISHED_TARGETS.join(','), '--node-cache', join(state.out, 'node-cache')], { cwd: state.source, env: childEnv }));
  if (!(await completedServer(state))) throw new Error('Server build exited without its build report');
  await checkedProductVersion(state.source, { serverBuildJSON: serverReport(state) });
  state.server = { phase: 'complete', report: serverReport(state) }; await saveState(state);
}

/** Explicit build authorization submits four Apple jobs; publication is a separate helper invocation. */
export async function buildRelease(options, dependencies = {}) {
  const r = runtime(dependencies);
  if (!options['authorize-notarization']) throw new Error('Build submits App and DMG to Apple for both architectures; explicit --authorize-notarization is required');
  const prepared = await exists(join(options.out, stateName)) ? await loadState(options.out) : await prepareRelease(options, dependencies);
  if (r.platform !== 'darwin') throw new Error('Run builds on the signing Mac');
  return lock(join(prepared.out, '.orchestration.lock'), () => lock(r.buildLockPath, async () => {
    // State must be read under the same lock as every dispatch decision and write.
    const state = await loadState(prepared.out);
    for (const [key, expected] of Object.entries({ version: state.version, sha: state.sha, repo: state.seedRepo,
      'update-config': state.paths.updateConfig, 'cos-config': state.paths.cosConfig, 'notes-file': state.paths.notesFile, 'keychain-profile': state.keychainProfile })) {
      if (options[key] === undefined) continue;
      const actual = ['repo', 'update-config', 'cos-config', 'notes-file'].includes(key) ? await canonicalPath(options[key]) : options[key];
      if (actual !== expected) throw new Error(`Existing release fixes --${key}; resume cannot change it`);
    }
    await checkInputs(state); await checkCancelled(state);
    const readConfig = await readCosConfig(state.paths.cosConfig);
    const privateNames = cosCredentialEnvNames(readConfig);
    const buildEnv = Object.fromEntries(Object.entries(r.env).filter(([key]) => !privateNames.includes(key)));
    r.childEnv = buildEnv;
    if (!dependencies.api) r.api = (path, paginate) => ghAPI(path, buildEnv, paginate);
    await sourceWorktree(state, r);
    await dispatchWindows(state, r, buildEnv);
    const polling = new AbortController(), downloads = new AbortController();
    let windowsError;
    const windowsTask = windowsArtifacts(state, r, buildEnv, polling, downloads).catch(error => { windowsError = error; });
    const cancellationTimer = setInterval(() => {
      checkCancelled(state).catch(error => { windowsError ??= error; polling.abort(); downloads.abort(error); });
    }, r.cancelPollMs);
    try {
      if (!state.dependenciesInstalled || !(await exists(join(state.source, 'node_modules')))) {
        await checkCancelled(state);
        state.mac.phase = 'installing-dependencies'; await saveState(state);
        await timed(state, 'dependencies / network download', () => r.run('npm', ['ci'], { cwd: state.source, env: { ...buildEnv, HOME: state.buildHome } }));
        state.dependenciesInstalled = true; await saveState(state);
      }
      // Both helpers mutate packages/desktop/stage; never run these in parallel.
      for (const architecture of ['arm64', 'x64']) {
        await checkCancelled(state); await checkInputs(state);
        if (windowsError) throw windowsError;
        await assertWindowsHealthy(state, r);
        if (await completedMac(state, architecture)) { state.mac[architecture] = 'complete'; continue; }
        state.mac.phase = architecture; state.mac[architecture] = 'running'; await saveState(state);
        r.log(`macOS ${architecture}: building, signing and waiting for App / DMG notarization; Windows runs concurrently.`);
        const timer = r.progressMs ? setInterval(() => {
          Promise.all([appleProgress(state, architecture), findWindowsRun(state, r)]).then(([apple, windows]) =>
            r.log(`macOS ${architecture}: App ${apple.app}; DMG ${apple.dmg}. Windows: ${windows?.status ?? 'discovering run'}${windows?.conclusion ? ` / ${windows.conclusion}` : ''}`)).catch(() => {});
        }, r.progressMs) : undefined;
        try {
          await timed(state, `mac-${architecture} build / package / notarize`, () => r.run(process.execPath, [join(state.source, 'scripts/release-mac.mjs'), '--repo', state.source, '--version', state.version,
            '--sha', state.sha, '--out', join(state.out, `mac-${architecture}`), '--build-home', state.buildHome, '--mode', 'release',
            '--architecture', architecture, '--keychain-profile', state.keychainProfile, '--notes-file', state.paths.notesFile,
            '--cos-config', state.paths.cosConfig, ...releaseFlags(state),
            ...(options[`recover-${architecture}`] ? ['--recover-submission', options[`recover-${architecture}`]] : [])],
          { cwd: state.source, env: { ...r.env, VONVON_DESKTOP_UPDATE_CONFIG: state.paths.updateConfig } }));
        } finally { clearInterval(timer); }
        if (!(await completedMac(state, architecture))) throw new Error('macOS helper exited without complete evidence');
        state.mac[architecture] = 'complete'; await saveState(state);
      }
      await checkCancelled(state); await checkInputs(state);
      if (windowsError) throw windowsError;
      try { await buildServerPackages(state, r, buildEnv); }
      catch (error) { state.server = { phase: 'failed-or-interrupted' }; await saveState(state); throw error; }
      await checkCancelled(state);
      if (windowsError) throw windowsError;
      await assertWindowsHealthy(state, r);
      if (state.macRelease && await exists(join(state.macRelease, 'SHA256SUMS'))) {
        await r.validateCombined(state.macRelease, { version: state.version, sha: state.sha });
      } else {
        // An interrupted assembler keeps its private partial output. Retry into a new empty directory.
        state.assemblyAttempts += 1; state.macRelease = join(state.out, `mac-combined-${state.assemblyAttempts}`);
        state.mac.phase = 'assembling'; await saveState(state);
        await timed(state, 'mac assembly / verification', () => r.run(process.execPath, [join(state.source, 'scripts/assemble-split-release.mjs'), '--repo', state.source, '--out', state.macRelease,
          '--arm64', join(state.out, 'mac-arm64'), '--x64', join(state.out, 'mac-x64'), '--version', state.version, '--sha', state.sha],
        { cwd: state.source, env: { ...buildEnv, VONVON_DESKTOP_UPDATE_CONFIG: state.paths.updateConfig } }));
        await r.validateCombined(state.macRelease, { version: state.version, sha: state.sha });
      }
      state.mac.phase = 'candidate-complete'; await saveState(state);
      polling.abort();
      await windowsTask;
      if (windowsError) throw windowsError;
      await checkCancelled(state);
      await assertWindowsHealthy(state, r);
      return releaseStatus({ out: state.out }, dependencies);
    } finally {
      clearInterval(cancellationTimer);
      polling.abort(); downloads.abort();
      // No background downloader survives a Mac failure, cancellation or signal.
      await windowsTask;
    }
  }));
}
const releaseFlags = state => [...(state.flags.firstRelease ? ['--first-release'] : []), ...(state.flags.noLiveManifest ? ['--no-live-manifest'] : [])];

export async function releaseStatus({ out }, dependencies = {}) {
  const r = runtime(dependencies), state = await loadState(out);
  const readConfig = await readCosConfig(state.paths.cosConfig);
  if (!dependencies.api) r.api = (path, paginate) => ghAPI(path, Object.fromEntries(Object.entries(r.env).filter(([key]) => !cosCredentialEnvNames(readConfig).includes(key))), paginate);
  const [windows, checks] = await Promise.allSettled([
    state.windows.dispatch === 'not-requested' ? undefined : findWindowsRun(state, r),
    r.api(`repos/${repository}/commits/${state.sha}/check-runs?per_page=100`, true),
  ]);
  const run = windows.status === 'fulfilled' ? windows.value : undefined;
  const jobs = run ? await r.api(`repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, true).catch(() => undefined) : undefined;
  return { version: state.version, sourceSha: state.sha, cancelled: await exists(join(out, 'CANCEL')),
    ci: checks.status === 'fulfilled' ? pages(checks.value, 'check_runs').map(check => ({ name: check.name, status: check.status, conclusion: check.conclusion })) : 'unavailable; inspect GitHub',
    windows: run ? { runId: run.id, status: run.status, conclusion: run.conclusion, download: state.windows.download ?? 'not-started', url: run.html_url, jobs: jobTimings(pages(jobs ?? {}, 'jobs'), run.created_at) } : { dispatch: state.windows.dispatch, download: state.windows.download ?? 'not-started', status: state.windows.dispatch === 'not-requested' ? 'not-started' : windows.status === 'rejected' ? 'query failed; no new dispatch' : 'waiting for run discovery' },
    mac: { phase: state.mac.phase ?? 'not-started', architectures: await Promise.all(['arm64', 'x64'].map(architecture => appleProgress(state, architecture))), combined: state.macRelease ?? null },
    server: await serverStatus(state),
    timings: state.timings, runners: { windows: state.runners, ci: state.ciRunners },
    publication: 'Use existing publication helpers after reviewing the candidates; this orchestrator never uploads or promotes stable.' };
}

async function serverStatus(state) {
  const summary = await exists(serverReport(state)) ? await readJSON(serverReport(state)).catch(() => undefined) : undefined;
  // required: from 0.9.0 release-publish plans nothing without this build, and the website handoff waits for its stable.
  return { phase: state.server?.phase ?? 'not-started', required: serverRequired(state.version),
    packages: PUBLISHED_TARGETS.flatMap(target => summary?.files?.[target] ? [{ target, file: summary.files[target].name, bytes: summary.files[target].size, sha256: summary.files[target].sha256 }] : []) };
}

export function jobTimings(jobs, queuedAt) {
  const seconds = (start, end) => start && end ? Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000) : null;
  return jobs.map(job => ({ name: job.name, status: job.status, conclusion: job.conclusion,
    queuedSeconds: seconds(job.created_at ?? queuedAt, job.started_at), seconds: seconds(job.started_at, job.completed_at),
    steps: (job.steps ?? []).map(step => ({ name: step.name, status: step.status, conclusion: step.conclusion, seconds: seconds(step.started_at, step.completed_at) })) }));
}

/** Only verified public receipts can supply website URLs; never guess URLs from candidate names. */
export async function collectRelease({ out }, dependencies = {}) {
  const state = await loadState(out), readOptional = async path => await exists(path) ? readJSON(path) : undefined;
  const r = runtime(dependencies);
  const readConfig = await readCosConfig(state.paths.cosConfig);
  if (!dependencies.api) r.api = (path, paginate) => ghAPI(path, Object.fromEntries(Object.entries(r.env).filter(([key]) => !cosCredentialEnvNames(readConfig).includes(key))), paginate);
  const run = state.windows.dispatch === 'not-requested' ? undefined : await assertWindowsHealthy(state, r, undefined, false);
  const mac = state.macRelease ? await readOptional(join(state.macRelease, 'upload-receipt.json')) : undefined;
  const stable = state.macRelease ? await readOptional(join(state.macRelease, 'publish-receipt.json')) : undefined;
  const windows = await readOptional(join(out, 'windows', 'windows-publish-receipt.json'));
  if (windows) {
    const source = await readJSON(join(out, 'windows', 'github-build.json'));
    if (run?.conclusion !== 'success' || source.runId !== run.id || source.sourceSha !== state.sha) throw new Error('Windows publication receipt lacks a matching successful build provenance');
  }
  // The server is part of every release from 0.9.0; before it, when the reviewed publication plan has it (cos-server.json existed).
  const plan = await readOptional(join(out, 'publication-plan.json'));
  const serverExpected = serverRequired(state.version) || !!plan?.candidate?.server;
  const serverUpload = await readOptional(join(out, 'server', UPLOAD_RECEIPT)), serverStable = await readOptional(join(out, 'server', STABLE_RECEIPT));
  for (const receipt of [mac, stable, windows, serverUpload, serverStable].filter(Boolean)) {
    if (receipt.version !== state.version || (receipt.sourceCommit ?? receipt.sourceSha) !== state.sha) throw new Error('Publication receipt version or source SHA differs from this release');
  }
  const macVerified = mac?.versionedVerification?.versionedObjectsVerified === true;
  const stableVerified = stable?.status === 'published' && stable.publicVerification?.publiclyVerified === true;
  if (stableVerified && (!macVerified || stable.planSHA256 !== mac.planSHA256)) throw new Error('Mac stable and upload receipts belong to different plans');
  const downloads = [];
  if (macVerified) for (const architecture of ['arm64', 'x64']) {
    const file = `Vonvon-Bot-${state.version}-${architecture}.dmg`;
    const object = mac.objects?.find(item => item.file === file);
    if (!object || !/^[a-f0-9]{64}$/.test(object.sha256 ?? '') || !Number.isSafeInteger(object.size)) throw new Error('Mac upload receipt lacks a verified DMG record');
    downloads.push({ platform: 'mac', architecture, file, url: object.url, bytes: object.size, sha256: object.sha256 });
  }
  if (windows && windows.architecture !== 'x64+arm64') throw new Error('Windows receipt must cover both x64 and ARM64');
  const windowsArchitectures = ['x64', 'arm64'];
  const updates = await readOptional(join(out, 'windows', 'windows-update-publish-receipt.json'));
  let updatesVerified = false;
  if (windows?.updatesEnabled === true && updates?.status === 'published') {
    const planBytes = await readFile(join(out, 'publication-plan.json')), plan = JSON.parse(planBytes);
    const expected = plan.candidate?.windows?.updates;
    if (plan.format !== 1 || plan.candidate.version !== state.version || plan.candidate.sourceSha !== state.sha ||
        updates.planSHA256 !== digest(planBytes) || updates.version !== state.version || updates.sourceSha !== state.sha || updates.updatesEnabled !== true ||
        !Array.isArray(expected) || expected.length !== 2 || !Array.isArray(updates.feeds) || updates.feeds.length !== 2 ||
        !windowsArchitectures.every(architecture => {
          const feed = updates.feeds.find(item => item.architecture === architecture), candidate = expected.find(item => item.architecture === architecture);
          return feed && candidate && feed.url === `https://dl.vonvon.cc/bot/windows/stable/${architecture}/update.json` &&
            feed.url === candidate.url && feed.bytes === candidate.bytes && feed.bytes > 0 && Number.isSafeInteger(feed.bytes) &&
            /^[a-f0-9]{64}$/.test(feed.sha256) && feed.sha256 === candidate.sha256;
        })) throw new Error('Windows update receipt differs from the reviewed publication plan');
    updatesVerified = true;
  }
  if (windows) for (const architecture of windowsArchitectures) for (const [kind, file] of [['installer', `Vonvon-Bot-Setup-${state.version}-${architecture}.exe`]]) {
    const object = windows.objects?.find(item => item.file === file);
    if (windows.signed !== false || typeof windows.updatesEnabled !== 'boolean' || !object || !/^[a-f0-9]{64}$/.test(object.sha256 ?? '') || !Number.isSafeInteger(object.bytes)) throw new Error('Windows receipt lacks a verified manual download record');
    downloads.push({ platform: 'windows', architecture, kind, ...object });
  }
  for (const item of downloads) {
    const expected = item.platform === 'mac' ? `https://dl.vonvon.cc/bot/mac/stable/${item.file}` : `https://dl.vonvon.cc/bot/windows/${state.version}/${item.file}`;
    if (item.url !== expected || item.bytes <= 0) throw new Error('Publication receipt contains an unexpected public download URL or size');
  }
  const serverPackages = [];
  if (serverUpload) for (const target of PUBLISHED_TARGETS) {
    const file = archiveName(state.version, target), object = serverUpload.objects?.find(item => item.file === file);
    if (!object || object.url !== `${SERVER_BASE_URL}/${state.version}/${file}` || !/^[a-f0-9]{64}$/.test(object.sha256 ?? '') || !Number.isSafeInteger(object.bytes) || object.bytes <= 0) throw new Error('Server receipt lacks a verified package record');
    serverPackages.push({ target, file, url: object.url, bytes: object.bytes, sha256: object.sha256 });
  }
  const serverStableVerified = !!serverUpload && serverStable?.status === 'published' && serverStable.planSHA256 === (plan ? digest(await readFile(join(out, 'publication-plan.json'))) : undefined);
  const mirrorExpected = !!plan?.candidate?.r2;
  const mirrorReceiptFile = mirrorExpected ? join(out, 'server', 'r2-stable-receipt.json') : null;
  const mirrorReceipt = mirrorReceiptFile ? await readOptional(mirrorReceiptFile) : undefined;
  let mirrorVerified = false;
  if (mirrorReceipt?.status === 'verified') {
    const expected = plan.candidate.r2, stableObjects = expected.plan?.stable;
    if (mirrorReceipt.schemaVersion !== 1 || mirrorReceipt.mode !== 'stable' || mirrorReceipt.version !== state.version || mirrorReceipt.sourceSha !== state.sha ||
        mirrorReceipt.publicationPlanSHA256 !== digest(await readFile(join(out, 'publication-plan.json'))) || mirrorReceipt.planSHA256 !== expected.planSHA256 ||
        expected.planSHA256 !== digest(json(expected.plan)) || expected.plan.version !== state.version || expected.plan.sourceSha !== state.sha ||
        !Array.isArray(stableObjects) || stableObjects.length !== 3 || !Array.isArray(mirrorReceipt.verification) || mirrorReceipt.verification.length !== stableObjects.length ||
        !['install.sh', 'uninstall.sh', 'stable-manifest.json'].every(file => {
          const object = stableObjects.find(item => item.file === file), verified = mirrorReceipt.verification.find(item => item.file === file);
          return object && verified && verified.url === object.url && verified.bytes === object.bytes && Number.isSafeInteger(verified.bytes) && verified.bytes > 0 &&
            /^[a-f0-9]{64}$/.test(verified.sha256) && verified.sha256 === object.sha256;
        })) throw new Error('R2 stable receipt differs from the reviewed publication plan');
    mirrorVerified = true;
  }
  // Keep the website's string field, but derive it from the tested inline bootstrap instead of a single-source curl.
  const installCommand = serverExpected ? await linuxInstallCommand() : undefined;
  const installCommandFile = serverExpected ? join(out, 'linux-install-command.sh') : null;
  if (installCommandFile) await writeFile(installCommandFile, installCommand, { mode: 0o600 });
  const handoff = { format: 1, version: state.version, sourceSha: state.sha, readyForWebsite: macVerified && stableVerified && !!windows && downloads.length === 2 + windowsArchitectures.length && (!windows.updatesEnabled || updatesVerified)
      && (!serverExpected || serverStableVerified) && (!mirrorExpected || mirrorVerified),
    mac: { versionedVerified: macVerified, stableVerified, notarization: mac?.notarization ?? stable?.notarization ?? null },
    windows: { published: !!windows, signed: false, updatesEnabled: updatesVerified, ...(updatesVerified ? { updateFeeds: updates.feeds } : {}) }, downloads,
    // Linux only: Mac and Windows install the desktop app, which carries its server (owner 2026-11-01).
    server: serverExpected ? { published: !!serverUpload, stableVerified: serverStableVerified, mirrorVerified: mirrorExpected ? mirrorVerified : null, installCommand, packages: serverPackages } : null,
    evidence: { mac: state.macRelease ? join(state.macRelease, 'upload-receipt.json') : null, stable: state.macRelease ? join(state.macRelease, 'publish-receipt.json') : null,
      windows: join(out, 'windows', 'windows-publish-receipt.json'), server: serverExpected ? join(out, 'server', STABLE_RECEIPT) : null,
      linuxInstallCommand: installCommandFile, r2: mirrorReceiptFile } };
  await atomicJSON(join(out, 'release-handoff.json'), handoff);
  runtime(dependencies).log(json(handoff));
  return handoff;
}

const help = `Usage: node scripts/release-all.mjs <prepare|build|resume|status|collect|cancel> --out /absolute/persistent/release [options]
prepare  --repo /absolute/checkout --version X.Y.Z --sha FULL_MAIN_SHA --update-config /external/desktop-update.json --cos-config /external/readonly.json --notes-file /absolute/notes.md [--keychain-profile notelet-notary] [--first-release | --no-live-manifest]
         Checks source versions/main ancestry, repo AND inherited organization runners, config paths and signing/notary credentials. No Apple submissions or publication.
build    Same options for a new release, or only --out for a prepared release, plus --authorize-notarization. Dispatches pinned Windows build, downloads and verifies it as soon as it succeeds while arm64 then x64 Mac helpers run, then builds the two Linux server packages into OUT/server and assembles evidence. Never uploads or promotes stable.
resume   --out ... --authorize-notarization [--recover-arm64 app=UUID|dmg=UUID] [--recover-x64 app=UUID|dmg=UUID]. Reuses original inputs, Apple IDs and Windows request. Unknown dispatch outcomes are queried, never automatically repeated.
status   Queries CI/Windows and reads Apple stage evidence. Can run while build is active.
collect  Validates matching publication receipts and writes release-handoff.json; readyForWebsite requires both public platforms, verified Mac stable and, from 0.9.0 (before it, when the publication plan has the server), the server's verified stable.
cancel   Creates OUT/CANCEL. Stops before the next stage; does not cancel jobs already submitted to Apple/GitHub. Remove only this marker deliberately before resuming.
See docs/release-orchestration.md for publication commands, stage boundaries and recovery.`;

const invokedPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (invokedPath && invokedPath === await realpath(fileURLToPath(import.meta.url))) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      ...Object.fromEntries(['repo', 'out', 'version', 'sha', 'update-config', 'cos-config', 'notes-file', 'keychain-profile', 'recover-arm64', 'recover-x64'].map(name => [name, { type: 'string' }])),
      ...Object.fromEntries(['help', 'authorize-notarization', 'first-release', 'no-live-manifest'].map(name => [name, { type: 'boolean' }])),
    } });
    const command = positionals[0];
    if (values.help) console.log(help);
    else if (positionals.length !== 1 || !['prepare', 'build', 'resume', 'status', 'collect', 'cancel'].includes(command)) throw new Error('Choose prepare, build, resume, status, collect or cancel; see --help');
    else if (command === 'prepare') await prepareRelease(values);
    else if (command === 'build' || command === 'resume') {
      if (command === 'resume') await loadState(values.out);
      console.log(json(await buildRelease(values)));
    } else if (command === 'status') console.log(json(await releaseStatus(values)));
    else if (command === 'collect') await collectRelease(values);
    else { const state = await loadState(values.out); await writeFile(join(state.out, 'CANCEL'), 'Stop before the next stage. Existing remote jobs were not cancelled.\n'); }
  } catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
}
