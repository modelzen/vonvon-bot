import { expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';

const updates = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../src/project/registry', () => ({ updateProject: updates }));
vi.mock('../src/project/git-info', () => ({ currentBranch: async () => 'feature' }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} } }));
import { refreshBranch } from '../src/project/announcement';

/** An announcement whose first list fails with `first`, then answers. */
function channel(first: Error) {
  const list = vi.fn()
    .mockRejectedValueOnce(first)
    .mockResolvedValue({ code: 0, data: { items: [{ block_type: 1, block_id: 'page', children: [] }] } });
  const create = vi.fn(async () => ({ code: 0 }));
  return { list, create, channel: { rawClient: { docx: { v1: { chatAnnouncementBlock: { list }, chatAnnouncementBlockChildren: { create, batchDelete: vi.fn() } } } } } as unknown as LarkChannel };
}
const project = { name: 'p', chatId: 'oc_p', cwd: '/nowhere', blank: true, createdAt: 1, branch: 'main' };

it('s36d1: a branch refresh, outside any creation, retries a connection that timed out like any other failure', async () => {
  for (const code of ['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET']) {
    updates.mockClear();
    const fixture = channel(Object.assign(new Error(`connect ${code} 192.0.2.1:443`), { code }));
    await refreshBranch(fixture.channel, project as never);
    expect(fixture.list, code).toHaveBeenCalledTimes(2);
    expect(fixture.create, code).toHaveBeenCalledOnce();
    expect(updates, code).toHaveBeenCalledWith('p', { branch: 'feature' });
  }
});
