import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcError, type VonvonClient } from '@vonvon/client/browser';
import {
  agentIdSchema,
  groupIdSchema,
  recipeInstallRequestSchema,
  recipeUseReplySchema,
  type DesktopRecipeSourceRequest,
  type RecipeUseRequest,
  type RecipeUseReply,
  type RecipeInstallRequest,
} from '@vonvon/protocol';
import type { NativeAccount } from '../src/account-session.js';
import { RecipeUseController } from '../src/recipe-use.js';
import { RecipeJournal } from '../src/recipe-use-journal.js';
import { createDesktopFacades } from '../src/facade.js';
import { desktopChannels } from '../src/ipc-contract.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recipe-use-'));
  roots.push(root);
  const path = join(root, 'journal.json'),
    accountId = randomUUID(),
    recipeId = randomUUID(),
    versionId = randomUUID(),
    deviceId = randomUUID();
  const botId = agentIdSchema.parse('cli_test'),
    groupId = groupIdSchema.parse('oc_test'),
    operationId = randomUUID();
  const binary = (n: number) => Buffer.alloc(32, n).toString('base64url');
  const pk = binary(1),
    commitment = binary(2),
    ticket = binary(3),
    serverKey = binary(4);
  const bytes = Buffer.from(
    JSON.stringify({
      schema: 1,
      recipeId,
      versionId,
      authorId: accountId,
      revision: 1,
      access: 'direct',
      role: '角色🦉',
    }),
  );
  const manifest = bytes.toString('base64url'),
    sha = createHash('sha256').update(bytes).digest('hex');
  const state = {
    seq: 0,
    signal: new AbortController(),
    key: pk,
    at: (_step: string) => {},
    changedReview: false,
    conflict: false,
    cloudCancel: 'cancelled',
    local: 'prepared',
    issued: false,
    saved: false,
    versionRight: true,
    expired: false,
    negative: true,
    dropCommit: false,
    dropCreation: false,
    unsaved: false,
    unsent: false,
    binding: false,
    callsToBind: 0,
    loseBind: false,
    otherBinding: false,
    sourceEpoch: 1,
    ignores: 0,

    found: false,
    extra: false,
    wrongPreview: false,
    steps: [] as string[],
    commitIds: [] as string[],
    createIds: [] as string[],
    rawAuths: [] as string[],
    userValues: [] as unknown[],
  };
  function step(name: string) {
    state.steps.push(name);
    state.at(name);
  }
  const account = {
    lease: (id: string) => (id === accountId ? state.signal.signal : undefined),
    request: async (id: string, path: string, init?: RequestInit, before?: () => void) => {
      expect(id).toBe(accountId);
      before?.();
      const action = path.split('/').pop()!;
      step('cloud:' + action);
      if (action === 'latest-install-version')
        return Response.json({
          recipeId,
          versionId: 'bbbbbbbb-0000-4000-8000-000000000001',
          version: '新',
          revision: 2,
          entitled: true,
        });
      if (action === 'install-preview')
        return state.versionRight
          ? Response.json({
              accountId,
              recipeId,
              versionId,
              manifest,
              manifestSha256: sha,
              ...(state.extra && { ticket }),
            })
          : Response.json({ error: { code: 'forbidden' } }, { status: 403 });
      if (action === 'authorize') {
        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({
          purpose: 'installBoundRole',
          generation: 1,
          versionId,
          manifestSha256: sha,
          targetPublicKey: pk,
          nonceCommitment: commitment,
        });
        state.rawAuths.push(path);
        if (state.expired) return Response.json({ error: { code: 'operation_expired' } }, { status: 410 });
        return Response.json({
          ...body,
          accountId,
          operationId,
          status: 'authorized',
          serverPublicKey: serverKey,
          ticket,
          deadline: Date.now() + 300000,
        });
      }
      if (action === 'cancel') return Response.json({ operationId, status: state.cloudCancel });
      throw Error('unexpected cloud action ' + action);
    },
  } as NativeAccount;
  function status() {
    return {
      kind: 'status',
      operationId,
      groupId,
      status: state.local,
      issuerState: state.saved ? 'authorized' : state.issued ? 'issuing' : 'unissued',
      stillNeedsTicket: !state.saved && state.local === 'prepared',
    };
  }
  const client = {
    device: async () => {
      step('identity');
      return {
        kind: 'deviceStatus',
        status: {
          device: { id: deviceId, publicKey: state.key, name: '设备' },
          remote: { port: 8000, addresses: [] },
          clients: { total: 1, active: 1 },
        },
      };
    },
    recipeInstall: async (raw: RecipeInstallRequest) => {
      const r = recipeInstallRequestSchema.parse(raw);
      step('daemon:' + r.type);
      const kind: string = r.type;
      if (kind === 'issuing') {
        state.issued = true;
        return status();
      }
      if (kind === 'reconcile') {
        if (state.negative) state.local = 'rejected';
        return status();
      }
      if (r.type === 'source' || r.type === 'ignoreVersion') {
        if (r.type === 'ignoreVersion') ++state.ignores;
        return {
          kind: 'source',
          groupId,
          source: {
            recipeId,
            versionId,
            authorId: accountId,
            revision: 1,
            installedAt: 42,
            sourceToken: String(state.sourceEpoch).repeat(64),
          },
        };
      }
      if (r.type === 'createdGroup') return { kind: r.type, groupId: state.found ? groupId : null };
      if (r.type === 'status' || r.type === 'cancel') {
        if (r.type === 'cancel' && !state.issued && !state.saved) state.local = 'rejected';
        return status();
      }
      if (r.type === 'prepare') {
        expect(r.manifest).toBe(manifest);
        const review = {
          groupId,
          reviewToken: (state.changedReview ? 'c' : 'b').repeat(64),
          currentRole: state.changedReview ? '已变更' : '本地职责',
          incomingRole: state.wrongPreview ? '别的职责' : '角色🦉',
          roleChoiceRequired: state.conflict,
          setupChoiceRequired: false,
        };
        if (state.conflict && (!r.resolution || r.reviewToken !== review.reviewToken))
          return { kind: 'review', ...review };
        return {
          kind: 'prepared',
          ...review,
          targetPublicKey: pk,
          nonceCommitment: commitment,
          operationId,
          versionId,
          manifestSha256: sha,
        };
      }
      if (r.type === 'commit') {
        if (!state.saved) expect(r.authorization?.ticket).toBe(ticket);
        state.commitIds.push(r.operationId);
        state.saved = true;
        state.local = 'applied';
        if (state.dropCommit) {
          state.dropCommit = false;
          throw Error('lost committed response');
        }
        return status();
      }
      throw Error('unexpected ' + kind);
    },
    snapshot: async () => ({
      memberships: [
        ...(state.binding ? [{ agentId: botId, groupId }] : []),
        ...(state.otherBinding ? [{ agentId: 'cli_other', groupId }] : []),
      ],
    }),
    run: async () => {
      ++state.callsToBind;
      state.binding = true;
      if (state.loseBind) throw Error('lost bind result');
      return { kind: 'applied', revision: 7 };
    },
    collaboration: async (r: { requestId: string }) => {
      state.createIds.push(r.requestId);
      if (state.unsaved) throw new RpcError('created_unsaved', '已建好但未连接', { groupId });
      if (state.unsent) throw new RpcError('conflict', 'HTTP 未发出', { creationRefused: true });
      state.found = true;
      if (state.dropCreation) throw Error('lost creation receipt');
      return { kind: 'applied', project: { chatId: groupId } };
    },
  } as unknown as VonvonClient;
  let ctrl: RecipeUseController;
  function restart() {
    ctrl = new RecipeUseController(
      account,
      (id) => {
        const seq = state.seq;
        return {
          viewId: id,
          client,
          pairedKey: id === 'local' ? undefined : pk,
          check() {
            if (seq !== state.seq) throw Error('view changed');
          },
        };
      },
      new RecipeJournal(path),
    );
  }
  restart();
  const { shell } = createDesktopFacades({
    invoke: async (channel, raw) => {
      if (channel === desktopChannels.subscribe) return { ok: true, value: undefined };
      if (channel === desktopChannels.recipeSource)
        return { ok: true, value: await ctrl.source(raw as DesktopRecipeSourceRequest) };
      expect(channel).toBe(desktopChannels.recipeUse);
      const value = recipeUseReplySchema.parse(await ctrl.request(raw as RecipeUseRequest));
      state.userValues.push(value);
      return { ok: true, value };
    },
    receive: () => () => {},
  });
  const main = (r: RecipeUseRequest) => shell.recipeUse.request(r);
  const begin = (inGroup = true) =>
    main({ type: 'begin', accountId, recipeId, versionId, viewId: deviceId, botId, ...(inGroup && { groupId }) });
  const handle = (r: RecipeUseReply) => {
    if (!('handle' in r)) throw Error('missing handle');
    return r.handle;
  };
  return {
    accountId,
    source: (r: DesktopRecipeSourceRequest) => shell.recipeSource.request(r),
    deviceId,
    groupId,
    operationId,
    ticket,
    versionId,
    state,
    begin,
    main,
    handle,
    restart,
    path,
    botId,
  };
}
describe('native recipe installation', () => {
  it('denies public-but-unacquired versions and malformed exact previews before preparing a target', async () => {
    const f = fixture();
    f.state.versionRight = false;
    await expect(f.begin()).rejects.toThrow('安装权');
    f.state.versionRight = true;
    f.state.extra = true;
    await expect(f.begin()).rejects.toThrow();
    expect(f.state.steps).not.toContain('daemon:prepare');
  });
  it('never displays a daemon preview whose incoming text differs from the exact cloud bytes', async () => {
    const f = fixture();
    f.state.wrongPreview = true;
    await expect(f.begin()).rejects.toThrow('回执无效');
    expect(f.state.userValues).toEqual([]);
    expect(f.state.rawAuths).toEqual([]);
  });
  it('replaces an outdated resolution with a fresh review and requests no authorization until confirmation', async () => {
    const f = fixture();
    f.state.conflict = true;
    const original = await f.begin();
    if (original.kind !== 'review') throw Error();
    f.state.changedReview = true;
    const changed = await f.main({
      type: 'resolve',
      handle: original.handle,
      reviewToken: original.review.reviewToken,
      resolution: { role: { kind: 'replace' } },
    });
    expect(changed).toMatchObject({ kind: 'review', review: { currentRole: '已变更' } });
    expect(f.state.rawAuths).toEqual([]);
    if (changed.kind !== 'review') throw Error();
    expect(
      await f.main({
        type: 'resolve',
        handle: changed.handle,
        reviewToken: changed.review.reviewToken,
        resolution: { role: { kind: 'keep' } },
      }),
    ).toMatchObject({ kind: 'prepared' });
  });
  it.each([
    'cloud:install-preview',
    'daemon:prepare',
    'daemon:status',
    'daemon:issuing',
    'cloud:authorize',
    'after-authorization',
  ] as const)('invalidates both account relogin and A→B→A during %s', async (point) => {
    for (const change of ['account', 'device']) {
      const f = fixture();
      let seen = false;
      f.state.at = (s) => {
        if (
          s !== point &&
          !(point === 'after-authorization' && s === 'identity' && f.state.steps.includes('cloud:authorize'))
        )
          return;
        seen = true;
        if (change === 'device') f.state.seq += 2;
        else {
          f.state.signal.abort();
          f.state.signal = new AbortController();
        }
      };
      const run = async () => {
        const r = await f.begin();
        return f.main({ type: 'confirm', handle: f.handle(r) });
      };
      await expect(run()).rejects.toThrow();
      expect(seen).toBe(true);
      expect(f.state.commitIds).toEqual([]);
    }
  });
  it('never treats an unavailable ticket as a definitive cancellation', async () => {
    const f = fixture();
    const p = await f.begin();
    f.state.expired = true;
    f.state.negative = false;
    expect(await f.main({ type: 'confirm', handle: f.handle(p) })).toMatchObject({ kind: 'pending' });
    expect(f.state.steps).toContain('daemon:reconcile');
    expect(f.state.commitIds).toEqual([]);
    f.state.negative = true;
    const rejected = await f.main({ type: 'resume', handle: f.handle(p) });
    expect(rejected).toMatchObject({ kind: 'rejected' });
    const retry = await f.main({ type: 'retry', handle: f.handle(p) });
    expect(retry).toMatchObject({ kind: 'prepared', groupId: f.groupId });
    expect(f.state.createIds).toHaveLength(0);
  });
  it('cancels an unissued operation in the original account before recording the local result', async () => {
    const f = fixture();
    const p = await f.begin();
    expect(await f.main({ type: 'cancel', handle: f.handle(p) })).toMatchObject({ kind: 'rejected' });
    expect(f.state.steps.indexOf('cloud:cancel')).toBeLessThan(f.state.steps.indexOf('daemon:cancel'));
    expect(f.state.steps).not.toContain('cloud:authorize');
  });
  it('refuses a changed key after cloud authorization', async () => {
    const f = fixture();
    const prepared = await f.begin();
    f.state.at = (step) => {
      if (step === 'cloud:authorize') f.state.key = Buffer.alloc(32, 6).toString('base64url');
    };
    await expect(f.main({ type: 'confirm', handle: f.handle(prepared) })).rejects.toThrow();
    expect(f.state.commitIds).toEqual([]);
  });
  it('recovers a lost applied reply after a process restart without a new prepare, authorization or group', async () => {
    const f = fixture();
    const prep = await f.begin();
    f.state.dropCommit = true;
    await expect(f.main({ type: 'confirm', handle: f.handle(prep) })).rejects.toThrow();
    f.restart();
    const recovered = await f.begin();
    expect(recovered.kind).toBe('pending');
    expect(await f.main({ type: 'resume', handle: f.handle(recovered) })).toMatchObject({
      kind: 'applied',
      groupId: f.groupId,
    });
    expect(f.state.commitIds).toEqual([f.operationId, f.operationId]);
    expect(f.state.rawAuths).toHaveLength(1);
    expect(f.state.steps.filter((s) => s === 'daemon:prepare')).toHaveLength(1);
    for (const key of [f.ticket, 'nonceCommitment', 'authorization', 'serverPublicKey']) {
      expect(JSON.stringify(f.state.userValues)).not.toContain(key);
      expect(readFileSync(f.path, 'utf8')).not.toContain(key);
    }
  });
  it('keeps the confirmed physical group from created_unsaved across restart and repairs only the existing binding', async () => {
    const f = fixture();
    f.state.unsaved = true;
    const create = {
      action: 'createProject' as const,
      agentId: f.botId,
      name: '已建群',
      folder: { kind: 'default' as const },
      tool: 'codex' as const,
      conversation: 'threads' as const,
    };
    const first = await f.main({ type: 'join', handle: f.handle(await f.begin(false)), input: create });
    expect(first).toMatchObject({
      kind: 'pending',
      phase: 'joining',
      recovery: { state: 'createdUnsaved', groupId: f.groupId, name: '已建群' },
    });
    expect(JSON.parse(readFileSync(f.path, 'utf8')).rows[0].intent).toEqual(create);
    f.restart();
    const pending = await f.begin(false);
    expect(pending).toMatchObject({ kind: 'pending', recovery: { groupId: f.groupId } });
    const bind = {
      type: 'bindGroup' as const,
      agentId: f.botId,
      groupId: f.groupId,
      projectName: '连接回来',
      folder: { kind: 'default' as const },
      tool: 'codex' as const,
      conversation: 'threads' as const,
    };
    await expect(
      f.main({
        type: 'repairJoin',
        handle: f.handle(pending),
        input: { ...bind, groupId: groupIdSchema.parse('oc_other') },
      }),
    ).rejects.toThrow();
    expect(await f.main({ type: 'repairJoin', handle: f.handle(pending), input: bind })).toMatchObject({
      kind: 'prepared',
      groupId: f.groupId,
    });
    expect(f.state.createIds).toHaveLength(1);
    expect(f.state.callsToBind).toBe(1);
  });
  it('allows a fresh user choice after a definitive refusal and ending tracking on a genuinely unknown group', async () => {
    const f = fixture();
    f.state.unsent = true;
    const pick = await f.begin(false);
    const create = {
      action: 'createProject' as const,
      agentId: f.botId,
      name: '测试群',
      folder: { kind: 'default' as const },
      tool: 'codex' as const,
      conversation: 'threads' as const,
    };
    await expect(f.main({ type: 'join', handle: f.handle(pick), input: create })).rejects.toThrow();
    expect(JSON.parse(readFileSync(f.path, 'utf8')).rows).toHaveLength(0);
    f.state.unsent = false;
    f.state.dropCreation = true;
    await f.main({ type: 'join', handle: f.handle(pick), input: create });
    f.state.found = false;
    f.restart();
    const paused = await f.begin(false);
    expect(await f.main({ type: 'resume', handle: f.handle(paused) })).toMatchObject({
      kind: 'pending',
      recovery: { state: 'unknown' },
    });
    expect(await f.main({ type: 'dismissJoin', handle: f.handle(paused) })).toEqual({ kind: 'closed' });
    expect(f.state.createIds).toHaveLength(2);
    expect(f.state.callsToBind).toBe(0);
  });
  it('refuses a latest-version response after the installed binding changes during the cloud read', async () => {
    const f = fixture();
    f.state.at = (step) => {
      if (step === 'cloud:latest-install-version') ++f.state.sourceEpoch;
    };
    await expect(
      f.source({ type: 'check', botId: f.botId, viewId: f.deviceId, groupId: f.groupId, accountId: f.accountId }),
    ).rejects.toThrow(/改变|变化/);
    expect(f.state.steps.filter((s) => s === 'daemon:source')).toHaveLength(2);
  });
  it('repairs an unknown join by verified physical ID and recovers a lost binding receipt without a second bind', async () => {
    const f = fixture();
    f.state.dropCreation = true;
    f.state.otherBinding = true;
    const create = {
      action: 'createProject' as const,
      agentId: f.botId,
      name: '同名群',
      folder: { kind: 'default' as const },
      tool: 'codex' as const,
      conversation: 'threads' as const,
    };
    const pick = await f.begin(false);
    const pending = await f.main({ type: 'join', handle: f.handle(pick), input: create });
    f.state.found = false;
    const existing = { type: 'existingBinding' as const, agentId: f.botId, groupId: f.groupId };
    await expect(f.main({ type: 'repairJoin', handle: f.handle(pending), input: existing })).rejects.toThrow(
      '绑定已改变',
    );
    const bind = {
      type: 'bindGroup' as const,
      agentId: f.botId,
      groupId: f.groupId,
      projectName: '手动绑定',
      folder: { kind: 'default' as const },
      tool: 'codex' as const,
      conversation: 'threads' as const,
    };
    f.state.loseBind = true;
    expect(await f.main({ type: 'repairJoin', handle: f.handle(pending), input: bind })).toMatchObject({
      kind: 'pending',
      recovery: { groupId: f.groupId },
    });
    f.restart();
    const restored = await f.begin(false);
    expect(await f.main({ type: 'repairJoin', handle: f.handle(restored), input: existing })).toMatchObject({
      kind: 'prepared',
      groupId: f.groupId,
    });
    expect(f.state.callsToBind).toBe(1);
    expect(f.state.createIds).toHaveLength(1);
  });
  it('rejects a stale source token from a displayed update before sending ignore to the daemon', async () => {
    const f = fixture(),
      target = { botId: f.botId, viewId: f.deviceId, groupId: f.groupId, accountId: f.accountId };
    const shown = await f.source({ type: 'check', ...target });
    if (!shown.source || !shown.latest) throw Error('missing shown update');
    ++f.state.sourceEpoch;
    await expect(
      f.source({
        type: 'ignore',
        ...target,
        sourceToken: shown.source.sourceToken,
        installedVersionId: shown.source.versionId,
        versionId: shown.latest.versionId,
      }),
    ).rejects.toThrow('来源已改变');
    expect(f.state.ignores).toBe(0);
  });
  it('retains an uncertain created group, looks up the original creation UUID and prepares that group once', async () => {
    const f = fixture();
    f.state.dropCreation = true;
    const pick = await f.begin(false);
    const join = await f.main({
      type: 'join',
      handle: f.handle(pick),
      input: {
        action: 'createProject',
        agentId: f.botId,
        name: '新群',
        folder: { kind: 'default' },
        tool: 'codex',
        conversation: 'threads',
      },
    });
    expect(join).toMatchObject({ kind: 'pending', phase: 'joining' });
    f.restart();
    const again = await f.begin(false);
    expect(await f.main({ type: 'resume', handle: f.handle(again) })).toMatchObject({
      kind: 'prepared',
      groupId: f.groupId,
    });
    expect(f.state.createIds).toHaveLength(1);
    expect(JSON.parse(readFileSync(f.path, 'utf8')).rows[0]).toMatchObject({
      id: f.state.createIds[0],
      groupId: f.groupId,
      operation: { id: f.operationId },
    });
  });
  it('shows in-progress when cloud redemption wins cancellation, then finishes the same operation', async () => {
    const f = fixture();
    const p = await f.begin();
    f.state.cloudCancel = 'in_progress';
    f.state.saved = true;
    f.state.local = 'in_progress';
    const res = await f.main({ type: 'cancel', handle: f.handle(p) });
    expect(res).toMatchObject({ kind: 'pending', phase: 'installing' });
    expect(f.state.steps).not.toContain('daemon:cancel');
    expect(await f.main({ type: 'resume', handle: f.handle(p) })).toMatchObject({ kind: 'applied' });
    expect(f.state.commitIds).toEqual([f.operationId]);
  });
});
