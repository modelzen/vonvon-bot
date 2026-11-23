import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

function imTransport() {
  const cards = new Map(),
    messages = new Map(),
    replies = [];
  const updates = [];
  const faults = { update: false };
  const channel = {
    send: async (chat, data) => {
      replies.push({ chat, data });
    },
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: async ({ data }) => {
              const card_id = randomUUID();
              cards.set(card_id, JSON.parse(data.data));
              return { code: 0, data: { card_id } };
            },
            update: async ({ path, data }) => {
              updates.push({cardId:path.card_id, ...data});
              if (faults.update) throw Error('card update offline');
              cards.set(path.card_id, JSON.parse(data.card.data));
              return { code: 0 };
            },
          },
        },
      },
      im: {
        v1: {
          chatMembers: { isInChat: async () => ({ code: 0, data: { is_in_chat: true } }) },
          message: {
            create: async ({ data }) => {
              const prior = messages.get(data.uuid);
              const message = prior ?? {
                message_id: randomUUID(),
                chat_id: data.receive_id,
                card: JSON.parse(data.content).data.card_id,
              };
              messages.set(data.uuid, message);
              return { code: 0, data: message };
            },
          },
        },
      },
    },
  };
  return {
    channel,
    faults, updates, cards,
    messages,
    replies,
    click(verb, operator, chatId, tenantKey) {
      const message = [...messages.values()].at(-1);
      const card = cards.get(message.card);
      const action = card.body.elements.flatMap((el) => el.behaviors ?? []).find((b) => b.value?.verb === verb);
      assert.ok(action, 'the displayed private card has the requested button');
      return {
        chatId,
        messageId: message.message_id,
        operator: { openId: operator },
        raw: { operator: { open_id: operator, tenant_key: tenantKey } },
        action: { value: action.value },
      };
    },
  };
}
export async function checkNativeAuthoring({ root, tmp, origin, author, reader, accountId, sql, request }) {
  const home = join(realpathSync(tmp), 'authoring-state');
  mkdirSync(home, { mode: 0o700 });
  process.env.VONVON_HOME = home;
  const botId = 'cli_authoring_fixture',
    groupId = 'oc_authoring_fixture',
    dm = 'oc_private_fixture';
  const operator = 'ou_author',
    tenantKey = 'test-fixture',
    deviceId = randomUUID(),
    peerId = randomUUID();
  const bot = { appId: botId, tenant: 'feishu', createdAt: 1, registrationId: randomUUID() };
  writeFileSync(join(home, 'bots.json'), JSON.stringify({ version: 1, bots: [{ ...bot, name: '测试助手' }] }));
  const journalPath = join(home, 'desktop-authoring.json');
  const entry = join(tmp, 'authoring-entry.ts'),
    compiled = join(tmp, 'authoring-entry.cjs');
  const modules = [
    ['AuthoringService', 'packages/daemon/src/recipe/authoring-service.ts'],
    ['RecipeAuthoringController', 'packages/desktop/src/recipe-authoring.ts'],
    ['AuthoringJournal', 'packages/desktop/src/recipe-authoring-journal.ts'],
    ['createDesktopFacades', 'packages/desktop/src/facade.ts'],
    ['desktopChannels', 'packages/desktop/src/ipc-contract.ts'],
    ['botPaths,useBotDir', 'packages/daemon/src/config/paths.ts'],
    ['addProject,removeProject,getProjectByChatId', 'packages/daemon/src/project/registry.ts'],
    ['loadOrCreateDevice', 'packages/daemon/src/remote/device.ts'],
    [
      'recipeAuthoringRequestSchema,recipeAuthoringReplySchema,desktopAuthoringReplySchema,desktopAuthoringRequestSchema',
      'packages/protocol/src/index.ts',
    ],
  ];
  writeFileSync(
    entry,
    modules.map(([names, path]) => 'export {' + names + '} from ' + JSON.stringify(join(root, path)) + ';').join('\n'),
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
  const code = (await import(pathToFileURL(compiled))).default;
  const dev = await code.loadOrCreateDevice(home, deviceId),
    pk = dev.keypair.publicKey;
  const peer = { id: peerId, device: deviceId + '/' + pk };
  code.useBotDir(botId);
  mkdirSync(code.botPaths(botId).dir, { recursive: true });
  const location = { file: code.botPaths(botId).projectsFile, dataRoot: home };
  await code.addProject(
    { chatId: groupId, name: 'fixture', cwd: home, blank: false, createdAt: 1, supplement: '群角色' },
    location,
  );
  const im = imTransport();
  let loseRegister = true,
    loseAccept = true,
    unavailableCancel,
    afterDraftRead, afterAuthorize, offlineAuthoring = false, substituteRecovery, daemonOffset = 0;
  let generation = new AbortController(),
    actor = accountId,
    deviceGeneration = 0;
  const alternate = (await request('/me', { token: reader })).accountId;
  const seen = [];
  const account = {
    lease: (id) => (id === actor ? generation.signal : undefined),
    status: () => ({
      kind: 'signedIn',
      accountId: actor,
      displayName: '测试作者',
      provider: 'google',
      persistence: 'memory',
    }),
    request: async (id, path, init, beforeSend) => {
      assert.equal(id, actor);
      beforeSend();
      if (offlineAuthoring && path.startsWith('/v1/authoring/')) throw Error('before first cloud registration');
      if (substituteRecovery && path.endsWith('/recovery')) return substituteRecovery(path.split('/')[3]);
      if (unavailableCancel && path === '/v1/authoring/' + unavailableCancel + '/cancel') throw Error('offline cancellation');
      if (path.endsWith('/register')) {
        const id = path.split('/').at(-2);
        const record = new code.AuthoringJournal(journalPath);
        if (JSON.parse(init.body).purpose === 'prepareDraft') {
          assert.ok(record.history.source({accountId:actor,deviceId,deviceKey:pk,botId},id));
          record.history.close();
        }
      }
      if (path.endsWith('/source-history')) assert.deepEqual(Object.keys(JSON.parse(init.body)), ['operationIds']);
      const headers = new Headers(init.headers);
      headers.set('Authorization', 'Bearer ' + (actor === accountId ? author : reader));
      const res = await fetch(origin + path, { ...init, headers });
      if (afterDraftRead && path.startsWith('/v1/drafts/') && res.ok) {
        const hook = afterDraftRead; afterDraftRead = undefined;
        await hook();
      }
      if (path.endsWith('/register') && res.ok && loseRegister) {
        loseRegister = false;
        await res.text();
        throw Error('lost registration reply');
      }
      if (path.endsWith('/authorize') && res.ok && afterAuthorize) {
        const fn = afterAuthorize;
        afterAuthorize = undefined;
        fn();
      }
      return res;
    },
  };
  const deviceHttp = async (url, init) => {
    assert.equal(new URL(url).origin, origin);
    assert.equal(new Headers(init.headers).has('Authorization'), false);
    const response = await fetch(url, init);
    if (url.endsWith('/accept') && response.ok && loseAccept) {
      loseAccept = false;
      await response.text();
      throw Error('lost accept reply');
    }
    return response;
  };
  const access = { admins: [operator] };
  const modelInputs = [], savedEvents = [];
  let afterPropose;
  function boot() {
    const daemon = new code.AuthoringService({
      bot,
      cfg: { preferences: { access } },
      channel: im.channel,
      root: home,
      now: () => Date.now() + daemonOffset,
      origin,
      fetch: deviceHttp,
      loopback: true,
      parser:{async propose(input) {
        modelInputs.push(input);
        const hook = afterPropose; afterPropose = undefined; await hook?.();
        if (input.instruction.includes('周报替换成草稿')) return {kind:'proposal',changes:[{action:'replace',field:'name',before:'周报',value:'草稿'}]};
        return {kind:'proposal',changes:[{action:'replace',field:'name',before:'草稿',value:'周报'}]};
      }},
    });
    const client = {
      snapshot: async () => ({
        agents: [{ id: botId, name: '测试助手' }],
        groups: [{ id: groupId, name: '产品群' }],
        memberships: [{ agentId: botId, groupId }],
      }),
      device: async () => ({
        kind: 'deviceStatus',
        status: {
          device: { id: deviceId, publicKey: pk, name: '测试设备' },
          remote: { port: 3000, addresses: [] },
          clients: { active: 1, total: 1 },
        },
      }),
      recipeAuthoring: async (raw) => {
        const r = code.recipeAuthoringRequestSchema.parse(raw);
        assert.ok(!JSON.stringify(r).includes(author));
        seen.push(r.type);
        return code.recipeAuthoringReplySchema.parse(await daemon.request(peer, r));
      },
    };
    const ctrl = new code.RecipeAuthoringController(
      account,
      (viewId) => {
        const gen = deviceGeneration;
        return { viewId, client, check: () => assert.equal(deviceGeneration, gen, 'stale device view') };
      },
      new code.AuthoringJournal(journalPath),
      receipt=>savedEvents.push(receipt),
    );
    const { shell } = code.createDesktopFacades({
      invoke: async (channel, raw) => {
        if (channel === code.desktopChannels.subscribe) return { ok: true, value: undefined };
        assert.equal(channel, code.desktopChannels.recipeAuthoring);
        const r = code.desktopAuthoringRequestSchema.parse(raw);
        const reply = code.desktopAuthoringReplySchema.parse(await ctrl.request(r));
        const text = JSON.stringify(reply);
        assert.ok(!text.includes(author));
        for (const key of ['ticket', 'nonceCommitment', 'targetPublicKey', 'serverPublicKey', 'authorization'])
          assert.ok(!text.includes('"' + key + '"'));
        return { ok: true, value: reply };
      },
      receive: () => () => {},
    });
    const main = shell.recipeAuthoring.request;
    return { daemon, ctrl, main };
  }
  function message(content, senderId = operator, replyToMessageId, chatId = dm) {
    const messageId = randomUUID();
    return {
      chatType: 'p2p',
      chatId,
      messageId,
      senderId,
      content,
      rawContentType: 'text',
      replyToMessageId,
      raw: {
        message: { chat_type: 'p2p', chat_id: chatId, message_id: messageId },
        sender: { sender_type: 'user', tenant_key: tenantKey, sender_id: { open_id: senderId } },
      },
    };
  }
  let running = boot();
  const start = () => running.main({ type: 'open', accountId, viewId: 'local', botId });
  let handle;
  const act = (type, fields) => running.main({ type, handle, ...fields });
  const rebase = async () => {
    running.ctrl.closeAll();
    running.daemon.close();
    running = boot();
    const session = await start();
    handle = session.handle;
    return session;
  };
  try {
    const session = await start();
    handle = session.handle;
    const challenge = await act('beginLink');
    await running.daemon.onMessage(message('/recipe link ' + challenge.code, 'ou_other'));
    assert.equal((await act('inspectLink', { challengeId: challenge.challengeId })).evidence, undefined);
    await running.daemon.onMessage(message('/recipe link ' + challenge.code));
    const link = await act('inspectLink', { challengeId: challenge.challengeId });
    assert.equal(link.recipient.openId, operator);
    await act('confirmLink', { challengeId: challenge.challengeId, evidence: link.evidence });
    const source = await act('reviewSource', { groupId });
    assert.equal(source.role, '群角色');
    assert.equal(source.groupName, '产品群');
    const prepare = { groupId, reviewToken: source.reviewToken, sourceAttested: true };
    await assert.rejects(act('prepare', prepare), /lost registration reply/);
    assert.equal(im.messages.size, 0);
    const registered = sql("select id from recipe_private.authoring_operations where account_id='" + accountId + "'");
    assert.ok(registered);
    let recovered = await rebase();
    assert.equal(recovered.operations[0].operationId, registered);
    assert.equal(recovered.operations[0].state, 'waiting');
    assert.equal(im.messages.size, 1);
    await running.daemon.onAction(im.click('confirm', 'ou_other', dm, tenantKey));
    assert.equal((await act('status')).operations[0].state, 'waiting');
    await running.daemon.onAction(im.click('confirm', operator, dm, tenantKey));
    const pending = await act('status');
    assert.equal(pending.operations[0].state, 'pendingCloud');
    assert.equal(
      sql("select state from recipe_private.authoring_operations where id='" + registered + "'"),
      'accepted',
    );
    recovered = await rebase();
    const saved = recovered.operations.find((o) => o.operationId === registered);
    assert.equal(saved.state, 'completed');
    const draftId = saved.receipt.draftId;
    assert.equal(saved.receipt.revision, 1);
    assert.deepEqual((await request('/drafts/' + draftId, { token: author })).config, { role: '群角色' });
    const cancelledLate = await act('cancel', { operationId: registered });
    assert.deepEqual(cancelledLate.operation.receipt, saved.receipt);

    const edit = await act('edit', { draftId, baseRevision: 1 });
    const editId = edit.operation.operationId;
    const last = [...im.messages.values()].at(-1);
    im.faults.update = true;
    await running.daemon.onMessage(message('/recipe role 独立的新角色', operator, last.message_id));
    const candidateUpdate = im.updates.at(-1);
    assert.throws(() => im.click('confirm', operator, dm, tenantKey));
    im.faults.update = false;
    await act('status');
    assert.deepEqual(im.updates.at(-1), candidateUpdate);
    im.click('confirm', operator, dm, tenantKey);
    assert.equal(im.messages.size, 2);
    const candidate = await act('inspectCandidate', { operationId: editId });
    assert.deepEqual(candidate.content.changes, [{ op: 'setDraftRole', value: '独立的新角色' }]);
    await assert.rejects(act('accept', { operationId: editId, payloadDigest: candidate.payloadDigest }));
    await running.daemon.onAction(im.click('confirm', operator, dm, tenantKey));
    afterAuthorize = () => {
      generation.abort();
      actor = alternate;
      generation = new AbortController();
      generation.abort();
      actor = accountId;
      generation = new AbortController();
    };
    const before = seen.filter((t) => t === 'advance').length;
    await assert.rejects(act('resume', { operationId: editId }));
    assert.equal(seen.filter((t) => t === 'advance').length, before);
    await assert.rejects(act('status'));
    assert.equal((await request('/drafts/' + draftId, { token: author })).revision, 1);
    im.faults.update = true;
    recovered = await rebase();
    const stale = recovered.operations.find(o => o.operationId === editId);
    assert.equal(stale.receipt.revision, 2);
    assert.match(stale.syncMessage, /私聊卡片/);
    assert.doesNotMatch(JSON.stringify(im.cards.get(last.card)), /私人草稿已保存/);
    const savedUpdate = im.updates.at(-1);
    const sent = im.messages.size;
    im.faults.update = false;
    recovered = await rebase();
    assert.equal(recovered.operations.find(o => o.operationId === editId).syncMessage, undefined);
    assert.deepEqual(im.updates.at(-1), savedUpdate);
    assert.match(JSON.stringify(im.cards.get(last.card)), /私人草稿已保存/);
    assert.equal(im.messages.size, sent);
    console.log('PASS: status repairs the original candidate card; reopen repairs the saved card with the same receipt and no second message.');
    assert.equal((await request('/drafts/' + draftId, { token: author })).config.role, '独立的新角色');
    await assert.rejects(act('edit', { draftId, baseRevision: 1 }));
    const again = await act('edit', { draftId, baseRevision: 2 });
    const activeId = again.operation.operationId;
    await running.daemon.onMessage(
      message('/recipe summary 仅私人稿', operator, [...im.messages.values()].at(-1).message_id),
    );
    const lateButton = im.click('confirm', operator, dm, tenantKey);
    await act('cancel', { operationId: activeId });
    await running.daemon.onAction(lateButton);
    assert.equal((await request('/drafts/' + draftId, { token: author })).revision, 2);
    assert.equal(sql("select state from recipe_private.authoring_operations where id='" + activeId + "'"), 'cancelled');
    assert.equal((await code.getProjectByChatId(groupId, location.file)).supplement, '群角色');
    assert.equal(
      sql(
        "select count(*) from recipe_private.authoring_operations where account_id='" +
          accountId +
          "' and state='accepted'",
      ),
      '2',
    );
    assert.ok(!readFileSync(journalPath, 'utf8').includes('独立的新角色'));
    const fromChat = message('/recipe create');
    await running.daemon.onMessage(fromChat);
    await running.daemon.onAction(im.click('source', operator, dm, tenantKey));
    const chatStatus = await act('status');
    const chatOp = chatStatus.operations.find((o) => o.state === 'waiting');
    assert.equal(chatOp.groupId, groupId);
    assert.notEqual(chatOp.operationId, registered);
    await running.daemon.onMessage(fromChat);
    const clickSave = im.click('confirm', operator, dm, tenantKey);
    await act('close');
    await running.daemon.onAction(clickSave);
    assert.equal(
      sql("select state from recipe_private.authoring_operations where id='" + chatOp.operationId + "'"),
      'dispatched',
    );
    actor = alternate;
    generation.abort();
    generation = new AbortController();
    const otherSession = await running.main({ type: 'open', accountId: alternate, viewId: 'local', botId });
    assert.deepEqual(otherSession.operations, []);
    await assert.rejects(
      running.main({ type: 'cancel', handle: otherSession.handle, operationId: chatOp.operationId }),
    );
    await running.daemon.onAction(clickSave);
    actor = accountId;
    generation.abort();
    generation = new AbortController();
    recovered = await rebase();
    await running.daemon.onAction(clickSave);
    const fromChatSaved = (await act('status')).operations.find((o) => o.operationId === chatOp.operationId);
    assert.equal(fromChatSaved.receipt.revision, 1);
    assert.notEqual(fromChatSaved.receipt.draftId, draftId);
    assert.equal((await request('/drafts/' + fromChatSaved.receipt.draftId, { token: author })).config.role, '群角色');
    assert.equal(
      sql("select count(*) from recipe_private.authoring_operations where account_id='" + accountId + "'"),
      '4',
    );
    console.log(
      'PASS: typed desktop authoring, real device proofs, original account, two-way link, App/chat creation and chat edit, close/reopen, A→B→A and retained cancel/accept receipts.',
    );
    const orphan = (await act('edit', { draftId, baseRevision: 2 })).operation.operationId;
    const accepted = (await act('edit', { draftId: fromChatSaved.receipt.draftId, baseRevision: 1 })).operation.operationId;
    await running.daemon.onMessage(message('/recipe name 仲裁前确认', operator, [...im.messages.values()].at(-1).message_id));
    await running.daemon.onAction(im.click('confirm', operator, dm, tenantKey));
    loseAccept = true;
    assert.equal((await act('status')).operations.find(o => o.operationId === accepted).state, 'pendingCloud');
    assert.equal(sql("select state from recipe_private.authoring_operations where id='" + accepted + "'"), 'accepted');
    const otherAdmin = 'ou_relinked', otherDm = 'oc_relinked';
    access.admins.push(otherAdmin);
    const nextLink = await act('beginLink');
    await running.daemon.onMessage(message('/recipe link ' + nextLink.code, otherAdmin, undefined, otherDm));
    const nextEvidence = await act('inspectLink', { challengeId: nextLink.challengeId });
    await act('confirmLink', { challengeId: nextLink.challengeId, evidence: nextEvidence.evidence });
    const sentBefore = im.messages.size;
    unavailableCancel = orphan;
    const offline = await rebase();
    const pendingCancel = offline.operations.find(o => o.operationId === orphan);
    assert.equal(pendingCancel?.state, 'cancelPending');
    assert.equal(pendingCancel.receipt, undefined);
    assert.ok(pendingCancel.syncMessage);
    assert.equal(sql("select state from recipe_private.authoring_operations where id='" + orphan + "'"), 'dispatched');
    unavailableCancel = undefined;
    const afterRelink = await rebase();
    const cancelled = afterRelink.operations.find(o => o.operationId === orphan);
    assert.equal(cancelled?.receipt?.status, 'cancelled', 'relink must release the old proposal without its recipient');
    const acceptedReceipt = afterRelink.operations.find(o => o.operationId === accepted)?.receipt;
    assert.deepEqual(acceptedReceipt, {operationId:accepted, status:'accepted', stateRevision:3, draftId:fromChatSaved.receipt.draftId, revision:2});
    assert.equal(sql("select state from recipe_private.authoring_operations where id='" + orphan + "'"), 'cancelled');
    for (const type of ['inspectCandidate', 'resume', 'resend'])
      await assert.rejects(act(type, { operationId: orphan }));
    assert.equal(im.messages.size, sentBefore);
    const reopened = (await act('edit', { draftId, baseRevision: 2 })).operation.operationId;
    assert.notEqual(reopened, orphan);
    assert.equal([...im.messages.values()].at(-1).chat_id, otherDm);
    access.admins = [operator];
    await running.daemon.adminRemoved(otherAdmin);
    const unlinked = await rebase();
    assert.equal(unlinked.linked, false);
    assert.equal(unlinked.operations.find(o => o.operationId === reopened)?.receipt?.status, 'cancelled');
    assert.deepEqual(unlinked.operations.find(o => o.operationId === accepted)?.receipt, acceptedReceipt);
    assert.equal(sql("select state from recipe_private.authoring_operations where id='" + reopened + "'"), 'cancelled');
    console.log('PASS: relink and removed admin recover on restart, cancel releases the same-draft lock, lost acceptance keeps its actual revision, and the old recipient never receives another dispatch.');
    // A stopped/relinked Bot can own three IDs the cloud never saw. Simulate birth six minutes ago
    // without advancing PostgreSQL time, and keep the reservation until the real recovery route answers.
    daemonOffset = -6*60_000;
    await rebase();
    const relink = await act('beginLink');
    await running.daemon.onMessage(message('/recipe link ' + relink.code));
    const evidence = await act('inspectLink', {challengeId:relink.challengeId});
    await act('confirmLink',{challengeId:relink.challengeId,evidence:evidence.evidence});
    const emptyDraft = () => request('/drafts',{method:'POST',token:author,body:{
      public:{name:'测试',summary:'',overview:'',version:'1',access:'direct'},config:{role:'测试'},
    }});
    const draftIds = [draftId,fromChatSaved.receipt.draftId,(await emptyDraft()).draftId];
    offlineAuthoring = true;
    for (const id of draftIds) {
      const draft = await request('/drafts/'+id,{token:author});
      await assert.rejects(act('edit',{draftId:id,baseRevision:draft.revision}),/before first cloud registration/);
    }
    const tracked = (await act('status')).operations.filter(o=>draftIds.includes(o.draftId) && o.state==='pendingMain');
    assert.equal(tracked.length,3);
    const extra = await emptyDraft();
    await assert.rejects(act('edit',{draftId:extra.draftId,baseRevision:1}),/上限/);
    access.admins = [];
    await running.daemon.adminRemoved(operator);
    for (const op of tracked) {
      assert.equal(sql("select count(*) from recipe_private.authoring_operations where id='"+op.operationId+"'"),'0');
    }
    offlineAuthoring = false;
    const assertStillPending = async () => {
      const result = await rebase();
      for (const old of tracked) assert.equal(result.operations.find(o=>o.operationId===old.operationId)?.state,'cancelPending');
    };
    substituteRecovery = () => Response.json({error:{code:'operation_expired'}},{status:410});
    await assertStillPending();
    substituteRecovery = operationId => Response.json({operationId,accountId:alternate,unredeemable:true});
    await assertStillPending();
    substituteRecovery = () => Response.json({operationId:randomUUID(),accountId,unredeemable:true});
    await assertStillPending();
    substituteRecovery = undefined;
    const settled = await rebase();
    for (const {operationId} of tracked) {
      const result = settled.operations.find(o=>o.operationId===operationId);
      assert.equal(result.state,'expired');
      assert.deepEqual(result.receipt,{operationId,status:'expired',outcome:'unknown'});
      assert.match(result.syncMessage,/创作中心/);
      await assert.rejects(act('resend',{operationId}));
    }
    assert.deepEqual(settled.operations.find(o=>o.operationId===accepted)?.receipt,acceptedReceipt);
    daemonOffset = 0;
    access.admins = [operator];
    await rebase();
    const linkAgain = await act('beginLink');
    await running.daemon.onMessage(message('/recipe link ' + linkAgain.code));
    const proofAgain = await act('inspectLink',{challengeId:linkAgain.challengeId});
    await act('confirmLink',{challengeId:linkAgain.challengeId,evidence:proofAgain.evidence});
    const newOp = (await act('edit',{draftId:extra.draftId,baseRevision:1})).operation;
    assert.equal(newOp.state,'waiting');
    await act('cancel',{operationId:newOp.operationId});
    console.log('PASS: three unregistered revoked IDs retain quota on 410 and mismatched proofs, then release it only on authenticated original-ID recovery; old accepts stay saved.');
    await act('close');
    running.ctrl.closeAll();
    running.daemon.close();
    const old = await request('/drafts/'+draftId,{token:author});
    const ready = await request('/drafts/'+draftId,{method:'PATCH',revision:old.revision,token:author,
      body:{public:{name:'来源群版本',summary:'摘要',overview:'说明',version:'1',access:'direct'},config:old.config}});
    const version = await request('/drafts/'+draftId+'/publish',{method:'POST',revision:ready.revision,token:author,body:{}});
    sql(`update recipe_private.authoring_operations set terminal_at=clock_timestamp()-interval '10 days'
      where account_id='${accountId}' and state='accepted'; select recipe_private.maintain_authoring('${accountId}')`);
    assert.equal(sql(`select count(*) from recipe_private.authoring_operations where id='${registered}'`),'0');
    daemonOffset = 10 * 86400000;
    running = boot();
    const groupSession = await running.main({type:'open',accountId,viewId:'local',botId,groupId});
    handle = groupSession.handle;
    const history = await act('sourceHistory',{groupId});
    assert.ok(history.entries.some(row=>row.operationId===registered && row.state==='published' && row.versionId===version.versionId));
    assert.ok(history.entries.some(row=>row.operationId===chatOp.operationId && row.state==='draft' && row.draftId===fromChatSaved.receipt.draftId));
    assert.ok(!history.entries.some(row=>row.operationId===editId));
    await code.removeProject('fixture');
    await code.addProject({chatId:groupId,name:'rebound',cwd:home,blank:false,createdAt:2,supplement:'群角色'},location);
    await assert.rejects(act('sourceHistory',{groupId}));
    const rebound = await running.main({type:'open',accountId,viewId:'local',botId,groupId});
    handle = rebound.handle;
    assert.deepEqual((await act('sourceHistory',{groupId})).entries,[]);
    console.log('PASS: private source intents persisted before registration, exact draft and remote publication recovered after ten days, same physical group rebound without prior history.');
    daemonOffset=0;
    const liveGroup = await running.main({type:'open',accountId,viewId:'local',botId,groupId});handle=liveGroup.handle;
    const groupReview = await act('reviewSource',{groupId});
    const workflow = (await act('prepare',{groupId,reviewToken:groupReview.reviewToken,sourceAttested:true})).operation;
    await running.daemon.onAction(im.click('confirm',operator,dm,tenantKey));
    const firstSave = (await act('status')).operations.find(o=>o.operationId===workflow.operationId);
    assert.equal(firstSave.receipt.revision,1);
    const continuedId = firstSave.receipt.draftId;
    const readContinued = () => request('/drafts/'+continuedId,{token:author});
    const awaitCondition = async (fn) => {
      const until = Date.now()+24_000;
      do { if (await fn()) return; await delay(120); } while (Date.now()<until);
      throw Error('timed out waiting for detached Main workflow');
    };
    const firstMessage = [...im.messages.values()].at(-1).message_id;
    await act('detach');
    await assert.rejects(act('status'));
    await running.daemon.onMessage(message('/recipe name 每周草稿'));
    await awaitCondition(() => {
      const card = im.cards.get([...im.messages.values()].at(-1).card);
      return card.body.elements.some(el=>el.behaviors?.some(b=>b.value.verb==='confirm')) &&
        [...im.messages.values()].at(-1).message_id !== firstMessage;
    });
    await running.daemon.onAction(im.click('confirm',operator,dm,tenantKey));
    await awaitCondition(async ()=>(await readContinued()).revision===2);
    assert.equal((await readContinued()).public.name,'每周草稿');
    const scoped = '把名称中的草稿替换成周报';
    await running.daemon.onMessage(message(scoped));
    assert.deepEqual(modelInputs.at(-1),{instruction:scoped,current:{field:'name',value:'每周草稿'}});
    const priorMessages=im.messages.size;
    await awaitCondition(() => im.messages.size>priorMessages ||
      im.cards.get([...im.messages.values()].at(-1).card).body.elements.some(el=>el.behaviors?.some(b=>b.value.verb==='confirm')));
    await running.daemon.onAction(im.click('confirm',operator,dm,tenantKey));
    await awaitCondition(async ()=>(await readContinued()).revision===3);
    assert.equal((await readContinued()).public.name,'每周周报');
    assert.equal((await readContinued()).config.role,'群角色');
    await awaitCondition(() => savedEvents.some(event=>event.draftId===continuedId && event.revision===3));
    assert.deepEqual(savedEvents.filter(event=>event.draftId===continuedId),[1,2,3].map(revision=>({accountId,draftId:continuedId,revision})));
    console.log('PASS: detached group workflow saved a second revision, then replaced only the exact public field of the same draft through Main and PostgreSQL.');

    const reopenedFlow = await start();handle = reopenedFlow.handle;
    const current=await readContinued();
    const concurrentEdit = (await act('edit',{draftId:continuedId,baseRevision:3})).operation;
    afterPropose = () => request('/drafts/'+continuedId,{method:'PATCH',token:author,revision:3,body:{public:{...current.public,name:'独立第三方修订'},config:current.config}});
    const beforeStale=modelInputs.length;
    await running.daemon.onMessage(message('把名称中的周报替换成草稿'));
    const noCandidate=(await act('status')).operations.find(o=>o.operationId===concurrentEdit.operationId);
    assert.equal(modelInputs.length,beforeStale+1); assert.equal(noCandidate.state,'waiting');
    assert.equal((await readContinued()).public.name,'独立第三方修订');
    await act('cancel',{operationId:concurrentEdit.operationId});
    await act('edit',{draftId:continuedId,baseRevision:4});
    const beforeLogout=modelInputs.length;
    afterDraftRead = () => {generation.abort();actor=alternate;generation=new AbortController();};
    await running.daemon.onMessage(message('把名称中的第三方替换成同事'));
    assert.equal(modelInputs.length,beforeLogout);
    await assert.rejects(act('status')); assert.equal((await readContinued()).revision,4);
    actor=accountId;generation.abort();generation=new AbortController();
    const beforeSwitch=await rebase();
    const pendingEdit=beforeSwitch.operations.find(o=>o.draftId===continuedId && o.baseRevision===4 && o.state==='waiting');
    assert.ok(pendingEdit);
    afterDraftRead=()=>{deviceGeneration+=2;running.ctrl.invalidateStale();};
    await running.daemon.onMessage(message('把名称中的第三方替换成同事'));
    assert.equal(modelInputs.length,beforeLogout);
    await assert.rejects(act('status'));
    await rebase();
    assert.equal((await readContinued()).revision,4);
    console.log('PASS: device A/B/A during the field response discards it without invoking the parser.');
    console.log('PASS: a revision change during parsing invalidated the candidate; logout during the exact field read released no text to the parser.');

    deviceGeneration += 2;
    await assert.rejects(act('status'), /stale device view/);
  } finally {
    running.ctrl.closeAll();
    running.daemon.close();
  }
}
