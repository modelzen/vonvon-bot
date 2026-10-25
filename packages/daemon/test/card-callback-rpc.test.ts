import { expect, it, vi } from 'vitest';
import { agentIdSchema } from '@vonvon/protocol';
import type { AdminService } from '../src/admin/service';
import { adminRpc } from '../src/server/rpc/admin';

const agentId = agentIdSchema.parse('cli_a');

it('reads callback evidence through the local service without the remote setup probe or a mutation', async () => {
  const cardCallback = { confirmed: true, verifiedAt: 1_790_000_000_000 };
  const getCardCallbackStatus = vi.fn(async () => cardCallback);
  const getSetupStatus = vi.fn();
  const followLogs = vi.fn();
  const service = { getCardCallbackStatus, getSetupStatus } as unknown as AdminService;
  expect(await adminRpc(service, followLogs, { type: 'cardCallbackStatus', agentId })).toEqual({
    kind: 'read', value: { kind: 'cardCallbackStatus', cardCallback },
  });
  expect(getCardCallbackStatus).toHaveBeenCalledExactlyOnceWith('cli_a');
  expect(getSetupStatus).not.toHaveBeenCalled();
  expect(followLogs).not.toHaveBeenCalled();
});

it('declares the optional local query unsupported instead of falling back to Feishu', async () => {
  const getSetupStatus = vi.fn();
  await expect(adminRpc({ getSetupStatus } as unknown as AdminService, vi.fn(), { type: 'cardCallbackStatus', agentId }))
    .rejects.toMatchObject({ code: 'unsupported' });
  expect(getSetupStatus).not.toHaveBeenCalled();
});
