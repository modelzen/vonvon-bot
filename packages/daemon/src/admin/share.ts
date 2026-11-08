import { createHash, randomUUID } from 'node:crypto';
import { agentIdSchema, openIdSchema, SHARE_GIF_MAX_BYTES, SHARE_PART_BYTES, type AdminReply, type AdminRequest, type ShareTarget } from '@vonvon/protocol';
import { withDeadline } from '../bot/names';
import type { ShareImageFailure, ShareImageReply } from '../bot/share-image';
import { log } from '../core/logger';
import { NotWiredYetError, type AdminBot, type AdminService } from './service';
import type { AgentSettingsView } from './settings-types';

/**
 * now-share N5c: the 此刻 share dialog's 发到飞书. The dialog lists the Bots and their administrators, sends the GIF up in
 * parts on its connection, and one of the Bots sends it to one of its administrators in their private chat. Every
 * refusal is a `refused` reply in words for the user; Feishu's own answer stays in the Bot process's log.
 */

/** An upload nobody added to for this long is dropped. */
export const SHARE_IDLE_MS = 120_000;
/** A Bot whose settings do not come back in this long is listed without administrators. */
const ADMINS_MS = 10_000;

type Refusal = Extract<AdminReply, { kind: 'refused' }>;
type ShareRefusal = 'unknown_bot' | 'bot_offline' | 'not_admin' | 'too_large' | 'bad_image' | 'upload_missing' | 'feishu_failed';
const refused = (code: ShareRefusal, message: string): Refusal => ({ kind: 'refused', code, message });
const offline = (bot: string): Refusal => refused('bot_offline', `「${bot}」没连上飞书，连上以后再发。`);
const notAdmin = (bot: string): Refusal => refused('not_admin', `这个人不是「${bot}」的管理员。分享图只能发给 Bot 的管理员。`);
const tooLarge = (): Refusal => refused('too_large', `分享图超过 ${SHARE_GIF_MAX_BYTES / 1024 / 1024} MB，飞书发不了。少选几项再试。`);
const broken = (): Refusal => refused('bad_image', '分享图没有完整传过来，请重新发送。');
const missing = (): Refusal => refused('upload_missing', '分享图已经失效（2 分钟没有传完，或者连接断开了），请重新发送。');
const unanswered = (bot: string): Refusal => refused('feishu_failed', `「${bot}」没有及时回话，不知道图发出去没有。先去私聊里看一眼，没有再重发。`);

/** What a Bot answered, in the dialog's words (now-share §2: 失败写明原因). */
function failureRefusal(reason: ShareImageFailure, bot: string): Refusal {
  switch (reason) {
    case 'offline': return offline(bot);
    case 'not-admin': return notAdmin(bot);
    case 'too-large': return tooLarge();
    case 'bad-image': return refused('bad_image', '飞书认不出这张图，请重新生成后再发。');
    case 'out-of-range': return refused('feishu_failed', `这个人不在「${bot}」的可用范围里，收不到私聊。`);
    case 'scope': return refused('feishu_failed', `「${bot}」还没开通发图片要的飞书权限，开通并发布新版本后再发。`);
    case 'no-answer': return refused('feishu_failed', '飞书没有回话，不知道图发出去没有。先去私聊里看一眼，没有再重发。');
    case 'failed': return refused('feishu_failed', '飞书没有发出这张图，稍后再试。');
  }
}

/** The name the pages show, and connected as the 此刻 page reads it (server/projection.ts). */
const labelOf = (bot: AdminBot): string => bot.botName || bot.name;
const connectedOf = (bot: AdminBot): boolean => bot.running && bot.connection === 'connected';

/** A Bot's administrators as its 管理员 page reads them: the stored order, the names Feishu gave, who scanned it in. */
async function administrators(service: AdminService, botId: string): Promise<{ openIds: string[]; names: Record<string, string>; creator: string | null } | undefined> {
  if (!service.settings) return undefined;
  try {
    const view = await withDeadline(service.settings.read({ kind: 'agent', botId }), ADMINS_MS, false);
    if (view?.scope.kind !== 'agent') {
      if (!view) log.warn('share', 'admins-late', { ms: ADMINS_MS });
      return undefined;
    }
    const { administrators: { openIds, names }, ownerOpenId } = view as AgentSettingsView;
    return { openIds, names: names ?? {}, creator: ownerOpenId };
  } catch (error) {
    log.warn('share', 'admins-unread', { err: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    return undefined;
  }
}

/** Every Bot here, with the administrators it can send the GIF to; the dialog shows only the connected ones that have some. */
export async function shareTargets(service: AdminService): Promise<Extract<AdminReply, { kind: 'shareTargets' }>> {
  const bots = (await service.listBots()).filter(bot => agentIdSchema.safeParse(bot.appId).success);
  return { kind: 'shareTargets', bots: await Promise.all(bots.map(async (bot): Promise<ShareTarget> => {
    const admins = await administrators(service, bot.appId);
    const recipients = (admins?.openIds ?? []).filter(openId => openIdSchema.safeParse(openId).success).map(openId => {
      const name = admins?.names[openId];
      return { openId, ...(name ? { name } : {}), creator: openId === admins?.creator };
    });
    return { agentId: agentIdSchema.parse(bot.appId), name: labelOf(bot), connected: connectedOf(bot), recipients };
  })) };
}

interface Upload {
  id: string; agentId: string; bot: string; openId: string; bytes: number; sha256: string;
  parts: Buffer[]; received: number; timer: NodeJS.Timeout;
}
type ShareRequest = Extract<AdminRequest, { type: 'shareStart' | 'sharePart' | 'shareSend' }>;
/** shareStart, sharePart and shareSend, one upload per connection (`owner`) at a time, kept in memory only. */
export interface ShareUploads {
  handle(owner: object, request: ShareRequest): Promise<AdminReply>;
  /** The connection closed: its upload goes with it. */
  detach(owner: object): void;
  close(): void;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const isGif = (image: Buffer): boolean => ['GIF87a', 'GIF89a'].includes(image.subarray(0, 6).toString('latin1'));

export function createShareUploads(service: AdminService, options: { idleMs?: number } = {}): ShareUploads {
  const idleMs = options.idleMs ?? SHARE_IDLE_MS;
  const uploads = new Map<object, Upload>();
  /** Connections that closed, so a start answered after its connection went keeps nothing. */
  const gone = new WeakSet<object>();
  /** The last send of each Bot: the next one waits for it. */
  const sending = new Map<string, Promise<void>>();
  const drop = (owner: object): void => {
    const upload = uploads.get(owner);
    if (!upload) return;
    clearTimeout(upload.timer);
    uploads.delete(owner);
  };
  const idle = (owner: object): NodeJS.Timeout => {
    const timer = setTimeout(() => {
      if (uploads.get(owner)?.timer !== timer) return;
      uploads.delete(owner);
      log.info('share', 'upload-expired', { idleMs });
    }, idleMs);
    timer.unref?.();
    return timer;
  };

  async function start(owner: object, request: Extract<ShareRequest, { type: 'shareStart' }>): Promise<AdminReply> {
    const bot = (await service.listBots()).find(item => item.appId === request.agentId);
    if (!bot) return refused('unknown_bot', '这台设备上没有这个 Bot，刷新后再试。');
    const name = labelOf(bot);
    if (!connectedOf(bot)) return offline(name);
    const admins = await administrators(service, bot.appId);
    if (!admins) return refused('bot_offline', `「${name}」现在没有回应，稍后再试。`);
    if (!admins.openIds.includes(request.openId)) return notAdmin(name);
    if (request.bytes > SHARE_GIF_MAX_BYTES) return tooLarge();
    if (gone.has(owner)) return missing();
    // A new upload replaces the one this connection left.
    drop(owner);
    const upload: Upload = { id: randomUUID(), agentId: bot.appId, bot: name, openId: request.openId, bytes: request.bytes, sha256: request.sha256, parts: [], received: 0, timer: idle(owner) };
    uploads.set(owner, upload);
    return { kind: 'shareUpload', uploadId: upload.id, received: 0 };
  }

  function part(owner: object, request: Extract<ShareRequest, { type: 'sharePart' }>): AdminReply {
    const upload = uploads.get(owner);
    if (upload?.id !== request.uploadId) return missing();
    const data = BASE64.test(request.data) && request.data.length % 4 === 0 ? Buffer.from(request.data, 'base64') : undefined;
    // In order, each within its size, never past what was declared: anything else and the upload starts over.
    if (!data?.length || data.length > SHARE_PART_BYTES || request.index !== upload.parts.length || upload.received + data.length > upload.bytes) {
      drop(owner);
      return broken();
    }
    upload.parts.push(data);
    upload.received += data.length;
    clearTimeout(upload.timer);
    upload.timer = idle(owner);
    return { kind: 'shareUpload', uploadId: upload.id, received: upload.received };
  }

  async function deliver(upload: Upload, image: Buffer): Promise<AdminReply> {
    let reply: ShareImageReply;
    try { reply = await service.shareImage!(upload.agentId, { openId: upload.openId, image: image.toString('base64'), sha256: upload.sha256 }); }
    catch (error) {
      if (error instanceof NotWiredYetError) throw error;
      log.warn('share', 'send-unknown', { err: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      return unanswered(upload.bot);
    }
    if (!reply.ok) {
      log.info('share', 'send-refused', { reason: reply.reason });
      return failureRefusal(reply.reason, upload.bot);
    }
    return { kind: 'shareSent', messageId: reply.messageId };
  }

  async function send(owner: object, request: Extract<ShareRequest, { type: 'shareSend' }>): Promise<AdminReply> {
    const upload = uploads.get(owner);
    if (upload?.id !== request.uploadId) return missing();
    // Taken whatever the answer: memory is freed once this send ends.
    drop(owner);
    const image = Buffer.concat(upload.parts);
    upload.parts = [];
    if (image.length !== upload.bytes || createHash('sha256').update(image).digest('hex') !== upload.sha256) return broken();
    if (!isGif(image)) return refused('bad_image', '分享图不是 GIF，请重新生成后再发。');
    // One send per Bot at a time: a second one waits for the first, and goes out even if its window left meanwhile, since
    // the person clicked 发送.
    const run = (sending.get(upload.agentId) ?? Promise.resolve()).then(() => deliver(upload, image));
    const tail = run.then(() => undefined, () => undefined);
    sending.set(upload.agentId, tail);
    void tail.then(() => { if (sending.get(upload.agentId) === tail) sending.delete(upload.agentId); });
    return run;
  }

  return {
    handle(owner, request) {
      if (!service.shareImage) throw new NotWiredYetError('发分享图');
      if (request.type === 'shareStart') return start(owner, request);
      if (request.type === 'sharePart') return Promise.resolve(part(owner, request));
      return send(owner, request);
    },
    detach(owner) {
      gone.add(owner);
      drop(owner);
    },
    close() {
      for (const owner of [...uploads.keys()]) drop(owner);
    },
  };
}
