import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCooldown } from '../src/judge/cooldown';
import { JudgeCallError } from '../src/agent/types';
import { claudeWithFakeCli, writeWaitingClaudeCli } from './helpers/fake-claude-cli';

// Real SDK transport, a local fake CLI: never starts Claude or submits inference.
describe('Claude judge process ownership', () => {
  it.each(['normal', 'result', 'abort', 'error', 'exit', 'signal', 'auth', 'quota', 'model', 'max-turns'] as const)('waits for process death on %s', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'claude-judge-process-'));
    const cli = join(root, 'fake-cli.mjs');
    const pidFile = join(root, 'pid');
    await writeFile(cli, `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
if (${JSON.stringify(mode)} === 'normal') process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  if (message.type === 'user') {
    if (['auth', 'quota', 'model'].includes(${JSON.stringify(mode)})) {
      send({ type: 'assistant', error: ${JSON.stringify(mode === 'auth' ? 'authentication_failed' : mode === 'quota' ? 'rate_limit' : 'model_not_found')}, message: { content: [] } });
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', errors: ['structured fake error'] }) + '\\n', () => process.exit(1));
      return;
    }
    if (${JSON.stringify(mode)} === 'max-turns') {
      // the CLI 2.1.296 after a text answer: error_max_turns, then exit 1 (e12)
      send({ type: 'assistant', message: { content: [{ type: 'text', text: '{"decision":"skip","reason":"闲聊"}' }] } });
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (1)'], usage: {} }) + '\\n', () => process.exit(1));
      return;
    }
    if (${JSON.stringify(mode)} === 'exit') process.exit(7);
    if (${JSON.stringify(mode)} === 'signal') process.kill(process.pid, 'SIGUSR2');
    if (${JSON.stringify(mode)} === 'error') send({ type: 'assistant', error: 'rate_limit', message: { content: [] } });
    if (${JSON.stringify(mode)} !== 'abort') send({ type: 'result', subtype: ${JSON.stringify(mode === 'error' ? 'error_during_execution' : 'success')}, result: '{}', errors: ['fake error'], usage: {} });
  }
});
`);
    const controller = new AbortController();
    const backend = claudeWithFakeCli(root, cli);
    let pid: number | undefined;
    try {
      const pending = backend.judge!({ system: 'fake', input: 'fake', model: 'fake', schema: {}, cwd: root, signal: controller.signal })
        .then(value => ({ value }), (error: unknown) => ({ error }));
      await expect.poll(async () => {
        try { pid = Number(await readFile(pidFile, 'utf8')); return pid; } catch { return undefined; }
      }).toBeTypeOf('number');
      if (mode === 'abort') controller.abort();
      const outcome = await pending;
      expect(pid).toBeTypeOf('number');
      expect(() => process.kill(pid!, 0)).toThrow();
      if (['auth', 'quota', 'model'].includes(mode)) {
        expect(outcome).toMatchObject({ error: { kind: mode, structured: true } });
        const cooldown = createCooldown(() => 1000);
        if ('error' in outcome) cooldown.note('claude-agent', 'fake', outcome.error);
        expect(cooldown.check('claude-agent', 'fake')).toMatchObject({ kind: mode });
      }
      // Ignoring TERM requires KILL: even a structured quota error must report cleanup failure.
      expect(outcome).toHaveProperty(mode === 'normal' || mode === 'max-turns' ? 'value' : 'error');
      // its exit 1 is expected there, not a cleanup failure
      if (mode === 'max-turns') expect(outcome).toMatchObject({ value: { text: '{"decision":"skip","reason":"闲聊"}' } });
      if (['result', 'abort', 'error'].includes(mode)) expect(outcome).toMatchObject({ error: { name: 'Error', message: 'Claude 子进程树已退出，但清理失败' } });
      // The group is killed by us, not through the SDK's forwarded signal on spawn, which also
      // reported an AbortError (s23c review F3): the only failure left is the SIGKILL.
      if (mode === 'abort' && 'error' in outcome) {
        const cause = (outcome.error as Error).cause;
        expect(cause).toBeInstanceOf(AggregateError);
        expect((cause as AggregateError).errors.map((error: Error) => error.message)).toEqual(['Claude process group required SIGKILL']);
      }
    } finally {
      if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already reaped */ } }
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  // The real CLI exits 143 soon after SIGTERM, and with a request in flight ignores stdin EOF. The SDK
  // alone only ends stdin on abort and sends its own SIGTERM 2 s later (s23c review F2, F3).
  it.skipIf(process.platform === 'win32')('an abort stops a CLI waiting on the API at once, and its exit 143 is not a cleanup failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-judge-term-'));
    const { cli, pidFile } = await writeWaitingClaudeCli(root);
    const controller = new AbortController();
    let pid: number | undefined;
    try {
      const pending = claudeWithFakeCli(root, cli).judge!({ system: 'fake', input: 'fake', model: 'fake', schema: {}, cwd: root, signal: controller.signal })
        .then(value => ({ value }), (error: unknown) => ({ error }));
      await expect.poll(async () => readFile(`${pidFile}.user`, 'utf8').catch(() => undefined), { timeout: 10_000 }).toBe('1');
      pid = Number(await readFile(pidFile, 'utf8'));
      const abortedAt = Date.now();
      controller.abort();
      const outcome = await pending;
      const settledMs = Date.now() - abortedAt;
      expect('error' in outcome && outcome.error).toBeInstanceOf(JudgeCallError);
      expect(settledMs).toBeLessThan(1_500);
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already reaped */ } }
      await rm(root, { recursive: true, force: true });
    }
  });
});
