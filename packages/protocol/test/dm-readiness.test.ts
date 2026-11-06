import { expect, it } from 'vitest';
import { desktopSnapshotSchema } from '../src/index.js';

const agent = { id: 'cli_test', name: 'Bot', enabled: true, running: true, connection: 'connected', activation: 'active' };
const snapshot = {
  revision: 1, observedAt: 0, stale: false, host: { kind: 'starting' },
  agents: [agent], groups: [], memberships: [], tools: [], jobs: [],
  application: { platform: 'macos', version: '1', loginItem: false, dataPath: '/tmp' },
};

it('accepts old snapshots without private-chat readiness fields', () => {
  const parsed = desktopSnapshotSchema.parse(snapshot).agents[0];
  expect(parsed).toEqual(agent);
  expect(parsed).not.toHaveProperty('dmError');
  expect(parsed).not.toHaveProperty('dm');
});

it('retains a private-chat failure without requiring a synthetic membership or group error', () => {
  const dmError = '私聊初始化失败：Bot 目录需要修复';
  const parsed = desktopSnapshotSchema.parse({ ...snapshot, agents: [{ ...agent, dmError }] }).agents[0];
  expect(parsed).toEqual({ ...agent, dmError });
  expect(parsed).not.toHaveProperty('readError');
  expect(desktopSnapshotSchema.safeParse({ ...snapshot, agents: [{ ...agent, dmError: 123 }] }).success).toBe(false);
});
