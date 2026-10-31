import { fake, human, job, setup, thread, topics, until } from './helpers/scheduled-run';
import { afterEach, expect, it } from 'vitest';

// T2 4.1 第 6 条: a scheduled run's hidden topic lets its process go once settled, unless someone joined it. A run in a
// session that was there before (the main one, a topic it went back to) leaves the process as a person's turn does.
let current: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => { await current?.orchestrator.shutdown(); current = undefined; });

it('closes a Claude session of a new topic nobody joined; the next message there resumes it', async () => {
  current = await setup('multi');
  const run = thread(), later = thread();
  fake.backend.startThread.mockResolvedValue(run.t);
  fake.backend.resumeThread.mockResolvedValue(later.t);
  const result = current.runScheduled(job());
  await until(() => expect(run.consumed).toHaveLength(1));
  run.turns[0]!.resolve();
  await expect(result).resolves.toMatchObject({ status: 'done', topicId: 'topic-new' });
  await until(() => expect(run.t.close).toHaveBeenCalled());
  await current.orchestrator.onMessage(human('谢谢', 'topic-new'));
  await until(() => expect(later.consumed).toHaveLength(1));
  expect(fake.backend.resumeThread).toHaveBeenCalledOnce();
  later.turns[0]!.resolve();
});

it('keeps it when someone wrote in the topic meanwhile', async () => {
  current = await setup('multi');
  const run = thread();
  fake.backend.startThread.mockResolvedValue(run.t);
  const result = current.runScheduled(job());
  await until(() => expect(run.consumed).toHaveLength(1));
  await until(() => expect(topics.note).toHaveBeenCalled()); // the topic is adopted
  await current.orchestrator.onMessage(human('补充一句', 'topic-new'));
  await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
  run.turns[0]!.resolve();
  await expect(result).resolves.toMatchObject({ status: 'done' });
  await until(() => expect(run.consumed).toHaveLength(2));
  run.turns[1]!.resolve();
  await until(() => expect(fake.log.info.mock.calls.filter(([, event]) => event === 'final')).toHaveLength(2));
  await current.orchestrator.onMessage(human('再问一句', 'topic-new'));
  await until(() => expect(run.consumed).toHaveLength(3));
  expect(run.t.close).not.toHaveBeenCalled();
  expect(fake.backend.resumeThread).not.toHaveBeenCalled();
  run.turns[2]!.resolve();
});

it.each([
  ['the main session', 'single', {}, undefined],
  ['a topic it was put back in', 'multi', { placement: { kind: 'topic', topicId: 'topic-old' } }, 'topic-old'],
] as const)('keeps the process of %s: someone talks there again', async (_name, kind, task, topicId) => {
  current = await setup(kind);
  const run = thread();
  fake.backend.resumeThread.mockResolvedValue(run.t);
  const result = current.runScheduled(job(task));
  await until(() => expect(run.consumed).toHaveLength(1));
  run.turns[0]!.resolve();
  await expect(result).resolves.toMatchObject({ status: 'done' });
  await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
  expect(run.t.close).not.toHaveBeenCalled();
  await current.orchestrator.onMessage(human('接着说', topicId));
  await until(() => expect(run.consumed).toHaveLength(2));
  expect(fake.backend.resumeThread).toHaveBeenCalledOnce();
  run.turns[1]!.resolve();
});
