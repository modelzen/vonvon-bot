import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export async function checkNativeInstall({ root, tmp, origin, author, accountId, version, nextVersion, sql }) {
  const home = join(tmp, 'native-install-state');
  mkdirSync(home, { mode: 0o700 });
  process.env.VONVON_HOME = home;
  const botId = 'cli_install_fixture',
    groupId = 'oc_install_fixture',
    deviceId = randomUUID();
  writeFileSync(
    join(home, 'bots.json'),
    JSON.stringify({
      version: 1,
      bots: [{ name: 'fixture', appId: botId, tenant: 'feishu', createdAt: 1, registrationId: randomUUID() }],
    }),
  );
  const entry = join(tmp, 'install-entry.ts'),
    compiled = join(tmp, 'install-entry.cjs');
  writeFileSync(
    entry,
    [
      ['RecipeUseController', 'packages/desktop/src/recipe-use.ts'],
      ['RecipeJournal', 'packages/desktop/src/recipe-use-journal.ts'],
      ['RecipeInstaller', 'packages/daemon/src/recipe/installer.ts'],
      ['loadOrCreateDevice', 'packages/daemon/src/remote/device.ts'],
      ['botPaths,useBotDir', 'packages/daemon/src/config/paths.ts'],
      ['addProject,getProjectByChatId,removeProject', 'packages/daemon/src/project/registry.ts'],
      ['recipeInstallRequestSchema,recipeInstallReplySchema', 'packages/protocol/src/index.ts'],
    ]
      .map(([symbols, path]) => 'export {' + symbols + '} from ' + JSON.stringify(join(root, path)) + ';')
      .join('\n'),
  );
  await build({
    entryPoints: [entry],
    outfile: compiled,
    alias: { '@vonvon/protocol': join(root, 'packages/protocol/src/index.ts') },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  });
  const {
    RecipeUseController,
    RecipeJournal,
    RecipeInstaller,
    loadOrCreateDevice,
    botPaths,
    useBotDir,
    removeProject,
    addProject,
    getProjectByChatId,
    recipeInstallRequestSchema,
    recipeInstallReplySchema,
  } = (await import(pathToFileURL(compiled))).default;
  const device = await loadOrCreateDevice(home, deviceId);
  mkdirSync(botPaths(botId).dir, { recursive: true });
  const location = { file: botPaths(botId).projectsFile, dataRoot: home };
  await addProject({ chatId: groupId, name: 'fixture', cwd: home, blank: false, createdAt: 1 }, location);
  const lease = new AbortController();
  const ids = [];
  let loseReceipt = true;
  let afterLatest;
  const account = {
    lease: (id) => (id === accountId ? lease.signal : undefined),
    request: async (id, path, init, guard) => {
      assert.equal(id, accountId);
      guard();
      const headers = new Headers(init.headers);
      headers.set('Authorization', 'Bearer ' + author);
      const response = await fetch(origin + path, { ...init, headers });
      if (afterLatest && path.endsWith('/latest-install-version')) {
        const change = afterLatest;
        afterLatest = undefined;
        await change();
      }
      return response;
    },
  };
  function boot() {
    const installer = new RecipeInstaller({
      apiOrigin: origin,
      allowLoopbackForTests: true,
      device,
      isInChat: async (bot, chat) => {
        assert.equal(bot, botId);
        assert.equal(chat, groupId);
      },
      fetch: async (url, init) => {
        assert.equal(new URL(url).origin, origin);
        assert.equal(new Headers(init.headers).has('Authorization'), false);
        const result = await fetch(url, init);
        if (loseReceipt && url.endsWith('/complete') && result.ok) {
          loseReceipt = false;
          await result.text();
          throw Error('Synthetic receipt loss');
        }
        return result;
      },
    });
    const client = {
      device: async () => ({
        kind: 'deviceStatus',
        status: {
          device: { id: deviceId, name: 'test device', publicKey: device.keypair.publicKey },
          remote: { addresses: [], port: 9000 },
          clients: { total: 0, active: 0 },
        },
      }),
      recipeInstall: async (raw) => {
        const r = recipeInstallRequestSchema.parse(raw);
        if (r.type === 'commit') ids.push(r.operationId);
        return recipeInstallReplySchema.parse(await installer.request(r));
      },
    };
    return new RecipeUseController(
      account,
      () => ({ viewId: 'local', client, check() {} }),
      new RecipeJournal(join(home, 'desktop-journal.json')),
    );
  }
  const begin = {
    type: 'begin',
    viewId: 'local',
    accountId,
    botId,
    groupId,
    recipeId: version.recipeId,
    versionId: version.versionId,
  };
  let controller = boot();
  const preview = await controller.request(begin);
  assert.equal(preview.kind, 'prepared');
  assert.equal(Object.hasOwn(preview, 'ticket'), false);
  await assert.rejects(controller.request({ type: 'confirm', handle: preview.handle }), /Synthetic receipt loss/);
  controller = boot();
  const pending = await controller.request(begin);
  assert.equal(pending.kind, 'pending');
  assert.equal((await controller.request({ type: 'resume', handle: pending.handle })).kind, 'applied');
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(sql(`select state from recipe_private.install_operations where id='${ids[0]}'`), 'applied');
  const row = await getProjectByChatId(groupId, location.file);
  assert.equal(row.recipeInstall.versionId, version.versionId);
  assert.equal(row.supplement, '角色');
  // A fresh role-v1 install applies the role without activating legacy setup steps.
  assert.deepEqual(row.recipeInstall.base, {role: '角色'});
  assert.equal(row.recipeInstall.setup, undefined);
  assert.equal((await controller.request({ type: 'finish', handle: pending.handle })).kind, 'closed');
  const place = { viewId: 'local', accountId, botId, groupId };
  const shown = await controller.source({ type: 'check', ...place });
  assert.equal(shown.latest.versionId, nextVersion.versionId);
  afterLatest = async () => {
    useBotDir(botId);
    await removeProject('fixture');
    await addProject({ chatId: groupId, name: 'fixture', cwd: home, blank: false, createdAt: 1 }, location);
    const fresh = await controller.request(begin);
    assert.equal(fresh.kind, 'prepared');
    assert.equal((await controller.request({ type: 'confirm', handle: fresh.handle })).kind, 'applied');
    assert.equal((await controller.request({ type: 'finish', handle: fresh.handle })).kind, 'closed');
  };
  await assert.rejects(controller.source({ type: 'check', ...place }), /来源已改变/);
  const ignore = { type: 'ignore', ...place, installedVersionId: version.versionId, versionId: nextVersion.versionId };
  await assert.rejects(controller.source({ ...ignore, sourceToken: shown.source.sourceToken }), /来源已改变/);
  const current = await controller.source({ type: 'check', ...place });
  assert.notEqual(current.source.sourceToken, shown.source.sourceToken);
  assert.equal(current.source.ignoredVersionId, undefined);
  assert.equal(
    (await controller.source({ ...ignore, sourceToken: current.source.sourceToken })).source.ignoredVersionId,
    nextVersion.versionId,
  );
  assert.equal((await controller.source({ type: 'check', ...place })).latest, undefined);
  console.log(
    'PASS: latest check and ignore follow the exact displayed binding through real HTTP, unbind and reinstall.',
  );
  console.log(
    'PASS: original desktop operation, real daemon/PG/HTTP authorization and applied receipt recover after a lost reply and restart.',
  );
}
