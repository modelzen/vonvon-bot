import { fake, human, job, setup, thread, until } from './helpers/scheduled-run';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentEntries } from '../src/agent/entry/registry';

// T2 4.4: a turn runScheduled starts opens as the task's own unattended turn; the person after it is present again.
let current: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => { await current?.orchestrator.shutdown(); current = undefined; });

it('opens the scheduled turn with its task and run, presence scheduled; memory turns go on as initiative', async () => {
  const entries = createAgentEntries({ appId: 'fixture', isAdmin: id => id === 'owner' });
  const open = vi.spyOn(entries, 'openTurn');
  const memory = vi.spyOn(entries, 'memoryTurn');
  current = await setup('single', { entries });
  const run = thread();
  fake.backend.resumeThread.mockResolvedValue(run.t);
  const result = current.runScheduled(job());
  await until(() => expect(run.consumed).toHaveLength(1));
  expect(open).toHaveBeenCalledWith(run.t, expect.objectContaining({ scheduled: { taskId: 'st_00000000000000a1', runId: 'run-1' } }));
  expect(open.mock.results[0]!.value).toMatchObject({ presence: 'scheduled', scheduled: { taskId: 'st_00000000000000a1', runId: 'run-1' } });
  const turn = memory.mock.results[0]!.value as { turn(): { kind: string } | undefined };
  expect(turn.turn()).toMatchObject({ kind: 'initiative' });
  await current.orchestrator.onMessage(human('接着问'));
  run.turns[0]!.resolve();
  await expect(result).resolves.toMatchObject({ status: 'done' });
  await until(() => expect(run.consumed).toHaveLength(2));
  expect(open.mock.calls[1]![1]).not.toHaveProperty('scheduled');
  expect(open.mock.results[1]!.value).toMatchObject({ presence: 'human' });
  run.turns[1]!.resolve();
});
