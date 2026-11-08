import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createTurnMapper } from '../src/agent/claude-agent/event-map';
import type { AgentEvent } from '../src/agent/types';

/**
 * 锁定 SDKMessage → AgentEvent 映射（纯函数无网络）。喂合成消息流，断言事件序列
 * 与 itemId 关联。真实消息形状由 spike1/2 实证（见 event-map.ts 顶注）。
 */
const m = (o: unknown): SDKMessage => o as SDKMessage;
const sysInit = (sid: string, model?: string) => m({ type: 'system', subtype: 'init', session_id: sid, model });
const blockStart = (index: number, type: string) => m({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type } } });
const delta = (index: number, d: Record<string, unknown>) => m({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: d } });
const blockStop = (index: number) => m({ type: 'stream_event', event: { type: 'content_block_stop', index } });
const assistantTool = (id: string, name: string, input: unknown) => m({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const userToolResult = (toolId: string, content: unknown, isErr = false) => m({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content, is_error: isErr }] } });

function mapAll(mapper: { map(msg: SDKMessage): AgentEvent[] }, msgs: SDKMessage[]): AgentEvent[] {
  return msgs.flatMap((x) => mapper.map(x));
}

describe('createTurnMapper —— SDKMessage → AgentEvent', () => {
  it('system/init → system 事件，且只发一次', () => {
    const mp = createTurnMapper();
    expect(mp.map(sysInit('sess-1'))).toEqual([{ type: 'system', threadId: 'sess-1' }]);
    expect(mp.map(sysInit('sess-1'))).toEqual([]); // 第二次 init 抑制
  });

  it('压缩：status compacting → start；compact_boundary → end，带前后 token，窗口留给 thread 填', () => {
    const mp = createTurnMapper();
    mp.map(sysInit('s', 'claude-opus-5-5'));
    expect(mp.map(m({ type: 'system', subtype: 'status', status: 'compacting' }))).toEqual([{ type: 'compaction', phase: 'start' }]);
    expect(mp.map(m({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 170_000, post_tokens: 40_000 } }))).toEqual([
      { type: 'compaction', phase: 'end', preTokens: 170_000, postTokens: 40_000, contextWindow: null },
    ]);
    // post_tokens is optional.
    expect(mp.map(m({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 9000 } }))).toEqual([
      { type: 'compaction', phase: 'end', preTokens: 9000, contextWindow: null },
    ]);
    expect(mp.map(m({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'x' }))).toEqual([{ type: 'compaction', phase: 'end', failed: true }]);
    expect(mp.map(m({ type: 'system', subtype: 'status', status: null, compact_result: 'success' }))).toEqual([]);
  });

  it('主 agent 每个请求的 usage → 一次 context_usage（每块一条 assistant 也只算一次；子 agent 不算）', () => {
    const mp = createTurnMapper();
    const usage = { input_tokens: 10, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 6_000, output_tokens: 5 };
    const block = (id: string, parent: string | null) => m({ type: 'assistant', parent_tool_use_id: parent, message: { id, usage, content: [{ type: 'text', text: 'x' }] } });
    expect(mp.map(block('msg-1', null))).toEqual([{ type: 'context_usage', usedTokens: 86_010, contextWindow: null }]);
    expect(mp.map(block('msg-1', null))).toEqual([]);
    expect(mp.map(block('msg-2', 'toolu_task'))).toEqual([]);
    expect(mp.map(block('msg-3', null))).toHaveLength(1);
  });

  it('文本块：delta 累积 + stop 收尾，itemId 在 delta 与 text 间一致', () => {
    const mp = createTurnMapper();
    const evs = mapAll(mp, [
      blockStart(0, 'text'),
      delta(0, { type: 'text_delta', text: '你好' }),
      delta(0, { type: 'text_delta', text: '，世界' }),
      blockStop(0),
    ]);
    expect(evs).toEqual([
      { type: 'text_delta', itemId: 'b1', delta: '你好' },
      { type: 'text_delta', itemId: 'b1', delta: '，世界' },
      { type: 'text', itemId: 'b1', text: '你好，世界' },
    ]);
    // delta 与最终 text 同 itemId（run-state 据此替换而非重复）—— 上面 toEqual 已锁定，
    // 这里显式再断一次关联关系。
    const deltaEv = evs.find((e) => e.type === 'text_delta');
    const textEv = evs.find((e) => e.type === 'text');
    expect(deltaEv && textEv && 'itemId' in deltaEv && 'itemId' in textEv && deltaEv.itemId === textEv.itemId).toBe(true);
  });

  it('思考块：thinking_delta 累积 + thinking 收尾', () => {
    const mp = createTurnMapper();
    const evs = mapAll(mp, [
      blockStart(0, 'thinking'),
      delta(0, { type: 'thinking_delta', thinking: '让我想想' }),
      blockStop(0),
    ]);
    expect(evs).toEqual([
      { type: 'thinking_delta', itemId: 'b1', delta: '让我想想' },
      { type: 'thinking', itemId: 'b1', text: '让我想想' },
    ]);
  });

  it('工具：assistant tool_use → tool_use（itemId=工具id，Bash 标题=命令，kind=command）', () => {
    const mp = createTurnMapper();
    const evs = mp.map(assistantTool('tu_1', 'Bash', { command: 'ls -la', description: '列目录' }));
    expect(evs).toEqual([{ type: 'tool_use', itemId: 'tu_1', title: 'ls -la', detail: '列目录', kind: 'command' }]);
  });

  it('工具结果：user tool_result → tool_result（成功 exitCode=0，失败=1）', () => {
    const ok = createTurnMapper().map(userToolResult('tu_1', '输出内容', false));
    expect(ok).toEqual([{ type: 'tool_result', itemId: 'tu_1', output: '输出内容', exitCode: 0 }]);
    const bad = createTurnMapper().map(userToolResult('tu_2', '炸了', true));
    expect(bad).toEqual([{ type: 'tool_result', itemId: 'tu_2', output: '炸了', exitCode: 1 }]);
  });

  it('tool_result.content 为数组（{type:text}）也能拍平', () => {
    const evs = createTurnMapper().map(userToolResult('tu_1', [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]));
    expect(evs).toEqual([{ type: 'tool_result', itemId: 'tu_1', output: 'AB', exitCode: 0 }]);
  });

  it('result(success) → usage + 回退 context_usage（不按模型名猜窗口，thread 用 getContextUsage 填）', () => {
    const mp = createTurnMapper();
    mp.map(sysInit('s', 'claude-opus-4-8[1m]'));
    const evs = mp.map(
      m({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }),
    );
    expect(evs).toContainEqual({ type: 'usage', inputTokens: 10, outputTokens: 5 });
    // used = 10+3+2 = 15
    expect(evs).toContainEqual({ type: 'context_usage', usedTokens: 15, contextWindow: null });
    expect(evs.some((e) => e.type === 'done')).toBe(false);
  });

  it('多块顺序：思考→文本→工具，itemId 各自独立递增', () => {
    const mp = createTurnMapper();
    const evs = mapAll(mp, [
      blockStart(0, 'thinking'), delta(0, { type: 'thinking_delta', thinking: 'T' }), blockStop(0),
      blockStart(1, 'text'), delta(1, { type: 'text_delta', text: 'A' }), blockStop(1),
      assistantTool('tu_x', 'Read', { file_path: '/Users/x/proj/a.ts' }),
    ]);
    const ids = evs.filter((e) => 'itemId' in e).map((e) => (e as { itemId: string }).itemId);
    expect(new Set(ids).size).toBeGreaterThanOrEqual(3); // b1(思考) / b2(文本) / tu_x(工具) 互不相同
  });
});

const task = (subtype: string, fields: Record<string, unknown> = {}) => m({
  type: 'system', subtype, task_id: 'child', run_id: 'r1', ...fields,
});
const startAgent = (fields: Record<string, unknown> = {}) => task('task_started', {
  task_type: 'local_agent', description: '统计文件', subagent_type: 'explorer', ...fields,
});
const child = (type: 'assistant' | 'user', content: unknown[], fields: Record<string, unknown> = {}) => m({
  type, parent_tool_use_id: 'parent-tool', agent_id: 'child', message: { content }, ...fields,
});

describe('Claude 子 agent 事件', () => {
  it('登记稳定身份、截短任务，父 Agent 工具保留主过程行', () => {
    const mapper = createTurnMapper();
    expect(mapper.map(startAgent({ description: 'a'.repeat(130), parent_task_id: 'outer' }))).toEqual([
      { type: 'subagent_start', id: 'child', parentId: 'outer', name: 'explorer', task: 'a'.repeat(120), stoppable: true },
    ]);
    expect(mapper.map(startAgent())).toEqual([]);
    expect(mapper.map(assistantTool('parent-tool', 'Agent', { description: 'x' }))).toEqual([
      { type: 'tool_use', itemId: 'parent-tool', title: '子任务：x', detail: undefined, kind: 'tool' },
    ]);
    expect(mapper.map(userToolResult('parent-tool', '完成'))).toEqual([
      { type: 'tool_result', itemId: 'parent-tool', output: '完成', exitCode: 0 },
    ]);
  });

  it('子工具只进入子通道，按工具 id 收口，文本丢弃', () => {
    const mapper = createTurnMapper();
    const tools = child('assistant', [
      { type: 'text', text: '不进入主过程' },
      { type: 'tool_use', id: 'one', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', id: 'two', name: 'Read', input: { file_path: 'a.ts' } },
    ]);
    expect(mapper.map(tools)).toEqual([]);
    mapper.map(startAgent());
    expect(mapper.map(tools)).toEqual(['one', 'two'].map((stepId) => ({
      type: 'subagent_step', id: 'child', stepId, title: '读取 a.ts', status: 'running', kind: 'file', detail: undefined,
    })));
    expect(mapper.map(child('assistant', [{ type: 'tool_use', id: 'bash', name: 'Bash',
      input: { command: 'pwd', description: '检查目录' } }]))).toEqual([
      { type: 'subagent_step', id: 'child', stepId: 'bash', title: 'pwd', status: 'running', kind: 'command', detail: '检查目录' },
    ]);
    expect(mapper.map(child('user', [
      { type: 'tool_result', tool_use_id: 'two', is_error: true },
      { type: 'tool_result', tool_use_id: 'one' },
    ]))).toEqual([
      { type: 'subagent_step', id: 'child', stepId: 'two', title: '', status: 'failed' },
      { type: 'subagent_step', id: 'child', stepId: 'one', title: '', status: 'done' },
    ]);
    expect(mapper.map(child('assistant', [{ type: 'tool_use', id: 'x', name: 'Read' }], { agent_id: undefined }))).toEqual([]);
    expect(mapper.map(child('user', [{ type: 'tool_result', tool_use_id: 'x' }], { agent_id: undefined }))).toEqual([]);
  });

  it('子 stream 不污染主文本块', () => {
    const mapper = createTurnMapper();
    mapper.map(blockStart(0, 'text'));
    expect(mapper.map(m({ type: 'stream_event', parent_tool_use_id: 'p', event: {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child' },
    } }))).toEqual([]);
    expect(mapper.map(delta(0, { type: 'text_delta', text: 'parent' }))).toEqual([
      { type: 'text_delta', itemId: 'b1', delta: 'parent' },
    ]);
  });

  it.each([{ task_type: 'local_bash' }, { ambient: true }, { skip_transcript: true }])('排除非 agent 和后台杂务 %j', (fields) => {
    const mapper = createTurnMapper();
    expect(mapper.map(startAgent(fields))).toEqual([]);
    for (const msg of [task('task_progress'), task('task_updated', { patch: { status: 'completed' } }), task('task_notification', { status: 'completed', summary: 'x' })]) {
      expect(mapper.map(msg)).toEqual([]);
    }
  });

  it('progress 不重复记步骤；updated 和 notification 同 run 去重，续跑重新收口', () => {
    const mapper = createTurnMapper();
    mapper.map(startAgent());
    expect(mapper.map(task('task_progress', { last_tool_name: 'Read' }))).toEqual([]);
    expect(mapper.map(task('task_updated', { patch: { status: 'completed' } }))).toEqual([
      { type: 'subagent_status', id: 'child', status: 'completed', result: undefined },
    ]);
    expect(mapper.map(task('task_notification', { status: 'completed', summary: '重复' }))).toEqual([]);
    expect(mapper.map(startAgent({ run_id: 'r2' }))).toEqual([{ type: 'subagent_status', id: 'child', status: 'running' }]);
    expect(mapper.map(task('task_notification', { run_id: 'r2', status: 'completed', summary: 'x'.repeat(610) }))).toEqual([
      { type: 'subagent_status', id: 'child', status: 'completed', result: 'x'.repeat(600) },
    ]);
  });

  it.each(['completed', 'failed', 'killed'])('updated 终态 %s，缺失 run_id 也去重', (status) => {
    const mapper = createTurnMapper();
    mapper.map(startAgent({ run_id: undefined }));
    const terminal = task('task_updated', { run_id: undefined, patch: { status, error: '原因' } });
    expect(mapper.map(terminal)).toEqual([
      { type: 'subagent_status', id: 'child', status: status === 'killed' ? 'stopped' : status, result: '原因' },
    ]);
    expect(mapper.map(terminal)).toEqual([]);
  });

  it('新 run 开始后忽略旧 run 延迟终态和开始通知', () => {
    const mapper = createTurnMapper();
    mapper.map(startAgent());
    mapper.map(startAgent({ run_id: 'r2' }));
    expect(mapper.map(task('task_updated', { patch: { status: 'failed' } }))).toEqual([]);
    expect(mapper.map(task('task_notification', { status: 'completed', summary: '旧结果' }))).toEqual([]);
    expect(mapper.map(startAgent())).toEqual([]);
    expect(mapper.map(task('task_notification', { run_id: 'r2', status: 'completed', summary: '新结果' }))).toEqual([
      { type: 'subagent_status', id: 'child', status: 'completed', result: '新结果' },
    ]);
  });

  it.each([true, false])('同 run 终态一方缺 run_id 仍去重（updated 缺失=%s）', (missingUpdated) => {
    const mapper = createTurnMapper();
    mapper.map(startAgent());
    const updated = task('task_updated', { run_id: missingUpdated ? undefined : 'r1', patch: { status: 'completed' } });
    const notification = task('task_notification', { run_id: missingUpdated ? 'r1' : undefined, status: 'completed', summary: '重复' });
    expect(mapper.map(updated)).toHaveLength(1);
    expect(mapper.map(notification)).toEqual([]);
    mapper.map(startAgent({ run_id: 'r2' }));
    expect(mapper.map(task('task_notification', { run_id: undefined, status: 'completed', summary: '新结果' }))).toHaveLength(1);
  });

  it('新 run 的 id 字母序更小仍续跑，并忽略已见旧 run 的延迟消息', () => {
    const mapper = createTurnMapper();
    mapper.map(startAgent({ run_id: 'z-old' }));
    mapper.map(task('task_notification', { run_id: 'z-old', status: 'completed', summary: '旧结果' }));
    expect(mapper.map(startAgent({ run_id: 'a-new' }))).toEqual([
      { type: 'subagent_status', id: 'child', status: 'running' },
    ]);
    expect(mapper.map(task('task_notification', { run_id: 'z-old', status: 'failed', summary: '延迟结果' }))).toEqual([]);
    expect(mapper.map(startAgent({ run_id: 'z-old' }))).toEqual([]);
    expect(mapper.map(task('task_updated', { run_id: 'a-new', patch: { status: 'completed' } }))).toEqual([
      { type: 'subagent_status', id: 'child', status: 'completed', result: undefined },
    ]);
    expect(mapper.map(task('task_notification', { run_id: undefined, status: 'completed', summary: '重复' }))).toEqual([]);
  });

});
