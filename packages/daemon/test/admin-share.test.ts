import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { adminReplySchema, SHARE_GIF_MAX_BYTES, SHARE_PART_BYTES, type AdminReply, type AdminRequest } from '@vonvon/protocol';
import type { ShareImageReply, ShareImageRequest } from '../src/bot/share-image';
import { createAdminService, type AdminBot, type AdminService } from '../src/admin/service';
import { createShareUploads, SHARE_IDLE_MS } from '../src/admin/share';
import { log } from '../src/core/logger';
import { adminRpc, type AdminConnection } from '../src/server/rpc/admin';

const ALICE = 'ou_fixture_alice';
const BOB = 'ou_fixture_bob';
const CAROL = 'ou_fixture_carol';
const bot = (appId: string, extra: Partial<AdminBot> = {}): AdminBot => ({
  appId, name: `${appId} app`, botName: `Bot ${appId.slice(4)}`, tenant: 'feishu', active: true, current: false,
  running: true, connection: 'connected', completionReminder: { mode: 'failures', longTaskMinutes: 3 }, ...extra,
});
/** What the 管理员 page reads: the stored list, Feishu's names, the creator. */
const view = (openIds: string[], names: Record<string, string>, ownerOpenId: string | null) => ({ scope: { kind: 'agent' }, ownerOpenId, administrators: { openIds, names, revision: 'r' } });

let bots: AdminBot[];
let admins: Record<string, ReturnType<typeof view> | Error>;
let shareImage: ReturnType<typeof vi.fn<(botId: string, request: ShareImageRequest) => Promise<ShareImageReply>>>;
let service: AdminService;
beforeEach(() => {
  vi.spyOn(log, 'warn').mockImplementation(() => {});
  vi.spyOn(log, 'info').mockImplementation(() => {});
  bots = [bot('cli_fixture_a'), bot('cli_fixture_b')];
  admins = { cli_fixture_a: view([BOB, ALICE], { [ALICE]: 'Alice' }, ALICE), cli_fixture_b: view([CAROL], {}, null) };
  shareImage = vi.fn(async () => ({ ok: true as const, messageId: 'om_fixture' }));
  service = {
    listBots: async () => bots,
    settings: { read: async (scope: { botId: string }) => { const value = admins[scope.botId]; if (value instanceof Error) throw value; return value; } },
    shareImage,
  } as unknown as AdminService;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const gif = (size: number, fill = 7): Buffer => { const image = Buffer.alloc(size, fill); image.write('GIF89a', 0, 'latin1'); return image; };
const sha = (image: Buffer): string => createHash('sha256').update(image).digest('hex');
const connect = (shares = createShareUploads(service)): AdminConnection => ({ startedAt: 0, peer: {} as AdminConnection['peer'], shares });
async function ask(request: AdminRequest, connection?: AdminConnection): Promise<AdminReply> {
  const outcome = await adminRpc(service, vi.fn(), request, connection);
  if (outcome.kind !== 'read') throw new Error(`not a read: ${outcome.kind}`);
  return adminReplySchema.parse(outcome.value);
}
const start = (connection: AdminConnection, image: Buffer, extra: { agentId?: string; openId?: string } = {}) =>
  ask({ type: 'shareStart', agentId: extra.agentId ?? 'cli_fixture_a', openId: extra.openId ?? ALICE, bytes: image.length, sha256: sha(image) } as AdminRequest, connection);
const part = (connection: AdminConnection, uploadId: string, index: number, data: Buffer | string) =>
  ask({ type: 'sharePart', uploadId, index, data: typeof data === 'string' ? data : data.toString('base64') }, connection);
const send = (connection: AdminConnection, uploadId: string) => ask({ type: 'shareSend', uploadId }, connection);
const uploadIdOf = (reply: AdminReply): string => { if (reply.kind !== 'shareUpload') throw new Error(JSON.stringify(reply)); return reply.uploadId; };
/** Starts and sends every part of `image`, as the dialog does. */
async function upload(connection: AdminConnection, image: Buffer, extra?: { agentId?: string; openId?: string }): Promise<string> {
  const uploadId = uploadIdOf(await start(connection, image, extra));
  for (let index = 0; index * SHARE_PART_BYTES < image.length; index++) await part(connection, uploadId, index, image.subarray(index * SHARE_PART_BYTES, (index + 1) * SHARE_PART_BYTES));
  return uploadId;
}
const refusal = (code: string, message?: string | RegExp) => ({ kind: 'refused', code, message: message === undefined ? expect.any(String) : typeof message === 'string' ? message : expect.stringMatching(message) });

it('lists every Bot with its administrators in stored order, their names as the 管理员 page has them and the creator', async () => {
  bots.push(bot('cli_fixture_c', { running: true, connection: 'reconnecting' }), bot('cli_fixture_d', { running: false, connection: undefined, active: false }));
  admins.cli_fixture_c = new Error('settings unreadable');
  admins.cli_fixture_d = view(['not-an-open-id', CAROL], {}, CAROL);
  expect(await ask({ type: 'shareTargets' })).toEqual({ kind: 'shareTargets', bots: [
    { agentId: 'cli_fixture_a', name: 'Bot fixture_a', connected: true, recipients: [{ openId: BOB, creator: false }, { openId: ALICE, name: 'Alice', creator: true }] },
    { agentId: 'cli_fixture_b', name: 'Bot fixture_b', connected: true, recipients: [{ openId: CAROL, creator: false }] },
    { agentId: 'cli_fixture_c', name: 'Bot fixture_c', connected: false, recipients: [] },
    { agentId: 'cli_fixture_d', name: 'Bot fixture_d', connected: false, recipients: [{ openId: CAROL, creator: true }] },
  ] });
});

it('refuses a start for a Bot that is not here, not connected, or a person not on its list, before taking any bytes', async () => {
  const connection = connect();
  const image = gif(100);
  expect(await start(connection, image, { agentId: 'cli_fixture_x' })).toEqual(refusal('unknown_bot', '这台设备上没有这个 Bot，刷新后再试。'));
  bots[0] = bot('cli_fixture_a', { connection: 'reconnecting' });
  expect(await start(connection, image)).toEqual(refusal('bot_offline', '「Bot fixture_a」没连上飞书，连上以后再发。'));
  bots[0] = bot('cli_fixture_a', { running: false });
  expect(await start(connection, image)).toEqual(refusal('bot_offline'));
  bots[0] = bot('cli_fixture_a');
  expect(await start(connection, image, { openId: CAROL })).toEqual(refusal('not_admin', '这个人不是「Bot fixture_a」的管理员。分享图只能发给 Bot 的管理员。'));
  admins.cli_fixture_a = new Error('no answer');
  expect(await start(connection, image)).toEqual(refusal('bot_offline', '「Bot fixture_a」现在没有回应，稍后再试。'));
  admins.cli_fixture_a = view([ALICE], {}, ALICE);
  // The request schema stops it first; the store refuses it all the same.
  const outcome = await adminRpc(service, vi.fn(), { type: 'shareStart', agentId: 'cli_fixture_a', openId: ALICE, bytes: SHARE_GIF_MAX_BYTES + 1, sha256: sha(image) } as AdminRequest, connection);
  expect(outcome).toEqual({ kind: 'read', value: refusal('too_large', '分享图超过 10 MB，飞书发不了。少选几项再试。') });
  expect(shareImage).not.toHaveBeenCalled();
});

it('puts the parts together in order and sends the whole GIF through the Bot, then frees it', async () => {
  const connection = connect();
  const image = gif(Math.floor(SHARE_PART_BYTES * 2.5), 9);
  const started = await start(connection, image);
  expect(started).toEqual({ kind: 'shareUpload', uploadId: expect.any(String), received: 0 });
  const uploadId = uploadIdOf(started);
  expect(await part(connection, uploadId, 0, image.subarray(0, SHARE_PART_BYTES))).toEqual({ kind: 'shareUpload', uploadId, received: SHARE_PART_BYTES });
  expect(await part(connection, uploadId, 1, image.subarray(SHARE_PART_BYTES, 2 * SHARE_PART_BYTES))).toEqual({ kind: 'shareUpload', uploadId, received: 2 * SHARE_PART_BYTES });
  expect(await part(connection, uploadId, 2, image.subarray(2 * SHARE_PART_BYTES))).toEqual({ kind: 'shareUpload', uploadId, received: image.length });
  expect(await send(connection, uploadId)).toEqual({ kind: 'shareSent', messageId: 'om_fixture' });
  expect(shareImage).toHaveBeenCalledExactlyOnceWith('cli_fixture_a', { openId: ALICE, image: image.toString('base64'), sha256: sha(image) });
  expect(await send(connection, uploadId)).toEqual(refusal('upload_missing', /已经失效/));
  expect(await part(connection, uploadId, 3, Buffer.from('x'))).toEqual(refusal('upload_missing'));
});

it('starts over on a part out of order, past the declared size, too big or not base64', async () => {
  const connection = connect();
  const image = gif(SHARE_PART_BYTES + 10);
  let uploadId = uploadIdOf(await start(connection, image));
  expect(await part(connection, uploadId, 1, image.subarray(0, 10))).toEqual(refusal('bad_image', '分享图没有完整传过来，请重新发送。'));
  // Dropped with it: the rest of that upload is refused too.
  expect(await part(connection, uploadId, 0, image.subarray(0, 10))).toEqual(refusal('upload_missing'));
  uploadId = uploadIdOf(await start(connection, image));
  await part(connection, uploadId, 0, image.subarray(0, SHARE_PART_BYTES));
  expect(await part(connection, uploadId, 1, Buffer.alloc(11))).toEqual(refusal('bad_image'));
  uploadId = uploadIdOf(await start(connection, gif(SHARE_PART_BYTES * 3)));
  expect(await part(connection, uploadId, 0, Buffer.alloc(SHARE_PART_BYTES + 1))).toEqual(refusal('bad_image'));
  for (const data of ['R0lG*DlhAQ==', 'R0lGODlhA', '====']) {
    uploadId = uploadIdOf(await start(connection, image));
    expect(await part(connection, uploadId, 0, data)).toEqual(refusal('bad_image'));
  }
  expect(await part(connection, 'no-such-upload', 0, image.subarray(0, 10))).toEqual(refusal('upload_missing'));
  expect(shareImage).not.toHaveBeenCalled();
});

it('sends only the bytes that were declared: all of them, the same sha256, a GIF', async () => {
  const connection = connect();
  const image = gif(1000);
  let uploadId = uploadIdOf(await start(connection, image));
  await part(connection, uploadId, 0, image.subarray(0, 999));
  expect(await send(connection, uploadId)).toEqual(refusal('bad_image', '分享图没有完整传过来，请重新发送。'));
  uploadId = uploadIdOf(await start(connection, image));
  await part(connection, uploadId, 0, gif(1000, 8));
  expect(await send(connection, uploadId)).toEqual(refusal('bad_image'));
  const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(100)]);
  uploadId = await upload(connection, png);
  expect(await send(connection, uploadId)).toEqual(refusal('bad_image', '分享图不是 GIF，请重新生成后再发。'));
  expect(shareImage).not.toHaveBeenCalled();
});

it('drops an upload idle for two minutes, each part starting the two minutes again', async () => {
  vi.useFakeTimers();
  const connection = connect();
  const image = gif(30);
  const uploadId = uploadIdOf(await start(connection, image));
  await vi.advanceTimersByTimeAsync(SHARE_IDLE_MS - 1_000);
  expect(await part(connection, uploadId, 0, image.subarray(0, 10))).toMatchObject({ kind: 'shareUpload', received: 10 });
  await vi.advanceTimersByTimeAsync(SHARE_IDLE_MS - 1_000);
  expect(await part(connection, uploadId, 1, image.subarray(10, 20))).toMatchObject({ kind: 'shareUpload', received: 20 });
  await vi.advanceTimersByTimeAsync(SHARE_IDLE_MS);
  expect(await part(connection, uploadId, 2, image.subarray(20))).toEqual(refusal('upload_missing', '分享图已经失效（2 分钟没有传完，或者连接断开了），请重新发送。'));
});

it('drops an upload when its connection closes, and keeps none for a connection that closed while it started', async () => {
  const shares = createShareUploads(service);
  const connection = connect(shares);
  const image = gif(30);
  let uploadId = await upload(connection, image);
  shares.detach(connection.peer);
  expect(await send(connection, uploadId)).toEqual(refusal('upload_missing'));
  const late = connect(shares);
  let answer!: () => void;
  service.listBots = () => new Promise(resolve => { answer = () => resolve(bots); });
  const starting = start(late, image);
  shares.detach(late.peer);
  answer();
  expect(await starting).toEqual(refusal('upload_missing'));
  // A connection that is still open is not touched by another's close.
  service.listBots = async () => bots;
  const open = connect(shares);
  uploadId = await upload(open, image);
  shares.detach(late.peer);
  expect(await send(open, uploadId)).toEqual({ kind: 'shareSent', messageId: 'om_fixture' });
});

it('keeps one upload per connection: a new start replaces it, and another connection cannot use it', async () => {
  const shares = createShareUploads(service);
  const [one, two] = [connect(shares), connect(shares)];
  const image = gif(30);
  const first = uploadIdOf(await start(one, image));
  const second = await upload(one, image);
  expect(second).not.toBe(first);
  expect(await part(one, first, 0, image)).toEqual(refusal('upload_missing'));
  expect(await send(two, second)).toEqual(refusal('upload_missing'));
  expect(await send(one, second)).toEqual({ kind: 'shareSent', messageId: 'om_fixture' });
});

it('sends one GIF per Bot at a time, another Bot alongside', async () => {
  const shares = createShareUploads(service);
  const [one, two, three] = [connect(shares), connect(shares), connect(shares)];
  const answers: Array<(reply: ShareImageReply) => void> = [];
  shareImage.mockImplementation(() => new Promise(resolve => { answers.push(resolve); }));
  const [a1, a2, b] = [await upload(one, gif(30, 1)), await upload(two, gif(30, 2)), await upload(three, gif(30, 3), { agentId: 'cli_fixture_b', openId: CAROL })];
  const sent = [send(one, a1), send(two, a2), send(three, b)];
  await vi.waitFor(() => expect(shareImage).toHaveBeenCalledTimes(2));
  expect(shareImage.mock.calls.map(([agentId]) => agentId)).toEqual(['cli_fixture_a', 'cli_fixture_b']);
  answers[0]!({ ok: false, reason: 'out-of-range' });
  answers[1]!({ ok: true, messageId: 'om_b' });
  await vi.waitFor(() => expect(shareImage).toHaveBeenCalledTimes(3));
  expect(shareImage.mock.calls[2]![0]).toBe('cli_fixture_a');
  answers[2]!({ ok: true, messageId: 'om_a2' });
  expect(await Promise.all(sent)).toEqual([
    refusal('feishu_failed', '这个人不在「Bot fixture_a」的可用范围里，收不到私聊。'),
    { kind: 'shareSent', messageId: 'om_a2' },
    { kind: 'shareSent', messageId: 'om_b' },
  ]);
});

it("puts each of the Bot's refusals in the dialog's words, and a Bot that did not answer as not known", async () => {
  const connection = connect();
  const cases: Array<[ShareImageReply | Error, string, RegExp]> = [
    [{ ok: false, reason: 'offline' }, 'bot_offline', /没连上飞书/],
    [{ ok: false, reason: 'not-admin' }, 'not_admin', /不是「Bot fixture_a」的管理员/],
    [{ ok: false, reason: 'too-large' }, 'too_large', /超过 10 MB/],
    [{ ok: false, reason: 'bad-image' }, 'bad_image', /飞书认不出这张图/],
    [{ ok: false, reason: 'out-of-range' }, 'feishu_failed', /^这个人不在「Bot fixture_a」的可用范围里，收不到私聊。$/],
    [{ ok: false, reason: 'scope' }, 'feishu_failed', /还没开通发图片要的飞书权限/],
    [{ ok: false, reason: 'no-answer' }, 'feishu_failed', /不知道图发出去没有/],
    [{ ok: false, reason: 'failed' }, 'feishu_failed', /飞书没有发出这张图/],
    [new Error('Bot 进程 90000ms 未响应'), 'feishu_failed', /「Bot fixture_a」没有及时回话，不知道图发出去没有/],
  ];
  for (const [answer, code, message] of cases) {
    shareImage.mockImplementationOnce(async () => { if (answer instanceof Error) throw answer; return answer; });
    expect(await send(connection, await upload(connection, gif(30)))).toEqual(refusal(code, message));
  }
  // The log says why, never to whom.
  expect(JSON.stringify([vi.mocked(log.warn).mock.calls, vi.mocked(log.info).mock.calls])).not.toMatch(/ou_fixture/);
});

it('is unsupported on a connection without an upload store, and a Bot process that is not here answers offline', async () => {
  await expect(ask({ type: 'shareSend', uploadId: 'x' })).rejects.toMatchObject({ code: 'unsupported' });
  const executeShareImage = vi.fn(async () => undefined);
  const real = createAdminService({ executeShareImage });
  expect(await real.shareImage!('cli_fixture_a', { openId: ALICE, image: 'R0lG', sha256: 'f'.repeat(64) })).toEqual({ ok: false, reason: 'offline' });
  executeShareImage.mockResolvedValueOnce({ ok: true } as never);
  await expect(real.shareImage!('cli_fixture_a', { openId: ALICE, image: 'R0lG', sha256: 'f'.repeat(64) })).rejects.toThrow();
  await expect(createAdminService({}).shareImage!('cli_fixture_a', { openId: ALICE, image: 'R0lG', sha256: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'NOT_WIRED_YET' });
});
