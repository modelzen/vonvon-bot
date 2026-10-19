import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend } from '../src/agent';
import type { AgentEvent, AgentThread, PermissionMode } from '../src/agent/types';
const LIVE = process.env.CLAUDE_LIVE === '1';
const dirs: string[] = [];
const threads: AgentThread[] = [];
afterEach(async () => {
  await Promise.all(threads.splice(0).map(t => t.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace(): { dir: string; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), 's31-live-')); dirs.push(dir);
  const cwd = join(dir, 'work'); mkdirSync(cwd); return { dir, cwd };
}
async function start(cwd: string, mode: PermissionMode, network = false): Promise<AgentThread> {
  const thread = await createBackend('claude-agent').startThread({ cwd, mode, network, model: 'claude-haiku-5-5' });
  threads.push(thread); return thread;
}
async function run(thread: AgentThread, text: string, answer = false): Promise<AgentEvent[]> {
  const result = thread.runStreamed({ text }); const events: AgentEvent[] = [];
  for await (const event of result.events) {
    events.push(event);
    if (answer && event.type === 'ask') await result.respondToAsk?.(event.request.id, { kind: 'answered', answer: { kind: 'text', text: 'A' } });
  }
  expect(events.some(e => e.type === 'error' && !e.willRetry)).toBe(false);
  expect(events.some(e => e.type === 'done')).toBe(true);
  return events;
}
function text(events: AgentEvent[]): string {
  return events.flatMap(e => e.type === 'text_delta' ? [e.delta] : e.type === 'text' ? [e.text] : []).join('');
}
describe.runIf(LIVE)('Claude permission live boundaries', () => {
  it('qa refuses Write with a read-only explanation', { timeout: 180_000 }, async () => {
    const { cwd } = workspace(); const thread = await start(cwd, 'qa');
    const events = await run(thread, `Use Write to create ${cwd}/a.txt with hi. If refused, explain the exact reason in Chinese; do not retry other tools.`);
    expect(existsSync(join(cwd, 'a.txt'))).toBe(false); expect(text(events)).toContain('只读');
  });
  it('offline sandboxed curl cannot get HTTP 200', { timeout: 180_000 }, async () => {
    const { cwd } = workspace(); const events = await run(await start(cwd, 'write'), 'Use Bash exactly: curl -sS -m 10 -o /dev/null -w \'%{http_code}\' https://example.com . If denied, report the reason; do not retry.');
    const outputs = events.flatMap(e => e.type === 'tool_result' ? [e.output ?? ''] : []).join('\n');
    expect(outputs).not.toMatch(/(^|\s)200(\s|$)/); expect(text(events)).toMatch(/网络|联网|network|denied/i);
  });
  it('online WebFetch works', { timeout: 180_000 }, async () => {
    const { cwd } = workspace();
    expect(text(await run(await start(cwd, 'write', true), 'Use WebFetch for https://example.com and report its title.'))).toContain('Example Domain');
  });
  it('write tier accepts workspace writes and refuses outside writes', { timeout: 180_000 }, async () => {
    const { cwd, dir } = workspace();
    await run(await start(cwd, 'write'), `Use Write for ${cwd}/in.txt then ${dir}/x.txt, each with hi. Do not substitute Bash or retry the refusal.`);
    expect(existsSync(join(cwd, 'in.txt'))).toBe(true); expect(existsSync(join(dir, 'x.txt'))).toBe(false);
  });
  it('project allow rules cannot bypass the file hook', { timeout: 180_000 }, async () => {
    const { cwd, dir } = workspace(); mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude/settings.json'), JSON.stringify({ permissions: { allow: [`Write(/${dir}/**)`] } }));
    await run(await start(cwd, 'write'), `Use Write to create ${dir}/y.txt with hi. Do not use other tools or retry.`);
    expect(existsSync(join(dir, 'y.txt'))).toBe(false);
  });
  it.each(['write', 'full'] as const)('%s bridges a real question and answer', { timeout: 180_000 }, async mode => {
    const { cwd } = workspace(); const events = await run(await start(cwd, mode), 'Use AskUserQuestion to ask whether I choose A or B. Wait for its answer, then repeat the selected answer.', true);
    expect(events.some(e => e.type === 'ask' && e.request.kind === 'choices')).toBe(true); expect(text(events)).toContain('A');
  });
});
