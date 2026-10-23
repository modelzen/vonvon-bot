import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRunCard } from '../src/card/run-card';
import { RunRender } from '../src/card/run-render';
import { buildProcessBody, processTitle } from '../src/card/run-process';
import { initialState, reduce, type Block } from '../src/card/run-state';

afterEach(() => vi.useRealTimers());

describe('ordered run process', () => {
  it('keeps reasoning snapshots in their original position and groups only adjacent tools', () => {
    let state = reduce(initialState, { type: 'thinking_delta', itemId: 'r', delta: 'draft' });
    state = reduce(state, { type: 'tool_use', itemId: 't1', title: 'pwd', kind: 'command' });
    state = reduce(state, { type: 'text', itemId: 'p', text: 'PROGRESS' });
    state = reduce(state, { type: 'tool_use', itemId: 't2', title: 'npm test', kind: 'command' });
    state = reduce(state, { type: 'thinking', itemId: 'r', text: 'REASONING' });
    state = reduce(state, { type: 'text', itemId: 'a', text: 'ANSWER' });
    expect(state.blocks.map(b => b.kind)).toEqual(['reasoning', 'tool', 'text', 'tool', 'text']);
    const card = buildRunCard({ rs: state });
    const body = card.body as { elements: Record<string, unknown>[] };
    expect(body.elements[0]).toMatchObject({ text: { content: '上下文 —' } }); // s12: the meter heads the card
    const process = JSON.stringify(body.elements[1]);
    expect(process.indexOf('REASONING')).toBeLessThan(process.indexOf('pwd'));
    expect(process.indexOf('pwd')).toBeLessThan(process.indexOf('PROGRESS'));
    expect(process.indexOf('PROGRESS')).toBeLessThan(process.indexOf('npm test'));
    expect(process).not.toContain('ANSWER');
    expect(process).not.toContain('🧠');
    expect(body.elements[2]).toMatchObject({ tag: 'markdown', element_id: 'answer', content: 'ANSWER', text_size: 'normal' });
  });

  it('uses a live elapsed clock and freezes the duration at completion', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const render = new RunRender();
    vi.setSystemTime(4100);
    expect(JSON.stringify(buildRunCard({ rs: render.snapshot() }))).toContain('已处理 3秒');
    render.apply({ type: 'done', turnId: 't' });
    vi.setSystemTime(91000);
    expect(JSON.stringify(buildRunCard({ rs: render.snapshot() }))).toContain('用时 3秒');
  });

  it('bounds UTF-8 bytes and nested components while preserving a chronological prefix', () => {
    const blocks: Block[] = Array.from({ length: 200 }, (_, i) => ({ kind: 'text', id: String(i), content: `STEP_${i}：${'中'.repeat(4000)}`, streaming: false }));
    const body = buildProcessBody(blocks);
    const json = JSON.stringify(body);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(22000);
    expect(json).toContain('STEP_0');
    expect(json).not.toContain('STEP_199');
    expect(json).toContain('项过程已省略（卡片容量限制）');
  });

  it('keeps command/output fences closed even when the output contains fences', () => {
    const body = buildProcessBody([{ kind: 'tool', tool: { id: 'x', kind: 'command', title: 'echo hi', status: 'error', output: '```\ninner\n```', exitCode: 1 } }]);
    const panel = body[0] as { elements: { content: string }[] };
    expect(panel.elements[0]!.content).toContain('```bash\necho hi\n```');
    expect(panel.elements[0]!.content).toContain('````\n```\ninner\n```\n````');
    expect(panel.elements[0]!.content).toContain('**退出码** `1`');
  });

  it('shows a running group and its failed count together', () => {
    const body = buildProcessBody([
      { kind: 'tool', tool: { id: 'one', kind: 'command', title: 'pwd', status: 'error' } },
      { kind: 'tool', tool: { id: 'two', kind: 'command', title: 'ls', status: 'running' } },
    ]);
    const group = body[0] as { header: { title: { content: string } } };
    expect(group.header.title.content).toBe("<font color='grey'>2 项操作</font> <font color='red'>· 1 项失败</font>");
    expect(JSON.stringify(body)).not.toContain('正在执行');
  });

  it('uses one failure mark when a group has finished with errors', () => {
    const body = buildProcessBody([
      { kind: 'tool', tool: { id: 'one', kind: 'command', title: 'pwd', status: 'error' } },
      { kind: 'tool', tool: { id: 'two', kind: 'command', title: 'ls', status: 'done' } },
    ]);
    const group = body[0] as { header: { title: { content: string } } };
    expect(group.header.title.content).toBe("<font color='grey'>2 项操作</font> <font color='red'>· 1 项失败</font> <font color='red'>×</font>");
  });

  it.each([
    ['running', false],
    ['done', true],
    ['error', false],
  ] as const)('shows the no-output search explanation only after completion (%s)', (status, explained) => {
    const body = buildProcessBody([{ kind: 'tool', tool: {
      id: 'search', kind: 'search', title: '联网搜索：query', status,
    } }]);
    const json = JSON.stringify(body);
    expect(json.includes('搜索结果已用于作答，不单独回传')).toBe(explained);
  });

  it('keeps timeout explicit while using the shared process mark', () => {
    expect(processTitle('idle_timeout', 3_000)).toBe("<font color='grey'>用时 3秒 · 已超时</font> <font color='orange'>!</font>");
    expect(processTitle('error', 3_000)).toBe("<font color='grey'>用时 3秒</font> <font color='red'>×</font>");
  });
});
