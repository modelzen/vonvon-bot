import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { defaultCardDisplay, type CardDisplayConfig } from '@vonvon/protocol';
import { loadCommands } from './helpers/cli-commands';

/**
 * devices 8.1, run as a user would: each command with --json prints one JSON line on stdout and nothing on stderr,
 * `{ ok: true, … }` on exit 0 and `{ ok: false, error: { kind, message }, exitCode }` with the same exit code
 * otherwise. No daemon runs and the data root is a temporary one, so the RPC commands answer 3 (or 2 for bad input).
 */
/** No background service on Windows (owner 2026-11-01: Mac and Windows run the desktop app only), so the service commands fail there. */
const WINDOWS = process.platform === 'win32';
const SAMPLES: ReadonlyArray<readonly [string[], number]> = [
  [['daemon', 'start', '--port', '70000'], 2], [['daemon', 'stop'], 0], [['daemon', 'status'], 0], [['daemon', 'logs'], 0], [['daemon', 'logs', '--follow'], 3],
  [['service', 'install'], 1], [['service', 'uninstall'], WINDOWS ? 1 : 0], [['service', 'status'], WINDOWS ? 1 : 0], [['service', 'skip'], 3],
  [['bot', 'add'], 3], [['bot', 'list'], 3], [['bot', 'status'], 3], [['bot', 'repair-dir', 'nope'], 1],
  [['bot', 'enable'], 3], [['bot', 'disable'], 3], [['bot', 'remove', 'x'], 3], [['bot', 'rescan'], 3],
  [['bot', 'callback', 'status'], 3], [['bot', 'callback', 'confirm'], 3], [['bot', 'callback', 'unconfirm'], 3],
  [['group', 'list'], 3], [['group', 'joined'], 3], [['group', 'pending'], 3], [['group', 'bind', 'oc_x', '--folder', '.'], 2],
  [['group', 'create', 'x', '--conversation', 'multi'], 3], [['group', 'show', 'g'], 3], [['group', 'set', 'g', '--disable'], 3], [['group', 'unbind', 'g'], 3],
  [['dir', 'list'], 3], [['dir', 'suggest', 'x'], 3],
  [['project', 'list'], 0], [['project', 'rename', 'p', 'q'], 3], [['project', 'remove', 'p'], 3], [['project', 'workspace', 'p', '--add', '.'], 3],
  [['memory', 'list'], 2], [['memory', 'export'], 2], [['memory', 'add', 'x'], 2], [['memory', 'edit', 'x', '--revision', '1'], 2],
  [['memory', 'archive', 'x', '--revision', '1'], 2], [['memory', 'reseal'], 2], [['memory', 'branch-rename', 'a', 'b'], 2], [['memory', 'branch-merge', 'a', 'b'], 2],
  [['memory', 'events', 'x'], 2], [['memory', 'restore', 'x', '--revision', '1'], 2], [['memory', 'confirm', 'x', '--revision', '1'], 2],
  [['memory', 'promote', 'x', '--revision', '1'], 2], [['memory', 'move', 'x', '--revision', '1', '--to', 'p'], 2], [['memory', 'purge', 'x'], 2],
  [['memory', 'undo', 'e'], 2], [['memory', 'branch-delete', 'a'], 2], [['memory', 'people'], 2],
  // C5: a write goes through the daemon only, so with none running it is 3; the old name of archive still works
  [['memory', 'add', 'x', '--project', 'p'], 3], [['memory', 'forget', 'x', '--revision', '1', '--project', 'p'], 3],
  // Codex review 251-1: given --scope, the reads that fall back to the files want the daemon instead (no project p: 2 without it)
  [['memory', 'list', '--project', 'p', '--scope', 'bot=cli_a'], 3], [['memory', 'export', '--project', 'p', '--scope', 'bot=cli_a'], 3],
  [['memory', 'events', 'x', '--project', 'p', '--scope', 'bot=cli_a,group=oc_x'], 3], [['memory', 'list', '--project', 'p'], 2],
  [['project', 'list', '--scope', 'bot=cli_a'], 3], [['daemon', 'status', '--scope', 'bot=cli_a'], 3],
  [['settings', 'get'], 3], [['settings', 'access'], 3], [['settings', 'set', '--dm', 'presentation.cardDisplay=null'], 3],
  [['settings', 'set', 'cards.showToolCalls=false'], 2],
  [['settings', 'card-template'], 0], [['settings', 'card-check', 'missing-card.json'], 2],
  [['settings', 'card-test', 'missing-card.json', '--cwd', tmpdir()], 2],
  [['settings', 'get', '--host'], 3], [['settings', 'act', 'voice', 'test'], 3], [['settings', 'act', 'admin', 'add', 'ou_x'], 3], [['settings', 'act', 'admin', 'add', '123'], 2],
  [['settings', 'act', 'member', 'all', '--group', 'g'], 3], [['settings', 'act', 'comment-instructions', '--default'], 3], [['settings', 'act', 'comment-instructions', '--stdin'], 2],
  [['settings', 'models', '--backend', 'codex', '--purpose', 'project'], 3],
  [['schedule', 'list', '--all'], 3], [['schedule', 'add', '--group', 'g', '--name', 'n', '--every', '30m', 'x'], 3], [['schedule', 'edit', 'st_x', '--group', 'g', '--revision', 'r', '--name', 'n'], 3],
  [['schedule', 'delete', 'st_x', '--group', 'g'], 3], [['schedule', 'pause', 'st_x', '--group', 'g'], 3], [['schedule', 'resume', 'st_x', '--group', 'g'], 3],
  [['schedule', 'run', 'st_x', '--group', 'g'], 3], [['schedule', 'runs', 'st_x', '--group', 'g'], 3],
  [['session', 'list', '--group', 'g'], 3], [['session', 'context', '--group', 'g'], 3], [['session', 'clear', '--group', 'g'], 3], [['session', 'compact', '--group', 'g'], 3],
  [['session', 'resume', 'x', '--group', 'g'], 3], [['session', 'stop', '--group', 'g'], 3], [['session', 'end-goal', '--group', 'g'], 3],
  [['session', 'stop-subagent', 'x', '--group', 'g'], 3], [['session', 'reminder', '--on', '--group', 'g'], 3],
  [['usage', 'show'], 3], [['usage', 'share', '--group', 'g'], 3], [['usage', 'judge'], 3],
  [['memory', 'people'], 2],
  [['feishu', 'groups'], 3], [['feishu', 'members', 'oc_x'], 3],
  [['feishu', 'messages', 'oc_x'], 3], [['feishu', 'message', 'om_x'], 3], [['feishu', 'file', 'om_x', 'file_x', '--type', 'file'], 3], [['feishu', 'chat', 'oc_x'], 3],
  [['feishu', 'doc', 'dox'], 3], [['feishu', 'sheet', 'sht'], 3], [['feishu', 'base', 'bas'], 3], [['feishu', 'slides', 'sld'], 3], [['feishu', 'mindnote', 'bmn'], 3],
  [['feishu', 'board', 'brd'], 3], [['feishu', 'minutes', 'min'], 3], [['feishu', 'drive', 'box'], 3], [['feishu', 'folder'], 3], [['feishu', 'wiki'], 3],
  [['feishu', 'comments', 'dox'], 3], [['feishu', 'doc-media', 'box'], 3], [['feishu', 'search', 'x'], 3],
  [['env', 'scan'], 3], [['env', 'install', 'codex'], 3], [['env', 'update', 'codex'], 3], [['env', 'uninstall', 'codex'], 3], [['env', 'login', 'lark-cli'], 3],
  [['env', 'profile', 'list'], 3], [['env', 'profile', 'use', 'p'], 3], [['env', 'profile', 'add', 'p', '--app-id', 'cli_x'], 3], [['env', 'profile', 'init', 'p'], 3],
  [['env', 'backend', 'list'], 3], [['env', 'backend', 'version', 'x'], 3], [['env', 'backend', 'install', 'x'], 3], [['env', 'backend', 'uninstall', 'x'], 3],
  [['env', 'backend', 'check', 'x'], 3], [['env', 'cancel', 'install'], 3],
  [['provider', 'models', 'codex'], 3],
  [['secrets', 'list'], 0], [['secrets', 'set', 'typesafe-api-key'], 2], [['secrets', 'remove', 'typesafe-api-key'], 0], [['secrets', 'test', 'typesafe-api-key'], 3],
  [['mcp', 'list', '--provider', 'codex'], 3], [['mcp', 'add', 'x', '--provider', 'codex', '--command', 'y'], 3], [['mcp', 'remove', 'x', '--provider', 'codex'], 3], [['mcp', 'add', 'x', '--provider', 'codex'], 2],
  [['import', 'detect'], 3], [['import', 'preflight'], 3], [['import', 'start'], 3], [['import', 'status'], 3], [['import', 'rollback'], 3],
  [['context', 'show', '--group', 'g'], 3], [['context', 'show'], 2], [['now'], 3], [['snapshot'], 3],
  // devices 4.5: pair needs the daemon; the others fall back to the files
  [['pair'], 3], [['clients', 'ls'], 0], [['clients', 'rename', 'cl_0000000000000000', 'x'], 2], [['clients', 'revoke', 'cl_0000000000000000'], 2], [['device', 'rename', 'x'], 0],
  // D3 4.8: remote too; a public address needs --allow-public, a port under 1024 is a typing error
  [['remote', 'status'], 0], [['remote', 'enable', '203.0.113.5'], 4], [['remote', 'disable', '192.0.2.1'], 2], [['remote', 'port', '80'], 2],
  // Codex review 232-1, 234-2: a wildcard or a link-local IPv6 is a typing error, confirmed or not
  [['remote', 'enable', '0.0.0.0', '--allow-public'], 2], [['remote', 'enable', 'fe80::1%eth0'], 2],
  // A1: no address and no terminal (and --json is none): the candidates and a command to copy; disable with nothing open
  [['remote', 'enable'], 2], [['remote', 'disable'], 2], [['remote', 'candidates'], 0],
  [['update', '--to', 'latest'], 2],
  [['template', 'inspect', 'missing.vonvon.zip'], 1], [['template', 'extract', 'missing.vonvon.zip', '--dest', 'out'], 1],
  [['template', 'stage', 'missing.vonvon.zip', '--dest', 'out'], 1], [['template', 'pack', 'missing-dir', '--out', 'out.vonvon.zip'], 1],
  [['template', 'draft-group', 'missing-group', '--dest', 'out'], 3],
  // argument errors from commander itself
  [['nope'], 2], [['bot', 'list', '--nope'], 2], [['group'], 2],
];
/** These start a daemon when they succeed; test/daemon-cli.test.ts runs them. `daemon run` takes no --json. */
const STARTS_A_DAEMON = ['daemon run', 'daemon restart', 'open'];

let dir: string;
let entry: string;
beforeAll(async () => {
  await mkdir(resolve('node_modules/.cache'), { recursive: true });
  dir = await mkdtemp(resolve('node_modules/.cache/vonvon-cli-json-'));
  entry = join(dir, 'cli.mjs');
  await build({ entryPoints: [resolve('src/cli/index.ts')], outfile: entry, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

function run(home: string, root: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), VONVON_HOME: root, VONVON_SESSION: '', FEISHU_CODEX_BRIDGE: '' };
  delete env.VONVON_SERVICE;
  const child = spawn(process.execPath, [entry, ...args, '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); });
  return new Promise((done, fail) => { child.once('error', fail); child.once('close', code => done({ code, stdout, stderr })); });
}

// main 必败: most commands had no --json, and failures went to stderr as text
it('every command prints one JSON line with --json, its exit code inside a failure', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vonvon-cli-json-'));
  try {
    const home = join(base, 'home'); await mkdir(home);
    const root = join(base, 'data');
    const leaves = (await loadCommands()).filter(command => !command.hidden).map(command => command.path);
    const sampled = (path: string) => SAMPLES.some(([args]) => path.split(' ').every((word, i) => args[i] === word));
    expect(leaves.filter(path => !sampled(path) && !STARTS_A_DAEMON.includes(path))).toEqual([]);
    // one at a time: service and secrets take locks a second caller would be refused
    for (const [args, code] of SAMPLES) {
      const result = await run(home, root, args);
      const what = `vonvon ${args.join(' ')} --json: ${result.stdout}${result.stderr}`;
      expect(result.code, what).toBe(code);
      expect(result.stderr, what).toBe('');
      expect(result.stdout.endsWith('\n') && result.stdout.indexOf('\n') === result.stdout.length - 1, what).toBe(true);
      const json = JSON.parse(result.stdout) as { ok: boolean; exitCode?: number; error?: { kind: string; message: string } };
      expect(json.ok, what).toBe(code === 0);
      if (code !== 0) expect(json, what).toMatchObject({ exitCode: code, error: { kind: expect.any(String), message: expect.any(String) } });
    }
  } finally { await rm(base, { recursive: true, force: true }); }
}, 240_000);

it('prints a reusable card template and checks card files without writing data', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vonvon-card-cli-json-'));
  try {
    const home = join(base, 'home'); await mkdir(home);
    const root = join(base, 'data');
    const template = await run(home, root, ['settings', 'card-template']);
    expect(template.code).toBe(0);
    expect(template.stderr).toBe('');
    const templateJson = JSON.parse(template.stdout) as { ok: boolean; cardDisplay: unknown };
    expect(templateJson.ok).toBe(true);
    expect(templateJson.cardDisplay).toMatchObject({ version: 1, blocks: expect.any(Array) });
    const file = join(base, 'card.json');
    await writeFile(file, JSON.stringify(templateJson.cardDisplay));
    const valid = await run(home, root, ['settings', 'card-check', file]);
    expect(valid).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(valid.stdout)).toMatchObject({ ok: true, kind: 'valid' });
    await writeFile(file, '{broken');
    const malformed = await run(home, root, ['settings', 'card-check', file]);
    expect(malformed).toMatchObject({ code: 2, stderr: '' });
    expect(JSON.parse(malformed.stdout)).toMatchObject({ ok: false, exitCode: 2, error: { kind: expect.any(String), message: expect.stringContaining('JSON') } });
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(base, { recursive: true, force: true }); }
}, 60_000);

it('documents and enforces a read-time revision for complete card objects at the CLI entry', async () => {
  const base=await mkdtemp(join(tmpdir(),'vonvon-card-revision-cli-'));
  try {
    const home=join(base,'home');await mkdir(home);
    const root=join(base,'data');
    const assignment=`presentation.cardDisplay=${JSON.stringify(defaultCardDisplay())}`;
    const missing=await run(home,root,['settings','set','--dm',assignment]);
    expect(missing).toMatchObject({code:2,stderr:''});
    expect(JSON.parse(missing.stdout)).toMatchObject({exitCode:2,error:{kind:'bad-args',message:expect.stringContaining('view.sections.presentation.revision')}});
    const explicit=await run(home,root,['settings','set','--dm','--revision','snapshot-A',assignment]);
    expect(explicit.code).toBe(3); // Passed local validation and tried the absent daemon.
    const help=await run(home,root,['settings','set','--help']);
    expect(help.code).toBe(0);
    const helpText=help.stdout.replace(/\s+/g,' ');
    for(const words of ['required for a complete presentation.cardDisplay','view.sections.presentation.revision','--revision <读取时的版本>','不要仅替换 revision 后重提旧对象']) expect(helpText).toContain(words);
  } finally {await rm(base,{recursive:true,force:true});}
});

it('runs card scripts only on explicit card-test and reports missing JSON output', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vonvon-card-test-json-'));
  try {
    const home = join(base, 'home'); await mkdir(home);
    const root = join(base, 'data');
    const template = JSON.parse((await run(home, root, ['settings', 'card-template'])).stdout) as { cardDisplay: CardDisplayConfig };
    const config = template.cardDisplay;
    const { contextRules: _contextRules, ...seed } = config.blocks[0]!;
    config.blocks.push({ ...seed, id: 'custom_runtime', kind: 'custom', name: '路径', slot: 'top-left',
      source: 'script', language: 'node', template: '{{branch}}', sample: '{"branch":"sample","percent":3}',
      script: "const input=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log(JSON.stringify({branch:input.cwd,percent:input.context.percent}));",
    });
    const file = join(base, 'card.json');
    await writeFile(file, JSON.stringify(config));
    const checked = await run(home, root, ['settings', 'card-check', file]);
    expect(checked.code).toBe(0);
    const tested = await run(home, root, ['settings', 'card-test', file, '--cwd', base]);
    expect(tested).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(tested.stdout)).toMatchObject({ ok: true, kind: 'valid', values: { custom_runtime: { branch: base, percent: 3 } } });
    config.blocks.at(-1)!.script = '({branch:"not printed"});';
    await writeFile(file, JSON.stringify(config));
    expect((await run(home, root, ['settings', 'card-check', file])).code).toBe(0);
    const failed = await run(home, root, ['settings', 'card-test', file, '--cwd', base]);
    expect(failed).toMatchObject({ code: 2, stderr: '' });
    expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, exitCode: 2, error: { message: expect.stringContaining('custom_runtime') } });
    config.blocks.at(-1)!.script = 'console.log(JSON.stringify({}));';
    await writeFile(file, JSON.stringify(config));
    expect((await run(home, root, ['settings', 'card-check', file])).code).toBe(0);
    const missing = await run(home, root, ['settings', 'card-test', file, '--cwd', base]);
    expect(missing).toMatchObject({ code: 2, stderr: '' });
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, exitCode: 2, error: { message: expect.stringContaining('custom_runtime：脚本输出缺少模板字段 branch') } });
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(base, { recursive: true, force: true }); }
}, 60_000);

it.skipIf(WINDOWS)('cleans up card-test helpers before reporting SIGINT or SIGTERM', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vonvon-card-interrupt-'));
  let helperPid: number | undefined;
  let cli: ReturnType<typeof spawn> | undefined;
  try {
    const home = join(base, 'home'); await mkdir(home);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const pidFile = join(base, `${signal}.pid`);
      const config = defaultCardDisplay();
      const { contextRules: _contextRules, ...seed } = config.blocks[0]!;
      config.blocks.push({ ...seed, id: 'custom_wait', kind: 'custom', name: '等待', slot: 'top-left',
        source: 'script', language: 'node', template: '{{branch}}', sample: '{"branch":"sample"}',
        script: `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},100);`,
      });
      const file = join(base, `${signal}.json`);
      await writeFile(file, JSON.stringify(config));
      const root = join(base, `${signal}-data`);
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), VONVON_HOME: root, VONVON_SESSION: '', FEISHU_CODEX_BRIDGE: '' };
      delete env.VONVON_SERVICE;
      cli = spawn(process.execPath, [entry, 'settings', 'card-test', file, '--cwd', base, '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      cli.stdout!.on('data', data => { stdout += String(data); });
      cli.stderr!.on('data', data => { stderr += String(data); });
      const exit = new Promise<{code:number|null; signal:NodeJS.Signals|null}>(resolve => cli!.once('close', (code, endedSignal) => resolve({ code, signal: endedSignal })));
      let pidText: string | undefined;
      for (let n = 0; n < 120 && !pidText; n++) {
        try { pidText = await readFile(pidFile, 'utf8'); }
        catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      expect(pidText, `${signal} helper did not start`).toBeDefined();
      helperPid = Number(pidText);
      cli.kill(signal);
      expect(await exit).toEqual({ code: 130, signal: null });
      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, exitCode: 130, error: { kind: 'interrupted' } });
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
      let gone = false;
      for (let n = 0; n < 50 && !gone; n++) {
        try { process.kill(helperPid, 0); await new Promise(resolve => setTimeout(resolve, 10)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') gone = true; else throw error; }
      }
      expect(gone, `${signal} left helper pid ${helperPid} running`).toBe(true);
      helperPid = undefined;
      cli = undefined;
    }
  } finally {
    cli?.kill('SIGKILL');
    if (helperPid) { try { process.kill(helperPid, 'SIGKILL'); } catch { /* already stopped */ } }
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(WINDOWS)('cleans up syntax-check helpers before card-check or card-test exits on a signal', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vonvon-card-syntax-interrupt-'));
  let helperPid: number | undefined;
  let cli: ReturnType<typeof spawn> | undefined;
  try {
    const home = join(base, 'home'); await mkdir(home);
    const shimDir = join(base, 'bin'); await mkdir(shimDir);
    const shim = join(shimDir, 'pwsh');
    for (const command of ['card-check', 'card-test'] as const) for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const pidFile = join(base, `${command}-${signal}.pid`);
      await writeFile(shim, `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(pidFile)}\nwhile :; do sleep 1; done\n`);
      await chmod(shim, 0o755);
      const config = defaultCardDisplay();
      const { contextRules: _contextRules, ...seed } = config.blocks[0]!;
      config.blocks.push({ ...seed, id: 'custom_syntax', kind: 'custom', name: '语法检查', slot: 'top-left',
        source: 'script', language: 'powershell', template: '{{branch}}', sample: '{"branch":"sample"}',
        script: "Write-Output '{\"branch\":\"sample\"}'",
      });
      const file = join(base, `${command}-${signal}.json`);
      await writeFile(file, JSON.stringify(config));
      const root = join(base, `${command}-${signal}-data`);
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), VONVON_HOME: root, VONVON_SESSION: '', FEISHU_CODEX_BRIDGE: '', PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}` };
      delete env.VONVON_SERVICE;
      cli = spawn(process.execPath, [entry, 'settings', command, file, ...command === 'card-test' ? ['--cwd', base] : [], '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      cli.stdout!.on('data', data => { stdout += String(data); });
      cli.stderr!.on('data', data => { stderr += String(data); });
      const exit = new Promise<{code:number|null; signal:NodeJS.Signals|null}>(resolve => cli!.once('close', (code, endedSignal) => resolve({ code, signal: endedSignal })));
      let pidText: string | undefined;
      for (let n = 0; n < 120 && !pidText; n++) {
        try { pidText = await readFile(pidFile, 'utf8'); }
        catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      expect(pidText, `${command} ${signal} syntax helper did not start`).toBeDefined();
      helperPid = Number(pidText);
      cli.kill(signal);
      expect(await exit).toEqual({ code: 130, signal: null });
      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, exitCode: 130, error: { kind: 'interrupted' } });
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
      let gone = false;
      for (let n = 0; n < 50 && !gone; n++) {
        try { process.kill(helperPid, 0); await new Promise(resolve => setTimeout(resolve, 10)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') gone = true; else throw error; }
      }
      expect(gone, `${command} ${signal} left syntax helper pid ${helperPid} running`).toBe(true);
      helperPid = undefined;
      cli = undefined;
    }
  } finally {
    cli?.kill('SIGKILL');
    if (helperPid) { try { process.kill(helperPid, 'SIGKILL'); } catch { /* already stopped */ } }
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);

// cli-2-bot 4.6: only the commands named in LEASED take the data lease, and with it make the data root
it('takes the data lease for the commands that write the data root only', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vonvon-cli-lease-'));
  try {
    const home = join(base, 'home'); await mkdir(home);
    const root = join(base, 'data');
    expect((await run(home, root, ['bot', 'enable'])).code).toBe(3);
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await run(home, root, ['daemon', 'stop'])).code).toBe(0);
    expect((await stat(root)).isDirectory()).toBe(true);
    // devices 4.5: with no daemon, clients ls makes devices/ itself, so it needs the data root the lease makes
    const fresh = join(base, 'fresh');
    expect((await run(home, fresh, ['clients', 'ls'])).code).toBe(0);
    expect((await stat(join(fresh, 'devices'))).isDirectory()).toBe(true);
  } finally { await rm(base, { recursive: true, force: true }); }
}, 60_000);
