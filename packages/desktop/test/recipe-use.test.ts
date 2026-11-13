import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { VonvonClient } from '@vonvon/client/browser';
import {
  agentIdSchema,
  groupIdSchema,
  recipeInstallRequestSchema,
  recipeUseReplySchema,
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
    collaboration: async (r: { requestId: string }) => {
      state.createIds.push(r.requestId);
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
