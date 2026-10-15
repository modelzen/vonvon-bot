import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// s02c2: the hooks 咖啡一下 put into Claude Code and Codex CLI still run `vonvon hook` on every PermissionRequest
// and Stop. It must stay silent and exit 0 whatever it gets, so the tool asks in its terminal as before.
const bin = resolve(import.meta.dirname, '../bin/vonvon.mjs');
const root = mkdtempSync(join(tmpdir(), 'vonvon-hook-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Run = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; ms: number; writeError?: Error; homeFiles: string[] };

function run(entry: string, args: string[], input?: string | Buffer, keepOpen = false): Promise<Run> {
  const home = mkdtempSync(join(root, 'home-'));
  const env = { ...process.env, HOME: home, VONVON_HOME: join(home, 'vonvon'), NODE_OPTIONS: '' };
  const started = Date.now();
  const child = spawn(process.execPath, [entry, ...args], { env, stdio: 'pipe' });
  let stdout = '';
  let stderr = '';
  let writeError: Error | undefined;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.stdin.on('error', (error) => { writeError = error; });
  if (input !== undefined) child.stdin.write(input);
  if (!keepOpen) child.stdin.end();
  return new Promise((done, fail) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('vonvon hook did not exit within 10 s')); }, 10_000);
    child.once('error', fail);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, stdout, stderr, ms: Date.now() - started, ...(writeError ? { writeError } : {}), homeFiles: readdirSync(home, { recursive: true }).map(String) });
    });
  });
}

const hook = (args: string[], input?: string | Buffer, keepOpen = false) => run(bin, ['hook', ...args], input, keepOpen);

function expectSilentSuccess(result: Run): void {
  expect(result).toMatchObject({ code: 0, signal: null, stdout: '', stderr: '' });
  expect(result.writeError).toBeUndefined();
  // No data root, lease or log: the hook never reaches the daemon code.
  expect(result.homeFiles).toEqual([]);
}

const event = (fields: Record<string, unknown>) => JSON.stringify({ session_id: 's1', transcript_path: '/tmp/s1.jsonl', cwd: '/repo', ...fields }) + '\n';
const claudePermission = event({ hook_event_name: 'PermissionRequest', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Remove build' } });
const codexPermission = event({ hook_event_name: 'PermissionRequest', turn_id: 't1', model: 'gpt-5.5', tool_name: 'Bash', tool_input: { command: 'git push' } });
const stop = event({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });

describe('vonvon hook is an empty command', () => {
  it.each([
    ['Claude PermissionRequest', ['--agent', 'claude'], claudePermission],
    ['Claude Stop', ['--agent', 'claude'], stop],
    ['Codex PermissionRequest with --bot', ['--bot', 'cli_a1b2c3', '--agent', 'codex'], codexPermission],
    ['Codex Stop', ['--agent', 'codex'], stop],
    ['an old PostToolUse', ['--agent', 'claude'], event({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })],
  ])('%s: prints nothing and exits 0', async (_name, args, input) => {
    expectSilentSuccess(await hook(args, input));
  });

  it.each([
    ['empty stdin', ''],
    ['cut-off JSON', '{"hook_event_name":"PermissionRequest","tool_input":{'],
    ['not JSON', 'yes\n'],
    ['binary bytes', Buffer.from([0xff, 0xfe, 0x00, 0x1b, 0x5b, 0x41])],
  ])('%s: prints nothing and exits 0', async (_name, input) => {
    expectSilentSuccess(await hook(['--agent', 'claude'], input));
  });

  it.each([
    ['an unknown agent', ['--agent', 'gemini']],
    ['no --agent', []],
    ['--agent with no value', ['--agent']],
    ['options a later hook line might add', ['--bot=cli_x', '--agent', 'codex', '--matcher', '*', '--timeout', '86400', 'extra']],
    ['--help', ['--help']],
    ['--version', ['--version']],
  ])('%s: prints nothing and exits 0', async (_name, args) => {
    expectSilentSuccess(await hook(args, claudePermission));
  });

  it('reads all of a large event so the writer never meets a closed pipe', async () => {
    const big = event({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { content: 'x'.repeat(8 * 1024 * 1024) } });
    expectSilentSuccess(await hook(['--agent', 'claude'], big));
  });

  it('gives up on a stdin that never closes after about 2 s', async () => {
    const result = await hook(['--agent', 'claude'], claudePermission, true);
    expectSilentSuccess(result);
    expect(result.ms).toBeGreaterThanOrEqual(1900);
    expect(result.ms).toBeLessThan(8000);
  });

  it('answers before the CLI bundle loads', async () => {
    // A copy of the entry with no dist/ next to it: any other command fails to load the bundle.
    const entry = join(root, 'package', 'bin', 'vonvon.mjs');
    mkdirSync(join(root, 'package', 'bin'), { recursive: true });
    copyFileSync(bin, entry);
    const other = await run(entry, ['--version']);
    expect(other.code).not.toBe(0);
    expect(other.stderr).toContain('ERR_MODULE_NOT_FOUND');
    expectSilentSuccess(await run(entry, ['hook', '--agent', 'codex'], codexPermission));
  });
});
