import { afterEach, describe, expect, it } from 'vitest';
import { scheduleRefusalMessages } from '../src/admin/schedule-commands';
import { closeCodexToolFixtures, codexToolsFixture, OWNER, person } from './helpers/codex-tools-fixture';

// 定时任务 T3b: a Codex call is authorized as the turn whose turn/start answered with its turnId, not as the thread's first turn.
afterEach(closeCodexToolFixtures);

describe('Codex tool calls are bound to their own turn', () => {
  it('authorizes a second turn\'s call by the second turn\'s facts (the first-turn rule let the owner\'s turn answer for it)', async () => {
    const f = codexToolsFixture();
    const session = await f.open();
    await session.turn(person(OWNER), [{ tool: 'schedule_list' }]);
    await session.turn(person('ou_bot', { requesterKind: 'bot' }), [{ tool: 'schedule_list' }, { tool: 'schedule_pause', args: { taskId: 'st_1' } }]);
    expect(f.answers().map(answer => answer.success)).toEqual([true, true, false]);
    expect(f.answers()[2]!.text).toBe(scheduleRefusalMessages['not-human-turn']);
    expect(f.execute.mock.calls.map(([actor, request]) => [actor.kind === 'chat' && actor.openId, request.action]))
      .toEqual([[OWNER, 'list'], ['ou_bot', 'list']]);
  });
  it('waits for the turn/start answer when the call comes in before it', async () => {
    const f = codexToolsFixture();
    const session = await f.open();
    await session.turn(person(OWNER), [{ tool: 'schedule_list' }], true);
    expect(f.answers()).toEqual([{ success: true, text: expect.stringMatching(/^现在 /) }]);
  });
  it('refuses a call whose turn never answered turn/start (a goal\'s turn) as unknown-origin, after 2 seconds', async () => {
    const f = codexToolsFixture();
    const session = await f.open();
    const started = Date.now();
    await session.goal([{ tool: 'schedule_list' }]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(f.answers()).toEqual([{ success: false, text: expect.stringContaining('认不出') }]);
    expect(f.execute).not.toHaveBeenCalled();
  });
});
