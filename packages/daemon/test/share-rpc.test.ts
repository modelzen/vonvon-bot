import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { SHARE_PART_BYTES, type Request } from '@vonvon/protocol';
import type { AdminBot, AdminService } from '../src/admin/service';
import { fakeService, socketClient, startFixture } from './server-fixture';

/** Whose uploads the API dropped as their connections closed. */
const detached = vi.hoisted(() => ({ owners: [] as object[] }));
vi.mock('../src/admin/share', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/admin/share')>();
  return { ...actual, createShareUploads: (...args: Parameters<typeof actual.createShareUploads>) => {
    const shares = actual.createShareUploads(...args);
    return { ...shares, detach: (owner: object) => { detached.owners.push(owner); shares.detach(owner); } };
  } };
});

const ALICE = 'ou_fixture_alice';
const bot: AdminBot = { appId: 'cli_fixture_a', name: 'a', botName: 'Bot A', tenant: 'feishu', active: true, current: true, running: true, connection: 'connected', completionReminder: { mode: 'failures', longTaskMinutes: 3 } };

it('takes the GIF up in parts over a desktop connection and sends it, and drops what a closed connection left', async () => {
  const shareImage = vi.fn(async () => ({ ok: true as const, messageId: 'om_fixture' }));
  const service = fakeService({
    listBots: async () => [bot], shareImage,
    settings: { read: async () => ({ scope: { kind: 'agent' }, ownerOpenId: ALICE, administrators: { openIds: [ALICE], names: { [ALICE]: 'Alice' }, revision: 'r' } }) } as unknown as AdminService['settings'],
  });
  const fixture = await startFixture(service);
  const client = await socketClient(fixture.api.port, fixture.credential, undefined, 3000, 'desktop');
  const other = await socketClient(fixture.api.port, fixture.credential, undefined, 3000, 'desktop');
  let id = 0;
  const admin = async (connection: typeof client, payload: unknown) => {
    const frame = await connection.call({ type: 'request', id: `share-${++id}`, method: 'admin', payload } as Request);
    if (frame.type !== 'response') throw new Error(JSON.stringify(frame));
    return frame.payload;
  };
  try {
    await client.ready();
    await other.ready();
    expect(await admin(client, { type: 'shareTargets' })).toEqual({ kind: 'shareTargets', bots: [{ agentId: 'cli_fixture_a', name: 'Bot A', connected: true, recipients: [{ openId: ALICE, name: 'Alice', creator: true }] }] });
    const image = Buffer.alloc(SHARE_PART_BYTES + 100, 3);
    image.write('GIF89a', 0, 'latin1');
    const started = await admin(client, { type: 'shareStart', agentId: 'cli_fixture_a', openId: ALICE, bytes: image.length, sha256: createHash('sha256').update(image).digest('hex') });
    expect(started).toMatchObject({ kind: 'shareUpload', received: 0 });
    const { uploadId } = started as { uploadId: string };
    expect(await admin(client, { type: 'sharePart', uploadId, index: 0, data: image.subarray(0, SHARE_PART_BYTES).toString('base64') })).toEqual({ kind: 'shareUpload', uploadId, received: SHARE_PART_BYTES });
    expect(await admin(client, { type: 'sharePart', uploadId, index: 1, data: image.subarray(SHARE_PART_BYTES).toString('base64') })).toEqual({ kind: 'shareUpload', uploadId, received: image.length });
    expect(await admin(client, { type: 'shareSend', uploadId })).toEqual({ kind: 'shareSent', messageId: 'om_fixture' });
    expect(shareImage).toHaveBeenCalledExactlyOnceWith('cli_fixture_a', expect.objectContaining({ openId: ALICE, image: image.toString('base64') }));

    await admin(other, { type: 'shareStart', agentId: 'cli_fixture_a', openId: ALICE, bytes: 10, sha256: 'a'.repeat(64) });
    const before = detached.owners.length;
    await other.close();
    await vi.waitFor(() => expect(detached.owners.length).toBe(before + 1));
  } finally {
    await client.close();
    await other.close();
    await fixture.close();
  }
});
