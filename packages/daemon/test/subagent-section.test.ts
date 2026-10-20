import { expect, it } from 'vitest';
import { buildSubagentSection, subagentElementIds } from '../src/card/subagent-section';
import { buildRunCard, buildRunCardPlain } from '../src/card/run-card';
import { initialState, reduce, type SubagentRow, type RunState } from '../src/card/run-state';
const rows = (n: number): SubagentRow[] => Array.from({ length: n }, (_, i) => ({ id: `id${i}`, name: `name${i}!`, task: `task${i}!`, status: 'running', startedAt: i, stepCount: 7,
  steps: Array.from({ length: 5 }, (_, j) => ({ stepId: String(j), title: `step${j}`, status: 'done' })), stoppable: true }));
const section = (list = rows(2), extra = {}) => buildSubagentSection({ rows: list, cardKey: 'm1', running: true, terminal: 'running', now: 72000, ...extra });
const objects = (value: unknown): Record<string, unknown>[] => {
  if (!value || typeof value !== 'object') return [];
  return [...(!Array.isArray(value) ? [Object.fromEntries(Object.entries(value))] : []), ...Object.values(value).flatMap(objects)];
};
const buttons = (value: unknown) => objects(value).filter(o => o.tag === 'button');
const panels = (value: unknown) => objects(value).filter(o => o.tag === 'collapsible_panel');
const valueOf = (value: unknown) => objects(value).find(o => o.a);
const json = JSON.stringify;
it('renders stable collapsed identities, total steps, results and routed stop controls', () => {
  const list = rows(2); list[1] = { ...list[1]!, status: 'completed', result: 'review passed', endedAt: 1000 };
  const built = section(list), text = json(built);
  expect(text).toContain('子 agent · 1 个在跑 · 1 个已完成');
  expect(panels(built)).toHaveLength(2);
  expect(panels(built).every(p => p.expanded === false)).toBe(true);
  expect(text).toContain('前面还有 2 步'); expect(text).toContain('review passed');
  expect(text).toContain('7 步'); expect(text).toContain('name0!：task0!');
  expect(subagentElementIds('id0')).toEqual(subagentElementIds('id0'));
  expect(subagentElementIds('id0').panel).toMatch(/^sa_[0-9a-f]{12}$/);
  expect(subagentElementIds('id0')).not.toEqual(subagentElementIds('id1'));
  const b = buttons(built)[0]!;
  expect(valueOf(b)).toEqual({ a: 'run.stopSub', m: 'm1', subagentId: 'id0', e: b.element_id });
  expect(buttons(built)).toHaveLength(1);
});
it('suppresses controls for un-stoppable, plain and terminal cards', () => {
  expect(buttons(section(rows(2).map(r => ({ ...r, stoppable: false }))))).toHaveLength(0);
  for (const extra of [{ cardKey: undefined }, { running: false, terminal: 'done', cardKey: undefined }]) expect(buttons(section(rows(2), extra))).toHaveLength(0);
  const terminalSection = section(rows(40), { running: false, terminal: 'done' });
  expect(buttons(terminalSection)).toHaveLength(0);
  for (const row of rows(40)) expect(json(terminalSection)).toContain(`${row.name}：${row.task}`);
  const rs = { ...initialState, subagents: rows(2) };
  expect(json(buildRunCardPlain({ rs }))).not.toContain('run.stopSub');
  const text = json(buildRunCard({ rs: { ...rs, terminal: 'done', subagents: rows(40) }, cardKey: 'm1' }));
  for (const r of rows(40)) expect(text).toContain(`${r.name}：${r.task}`);
  expect(text.match(/没收到结束消息/g)).toHaveLength(40); expect(text).toContain('⚠️');
  expect(text).not.toMatch(/run.stopSub|run.subPage/);
});
it('keeps waiting visible and terminal labels in headers, with nesting', () => {
  const list = rows(4); list[1]!.parentId = 'id0'; list[2]!.parentId = 'id1'; list[3]!.parentId = 'absent';
  expect(panels(section(list)).map(p => p.margin)).toEqual(['0px 0px 0px 0px', '0px 0px 0px 16px', '0px 0px 0px 32px', '0px 0px 0px 16px']);
  list[1]!.status = 'failed'; list[2]!.status = 'stopped';
  const text = json(section(list, { waiting: { subagentId: 'id0', label: '⏸ 等 张三 回答（见下方卡片）' } }));
  expect(text.match(/见下方卡片/g)).toHaveLength(1); expect(text).toContain(' · 失败'); expect(text).toContain(' · 已停止');
  const built = section(rows(9), { waiting: { subagentId: 'id8', label: '⏸ 等 张三 回答（见下方卡片）' } });
  expect(panels(built).slice(0, 8).map(p => p.element_id)).toContain(subagentElementIds('id8').panel);
  expect(panels(built).slice(0, 8).map(p => p.element_id)).not.toContain(subagentElementIds('id0').panel);
  expect(valueOf(buttons(panels(built).at(-1))[0])).toMatchObject({ subagentId: 'id0' });
});
it('prioritizes active and failed rows and summarizes completed overflow', () => {
  const list = rows(12).map((r, i) => ({ ...r, status: i < 3 ? 'running' : i === 3 ? 'failed' : 'completed' } satisfies SubagentRow));
  const built = section(list);
  expect(panels(built).slice(0, 8).map(p => p.element_id)).toEqual(list.slice(0, 8).map(r => subagentElementIds(r.id).panel));
  expect(json(built)).toContain('另有 4 个已完成'); expect(built.components).toBeLessThanOrEqual(34);
});
it('paginates all active overflow with stable unique controls and bounded budget', () => {
  const small = section(rows(12)); expect(buttons(small)).toHaveLength(12); expect(json(small)).not.toContain('sp_next');
  const identities: unknown[] = [];
  for (const page of [0, 1]) {
    const built = section(rows(40), { page }), more = panels(built).at(-1)!;
    expect(built.components).toBeLessThanOrEqual(84);
    const ids = objects(built).flatMap(o => o.element_id ? [o.element_id] : []);
    expect(new Set(ids).size).toBe(ids.length);
    expect(json(more)).toContain(`下一页（${page + 1}/2）`);
    expect(valueOf(buttons(more).at(-1))).toEqual({ a: 'run.subPage', m: 'm1', p: 1 - page });
    const stops = buttons(more).filter(b => b.element_id !== 'sp_next');
    expect(stops).toHaveLength(page ? 8 : 24);
    for (const b of stops) { const value = valueOf(b)!; expect(value.e).toBe(b.element_id); identities.push(value.subagentId); }
  }
  expect(identities).toEqual(rows(40).slice(8).map(r => r.id));
  expect(section(rows(40), { page: 5 })).toEqual(section(rows(40), { page: 1 }));
  const plain = section(rows(40), { cardKey: undefined, page: 5 });
  expect(buttons(plain)).toHaveLength(0);
  for (const r of rows(40).slice(8)) expect(json(panels(plain).at(-1))).toContain(`${r.name}：${r.task}`);
});
it('integrates section before answer with shared process budget and waiting footer', () => {
  const rs: RunState = { ...initialState, subagents: rows(8), startedAt: 0, blocks: [
    ...Array.from({ length: 300 }, (_, i) => [
      { kind: 'tool', tool: { id: String(i), title: `tool${i}`, status: 'done' } },
      { kind: 'text', id: `progress${i}`, content: `progress${i}`, streaming: false },
    ] satisfies RunState['blocks']).flat(),
    { kind: 'text', id: 'answer', content: 'final answer', streaming: false }] };
  const card = buildRunCard({ rs }), without = buildRunCard({ rs: { ...rs, subagents: [] } });
  expect(objects(card).filter(o => o.tag).length - objects(without).filter(o => o.tag).length).toBeLessThanOrEqual(2);
  expect(json(card).indexOf('tool0')).toBeLessThan(json(card).indexOf('name0!'));
  expect(json(card).indexOf('name0!')).toBeLessThan(json(card).indexOf('final answer'));
  const waiting = { ...rs, subagents: rows(1), awaitingSubagents: true as const };
  expect(json(buildRunCard({ rs: waiting }))).toContain('主回合已答完，等 1 个子 agent 结束');
  expect(json(buildRunCard({ rs: waiting, askWaiting: 'please answer' }))).not.toContain('主回合已答完');
  expect(json(buildRunCard({ rs, subagentsCarried: true }))).toContain('接着显示在下一张卡');
  const continued = buildRunCard({ rs: { ...initialState, terminal: 'done', subagents: rows(2) }, continued: true });
  expect(panels(continued)).toHaveLength(0); expect(json(continued)).toContain('子 agent（2 个）接着显示在下一张卡');
});

it('keeps every reducer identity reachable across pages beyond 64 children', () => {
  let state = initialState;
  for (let i = 0; i < 80; i++) state = reduce(state, { type: 'subagent_start', id: `child${i}`, name: `worker${i}`, task: 'read', stoppable: true }, i);
  expect(state.subagents).toHaveLength(80);
  const visible = new Set<unknown>();
  for (let page = 0; page < 3; page++) {
    const built = section(state.subagents, { page });
    expect(built.components).toBeLessThanOrEqual(84);
    for (const b of buttons(built)) { const value = valueOf(b); if (value?.a === 'run.stopSub') visible.add(value.subagentId); }
  }
  expect([...visible].sort()).toEqual(state.subagents.map(row => row.id).sort());
});
