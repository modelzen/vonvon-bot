import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import { log } from '../src/core/logger';
import { sendShareImage, shareImageReplySchema, type ShareImageRequest } from '../src/bot/share-image';

const ALICE = 'ou_fixture_alice';
const BOB = 'ou_fixture_bob';
const image = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64, 5)]);
const request = (openId = ALICE): ShareImageRequest => ({ openId, image: image.toString('base64'), sha256: createHash('sha256').update(image).digest('hex') });
const cfg = { accounts: { app: { id: 'cli_fixture_a', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: ALICE, admins: [ALICE, BOB] } } } as unknown as AppConfig;
/** What Feishu answers a refused call with, the way the SDK throws it. */
const feishuRefusal = (code: number, msg: string) => Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { code, msg } } });

let state: string;
let uploadImage: ReturnType<typeof vi.fn>;
let createMessage: ReturnType<typeof vi.fn>;
const channel = () => ({
  getConnectionStatus: () => ({ state }),
  rawClient: { im: { v1: { image: { create: uploadImage }, message: { create: createMessage } } } },
}) as unknown as Parameters<typeof sendShareImage>[0]['channel'];
beforeEach(() => {
  vi.spyOn(log, 'warn').mockImplementation(() => {});
  vi.spyOn(log, 'info').mockImplementation(() => {});
  state = 'connected';
  uploadImage = vi.fn(async () => ({ image_key: 'img_v3_fixture' }));
  createMessage = vi.fn(async () => ({ code: 0, msg: 'success', data: { message_id: 'om_fixture' } }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const logged = (): string => JSON.stringify([vi.mocked(log.warn).mock.calls, vi.mocked(log.info).mock.calls]);

it('uploads the GIF with the image upload, then sends it to the person as an image in their private chat', async () => {
  expect(await sendShareImage({ channel: channel(), cfg }, request())).toEqual({ ok: true, messageId: 'om_fixture' });
  expect(uploadImage).toHaveBeenCalledExactlyOnceWith({ data: { image_type: 'message', image } });
  expect(createMessage).toHaveBeenCalledExactlyOnceWith({ params: { receive_id_type: 'open_id' },
    data: { receive_id: ALICE, msg_type: 'image', content: JSON.stringify({ image_key: 'img_v3_fixture' }), uuid: expect.stringMatching(/^share-[0-9a-f]{32}$/) } });
  // The same GIF to the same person is one message on Feishu's side; to someone else, another.
  await sendShareImage({ channel: channel(), cfg }, request());
  await sendShareImage({ channel: channel(), cfg }, request(BOB));
  const uuids = createMessage.mock.calls.map(([call]) => (call as { data: { uuid: string } }).data.uuid);
  expect(uuids[1]).toBe(uuids[0]);
  expect(uuids[2]).not.toBe(uuids[0]);
  expect(uuids.every(uuid => uuid.length <= 50)).toBe(true);
  expect(logged()).not.toMatch(/ou_fixture|R0lGODlh/);
});

it('sends nothing when the long connection is down or the person is no longer an administrator', async () => {
  state = 'reconnecting';
  expect(await sendShareImage({ channel: channel(), cfg }, request())).toEqual({ ok: false, reason: 'offline' });
  state = 'connected';
  expect(await sendShareImage({ channel: channel(), cfg }, request('ou_fixture_carol'))).toEqual({ ok: false, reason: 'not-admin' });
  expect(uploadImage).not.toHaveBeenCalled();
  expect(createMessage).not.toHaveBeenCalled();
});

it("reads Feishu's refusals of the upload and the message, keeping its words in the log without the person", async () => {
  const cases: Array<['upload' | 'send', unknown, string]> = [
    ['upload', feishuRefusal(234006, 'The file size exceeds the limit.'), 'too-large'],
    ['upload', feishuRefusal(234011, "Can't regonnize the image format."), 'bad-image'],
    ['upload', feishuRefusal(99991672, 'Access denied. One of the following scopes is required: [im:resource]'), 'scope'],
    ['upload', new Error('image.create timed out after 60000ms'), 'failed'],
    ['send', feishuRefusal(230013, `Bot has NO availability to this user. receive_id: ${ALICE}`), 'out-of-range'],
    ['send', { code: 230013, msg: 'Bot has NO availability to this user.' }, 'out-of-range'],
    ['send', feishuRefusal(230020, 'This operation triggers the frequency limit.'), 'failed'],
    ['send', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'no-answer'],
  ];
  for (const [phase, failure, reason] of cases) {
    const call = phase === 'upload' ? uploadImage : createMessage;
    if (failure instanceof Error) call.mockRejectedValueOnce(failure);
    else call.mockResolvedValueOnce(failure);
    expect(await sendShareImage({ channel: channel(), cfg }, request())).toEqual({ ok: false, reason });
  }
  expect(createMessage).toHaveBeenCalledTimes(4);
  const text = logged();
  expect(text).toMatch(/230013/);
  expect(text).toMatch(/Bot has NO availability to this user/);
  expect(text).not.toMatch(/ou_fixture|R0lGODlh/);
});

it('fails plainly when the upload gives no key or the message no id, and says a message that never answered may have gone', async () => {
  uploadImage.mockResolvedValueOnce({});
  expect(await sendShareImage({ channel: channel(), cfg }, request())).toEqual({ ok: false, reason: 'failed' });
  expect(createMessage).not.toHaveBeenCalled();
  createMessage.mockResolvedValueOnce({ code: 0, data: {} });
  expect(await sendShareImage({ channel: channel(), cfg }, request())).toEqual({ ok: false, reason: 'no-answer' });
  vi.useFakeTimers();
  createMessage.mockImplementationOnce(() => new Promise(() => {}));
  const late = sendShareImage({ channel: channel(), cfg }, request());
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await late).toEqual({ ok: false, reason: 'no-answer' });
});

it('takes only answers of the shape the host expects across the process boundary', () => {
  expect(shareImageReplySchema.parse({ ok: true, messageId: 'om_x' })).toEqual({ ok: true, messageId: 'om_x' });
  expect(shareImageReplySchema.parse({ ok: false, reason: 'out-of-range' })).toEqual({ ok: false, reason: 'out-of-range' });
  for (const value of [{ ok: true }, { ok: false, reason: 'other' }, { ok: true, messageId: 'om_x', extra: 1 }, undefined]) expect(shareImageReplySchema.safeParse(value).success).toBe(false);
});
