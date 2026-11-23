import {expect, it, vi} from 'vitest';
import type {AgentThread} from '../src/agent/types';
import {createAgentEntries, type TurnFacts, type AgentPlace} from '../src/agent/entry/registry';
import {feedbackTool, type FeedbackSource} from '../src/agent/entry/feedback-tool';
const args = {summary: {kind: 'bug', title: '标题', description: '说明'}, attachmentRefs: []};
const source: FeedbackSource = {chatId: 'oc_g', openId: 'ou_caller', messageId: 'om_1', attachments: [],
  prepare: vi.fn(async () => ({operationId: 'test', trackingCode: 'fixture'}))};
const facts: TurnFacts = {requesterKind: 'user', requesterOpenId: source.openId, triggerMessageId: source.messageId,
  retry: false, initiative: false, wake: false, feedback: source};
function setup(overrides: Partial<TurnFacts> = {}, place: AgentPlace = {kind: 'group', chatId: 'oc_g'}, enabled = true) {
  const entries = createAgentEntries({appId: 'fixture', isAdmin: () => false, feedbackEnabled: () => enabled, tools: [feedbackTool]});
  const entry = entries.issue(place);
  const thread = {isAlive: () => true} as AgentThread;
  entry.attach(thread);
  const turn = entries.openTurn(thread, {...facts, ...overrides});
  entry.noteToolUse('one');
  return {entries, entry, thread, turn, call: () => entry.call('feedback_prepare', args, {toolUseId: 'one'})};
}

it('exposes preparation in a configured group and binds a non-admin to the original turn', async () => {
  const f = setup();
  expect(f.entry.tools().map(tool => tool.name)).toEqual(['feedback_prepare']);
  const unconfigured = setup({feedback: undefined}, undefined, false);
  expect(unconfigured.entry.tools().map(tool => tool.name)).toEqual(['feedback_prepare']);
  expect(await unconfigured.call()).toMatchObject({ok: false, message: expect.stringContaining('/feedback setup')});
  expect(await f.call()).toMatchObject({ok: true});
  expect(await f.entry.call('feedback_prepare', {...args, actor: {openId: 'ou_other'}}, {toolUseId: 'one'})).toMatchObject({ok: false, code: 'bad-args'});
  expect(await f.entry.call('feedback_prepare', args)).toMatchObject({ok: false});
  f.entries.openTurn(f.thread, {...facts, triggerMessageId: 'om_two'});
  expect(await f.call()).toMatchObject({ok: false, reason: 'turn-ended'});
});

it.each([{retry: true}, {wake: true}, {initiative: true}, {scheduled: {taskId: 'test', runId: 'run'}},
  {requesterOpenId: 'ou_another'}, {requesterKind: 'bot' as const}, {triggerMessageId: 'om_other'}, {feedback: undefined}])('rejects an unbound or synthetic source %j', async diff => {
  expect(await setup(diff).call()).toMatchObject({ok: false});
});
it.each([{kind: 'doc', docId: 'doc'}, {kind: 'p2p', chatId: 'oc_g'}, {kind: 'group', chatId: 'oc_other'}] as const)('never uses the source in a different place %j', async place => {
  expect(await setup({}, place).call()).toMatchObject({ok: false});
});
it.each(['ou_caller', 'ou_other'])('revokes pending and future prepare on steer by %s', async openId => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  let signal: AbortSignal | undefined;
  const f = setup({feedback: {...source, prepare: async (_args, stop) => {
    signal = stop;
    await promise;
    stop.throwIfAborted();
    return {operationId: 'unreachable', trackingCode: ''};
  }}});
  const pending = f.call();
  await vi.waitFor(() => expect(signal).toBeDefined());
  f.entries.noteSteer(f.thread, {kind: 'user', openId});
  expect(await pending).toMatchObject({ok: false});
  expect(signal!.aborted).toBe(true);
  resolve();
  expect(await f.call()).toMatchObject({ok: false});
});
