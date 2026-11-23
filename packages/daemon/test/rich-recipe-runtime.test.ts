import { randomUUID, createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, vi } from 'vitest';
import {
  canonicalizeRichRecipeContent,
  recipeInstallRequestSchema,
  type RecipeRichContent,
  type RecipeInstallReply,
} from '@vonvon/protocol';
const root = await mkdtemp(join(tmpdir(), 'recipe-runtime-'));
vi.stubEnv('VONVON_HOME', root);
const { RecipeInstaller } = await import('../src/recipe/installer');
const { addProject, getProjectByChatId, mutateProjectByChatId } = await import('../src/project/registry');
const { applyRich } = await import('../src/recipe/rich-runtime');
const { recipeAdmissions, recipeSlot } = await import('../src/recipe/rich-admission');
const { createScheduleStore } = await import('../src/bot/schedule/store');
const { log } = await import('../src/core/logger');
const { botPaths } = await import('../src/config/paths');
const { richSetup } = await import('../src/recipe/rich-setup');
const { richInstallTranscript } = await import('../src/recipe/rich-install-proof');
const digest = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex'),
  identity = () => ({ itemId: randomUUID(), originId: randomUUID() });
const text = (value: string) => ({ kind: 'inline' as const, value });
const v = (value: string) => ({ ...identity(), value });
test('a redeemed install drains existing work and commits only the selected slot; a restart reuses its result and updates preserve local changes', async () => {
  const botId = 'cli_rich_fixture',
    groupId = 'oc_rich_fixture',
    accountId = randomUUID(),
    authorId = randomUUID(),
    recipeId = randomUUID();
  const bot = { appId: botId, name: 'fixture', createdAt: 1, registrationId: randomUUID(), tenant: 'feishu' as const };
  const botIdentity = { appId: botId, createdAt: 1, registrationId: bot.registrationId, tenant: 'feishu' as const };
  const dir = botPaths(botId),
    loc = { dataRoot: root, file: dir.projectsFile };
  await mkdir(dir.dir, { recursive: true });
  await writeFile(join(root, 'bots.json'), JSON.stringify({ version: 1, bots: [bot] }));
  for (const id of [groupId, 'oc_neighbor'])
    await addProject({ chatId: id, name: id, cwd: root, blank: false, createdAt: 1 }, loc);
  const group = () => getProjectByChatId(groupId, dir.projectsFile);
  const keys = generateKeyPairSync('x25519'),
    device = {
      v: 1 as const,
      deviceId: randomUUID(),
      name: 'fixture',
      keypair: {
        publicKey: keys.publicKey.export({ format: 'jwk' }).x!,
        secretKey: keys.privateKey.export({ format: 'jwk' }).d!,
      },
    };
  const store = createScheduleStore(dir.schedulesFile, {
    now: Date.now,
    log,
    diagnostics: () => {},
    activeRecipe: (chat) => {
      const r = JSON.parse(require('node:fs').readFileSync(dir.projectsFile, 'utf8')).projects.find(
        (p: { chatId: string }) => p.chatId === chat,
      )?.richRecipe;
      return r && { installation: r.pointer.installationId, generation: r.pointer.generationId, context: chat };
    },
  });
  await store.load();
  const role = { ...identity(), text: text('first') },
    step = {
      ...identity(),
      kind: 'config' as const,
      title: 'Review',
      instructions: 'Review the settings.',
      required: false,
      action: { kind: 'manual' as const },
    };
  const content: RecipeRichContent = {
    format: 'rich-v2',
    schemaVersion: 2,
    public: { name: v('test'), summary: v('summary'), overview: v('overview'), version: v('1') },
    role,
    settings: [{ ...identity(), field: 'response.noMention', value: true }],
    rules: [{ ...identity(), purpose: 'work', text: text('work rule') }],
    tasks: [
      {
        ...identity(),
        name: 'Weekly',
        instruction: text('send report'),
        spec: { kind: 'daily', time: '12:00' },
        placement: 'follow',
        timeZone: { kind: 'targetChoice' },
      },
      {...identity(),name:'Tokyo explicit',instruction:text('explicit zone'),spec:{kind:'daily',time:'09:00'},placement:'follow',timeZone:{kind:'recommended',iana:'Asia/Tokyo'}},
      {...identity(),name:'Tokyo once',instruction:text('fixed instant'),spec:{kind:'once',at:Date.parse('2027-01-02T00:00:00Z')},placement:'follow',timeZone:{kind:'recommended',iana:'Asia/Tokyo'}},
    ],
    memories: [{ ...identity(), text: text('selected') }],
    skills: [],
    files: [],
    setup: [step, { ...step, ...identity(), title: '应用响应设置', action: { kind: 'nativeSettings', entry: 'response' } }],
    parts: [],
  };
  const api = 'https://api.example.test',
    broker = 'https://objects.example.test';
  let failComplete = true;
  let revision = 0;
  const refs = new Map<string, { preview: unknown; bytes: Uint8Array; auth: Record<string, unknown> }>();
  const installer = () =>
    new RecipeInstaller({
      apiOrigin: api,
      device,
      isInChat: async () => {},
      rich: {
        brokerOrigin: broker,
        bot: async (_bot, op) => {
          if (op.kind === 'richActivate') return applyRich(botIdentity, op.activation, store, async () => {});
          throw Error('unneeded');
        },
      },
      fetch: async (url, init) => {
        const u = new URL(String(url)),
          [, , , id, stage] = u.pathname.split('/');
        const held = refs.get(id!)!;
        const body = JSON.parse(String(init?.body));
        if (stage === 'unredeemable') {
          expect(body).toEqual({ accountId });
          return Response.json({ operationId: id, unredeemable: true });
        }
        if (stage === 'objects') {
          expect(u.origin).toBe(broker);
          return new Response(Buffer.from(held.bytes));
        }
        const { ticket: _ticket, ...auth } = held.auth;
        const prev = held.preview as object;
        if (stage === 'redeem') return Response.json({ ...auth, ...prev, status: 'redeemed' });
        if (failComplete) {
          failComplete = false;
          throw Error('receipt disconnected');
        }
        return Response.json({ operationId: id, status: body.outcome, disposition: 'recorded' });
      },
    });
  const preview = async () => {
    const encoded = canonicalizeRichRecipeContent(content),
      hash = digest(encoded.canonicalUTF8);
    return {
      request: {
        type: 'richPrepare',
        botId,
        groupId,
        preview: {
          accountId,
          release: {
            format: 'rich-v2',
            recipeId,
            versionId: randomUUID(),
            authorId,
            revision: ++revision,
            access: 'direct',
            contentSha256: hash,
            logicalBytes: encoded.logicalBytes,
          },
          manifest: {
            objectId: randomUUID(),
            kind: 'manifest',
            sha256: hash,
            bytes: encoded.canonicalUTF8.length,
            mediaType: 'application/json',
          },
        },
        canonical: encoded.canonical,
        parts: {},
      },
      bytes: encoded.canonicalUTF8,
    };
  };
  async function prepare(choices?: Record<string, string>,authority?:'exactVersion'|'directUpdate',actorAccount=accountId) {
    const { request, bytes } = await preview();Object.assign(request,{...(authority?{authority}:{})});request.preview.accountId=actorAccount;
    const first = await installer().request(recipeInstallRequestSchema.parse(request));
    if (first.kind !== 'richReview') throw Error('missing review');
    const next = await installer().request(
      recipeInstallRequestSchema.parse({ ...request, reviewToken: first.reviewToken, choices }),
    );
    if (next.kind !== 'richPrepared') throw Error('missing plan');
    const issuing = await installer().request(
      recipeInstallRequestSchema.parse({ type: 'richIssuing', botId, operationId: next.operationId }),
    );
    expect(issuing).toMatchObject({ issuerState: 'issuing' });
    const auth = {
      ...next.intent,
      operationId: next.operationId,
      accountId:actorAccount,
      ticket: Buffer.alloc(32, 1).toString('base64url'),
      deadline: Date.now() + 60000,
      serverPublicKey: keys.publicKey.export({ format: 'jwk' }).x!,
      status: 'authorized',
    };
    refs.set(next.operationId, { preview: request.preview, bytes, auth });
    return {
      kind: next.intent.purpose,
      commit: recipeInstallRequestSchema.parse({
        type: 'richCommit',
        botId,
        operationId: next.operationId,
        authorization: auth,
      }),
    };
  }
  const bootstrap = async () => {
    const { request } = await preview();
    const r = await installer().request(recipeInstallRequestSchema.parse(request));
    if (r.kind !== 'richReview') throw Error('expected review');
    const p = await installer().request(recipeInstallRequestSchema.parse({ ...request, reviewToken: r.reviewToken }));
    if (p.kind !== 'richPrepared') throw Error('expected preparation');
    const action = (type: string) =>
      installer().request(recipeInstallRequestSchema.parse({ type, botId, operationId: p.operationId }));
    return action;
  };
  const canceled = await bootstrap();
  expect(await canceled('richCancel')).toMatchObject({ status: 'rejected', settled: true, issuerState: 'unissued' });
  const lost = await bootstrap();
  expect(await lost('richIssuing')).toMatchObject({ status: 'prepared', issuerState: 'issuing' });
  expect(await lost('richCancel')).toMatchObject({ status: 'prepared', settled: false });
  expect(await lost('richReconcile')).toMatchObject({ status: 'rejected', settled: true });
  const one = await prepare();
  const release = recipeAdmissions.acquire(recipeSlot(botId, groupId));
  const run = installer().request(one.commit);
  await new Promise((r) => setTimeout(r, 40));
  expect((await group())?.richRecipe).toBeUndefined();
  release();
  await expect(run).rejects.toThrow('receipt disconnected');
  expect((await group())?.supplement).toBe('first');
  expect((await getProjectByChatId('oc_neighbor', dir.projectsFile))?.richRecipe).toBeUndefined();
  await expect(installer().request(one.commit)).resolves.toMatchObject({
    kind: 'richStatus',
    status: 'applied',
    settled: true,
  });
  const source = await installer().request(recipeInstallRequestSchema.parse({type:'source',botId,groupId}));
  expect(source).toMatchObject({kind:'source',source:{format:'rich-v2',recipeId}});
  if(source.kind!=='source'||!source.source)throw new Error('Missing installed source');
  const ignoredVersionId=randomUUID();
  const ignored=await installer().request(recipeInstallRequestSchema.parse({type:'ignoreVersion',botId,groupId,recipeId,sourceToken:source.source.sourceToken,installedVersionId:source.source.versionId,versionId:ignoredVersionId}));
  expect(ignored).toMatchObject({source:{ignoredVersionId}});
  await expect(installer().request(recipeInstallRequestSchema.parse({type:'ignoreVersion',botId,groupId,recipeId,sourceToken:source.source.sourceToken,installedVersionId:source.source.versionId,versionId:randomUUID()}))).rejects.toThrow('来源已改变');
  const ordinary = await readFile(dir.schedulesFile, 'utf8').catch(() => '{"tasks":[]}');
  expect(JSON.parse(ordinary).tasks).toEqual([]);
  const taskId = store.all()[0]!.id;
  expect(store.all()[0]!.state).toBe('paused');
  expect(store.all()[0]!.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(store.all()[1]!.timeZone).toBe('Asia/Tokyo');
  const readSettings = vi.fn(async () => ({scope: {kind: 'project'},sections: {response: {effective: {noMention: true}}}}));
  const setup = (action: object) =>
    richSetup(
      recipeInstallRequestSchema.parse({ type: 'richSetup', botId, groupId, action }) as Extract<
        ReturnType<typeof recipeInstallRequestSchema.parse>,
        { type: 'richSetup' }
      >,
      store,
      {
        read: readSettings,
      } as never,
      () => true,
      'ou_fixture',
    ) as Promise<Extract<RecipeInstallReply, { kind: 'richSetup' }>>;
  const shown = await setup({ kind: 'read' });
  expect(shown.steps).toEqual([]);
  for(const kind of ['acknowledge','check','openSettings'])await expect(setup({kind,stepId:step.itemId,token:shown.token})).rejects.toThrow('普通技能');
  expect(readSettings).not.toHaveBeenCalled();
  expect((await group())?.richRecipe?.setup).toEqual({});
  expect(store.all()[0]!.state).toBe('paused');
  const observed=shown;
  expect(()=>recipeInstallRequestSchema.parse({type:'richSetup',botId,groupId,action:{kind:'enableTask',taskId,actor:'ou_untrusted',taskToken:observed.tasks[0]!.token,timeZone:'Asia/Shanghai',token:observed.token}})).toThrow();
  await expect(setup({kind:'enableTask',taskId,taskToken:'f'.repeat(64),timeZone:'Asia/Shanghai',token:observed.token})).rejects.toThrow('管理员身份');
  await setup({ kind: 'enableTask', taskId,taskToken:observed.tasks[0]!.token, timeZone: 'Asia/Shanghai', token: observed.token });
  expect(store.all()[0]?.state).toBe('active');
  const once=observed.tasks.find(task=>task.name==='Tokyo once')!;
  await setup({kind:'enableTask',taskId:once.id,taskToken:once.token,timeZone:'Asia/Shanghai',token:observed.token});
  expect(store.all().find(task=>task.id===once.id)).toMatchObject({timeZone:'Asia/Shanghai',spec:{kind:'once',at:Date.parse('2027-01-02T00:00:00Z')}});
  expect((await setup({kind:'read'})).tasks[0]).toMatchObject({timeZone:'Asia/Shanghai',spec:{kind:'daily',time:'12:00'}});
  const unchanged=await prepare();
  await installer().request(unchanged.commit);
  expect(store.all()[0]).toMatchObject({state:'active',timeZone:'Asia/Shanghai'});
  await mutateProjectByChatId(
    groupId,
    (p) => {
      p.supplement = 'local';
    },
    undefined,
    loc,
  );
  content.role!.text = text('changed upstream');
  content.tasks[0]!.instruction = text('changed schedule');
  const two = await prepare({ [role.itemId]: 'local' });
  expect(two.kind).toBe('updateDirectRichRecipe');
  await expect(installer().request(two.commit)).resolves.toMatchObject({ status: 'applied' });
  expect((await group())?.supplement).toBe('local');
  expect(store.all()[0]).toMatchObject({ id: taskId, state: 'paused', instruction: 'changed schedule' });
  expect((await setup({ kind: 'read' })).steps).toEqual([]);
  expect((await group())?.richRecipe?.setup).toEqual({});
  const exactFromOtherAccount=await prepare(undefined,'exactVersion',randomUUID());expect(exactFromOtherAccount.kind).toBe('installRichRecipe');await expect(installer().request(exactFromOtherAccount.commit)).resolves.toMatchObject({status:'applied'});expect((await group())?.supplement).toBe('local');
  expect(JSON.parse(await readFile(join(root, 'bots.json'), 'utf8')).allocations.format).toBe('bot-allocations-v2');
  expect(JSON.parse(await readFile(join(root, 'bots.before-recipe-v2.json'), 'utf8')).recipeRegistryFormat).toBeUndefined();
});
test('rich proofs keep redeem and each completion outcome distinct', async () => {
  const vectors = JSON.parse(
    await readFile(new URL('../../../services/recipe-api/test/fixtures/rich-install-proof.json', import.meta.url), 'utf8'),
  );
  for (const v of vectors) {
    expect(richInstallTranscript(v.binding, 'redeem').toString('hex')).toBe(v.transcriptHex);
    expect(richInstallTranscript(v.binding, 'applied')).not.toEqual(richInstallTranscript(v.binding, 'rejected'));
  }
});
test('a native run keeps its epoch lease through early termination; foreign history cannot open the managed native id', async () => {
  const { guardRecipeThread, rememberRecipeThread, recipeHistoryId, recipeResumeId, managedThreadOwner } = await import(
    '../src/recipe/rich-thread'
  );
  const folder = join(root, 'bots', 'cli_thread'),
    slot = recipeSlot('cli_thread', 'oc_thread'),
    epoch = 'v2',
    native = 'private-native-id';
  const alias = await rememberRecipeThread(folder, slot, epoch, native);
  expect(await recipeResumeId(folder, alias, slot, 'prior')).toBeUndefined();
  expect(await recipeResumeId(folder, alias, slot, epoch)).toBe(native);
  await expect(recipeHistoryId(folder, alias, 'foreign')).rejects.toThrow();
  await expect(recipeHistoryId(folder, native, 'foreign')).rejects.toThrow();
  expect(await managedThreadOwner(join(root, 'bots', 'other'), native)).toMatchObject({ slot, alias });
  let end!: () => void,
    closed = 0;
  const running = new Promise<void>((r) => {
    end = r;
  });
  const thread = guardRecipeThread(
    {
      sessionId: native,
      close: async () => {
        closed++;
      },
      runStreamed: () => ({
        events: (async function* () {
          await running;
          yield { type: 'done' };
        })(),
      }),
    } as never,
    slot,
    () => {},
    alias,
  );
  const run = thread.runStreamed({ text: 'work' });
  const drain = (async () => {
    for await (const _event of run.events) break;
  })();
  let committed = false;
  const switchGeneration = recipeAdmissions.exclusive(slot, async () => {
    committed = true;
  });
  expect(committed).toBe(false);
  expect(() => thread.runStreamed({ text: 'stale' })).toThrow();
  end();
  await drain;
  await switchGeneration;
  expect(closed).toBe(1);
  expect(committed).toBe(true);
});
