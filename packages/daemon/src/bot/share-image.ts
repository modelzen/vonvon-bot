import { createHash } from 'node:crypto';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { uploadBuffer } from '../card/outbound-images';
import { isAdmin, type AppConfig } from '../config/schema';
import { log } from '../core/logger';
import { feishuError, scopeDenial } from '../utils/feishu-error';
import { withDeadline } from './names';

/**
 * now-share N5c: the 此刻 share GIF, sent by this Bot to one of its administrators in their private chat. The host has
 * checked the bytes (admin/share.ts); this process holds the live admin list and the Feishu client, so it checks the
 * person and the connection again here.
 */
export interface ShareImageRequest { openId: string; /** the GIF, base64 */ image: string; sha256: string }
/** Why nothing was sent, for the host to put in the dialog's words: Feishu's own answer goes to the log only. */
export const SHARE_IMAGE_FAILURES = ['offline', 'not-admin', 'too-large', 'bad-image', 'out-of-range', 'scope', 'no-answer', 'failed'] as const;
export type ShareImageFailure = typeof SHARE_IMAGE_FAILURES[number];
export type ShareImageReply = { ok: true; messageId: string } | { ok: false; reason: ShareImageFailure };
/** The answer as the host takes it from the Bot process. */
export const shareImageReplySchema: z.ZodType<ShareImageReply> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), messageId: z.string().min(1).max(200) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(SHARE_IMAGE_FAILURES) }).strict(),
]);

/** A 10 MB upload on a slow link, well past the 15 s a reply's images get. */
const SHARE_UPLOAD_MS = 60_000;
const SHARE_SEND_MS = 15_000;
/** Feishu's codes (上传图片, 发送消息): the person is outside the app's availability, the image is over its size limit, or
 * not an image it reads. */
const OUT_OF_RANGE = 230013;
const TOO_LARGE = 234006;
const NOT_AN_IMAGE = 234011;

const withoutOpenIds = (text: string): string => text.replace(/ou_[\w-]+/g, 'ou_…').slice(0, 200);
/** Feishu's code and words, or the error's name and message: never the request, which holds the person and the image. */
function logged(phase: 'upload' | 'send', failure: unknown): void {
  const said = feishuError(failure);
  log.warn('share', 'feishu-refused', said
    ? { phase, code: said.code, ...(said.msg ? { msg: withoutOpenIds(said.msg) } : {}) }
    : { phase, err: withoutOpenIds(failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure)) });
}
function reasonOf(failure: unknown): ShareImageFailure {
  const code = feishuError(failure)?.code;
  if (scopeDenial(failure)) return 'scope';
  if (code === OUT_OF_RANGE) return 'out-of-range';
  if (code === TOO_LARGE) return 'too-large';
  if (code === NOT_AN_IMAGE) return 'bad-image';
  return 'failed';
}

export async function sendShareImage(deps: { channel: Pick<LarkChannel, 'rawClient' | 'getConnectionStatus'>; cfg: AppConfig }, request: ShareImageRequest): Promise<ShareImageReply> {
  const { channel, cfg } = deps;
  if (channel.getConnectionStatus?.()?.state !== 'connected') return { ok: false, reason: 'offline' };
  // The list as it is now: someone taken off since the dialog read it gets nothing.
  if (!isAdmin(cfg, request.openId)) return { ok: false, reason: 'not-admin' };
  const image = Buffer.from(request.image, 'base64');
  let imageKey: string | undefined;
  try { imageKey = await uploadBuffer(channel, image, SHARE_UPLOAD_MS); }
  catch (error) {
    logged('upload', error);
    return { ok: false, reason: reasonOf(error) };
  }
  if (!imageKey) return { ok: false, reason: 'failed' };
  // Again: the upload may have taken a minute.
  if (!isAdmin(cfg, request.openId)) return { ok: false, reason: 'not-admin' };
  // Feishu keeps one message per uuid for an hour: sent again after an answer that never came, the same GIF to the same
  // person is not sent twice.
  const uuid = `share-${createHash('sha256').update(`${request.sha256}:${request.openId}`).digest('hex').slice(0, 32)}`;
  let sent: unknown;
  try {
    sent = await withDeadline(channel.rawClient.im.v1.message.create({ params: { receive_id_type: 'open_id' },
      data: { receive_id: request.openId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }), uuid } }), SHARE_SEND_MS, false);
  } catch (error) {
    logged('send', error);
    // No code from Feishu: the request may have reached it all the same.
    return { ok: false, reason: feishuError(error) ? reasonOf(error) : 'no-answer' };
  }
  if (sent === undefined) {
    log.warn('share', 'send-late', { ms: SHARE_SEND_MS });
    return { ok: false, reason: 'no-answer' };
  }
  if (feishuError(sent)) {
    logged('send', sent);
    return { ok: false, reason: reasonOf(sent) };
  }
  const messageId = (sent as { data?: { message_id?: unknown } } | null)?.data?.message_id;
  if (typeof messageId !== 'string' || !messageId) {
    log.warn('share', 'no-message-id', {});
    return { ok: false, reason: 'no-answer' };
  }
  log.info('share', 'sent', { bytes: image.length });
  return { ok: true, messageId };
}
