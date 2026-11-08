import {describe, expect, it, vi} from 'vitest';
import {RpcError} from '@vonvon/client/browser';
import {agentIdSchema, SHARE_GIF_MAX_BYTES, SHARE_PART_BYTES, type AdminReply, type AdminRequest, type ShareTarget} from '@vonvon/protocol';
import type {ShareRecording} from '../src/client-context';
import {revealLabel, sendBlocked} from '../src/ShareDialog';
import {
  lastShareChoice, readShareTargets, recipientName, rememberShareChoice, SHARE_OLD_DAEMON, shareChoice, shareErrorText,
  shareRecordings, sendShareGif, ShareSendError,
} from '../src/share-send';

const a = agentIdSchema.parse('cli_a'), b = agentIdSchema.parse('cli_b'), c = agentIdSchema.parse('cli_c');
const person = (tail: string, fields: {name?: string; creator?: boolean} = {}) => ({openId: `ou_${tail}`, creator: false, ...fields});
const bots: ShareTarget[] = [
  {agentId: c, name: '小码', connected: false, recipients: [person('c1', {creator: true})]},
  {agentId: a, name: 'Vonvon', connected: true, recipients: [person('a1', {name: '林夏'}), person('a2', {name: '阿杰', creator: true})]},
  {agentId: b, name: '周全', connected: true, recipients: [person('b1', {name: '老秦'}), person('b2')]},
  {agentId: agentIdSchema.parse('cli_none'), name: 'Elaine', connected: true, recipients: []},
];

describe('who the GIF goes to', () => {
  it('defaults to the first connected Bot with an admin and its creator', () => {
    expect(shareChoice(bots)).toMatchObject({bot: {agentId: a}, recipient: {openId: 'ou_a2'}});
    expect(shareChoice([bots[2]!])).toMatchObject({bot: {agentId: b}, recipient: {openId: 'ou_b1'}});
    expect(shareChoice([bots[0]!, bots[3]!])).toBeUndefined();
  });
  it('comes back to the last choice while it still stands', () => {
    expect(shareChoice(bots, {agentId: b, openId: 'ou_b2'})).toMatchObject({bot: {agentId: b}, recipient: {openId: 'ou_b2'}});
    expect(shareChoice(bots, {agentId: b, openId: 'ou_gone'})).toMatchObject({bot: {agentId: b}, recipient: {openId: 'ou_b1'}});
    expect(shareChoice(bots, {agentId: c, openId: 'ou_c1'})).toMatchObject({bot: {agentId: a}, recipient: {openId: 'ou_a2'}});
    expect(shareChoice(bots, {agentId: a, openId: 'ou_b2'})).toMatchObject({bot: {agentId: a}, recipient: {openId: 'ou_a2'}});
  });
  it('remembers one choice per device and ignores what it cannot read', () => {
    const store = new Map<string, string>();
    const storage = {getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value)};
    rememberShareChoice(storage, 'local', {agentId: b, openId: 'ou_b2'});
    expect(lastShareChoice(storage, 'local')).toEqual({agentId: b, openId: 'ou_b2'});
    expect(lastShareChoice(storage, 'remote-1')).toBeUndefined();
    store.set('vonvon-share-recipient:remote-1', '{not json');
    expect(lastShareChoice(storage, 'remote-1')).toBeUndefined();
    store.set('vonvon-share-recipient:remote-1', JSON.stringify({agentId: b, openId: 'oc_group'}));
    expect(lastShareChoice(storage, 'remote-1')).toBeUndefined();
    expect(() => rememberShareChoice({setItem: () => {throw new Error('full');}}, 'local', {agentId: a, openId: 'ou_a1'})).not.toThrow();
  });
  it('names an admin Feishu does not name as the 管理员 page does', () => {
    expect(recipientName(person('abcdef123456', {name: '林夏'}))).toBe('林夏');
    expect(recipientName(person('abcdef123456'))).toBe('…123456');
  });
});

describe('whether 发到飞书 can be used', () => {
  const admin = (reply: () => Promise<AdminReply>) => vi.fn(async (_request: AdminRequest) => reply());
  const sends = ['device', 'share.gif'];
  it('reads the Bots that can send from a daemon that says it can', async () => {
    const read = admin(async () => ({kind: 'shareTargets', bots}));
    await expect(readShareTargets(read, sends)).resolves.toEqual({kind: 'ready', bots});
    expect(read).toHaveBeenCalledWith({type: 'shareTargets'});
    expect(sendBlocked({kind: 'ready', bots})).toBeUndefined();
  });
  it('does not ask a daemon without share.gif: through the desktop its error says nothing', async () => {
    const read = admin(async () => {throw new Error('当前 daemon 不支持此操作。');});
    await expect(readShareTargets(read, ['device', 'attention.group'])).resolves.toEqual({kind: 'old'});
    await expect(readShareTargets(read, [])).resolves.toEqual({kind: 'old'});
    expect(read).not.toHaveBeenCalled();
  });
  it('tells an old daemon from a failure', async () => {
    for (const code of ['unsupported', 'invalid_request']) {
      await expect(readShareTargets(admin(async () => {throw new RpcError(code, 'x');}), sends)).resolves.toEqual({kind: 'old'});
      // As the desktop's facade throws it, when the code gets through.
      await expect(readShareTargets(admin(async () => {throw Object.assign(new Error('x'), {code});}), sends)).resolves.toEqual({kind: 'old'});
    }
    await expect(readShareTargets(admin(async () => {throw new RpcError('outcome_unknown', '网络断开');}), sends)).resolves.toEqual({kind: 'failed', message: '网络断开'});
    await expect(readShareTargets(admin(async () => ({kind: 'refused', message: '只有管理员能做'})), sends)).resolves.toEqual({kind: 'failed', message: '只有管理员能做'});
    expect(sendBlocked({kind: 'old'})).toBe(SHARE_OLD_DAEMON);
    expect(sendBlocked({kind: 'failed', message: '网络断开'})).toBe('读不到能发图的 Bot：网络断开');
    expect(sendBlocked({kind: 'loading'})).toContain('正在读取');
  });
  it('says why no Bot can send', () => {
    expect(sendBlocked({kind: 'ready', bots: [bots[0]!]})).toBe('有管理员的 Bot 都没连上，连上后才能私聊发图。');
    expect(sendBlocked({kind: 'ready', bots: [bots[3]!]})).toBe('还没有 Bot 设置管理员，图只能私聊发给管理员。');
    expect(sendBlocked({kind: 'ready', bots: []})).toBe('还没有 Bot 设置管理员，图只能私聊发给管理员。');
  });
  it('names the file manager by platform', () => {
    expect(revealLabel('macos')).toBe('在访达中显示');
    expect(revealLabel('windows')).toBe('在资源管理器中显示');
    expect(revealLabel(undefined)).toBe('在访达中显示');
  });
});

const recording = (id: string): ShareRecording => ({id, bytes: 10, sha256: 'a'.repeat(64), width: 904, height: 1050, durationMs: 4000});
function shell() {
  const pending: {id: string; resolve: () => void; reject: (error: Error) => void}[] = [];
  let next = 0;
  const record = vi.fn((_model: unknown, _progress?: (fraction: number) => void) => {
    const id = `r${++next}`;
    return new Promise<ShareRecording>((resolve, reject) => pending.push({id, resolve: () => resolve(recording(id)), reject}));
  });
  const discard = vi.fn(async (_id: string) => undefined);
  return {record, discard, pending};
}
const settle = () => new Promise(done => setTimeout(done, 0));

describe('one recording per set of options', () => {
  it('reuses the recording for the same options, so 复制 then 发到飞书 records once', async () => {
    const fake = shell(), recordings = shareRecordings(fake), model = vi.fn(() => ({model: 1}));
    const first = recordings.get('k1', model);
    const again = recordings.get('k1', model);
    fake.pending[0]!.resolve();
    expect(await again).toEqual(await first);
    expect(fake.record).toHaveBeenCalledOnce();
    expect(model).toHaveBeenCalledOnce();
    expect(recordings.has('k1')).toBe(true);
    expect(recordings.has('k2')).toBe(false);
    expect(recordings.holds(first)).toBe(true);
  });
  it('discards the old recording when the options change, even one still recording', async () => {
    const fake = shell(), recordings = shareRecordings(fake);
    const first = recordings.get('k1', () => ({}));
    void recordings.get('k2', () => ({}));
    expect(recordings.holds(first)).toBe(false);
    expect(fake.discard).not.toHaveBeenCalled();
    fake.pending[0]!.resolve();
    await settle();
    expect(fake.discard).toHaveBeenCalledExactlyOnceWith('r1');
    expect(recordings.has('k2')).toBe(true);
    fake.pending[1]!.resolve();
    recordings.drop();
    await settle();
    expect(fake.discard).toHaveBeenLastCalledWith('r2');
    expect(recordings.has('k2')).toBe(false);
  });
  it('records again after a failed recording', async () => {
    const fake = shell(), recordings = shareRecordings(fake);
    const failed = recordings.get('k1', () => ({}));
    fake.pending[0]!.reject(new Error('录制失败'));
    await expect(failed).rejects.toThrow('录制失败');
    expect(recordings.has('k1')).toBe(false);
    void recordings.get('k1', () => ({}));
    expect(fake.record).toHaveBeenCalledTimes(2);
    expect(fake.discard).not.toHaveBeenCalled();
  });
});

describe('sending the GIF through the daemon', () => {
  const choice = {agentId: a, openId: 'ou_a2'};
  function daemon(refuse?: AdminRequest['type']) {
    const parts: Buffer[] = [];
    const admin = vi.fn(async (request: AdminRequest): Promise<AdminReply> => {
      if (request.type === refuse) return {kind: 'refused', message: `${refuse} 被拒绝`};
      if (request.type === 'shareStart') return {kind: 'shareUpload', uploadId: 'u1', received: 0};
      if (request.type === 'sharePart') {
        parts.push(Buffer.from(request.data, 'base64'));
        return {kind: 'shareUpload', uploadId: request.uploadId, received: parts.reduce((sum, part) => sum + part.length, 0)};
      }
      if (request.type === 'shareSend') return {kind: 'shareSent', messageId: 'om_sent'};
      throw new Error(`unexpected ${request.type}`);
    });
    return {admin, parts};
  }
  it('sends the GIF in numbered parts of at most SHARE_PART_BYTES, then has the Bot send it', async () => {
    const gif = Uint8Array.from({length: SHARE_PART_BYTES * 2 + 1234}, (_, index) => index * 7 % 256);
    const {admin, parts} = daemon(), progress = vi.fn();
    await expect(sendShareGif(admin, gif, recording('r1'), choice, progress)).resolves.toBe('om_sent');
    expect(admin.mock.calls[0]![0]).toEqual({type: 'shareStart', agentId: a, openId: 'ou_a2', bytes: gif.byteLength, sha256: 'a'.repeat(64)});
    const sent = admin.mock.calls.map(([request]) => request).filter(request => request.type === 'sharePart');
    expect(sent.map(request => request.type === 'sharePart' && request.index)).toEqual([0, 1, 2]);
    expect(sent.every(request => request.type === 'sharePart' && request.uploadId === 'u1' && request.data.length <= Math.ceil(SHARE_PART_BYTES / 3) * 4)).toBe(true);
    expect(Buffer.concat(parts).equals(Buffer.from(gif))).toBe(true);
    expect(progress.mock.calls).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(admin.mock.calls.at(-1)![0]).toEqual({type: 'shareSend', uploadId: 'u1'});
  });
  it.each(['shareStart', 'sharePart', 'shareSend'] as const)('stops with the daemon’s own words when %s is refused', async step => {
    const {admin} = daemon(step);
    await expect(sendShareGif(admin, new Uint8Array(10), recording('r1'), choice)).rejects.toThrow(`${step} 被拒绝`);
    const types = admin.mock.calls.map(([request]) => request.type);
    expect(types.at(-1)).toBe(step);
    if (step !== 'shareSend') expect(types).not.toContain('shareSend');
  });
  it('refuses a GIF Feishu would not take before uploading anything', async () => {
    const {admin} = daemon();
    await expect(sendShareGif(admin, new Uint8Array(SHARE_GIF_MAX_BYTES + 1), recording('r1'), choice)).rejects.toThrow(ShareSendError);
    expect(admin).not.toHaveBeenCalled();
  });
  it('words an unexpected reply and an old daemon', async () => {
    const admin = vi.fn(async (): Promise<AdminReply> => ({kind: 'shareSent', messageId: 'x'}));
    await expect(sendShareGif(admin, new Uint8Array(10), recording('r1'), choice)).rejects.toThrow('发送没有完成，请重试。');
    expect(shareErrorText(new RpcError('unsupported', 'x'), '发送失败')).toBe(SHARE_OLD_DAEMON + '。');
    expect(shareErrorText(Object.assign(new Error('x'), {code: 'invalid_request'}), '发送失败')).toBe(SHARE_OLD_DAEMON + '。');
    expect(shareErrorText(new Error('网络断开'), '发送失败')).toBe('网络断开');
    expect(shareErrorText('?', '发送失败')).toBe('发送失败');
  });
});
