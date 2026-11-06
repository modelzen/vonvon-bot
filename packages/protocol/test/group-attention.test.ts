import {expect, it} from 'vitest';
import {requestSchema} from '../src/rpc.js';
import {diagnosticsEventSchema, groupAttentionSchema} from '../src/diagnostics.js';

const record = {groupId: 'oc_attention', focusedTopics: 0, watchedTopics: 0};

it.each([10, 25, 50, 75, 100])('carries the unified group score %i through the diagnostics protocol', score => {
  const group = {score, intervalMs: 300_000, updatedAt: 1_000_000};
  const result = diagnosticsEventSchema.parse({kind: 'attention', groups: [{...record, group}]});
  expect(result).toEqual({kind: 'attention', groups: [{...record, group}]});
});

it('continues to accept legacy-only snapshots for an explicit update notice', () => {
  expect(groupAttentionSchema.parse({...record, main: {mode: 'watch', intervalMs: 60_000}}).group).toBeUndefined();
});

it.each([
  {score: 0, intervalMs: 300_000, updatedAt: 1},
  {score: 30, intervalMs: 300_000, updatedAt: 1},
  {score: 25, intervalMs: -1, updatedAt: 1},
  {score: 25, intervalMs: Infinity, updatedAt: 1},
  {score: 25, intervalMs: 300_000, updatedAt: -1},
  {score: 25, intervalMs: 300_000, updatedAt: 1, extra: true},
])('rejects invalid or unsupported group readings', group => {
  expect(groupAttentionSchema.safeParse({...record, group}).success).toBe(false);
});

it('keeps the legacy get request and accepts only an explicit group attention opt-in', () => {
  const request = {type: 'request', id: '1', method: 'snapshot'};
  expect(requestSchema.safeParse({...request, payload: {type: 'get'}}).success).toBe(true);
  expect(requestSchema.safeParse({...request, payload: {type: 'get', groupAttention: true}}).success).toBe(true);
  expect(requestSchema.safeParse({...request, payload: {type: 'get', groupAttention: false}}).success).toBe(false);
});
