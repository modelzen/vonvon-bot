import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planPublication, uploadPublication, promotePublication, publicationStatus } from './release-publish.mjs';
import { verifyWindowsArtifacts } from './package-windows.mjs';
import { planWindowsUpdates } from './publish-windows.mjs';

const sha = 'a'.repeat(40);
// From 0.9.0 every release carries the Linux server too; before it, a release without cos-server.json is macOS and Windows only.
const LEGACY = '0.8.3', THREE_PLATFORMS = '0.9.0';
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const save = (path, value) => writeFile(path, json(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
/** The fixture's dependencies as on a machine without the server's configuration: no server credentials either. */
const withoutServerCredentials = dependencies => {
  const strip = env => Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('SRV_')));
  return { ...dependencies, env: strip(dependencies.env), macDependencies: { ...dependencies.macDependencies, env: strip(dependencies.macDependencies.env) } };
};
async function fixture(t, modern = false, server = false, version = server ? THREE_PLATFORMS : LEGACY) {
  const out = await realpath(await mkdtemp(join(tmpdir(), 'release-publication-test-')));
  t.after(() => rm(out, { recursive: true, force: true }));
  const macOut = join(out, 'mac'), windowsOut = join(out, 'windows');
  await mkdir(macOut); await mkdir(windowsOut);
  const readonly = join(out, 'readonly.json'), write = join(out, 'write.json'), windowsConfig = join(out, 'windows.json');
  const keys = generateKeyPairSync('ed25519'), keyPath = join(out, 'private.pem');
  if (modern) await writeFile(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const common = { bucket: 'fixture-123', region: 'ap-shanghai', prefix: 'bot/mac/stable/', publicManifestURL: 'https://dl.vonvon.cc/bot/mac/stable/manifest.json' };
  await save(readonly, { ...common, ledgerFile: join(out, 'ledger.json'), secretIdEnv: 'READ_ID', secretKeyEnv: 'READ_KEY' });
  await save(write, { ...common, secretIdEnv: 'WRITE_ID', secretKeyEnv: 'WRITE_KEY' });
  await save(windowsConfig, { bucket: common.bucket, region: common.region, prefix: 'bot/windows/', publicBaseURL: 'https://dl.vonvon.cc/bot/windows/', secretIdEnv: 'WIN_ID', secretKeyEnv: 'WIN_KEY', ...(modern ? { updatePrivateKeyFile: keyPath } : {}) });
  await save(join(out, 'release-orchestration.json'), { format: 1, out, sha, version, paths: { cosConfig: readonly }, macRelease: macOut,
    mac: { phase: 'candidate-complete' }, windows: { runId: 123, status: 'completed', conclusion: 'success' }, flags: {},
    server: { phase: 'complete', report: join(out, 'server', `vonvon-server-${version}-build.json`) } });
  const artifacts = [];
  for (const architecture of ['x64', 'arm64']) {
    const pe = Buffer.alloc(100); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('PE\0\0', 64);
    const installer = `Vonvon-Bot-Setup-${version}-${architecture}.exe`, sha512 = hash(pe, 'sha512', 'base64');
    for (const [kind, file, bytes] of [['installer', installer, pe], ['zip', `Vonvon-Bot-${version}-windows-${architecture}.zip`, Buffer.from('archive')],
      ['blockmap', `${installer}.blockmap`, Buffer.from('blockmap')], ['feed', architecture === 'x64' ? 'latest.yml' : 'latest-arm64.yml', Buffer.from(`version: ${version}\npath: ${installer}\nsha512: ${sha512}\nfiles:\n  - url: ${installer}\n    sha512: ${sha512}\n    size: ${pe.length}\n`)]]) {
      if (modern && kind === 'zip') continue;
      await writeFile(join(windowsOut, file), bytes);
      artifacts.push({ kind, file, bytes: bytes.length, sha256: hash(bytes), sha512: hash(bytes, 'sha512', 'base64') });
    }
    await save(join(windowsOut, `windows-acceptance-${architecture}.json`), { passed: true, architecture, hostArchitecture: architecture, sourceSha: sha,
      installerSha256: hash(pe), steps: ['fresh-install', 'overwrite-install', 'uninstall', 'reinstall-after-uninstall', 'reinstall-after-0.7.5-orphan'].map(name => ({ name, passed: true,
        ...(name === 'uninstall' ? {} : { provider: { nativeModelParity: true, catalogCache: true, explicitRefresh: true, refreshFailureRecovery: true, configInvalidation: true } }) })) });
  }
  await save(join(windowsOut, 'windows-release-inventory.json'), { version, sourceSha: sha, architecture: 'x64+arm64', signed: false, updatesEnabled: modern, ...(modern ? { format: 2, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } : {}), artifacts });
  await save(join(windowsOut, 'github-build.json'), { sourceSha: sha, runId: 123, artifactId: 456, artifactDigest: `sha256:${'b'.repeat(64)}` });
  const macFiles = [];
  for (const architecture of ['arm64', 'x64']) for (const extension of ['zip', 'dmg']) {
    const file = `Vonvon-Bot-${version}-${architecture}.${extension}`, body = Buffer.from(file);
    await writeFile(join(macOut, file), body);
    macFiles.push({ file, size: body.length, sha256: hash(body), url: `https://dl.vonvon.cc/bot/mac/stable/${file}` });
  }
  const options = { out, 'cos-write-config': write, 'windows-cos-config': windowsConfig };
  const calls = [], flags = {}, serverInputs = [];
  if (server) {
    // planServer, uploadServer and promoteServer are replaced below; their own tests are publish-server.test.mjs.
    const serverKey = join(out, 'server.pem');
    await writeFile(serverKey, 'not read by the stubs', { mode: 0o600 });
    await save(join(out, 'server.json'), { bucket: common.bucket, region: common.region, prefix: 'bot/server/', publicBaseURL: 'https://dl.vonvon.cc/bot/server', secretIdEnv: 'SRV_ID', secretKeyEnv: 'SRV_KEY', updatePrivateKeyFile: serverKey });
    options['server-cos-config'] = join(out, 'server.json');
  }
  const candidateManifest = Buffer.from(json({ version, feedURL: `https://dl.vonvon.cc/bot/mac/stable/feed-${version}-arm64.json` }));
  const oldManifest = Buffer.from(json({ version: '1.2.2', feedURL: 'https://dl.vonvon.cc/bot/mac/stable/feed-1.2.2.json' }));
  const assertMacEnv = ({ env }) => { assert.equal(env.WIN_ID, undefined); assert.equal(env.WIN_KEY, undefined); assert.equal(env.SRV_ID, undefined); assert.equal(env.READ_ID, 'private'); assert.equal(env.WRITE_KEY, 'private'); };
  const secrets = { READ_ID: 'private', READ_KEY: 'private', WRITE_ID: 'private', WRITE_KEY: 'private', WIN_ID: 'private', WIN_KEY: 'private', ...(server ? { SRV_ID: 'private', SRV_KEY: 'private' } : {}) };
  const serverObject = (file, key) => { const body = Buffer.from(file); return { file, key, url: `https://dl.vonvon.cc/${key}`, bytes: body.length, sha256: hash(body), sha512: hash(body, 'sha512') }; };
  const serverPlan = { version, sourceSha: sha, publicKey: 'fixture', publishedAt: 1_793_000_000_000,
    versioned: [`vonvon-server-${version}-linux-x64.tar.gz`, `vonvon-server-${version}-linux-arm64.tar.gz`, `vonvon-server-${version}-build.json`, 'manifest.json'].map(file => serverObject(file, `bot/server/${version}/${file}`)),
    stable: [serverObject('install.sh', 'bot/server/install.sh'), serverObject('uninstall.sh', 'bot/server/uninstall.sh'), serverObject('stable-manifest.json', 'bot/server/stable/manifest.json')],
    previousManifest: { status: 404 } };
  const assertServerEnv = env => { assert.equal(env.SRV_ID, 'private'); assert.equal(env.SRV_KEY, 'private'); for (const name of ['READ_ID', 'WRITE_KEY', 'WIN_ID', 'WIN_KEY']) assert.equal(env[name], undefined, name); };
  const dependencies = {
    env: { ...secrets }, log: () => {}, serverConfigPath: join(out, 'no-cos-server.json'),
    releaseCodeConfigPath: join(out, 'release-code.json'),
    macDependencies: { env: { ...secrets } },
    planServer: async input => {
      assert.equal(input.dir, join(out, 'server')); assert.equal(input.version, version); assert.equal(input.sha, sha); assert.equal(input.config.secretIdEnv, 'SRV_ID');
      assert.equal(typeof input.readSource, 'function'); assert.equal(input.env, undefined, 'planning needs no write credential');
      serverInputs.push(input); await flags.serverPlan?.(input); return serverPlan;
    },
    uploadServer: async ({ dir, plan, env, cancelFile }) => {
      assertServerEnv(env); assert.equal(cancelFile, join(out, 'CANCEL')); assert.deepEqual(plan, serverPlan);
      calls.push('server-upload'); await flags.serverUpload?.();
      await mkdir(dir, { recursive: true });
      await save(join(dir, 'server-publish-receipt.json'), { version, sourceSha: sha, objects: plan.versioned });
    },
    promoteServer: async ({ env, ownerConfirmation, planSHA256, cancelFile, readSource }) => {
      assertServerEnv(env); assert.equal(ownerConfirmation, '确认发布'); assert.match(planSHA256, /^[a-f0-9]{64}$/); assert.equal(cancelFile, join(out, 'CANCEL')); assert.equal(typeof readSource, 'function');
      calls.push('server-promote'); await flags.serverPromote?.();
    },
    download: async ({ env, expectedSha, expectedVersion }) => {
      assert.deepEqual(env, {}); assert.equal(expectedSha, sha); assert.equal(expectedVersion, version);
      return verifyWindowsArtifacts(windowsOut, { sourceSha: sha, version });
    },
    planWindowsUpdates: input => planWindowsUpdates({ ...input, fetchImpl: async () => new Response(null, { status: 404 }) }),
    promoteWindowsUpdates: async input => { assert.equal(input.feeds.length, 2); assert.equal(input.ownerConfirmation, '确认发布'); calls.push('windows-promote'); },
    verifyMac: async () => {
      for (const file of macFiles) if (hash(await readFile(join(macOut, file.file))) !== file.sha256) throw new Error('Mac bytes changed');
      return { files: macFiles };
    },
    planMac: async (_input, deps) => {
      assertMacEnv(deps);
      const plan = { upload: macFiles, promote: { size: candidateManifest.length, sha256: hash(candidateManifest) }, previousManifest: { status: 200, size: oldManifest.length, sha256: hash(oldManifest) } };
      await save(join(macOut, 'publish-plan.json'), plan); return { plan, sha256: hash(json(plan)) };
    },
    uploadMac: async (input, deps) => {
      assertMacEnv(deps);
      calls.push('mac-upload'); await flags.mac?.();
      await save(join(macOut, 'upload-receipt.json'), { version, sourceCommit: sha, planSHA256: input['plan-sha256'], objects: macFiles, versionedVerification: { versionedObjectsVerified: true } });
    },
    execute: async (_command, args, { env }) => {
      calls.push('windows-upload'); assert.equal(env.READ_ID, undefined); assert.equal(env.WRITE_ID, undefined); assert.equal(env.WIN_ID, 'private'); assert.equal(env.SRV_ID, undefined);
      assert.equal(args[args.indexOf('--cancel-file') + 1], join(out, 'CANCEL'));
      await flags.windows?.();
      const inventory = JSON.parse(await readFile(join(out, 'publication-plan.json'), 'utf8')).candidate.windows;
      await save(join(windowsOut, 'windows-publish-receipt.json'), { version, sourceSha: sha, architecture: 'x64+arm64', signed: false, updatesEnabled: modern, objects: inventory.objects });
    },
    promoteMac: async (input, deps) => {
      assertMacEnv(deps);
      calls.push('promote'); assert.equal(input['owner-confirmation'], '确认发布'); assert.equal(input['reviewed-plan'], true);
      await save(join(macOut, 'publish-receipt.json'), { version, sourceCommit: sha, planSHA256: input['plan-sha256'], status: 'published' });
    },
    reverifyMac: async (_input, deps) => { assertMacEnv(deps); calls.push('reverify'); },
    readLiveManifest: async ({ env }) => { assert.deepEqual(env, {}); return { kind: 'present', bytes: flags.live ?? candidateManifest }; },
    verifyPublicMac: async ({ env }) => { assert.deepEqual(env, {}); calls.push('verify-stable'); return { publiclyVerified: true }; },
    collect: async (_input, { env }) => { assert.deepEqual(env, {}); calls.push('collect'); return { readyForWebsite: true }; },
  };
  const plan = await planPublication(options, dependencies);
  return { out, version, options: { ...options, 'plan-sha256': plan.planSHA256, 'owner-confirmation': '确认发布' }, dependencies, calls, flags, macOut, windowsOut, plan, oldManifest, serverInputs, serverPlan };
}
test('publication refuses missing or failed packaged Provider evidence before uploading', async t => {
  for (const architecture of ['x64', 'arm64']) for (const corruption of ['missing', 'failed']) await t.test(`${architecture} ${corruption}`, async t => {
    const f = await fixture(t, true);
    const reportPath = join(f.windowsOut, `windows-acceptance-${architecture}.json`);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const step = report.steps.find(step => step.name === 'fresh-install');
    if (corruption === 'missing') delete step.provider;
    else step.provider.explicitRefresh = false;
    await save(reportPath, report);
    await assert.rejects(uploadPublication(f.options, f.dependencies), /native acceptance lacks packaged Provider verification/);
    assert.deepEqual(f.calls, []);
  });
});

test('both native verified candidates produce one reviewed plan; uploads overlap and stable waits for both', async t => {
  const f = await fixture(t), macEntered = deferred(), windowsEntered = deferred(), release = deferred();
  assert.deepEqual(f.calls, []);
  f.flags.mac = async () => { macEntered.resolve(); await release.promise; };
  f.flags.windows = async () => { windowsEntered.resolve(); await release.promise; };
  const upload = uploadPublication(f.options, f.dependencies);
  await Promise.all([macEntered.promise, windowsEntered.promise]);
  await assert.rejects(promotePublication(f.options, f.dependencies), /lock exists/);
  release.resolve(); assert.equal((await upload).versionedObjectsVerified, true);
  assert.equal((await promotePublication(f.options, f.dependencies)).readyForWebsite, true);
  assert.deepEqual(f.calls.slice(0, 2).sort(), ['mac-upload', 'windows-upload']);
  assert.deepEqual(f.calls.slice(2), ['promote', 'collect']);
  await promotePublication(f.options, f.dependencies);
  assert.deepEqual(f.calls.slice(-2), ['verify-stable', 'collect'], 'published stable is verified without another manifest write');
  assert.equal((await publicationStatus(f.options)).website, 'not-ready', 'status does not invent a deployed website');
});
test('one failed platform retains the other receipt; retry skips its upload and download bytes', async t => {
  const f = await fixture(t);
  f.flags.windows = async () => { throw Object.assign(new Error('SECRET-EXEC-OUTPUT'), { stdout: 'SECRET-STDOUT', stderr: 'SECRET-STDERR' }); };
  await assert.rejects(uploadPublication(f.options, f.dependencies), error => {
    assert.match(error.message, /incomplete.*Windows publication helper failed/);
    assert.doesNotMatch(JSON.stringify(error, Object.getOwnPropertyNames(error)), /SECRET/); return true;
  });
  assert.equal((await publicationStatus(f.options)).macReceiptPresent, true);
  await assert.rejects(promotePublication(f.options, f.dependencies), /Both versioned/);
  const completedCalls = [...f.calls];
  f.flags.windows = undefined;
  await uploadPublication(f.options, f.dependencies);
  assert.equal(f.calls.filter(name => name === 'mac-upload').length, 1);
  assert.equal(f.calls.filter(name => name === 'windows-upload').length, 2);
  assert.deepEqual(f.calls.slice(completedCalls.length), ['windows-upload'], 'only the failed platform is retried');
});
test('approval hash, source artifacts, configuration, provenance and receipts cannot silently change', async t => {
  const f = await fixture(t);
  await assert.rejects(uploadPublication({ ...f.options, 'plan-sha256': '0'.repeat(64) }, f.dependencies), /plan hash differs/);
  await writeFile(join(f.macOut, f.plan.objects[0].file), 'changed');
  await assert.rejects(uploadPublication(f.options, f.dependencies), /Mac bytes changed/);
  assert.deepEqual(f.calls, []);
  const g = await fixture(t);
  await writeFile(g.options['cos-write-config'], json({ altered: true }));
  await assert.rejects(uploadPublication(g.options, g.dependencies), /COS write configuration/);
  const h = await fixture(t);
  await save(join(h.windowsOut, 'github-build.json'), { sourceSha: sha, runId: 999 });
  await assert.rejects(uploadPublication(h.options, h.dependencies), /provenance differs/);
  const i = await fixture(t);
  await uploadPublication(i.options, i.dependencies);
  const path = join(i.windowsOut, 'windows-publish-receipt.json'), receipt = JSON.parse(await readFile(path, 'utf8'));
  receipt.objects[0].sha256 = '0'.repeat(64); await save(path, receipt);
  await assert.rejects(promotePublication(i.options, i.dependencies), /Windows upload receipt/);
});
test('CANCEL prevents publication; interrupted stable uses reverify rather than another promote', async t => {
  const f = await fixture(t);
  await writeFile(join(f.out, 'CANCEL'), 'stop');
  await assert.rejects(uploadPublication(f.options, f.dependencies), /CANCEL/);
  assert.deepEqual(f.calls, []);
  const g = await fixture(t);
  await uploadPublication(g.options, g.dependencies);
  await save(join(g.macOut, 'publish-receipt.json'), { version: g.version, sourceCommit: sha, planSHA256: g.plan.macPlanSHA256, status: 'manifest-write-started' });
  await promotePublication(g.options, g.dependencies);
  assert.deepEqual(g.calls.slice(-2), ['reverify', 'collect']);
});
test('a crash before the stable PUT retries only the unchanged snapshot with current owner confirmation', async t => {
  const f = await fixture(t);
  await uploadPublication(f.options, f.dependencies);
  await save(join(f.macOut, 'publish-receipt.json'), { version: f.version, sourceCommit: sha, planSHA256: f.plan.macPlanSHA256, status: 'manifest-write-started' });
  f.flags.live = f.oldManifest;
  await assert.rejects(promotePublication({ ...f.options, 'owner-confirmation': undefined }, f.dependencies), /owner confirmation/);
  assert.equal(f.calls.includes('promote'), false);
  await promotePublication(f.options, f.dependencies);
  assert.deepEqual(f.calls.slice(-2), ['promote', 'collect']);
});
test('an interrupted publication stops if stable is neither the candidate nor its previous snapshot', async t => {
  const f = await fixture(t);
  await uploadPublication(f.options, f.dependencies);
  await save(join(f.macOut, 'publish-receipt.json'), { version: f.version, sourceCommit: sha, planSHA256: f.plan.macPlanSHA256, status: 'manifest-write-started' });
  f.flags.live = Buffer.from('unrelated manifest');
  const before = [...f.calls];
  await assert.rejects(promotePublication(f.options, f.dependencies), /neither this candidate nor the reviewed previous/);
  assert.deepEqual(f.calls, before);
});
test('credential names shared by Mac and Windows remain available to the Mac publisher', async t => {
  const f = await fixture(t), path = f.options['windows-cos-config'];
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.secretIdEnv = 'WRITE_ID'; config.secretKeyEnv = 'WRITE_KEY';
  await save(path, config);
  for (const env of [f.dependencies.env, f.dependencies.macDependencies.env]) { delete env.WIN_ID; delete env.WIN_KEY; }
  const planned = await planPublication(f.options, f.dependencies);
  assert.equal(planned.version, f.version, 'planMac assertions verify the shared write credential is retained');
});
test('SIGTERM persists CANCEL, aborts the Windows child and joins both upload branches before unlocking', async t => {
  const f = await fixture(t), macEntered = deferred(), windowsEntered = deferred(), releaseMac = deferred(), windowsStopped = deferred();
  const before = process.listenerCount('SIGTERM');
  f.flags.mac = async () => { macEntered.resolve(); await releaseMac.promise; await readFile(join(f.out, 'CANCEL')); throw new Error('cancelled'); };
  f.dependencies.execute = async (_command, _args, { signal }) => {
    windowsEntered.resolve();
    await new Promise(done => signal.addEventListener('abort', done, { once: true }));
    assert.match(await readFile(join(f.out, 'CANCEL'), 'utf8'), /SIGTERM/);
    windowsStopped.resolve(); throw new Error('child stopped');
  };
  let settled = false;
  const upload = uploadPublication(f.options, f.dependencies);
  const completion = upload.then(() => { settled = true; }, error => { settled = true; return error; });
  await Promise.all([macEntered.promise, windowsEntered.promise]);
  process.emit('SIGTERM');
  await windowsStopped.promise;
  assert.equal(settled, false, 'Mac in-flight work must be joined after Windows stops');
  await assert.rejects(uploadPublication(f.options, f.dependencies), /lock exists/);
  releaseMac.resolve();
  assert.match((await completion).message, /publication incomplete/);
  assert.equal(process.listenerCount('SIGTERM'), before, 'signal handler is released after joining both branches');
  await assert.rejects(readFile(join(f.out, '.publication.lock')), /ENOENT/);
});


test('new EXE-only releases bind two signed feeds in the unified plan and promote them after immutable uploads', async t => {
  const f = await fixture(t, true);
  const plan = JSON.parse(await readFile(join(f.out, 'publication-plan.json'), 'utf8'));
  assert.equal(plan.candidate.windows.updates.length, 2);
  assert.equal(plan.candidate.windows.objects.length, 4);
  assert.ok(plan.candidate.windows.objects.every(item => !item.file.endsWith('.zip')));
  assert.ok(f.plan.objects.some(item => item.url.endsWith('/stable/arm64/update.json')));
  await uploadPublication(f.options, f.dependencies);
  await promotePublication(f.options, f.dependencies);
  // The two uploads run concurrently; either may start first.
  assert.deepEqual(f.calls.slice(0, 2).sort(), ['mac-upload', 'windows-upload']);
  assert.deepEqual(f.calls.slice(2), ['promote', 'windows-promote', 'collect']);
  await writeFile(join(f.windowsOut, 'update-x64.json'), '{}');
  await assert.rejects(promotePublication(f.options, f.dependencies), /signature/);
});

test('before 0.9.0, without cos-server.json the plan, upload and status say only macOS and Windows are published', async t => {
  const f = await fixture(t);
  assert.equal(f.version, LEGACY);
  assert.match(f.plan.server, /服务端未配置/);
  assert.deepEqual(f.serverInputs, []);
  await uploadPublication(f.options, f.dependencies);
  await promotePublication(f.options, f.dependencies);
  assert.equal(f.calls.some(name => name.startsWith('server')), false);
  assert.match((await publicationStatus(f.options)).server, /服务端未配置/);
  await assert.rejects(planPublication({ ...f.options, 'server-cos-config': join(f.out, 'missing.json') }, f.dependencies), /服务端的 COS 配置不在指定的位置/);
});
test('from 0.9.0 the plan refuses to leave the server out: no cos-server.json, or no server build in the release state', async t => {
  const f = await fixture(t, false, true);
  assert.equal(f.version, THREE_PLATFORMS);
  const planPath = join(f.out, 'publication-plan.json'), reviewed = await readFile(planPath);
  const { 'server-cos-config': _named, ...unnamed } = f.options;
  // No --server-cos-config and nothing at the default path (dependencies.serverConfigPath does not exist).
  await assert.rejects(planPublication(unnamed, withoutServerCredentials(f.dependencies)), error => {
    assert.match(error.message, /^0\.9\.0 起三平台同版本，0\.9\.0 必须连 Linux 服务端包一起发，但没有服务端的发布配置 cos-server\.json/);
    assert.match(error.message, /docs\/release-orchestration\.md「Linux 服务端包」/);
    return true;
  });
  const statePath = join(f.out, 'release-orchestration.json'), state = JSON.parse(await readFile(statePath, 'utf8'));
  for (const server of [undefined, { phase: 'failed-or-interrupted' }]) {
    await save(statePath, { ...state, server });
    await assert.rejects(planPublication(f.options, f.dependencies), /^Error: 0\.9\.0 起三平台同版本，0\.9\.0 必须连 Linux 服务端包一起发，但 release-all 的状态里没有打好的服务端包.*release-all resume/);
  }
  assert.deepEqual(await readFile(planPath), reviewed, 'a refused plan leaves the reviewed one');
  assert.equal(f.serverInputs.length, 1, 'refused before the server is planned');
  assert.deepEqual(f.calls, []);
  // 0.10.0 compares as a later version, not as text.
  const later = await fixture(t, false, true, '0.10.0');
  await assert.rejects(planPublication((({ 'server-cos-config': _omit, ...rest }) => rest)(later.options), withoutServerCredentials(later.dependencies)), /0\.10\.0 必须连 Linux 服务端包一起发/);
});
test('from 0.9.0 a saved plan without the server can be neither uploaded nor promoted, and status says so', async t => {
  const f = await fixture(t, false, true);
  // A plan made before the rule: no server configuration, no server candidate.
  const planPath = join(f.out, 'publication-plan.json'), plan = JSON.parse(await readFile(planPath, 'utf8'));
  delete plan.configs.server; plan.candidate.server = null;
  await save(planPath, plan);
  const { 'server-cos-config': _named, ...options } = { ...f.options, 'plan-sha256': hash(json(plan)) };
  const dependencies = withoutServerCredentials(f.dependencies);
  await assert.rejects(uploadPublication(options, dependencies), /0\.9\.0 起三平台同版本.*cos-server\.json/);
  await assert.rejects(promotePublication(options, dependencies), /0\.9\.0 起三平台同版本.*cos-server\.json/);
  assert.deepEqual(f.calls, []);
  assert.match((await publicationStatus(f.options)).server, /^这份计划没有服务端：0\.9\.0 起不能只发 macOS 和 Windows/);
});
test('a configured server joins the reviewed plan; its upload runs beside the others and its stable goes last', async t => {
  const f = await fixture(t, true, true);
  assert.equal(f.plan.server.liveStable, 'none');
  assert.deepEqual(f.plan.server.stable.map(item => item.key), ['bot/server/install.sh', 'bot/server/uninstall.sh', 'bot/server/stable/manifest.json']);
  assert.ok(f.plan.objects.some(item => item.file === `vonvon-server-${f.version}-linux-arm64.tar.gz`));
  const saved = JSON.parse(await readFile(join(f.out, 'publication-plan.json'), 'utf8'));
  assert.deepEqual(saved.candidate.server, f.serverPlan);
  assert.ok(saved.configs.server.sha256);
  await uploadPublication(f.options, f.dependencies);
  assert.deepEqual(f.serverInputs.at(-1).previous, f.serverPlan, 'later steps reuse the reviewed live snapshot, not a fresh read');
  assert.deepEqual(f.calls.slice(0, 3).sort(), ['mac-upload', 'server-upload', 'windows-upload']);
  assert.equal((await publicationStatus(f.options)).server.receiptPresent, true);
  await promotePublication(f.options, f.dependencies);
  assert.deepEqual(f.calls.slice(3), ['promote', 'windows-promote', 'server-promote', 'collect']);
});
test('a failed server upload is named and retried alone; stable waits for its receipt', async t => {
  const f = await fixture(t, false, true);
  f.flags.serverUpload = async () => { throw new Error('SECRET-SDK-OUTPUT'); };
  await assert.rejects(uploadPublication(f.options, f.dependencies), error => {
    assert.match(error.message, /incomplete: server publication helper failed/); assert.doesNotMatch(error.message, /SECRET/); return true;
  });
  await assert.rejects(promotePublication(f.options, f.dependencies), /Both versioned/);
  assert.equal(f.calls.includes('promote'), false);
  const before = f.calls.length;
  f.flags.serverUpload = undefined;
  await uploadPublication(f.options, f.dependencies);
  assert.deepEqual(f.calls.slice(before), ['server-upload']);
  const path = join(f.out, 'server', 'server-publish-receipt.json'), receipt = JSON.parse(await readFile(path, 'utf8'));
  receipt.objects[0].sha256 = '0'.repeat(64); await save(path, receipt);
  await assert.rejects(promotePublication(f.options, f.dependencies), /服务端的上传回执/);
});
test('a server stable failure after macOS says so; the rerun with the same hash only completes the server', async t => {
  const f = await fixture(t, false, true);
  await uploadPublication(f.options, f.dependencies);
  f.flags.serverPromote = async () => { throw new Error('线上的服务端 stable 清单在 owner 看过计划之后变了；清单没覆盖'); };
  await assert.rejects(promotePublication(f.options, f.dependencies), /stable 已经切好，服务端 stable 没切成：线上的.*只补服务端/);
  assert.equal(f.calls.filter(name => name === 'promote').length, 1);
  f.flags.serverPromote = undefined;
  const before = f.calls.length;
  await promotePublication(f.options, f.dependencies);
  assert.deepEqual(f.calls.slice(before), ['verify-stable', 'server-promote', 'collect'], 'macOS is only re-verified');
});
test('the server plan is part of the review: a changed server candidate stops upload before anything is written', async t => {
  const f = await fixture(t, false, true);
  f.serverPlan.publishedAt += 1;
  await assert.rejects(uploadPublication(f.options, f.dependencies), /changed since review|differs/);
  assert.deepEqual(f.calls, []);
});

async function withR2(f) {
  const publicBaseURL = 'https://fixture.workers.dev/bot/server';
  const configPath = join(f.out, 'r2-linux.json');
  const config = { endpoint: `https://${'b'.repeat(32)}.r2.cloudflarestorage.com`, bucket: 'fixture-linux', publicBaseURL, accessKeyIdEnv: 'R2_ID', secretAccessKeyEnv: 'R2_SECRET', sdkModule: '/private/tools/node_modules/@aws-sdk/client-s3' };
  await save(configPath, config);
  f.serverPlan.mirrorBaseURLs = [publicBaseURL];
  f.dependencies.r2ConfigPath = configPath;
  f.dependencies.env.R2_ID = 'r2-private'; f.dependencies.env.R2_SECRET = 'r2-private';
  f.dependencies.macDependencies.env.R2_ID = 'r2-private'; f.dependencies.macDependencies.env.R2_SECRET = 'r2-private';
  await mkdir(join(f.out, 'server'), { recursive: true });
  f.dependencies.planR2 = async input => {
    assert.deepEqual(input.serverPlan, f.serverPlan);
    assert.equal(input.config.publicBaseURL, publicBaseURL);
    return { schemaVersion: 1, kind: 'r2-linux-mirror', version: f.version, sourceSha: sha, publicKey: 'fixture', publishedAt: f.serverPlan.publishedAt,
      target: { endpoint: config.endpoint, bucket: config.bucket, publicBaseURL },
      versioned: f.serverPlan.versioned.filter(item => !item.file.endsWith('-build.json')).map(item => ({ ...item, url: item.url.replace('https://dl.vonvon.cc/bot/server', publicBaseURL) })),
      stable: f.serverPlan.stable.map(item => ({ ...item, url: item.url.replace('https://dl.vonvon.cc/bot/server', publicBaseURL) })),
    };
  };
  f.dependencies.syncR2 = async ({ plan, planSHA256, mode, env, cancelFile }) => {
    assert.deepEqual(env, { R2_ID: 'r2-private', R2_SECRET: 'r2-private' });
    assert.equal(cancelFile, join(f.out, 'CANCEL'));
    assert.equal(planSHA256, hash(json(plan)));
    f.calls.push(`r2-${mode}`);
    await f.flags.r2?.(mode);
    return { schemaVersion: 1, status: 'verified', version: f.version, planSHA256, mode, objects: plan[mode].map(({ file }) => ({ file, action: 'uploaded' })), verification: plan[mode] };
  };
  const plan = await planPublication(f.options, f.dependencies);
  f.options['plan-sha256'] = plan.planSHA256;
  return { ...f, r2ConfigPath: configPath, r2Config: config };
}

test('enabled packaged mirrors require the matching config, and pin both config and mirror plan', async t => {
  const f = await fixture(t, true, true);
  f.serverPlan.mirrorBaseURLs = ['https://fixture.workers.dev/bot/server'];
  f.dependencies.r2ConfigPath = join(f.out, 'missing-r2-linux.json');
  await assert.rejects(planPublication(f.options, f.dependencies), /ENOENT|r2-linux/);
  assert.deepEqual(f.calls, []);
  const g = await withR2(f);
  const plan = JSON.parse(await readFile(join(g.out, 'publication-plan.json'), 'utf8'));
  assert.equal(plan.configs.r2.sha256, hash(await readFile(g.r2ConfigPath)));
  assert.equal(plan.candidate.r2.planSHA256, hash(json(plan.candidate.r2.plan)));
  assert.equal(plan.candidate.r2.plan.target.publicBaseURL, g.r2Config.publicBaseURL);
  g.serverPlan.mirrorBaseURLs = ['https://different.workers.dev/bot/server'];
  await assert.rejects(planPublication(g.options, g.dependencies), /must exactly match/);
  assert.deepEqual(g.calls, []);
});

test('R2 is isolated, uploads before stable, and promotes only after canonical COS', async t => {
  const f = await withR2(await fixture(t, true, true));
  await uploadPublication(f.options, f.dependencies);
  assert.equal(f.calls.includes('r2-versioned'), true);
  assert.equal(f.calls.includes('r2-stable'), false);
  await promotePublication(f.options, f.dependencies);
  assert.deepEqual(f.calls.slice(-5), ['promote', 'windows-promote', 'server-promote', 'r2-stable', 'collect']);
  const receipt = JSON.parse(await readFile(join(f.out, 'server/r2-stable-receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.publicationPlanSHA256, f.options['plan-sha256']);
  assert.equal(receipt.sourceSha, sha);
  assert.equal(receipt.verification.length, 3);
  assert.deepEqual((await publicationStatus(f.options)).r2, { publicBaseURL: f.r2Config.publicBaseURL, uploadStatus: 'verified', stableStatus: 'verified' });
});

test('failed R2 versioned upload blocks all stable and reruns only the failed branch', async t => {
  const f = await withR2(await fixture(t, true, true));
  f.flags.r2 = async () => { throw new Error('PRIVATE-SDK-SECRET'); };
  await assert.rejects(uploadPublication(f.options, f.dependencies), error => /R2 publication helper failed/.test(error.message) && !error.message.includes('PRIVATE'));
  assert.equal((await publicationStatus(f.options)).r2.uploadStatus, 'failed');
  await assert.rejects(promotePublication(f.options, f.dependencies), /required before stable/);
  assert.equal(f.calls.includes('promote'), false);
  f.flags.r2 = undefined;
  const before = f.calls.length;
  await uploadPublication(f.options, f.dependencies);
  assert.deepEqual(f.calls.slice(before), ['r2-versioned']);
});

test('failed R2 stable leaves no website handoff and same-plan recovery verifies COS then mirror', async t => {
  const f = await withR2(await fixture(t, true, true));
  await uploadPublication(f.options, f.dependencies);
  f.flags.r2 = async mode => { if (mode === 'stable') throw new Error('PRIVATE-SDK-SECRET'); };
  await assert.rejects(promotePublication(f.options, f.dependencies), error => /R2 Linux mirror publication failed/.test(error.message) && !error.message.includes('PRIVATE'));
  assert.equal(f.calls.includes('collect'), false);
  assert.equal((await publicationStatus(f.options)).r2.stableStatus, 'failed');
  f.flags.r2 = undefined;
  const before = f.calls.length;
  await promotePublication(f.options, f.dependencies);
  assert.deepEqual(f.calls.slice(before), ['verify-stable', 'windows-promote', 'server-promote', 'r2-stable', 'collect']);
  assert.equal(f.calls.filter(value => value === 'promote').length, 1);
});

test('R2 config drift, forged receipts, missing owner confirmation and changed mirror plan cannot bypass review', async t => {
  const f = await withR2(await fixture(t, true, true));
  const original = await readFile(f.r2ConfigPath);
  await writeFile(f.r2ConfigPath, Buffer.concat([original, Buffer.from('\n')]));
  await assert.rejects(uploadPublication(f.options, f.dependencies), /configuration changed since review/);
  assert.deepEqual(f.calls, []);
  await writeFile(f.r2ConfigPath, original);
  await uploadPublication(f.options, f.dependencies);
  const before = f.calls.length;
  await assert.rejects(promotePublication({ ...f.options, 'owner-confirmation': undefined }, f.dependencies), /R2 stable requires/);
  assert.equal(f.calls.length, before);
  const receiptPath = join(f.out, 'server/r2-publish-receipt.json'), receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.verification[0].sha256 = '0'.repeat(64); await save(receiptPath, receipt);
  await assert.rejects(promotePublication(f.options, f.dependencies), /R2 upload verification differs/);
  assert.equal(f.calls.length, before);
  f.serverPlan.publishedAt += 1;
  await assert.rejects(uploadPublication(f.options, f.dependencies), /changed since review/);
});

test('Mac stable re-verification and recovery snapshots retain configured CDN bypass checks', async t => {
  const f = await withR2(await fixture(t, true, true));
  for (const path of [join(f.out, 'readonly.json'), f.options['cos-write-config']]) {
    const config = JSON.parse(await readFile(path, 'utf8'));
    await save(path, { ...config, cdn: { provider: 'tencent', mutablePolicy: 'bypass' } });
  }
  f.dependencies.macDependencies.fetchImpl = async () => new Response('same bytes', { headers: { 'cache-control': 'no-cache', age: '3600', 'x-cache-lookup': 'Cache Hit' } });
  f.options['plan-sha256'] = (await planPublication(f.options, f.dependencies)).planSHA256;
  await uploadPublication(f.options, f.dependencies);
  await promotePublication(f.options, f.dependencies);
  f.dependencies.verifyPublicMac = async ({ fetchImpl }) => { await fetchImpl('https://dl.vonvon.cc/bot/mac/stable/manifest.json', { redirect: 'error' }); return { publiclyVerified: true }; };
  await assert.rejects(promotePublication(f.options, f.dependencies), /nonzero or invalid Age/);
  const receiptPath = join(f.macOut, 'publish-receipt.json'), receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  await save(receiptPath, { ...receipt, status: 'write-started' });
  f.dependencies.readLiveManifest = async ({ fetchImpl }) => { await fetchImpl('https://dl.vonvon.cc/bot/mac/stable/manifest.json', { redirect: 'error' }); };
  await assert.rejects(promotePublication(f.options, f.dependencies), /nonzero or invalid Age/);
});

test('failed re-verification invalidates a previous ready handoff and status also checks mirror receipts', async t => {
  const f = await withR2(await fixture(t, true, true));
  await uploadPublication(f.options, f.dependencies);
  await promotePublication(f.options, f.dependencies);
  const handoffPath = join(f.out, 'release-handoff.json');
  await save(handoffPath, { readyForWebsite: true });
  assert.equal((await publicationStatus(f.options)).website, 'handoff-ready; deployment not verified');
  f.flags.r2 = async mode => { if (mode === 'stable') throw new Error('verification failed'); };
  await assert.rejects(promotePublication(f.options, f.dependencies), /R2 Linux mirror publication failed/);
  assert.equal(JSON.parse(await readFile(handoffPath, 'utf8')).readyForWebsite, false);
  assert.equal((await publicationStatus(f.options)).website, 'not-ready');
  // A legacy/stale handoff must not contradict the current failed mirror receipt either.
  await save(handoffPath, { readyForWebsite: true });
  assert.equal((await publicationStatus(f.options)).website, 'not-ready');
});

test('optional release-code sync runs only after verified stable and can fail independently', async t => {
  const f = await fixture(t);
  await uploadPublication(f.options, f.dependencies);
  await save(f.dependencies.releaseCodeConfigPath, { sshHost: 'fixture-configured-host' });
  f.dependencies.env.VONVON_RELEASE_CODE_SSH = 'fixture-release-code';
  const attemptedHosts = [];
  f.dependencies.execute = async (command, args, { env }) => {
    assert.equal(f.calls.at(-1), 'collect');
    assert.equal(command, 'python3');
    assert.match(args[0], /release-code\.py$/);
    assert.deepEqual(args.slice(1, -1), ['send', '--out', f.out, '--host']);
    attemptedHosts.push(args.at(-1));
    assert.deepEqual(env, {});
    if (attemptedHosts.length === 1) throw new Error('source host unavailable');
  };
  assert.deepEqual(await promotePublication(f.options, f.dependencies), { readyForWebsite: true, releaseCodeSync: 'pending' });
  delete f.dependencies.env.VONVON_RELEASE_CODE_SSH;
  assert.deepEqual(await promotePublication(f.options, f.dependencies), { readyForWebsite: true, releaseCodeSync: 'verified' });
  f.dependencies.env.VONVON_RELEASE_CODE_SSH = '';
  assert.deepEqual(await promotePublication(f.options, f.dependencies), { readyForWebsite: true });
  delete f.dependencies.env.VONVON_RELEASE_CODE_SSH;
  await save(f.dependencies.releaseCodeConfigPath, { sshHost: '--bad' });
  assert.deepEqual(await promotePublication(f.options, f.dependencies), { readyForWebsite: true, releaseCodeSync: 'pending' });
  assert.deepEqual(attemptedHosts, ['fixture-release-code', 'fixture-configured-host']);
});
