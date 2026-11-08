import {agentIdSchema, openIdSchema, SHARE_GIF_MAX_BYTES, SHARE_PART_BYTES, type AdminReply, type AdminRequest, type AgentId, type ShareTarget} from '@vonvon/protocol';
import type {ShareRecording, ShareShell} from './client-context';

/** now-share N5a: the share dialog's recordings and its 发到飞书, apart from the dialog so they can be tested. */
type Admin = (request: AdminRequest) => Promise<AdminReply>;
export type ShareRecipient = ShareTarget['recipients'][number];
export type ShareTargetsRead = {kind: 'loading'} | {kind: 'ready'; bots: ShareTarget[]} | {kind: 'old'} | {kind: 'failed'; message: string};
export const SHARE_OLD_DAEMON = '这台设备上的 Vonvon Bot 升级后可用';

/** now-share N5c: a daemon that can send the GIF says so in its serverInfo. */
export const sharesGif = (capabilities: readonly string[]) => capabilities.includes('share.gif');
/** A daemon from before now-share N5c does not know the request, or answers it unsupported. Through the desktop the
 * error is a plain Error whose code may not cross into the page, so the capability is what tells. */
const unknownRequest = (error: unknown) => {
  const code = error instanceof Error ? (error as {code?: unknown}).code : undefined;
  return code === 'unsupported' || code === 'invalid_request';
};
/** `capabilities`: the shown device's; without `share.gif` it is not asked. */
export async function readShareTargets(admin: Admin, capabilities: readonly string[]): Promise<ShareTargetsRead> {
  if (!sharesGif(capabilities)) return {kind: 'old'};
  try {
    const reply = await admin({type: 'shareTargets'});
    if (reply.kind === 'shareTargets') return {kind: 'ready', bots: reply.bots};
    return {kind: 'failed', message: reply.kind === 'refused' ? reply.message : '读取可发的 Bot 失败。'};
  } catch (error) {
    if (unknownRequest(error)) return {kind: 'old'};
    return {kind: 'failed', message: error instanceof Error ? error.message : '读取可发的 Bot 失败。'};
  }
}

/** Only a connected Bot with an admin can send the GIF. */
export const shareSenders = (bots: readonly ShareTarget[]) => bots.filter(bot => bot.connected && bot.recipients.length > 0);
/** As the 管理员 page names someone Feishu does not. */
export const recipientName = (recipient: ShareRecipient) => recipient.name || `…${recipient.openId.slice(-6)}`;

export type ShareChoice = {agentId: AgentId; openId: string};
/** The Bot used last, else the first; on it, the person chosen last, else its creator while still an admin, else the
 * first admin. */
export function shareChoice(bots: readonly ShareTarget[], last?: ShareChoice): {bot: ShareTarget; recipient: ShareRecipient} | undefined {
  const senders = shareSenders(bots);
  const bot = senders.find(item => item.agentId === last?.agentId) ?? senders[0];
  if (!bot) return undefined;
  const recipient = (bot.agentId === last?.agentId ? bot.recipients.find(item => item.openId === last.openId) : undefined)
    ?? bot.recipients.find(item => item.creator) ?? bot.recipients[0]!;
  return {bot, recipient};
}
/** One choice per device shown, kept on this computer. */
const choiceKey = (device: string) => `vonvon-share-recipient:${device}`;
export function lastShareChoice(storage: Pick<Storage, 'getItem'>, device: string): ShareChoice | undefined {
  try {
    const value = JSON.parse(storage.getItem(choiceKey(device)) ?? 'null') as Partial<Record<keyof ShareChoice, unknown>> | null;
    const agentId = agentIdSchema.safeParse(value?.agentId), openId = openIdSchema.safeParse(value?.openId);
    if (agentId.success && openId.success) return {agentId: agentId.data, openId: openId.data};
  } catch { /* an unreadable entry is no choice */ }
  return undefined;
}
export function rememberShareChoice(storage: Pick<Storage, 'setItem'>, device: string, choice: ShareChoice): void {
  try { storage.setItem(choiceKey(device), JSON.stringify(choice)); } catch { /* a full or blocked storage forgets */ }
}

/** One recording for one set of options: 复制 and 发到飞书 share it, other options discard it, and so does closing. */
export function shareRecordings(shell: Pick<ShareShell, 'record' | 'discard'>) {
  let current: {key: string; recording: Promise<ShareRecording>} | undefined;
  function drop() {
    const old = current;
    current = undefined;
    // Still recording: discarded once it is done.
    void old?.recording.then(recording => shell.discard(recording.id)).catch(() => undefined);
  }
  return {
    get(key: string, model: () => unknown, onProgress?: (fraction: number) => void): Promise<ShareRecording> {
      if (current?.key === key) return current.recording;
      drop();
      const entry = {key, recording: shell.record(model(), onProgress)};
      current = entry;
      entry.recording.catch(() => {if (current === entry) current = undefined;});
      return entry.recording;
    },
    has: (key: string) => current?.key === key,
    /** Whether `recording` is still the one kept: once dropped, it is only discarded. */
    holds: (recording: Promise<ShareRecording>) => current?.recording === recording,
    drop,
  };
}

export class ShareSendError extends Error {}
function base64(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}
function expect<K extends AdminReply['kind']>(reply: AdminReply, kind: K): Extract<AdminReply, {kind: K}> {
  if (reply.kind === kind) return reply as Extract<AdminReply, {kind: K}>;
  throw new ShareSendError(reply.kind === 'refused' ? reply.message : '发送没有完成，请重试。');
}
/** The GIF goes up in SHARE_PART_BYTES parts (a frame holds 4 MB, and the device shown may be remote), then the Bot
 * sends it. A refusal at any step throws the daemon's own words. */
export async function sendShareGif(admin: Admin, gif: Uint8Array, recording: Pick<ShareRecording, 'sha256'>, choice: ShareChoice,
  onPart?: (sent: number, total: number) => void): Promise<string> {
  if (gif.byteLength > SHARE_GIF_MAX_BYTES) throw new ShareSendError('这张动图超过 10 MB，飞书发不了。');
  const total = Math.ceil(gif.byteLength / SHARE_PART_BYTES);
  const {uploadId} = expect(await admin({type: 'shareStart', agentId: choice.agentId, openId: choice.openId, bytes: gif.byteLength, sha256: recording.sha256}), 'shareUpload');
  for (let index = 0; index < total; index++) {
    const data = base64(gif.subarray(index * SHARE_PART_BYTES, (index + 1) * SHARE_PART_BYTES));
    expect(await admin({type: 'sharePart', uploadId, index, data}), 'shareUpload');
    onPart?.(index + 1, total);
  }
  return expect(await admin({type: 'shareSend', uploadId}), 'shareSent').messageId;
}
export function shareErrorText(error: unknown, fallback: string): string {
  if (unknownRequest(error)) return SHARE_OLD_DAEMON + '。';
  return error instanceof Error && error.message ? error.message : fallback;
}
