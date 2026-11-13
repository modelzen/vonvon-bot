import {expect, it} from 'vitest';
import {commandSchema, commandResultSchema, groupIdentitySchema} from '../src/domain';

it('accepts only the exact Bot/group request and minimal nonempty identity response', () => {
  const request = {type: 'readGroupIdentity', agentId: 'cli_exact', groupId: 'oc_exact'};
  expect(commandSchema.parse(request)).toEqual(request);
  for (const invalid of [{...request, cursor: 'page'}, {...request, groupId: 'a name'}, {...request, agentId: undefined}]) {
    expect(commandSchema.safeParse(invalid).success).toBe(false);
  }
  const result = {kind: 'groupIdentity', agentId: 'cli_exact', groupId: 'oc_exact', name: '飞书群🦉'};
  expect(commandResultSchema.parse(result)).toEqual(result);
  for (const invalid of [{...result, name: ' '}, {...result, groupId: 'not-id'}, {...result, description: 'private'}, {...result, members: []}]) {
    expect(groupIdentitySchema.safeParse(invalid).success).toBe(false);
  }
});
