import {expect, it} from 'vitest';
import {adminRequestSchema, adminReplySchema, adminSetupStatusSchema, botSteps, remoteStepsDone, type AdminSetupStatus, type Agent} from '../src/index.js';

const agent: Agent = {id: 'cli_callback' as Agent['id'], name: 'Callback Bot', enabled: true, running: true, connection: 'connected', activation: 'active'};
const status = (cardCallback: AdminSetupStatus['cardCallback']): AdminSetupStatus => ({
  appId: agent.id, tenant: 'feishu', credentials: {ok: true}, connection: {running: true},
  event: {state: 'ok'}, scopes: {grantUrl: 'https://example.test/auth', missingRequired: []},
  eventConfigUrl: 'https://example.test/event', consoleUrl: 'https://example.test', cardCallback,
});
const callback = (value: AdminSetupStatus) => botSteps(agent, value).find(step => step.id === 'callback')!;

it('keeps old host manual confirmations compatible without inventing receipt evidence', () => {
  const value = adminSetupStatusSchema.parse(status({confirmed: true}));
  expect(value.cardCallback).toEqual({confirmed: true});
  expect(callback(value)).toMatchObject({status: '已手动确认', done: true,
    actions: [{kind: 'confirmCallback', label: '撤销确认', confirmed: false}]});
  expect(remoteStepsDone(value)).toBe(true);
});

it('leaves an unobserved callback pending rather than claiming the configuration is missing', () => {
  const value = status({confirmed: false});
  expect(callback(value)).toMatchObject({status: '待验证', tone: 'neutral', done: false});
  expect(callback(value).detail).toContain('收到后会自动验证');
  expect(callback(value).detail).not.toContain('没有接口');
  expect(callback(value).actions).toContainEqual({kind: 'confirmCallback', label: '我已配置', confirmed: true});
  expect(remoteStepsDone(value)).toBe(false);
});

it('preserves actual receipt evidence through the protocol and gives it precedence over manual confirmation', () => {
  const value = adminSetupStatusSchema.parse(status({confirmed: true, verifiedAt: 1_792_900_000_000}));
  expect(value.cardCallback.verifiedAt).toBe(1_792_900_000_000);
  expect(callback(value)).toMatchObject({status: '已验证', tone: 'success', done: true, actions: []});
  expect(callback(value).detail).toContain('已收到过');
  expect(remoteStepsDone(value)).toBe(true);
});

it('supports a local-only callback read without rechecking remote configuration', () => {
  expect(adminRequestSchema.parse({type: 'cardCallbackStatus', agentId: agent.id}).type).toBe('cardCallbackStatus');
  const reply = {kind: 'cardCallbackStatus', cardCallback: {confirmed: true, verifiedAt: 1_792_900_000_000}};
  expect(adminReplySchema.parse(reply)).toEqual(reply);
});

it.each([0, -1, 1.5, NaN, Infinity, 8_640_000_000_000_001, 'today'])('rejects invalid receipt timestamps: %s', verifiedAt => {
  expect(adminSetupStatusSchema.safeParse({...status({confirmed: true}), cardCallback: {confirmed: true, verifiedAt}}).success).toBe(false);
});
