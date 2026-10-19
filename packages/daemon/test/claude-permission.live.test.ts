import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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


describe.runIf(LIVE)('Claude secrets get live sandbox', () => {
  it.each([
    { mode: 'qa', network: false },
    { mode: 'write', network: false },
    { mode: 'write', network: true },
  ] satisfies { mode: PermissionMode; network: boolean }[])('secrets get in $mode with network=$network', { timeout: 180_000 }, async ({ mode, network }) => {
    const { dir, cwd } = workspace(); const root = join(dir, 'vh'); mkdirSync(root);
    const cache = resolve('node_modules/.cache'); mkdirSync(cache, { recursive: true });
    const bundle = mkdtempSync(join(cache, 'secrets-get-live-')); dirs.push(bundle);
    const cli = join(bundle, 'cli.mjs'); const keystore = join(bundle, 'keystore.cjs');
    await build({ entryPoints: [resolve('src/cli/index.ts')], outfile: cli, bundle: true, packages: 'external', platform: 'node', format: 'esm' });
    await build({ entryPoints: [resolve('src/config/keystore.ts')], outfile: keystore, bundle: true, platform: 'node', format: 'cjs' });
    const fake = randomBytes(24).toString('hex');
    const setter = spawn(process.execPath, ['-e', `require(${JSON.stringify(keystore)}).setSecret('app-cli_fake',process.env.FAKE_SECRET).catch(()=>{process.exitCode=1})`], { env: { ...process.env, HOME: dir, VONVON_HOME: root, FAKE_SECRET: fake }, stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve, reject) => { setter.once('error', reject); setter.once('close', resolve); });
    expect(code).toBe(0);
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    const getter = join(root, 'secrets-getter');
    writeFileSync(getter, `#!/bin/sh\nVONVON_HOME=${quote(root)} exec ${quote(process.execPath)} ${quote(cli)} secrets get "$@"\n`, { mode: 0o700 });
    const before = readdirSync(root, { recursive: true }).sort();
    const expected = ['master.key', 'secrets-getter', 'secrets.enc'];
    if (process.platform === 'darwin') expected.push('.locks', join('.locks', 'keystore.lock'));
    expect(before).toEqual(expected.sort());
    const command = `printf '%s' '{"protocolVersion":1,"provider":"bridge","ids":["app-cli_fake"]}' | ${quote(getter)}`;
    const events = await run(await start(cwd, mode, network), ['Use Bash exactly once:', '```sh', command, '```', 'Report the output; do not retry.'].join('\n'));
    const replies = events.flatMap(event => event.type === 'tool_result' ? (event.output ?? '').split('\n').filter(line => line.startsWith('{"protocolVersion"')) : []);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.some(line => {
      try { return JSON.stringify(JSON.parse(line)) === JSON.stringify({ protocolVersion: 1, values: { 'app-cli_fake': fake }, errors: {} }); }
      catch { return false; }
    })).toBe(true);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
  });
});
