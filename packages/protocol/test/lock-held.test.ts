import { expect, it } from 'vitest';
import { agentSchema } from '../src/domain';

it('accepts old agents and reports a lock holder with or without a known pid', () => {
  const agent = { id: 'cli_fixture', name: 'Bot', enabled: true, running: false, connection: 'unknown', activation: 'active' };
  expect(agentSchema.parse(agent).lockHeld).toBeUndefined();
  expect(agentSchema.parse({ ...agent, lockHeld: { since: 1, pid: 123 } }).lockHeld).toEqual({ since: 1, pid: 123 });
  expect(agentSchema.parse({ ...agent, lockHeld: { since: 1 } }).lockHeld).toEqual({ since: 1 });
  expect(agentSchema.safeParse({ ...agent, lockHeld: { since: 1, pid: -1 } }).success).toBe(false);
});
