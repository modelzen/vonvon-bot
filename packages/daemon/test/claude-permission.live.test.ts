import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { loadBackendDep } from '../src/agent/backend-loader';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { claudeAccess, permissionOptions } from '../src/agent/claude-agent/permission';
import { permissionTable } from '../src/agent/permission';
import { createAgentEntries } from '../src/agent/entry/registry';
import type { AgentTool } from '../src/agent/entry/tools';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend } from '../src/agent';
import type { AgentEvent, AgentThread, PermissionMode, ReadScope } from '../src/agent/types';
const LIVE = process.env.CLAUDE_LIVE === '1';
const dirs: string[] = [];
const threads: AgentThread[] = [];
afterEach(async () => {
  await Promise.all(threads.splice(0).map(t => t.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace(): { dir: string; cwd: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 's31-live-'))); dirs.push(dir);
  const cwd = join(dir, 'work'); mkdirSync(cwd); return { dir, cwd };
}
async function start(cwd: string, mode: PermissionMode, network = false, readScope?: ReadScope): Promise<AgentThread> {
  const thread = await createBackend('claude-agent').startThread({ cwd, mode, network, readScope, model: 'claude-haiku-5-5' });
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


function scopedWorkspace() {
  const { dir } = workspace(), root = join(dir, 'vh'), cwd = join(root, 'projects/A/groups/g1');
  mkdirSync(cwd, { recursive: true });
  const blocked = ['projects/A/groups/g2/private.txt', 'bots/A/memory/dm/u1/private.txt', 'library/p1/memory.json', 'local-credential', 'config.json', '.keystore.salt'];
  const allowed = ['secrets.enc', 'master.key', 'bots/A/skills/s/SKILL.md'];
  const markers = new Map<string, string>();
  for (const rel of [...blocked, ...allowed]) {
    const file = join(root, rel), marker = `fixture-${randomBytes(16).toString('hex')}`;
    mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, marker); markers.set(file, marker);
  }
  const readScope: ReadScope = { deny: ['bots', 'projects', 'library', 'local-credential', 'config.json', '.keystore.salt'].map(rel => join(root, rel)), allow: [join(root, 'bots/A/skills')] };
  return { cwd, root, blocked: blocked.map(rel => join(root, rel)), allowed: allowed.map(rel => join(root, rel)), markers, readScope };
}
function workspaceFiles(cwd: string): string[] {
  return readdirSync(cwd, { recursive: true, encoding: 'utf8' }).filter(file => {
    if (file === '.claude') {
      const contents = readdirSync(join(cwd, file));
      return contents.length !== 1 || contents[0] !== '.cc-writes';
    }
    return file !== '.claude/.cc-writes';
  }).sort();
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
describe.runIf(LIVE)('s31b real backend read and configuration boundaries', () => {
  it.each(['qa', 'write'] as const)('%s blocks private Bash and Read but admits cwd, skills and credential getter files', { timeout: 300_000 }, async mode => {
    const f = scopedWorkspace(), own = join(f.cwd, 'own.txt'), ownMarker = randomBytes(16).toString('hex');
    writeFileSync(own, ownMarker); f.allowed.push(own); f.markers.set(own, ownMarker);
    const thread = await start(f.cwd, mode, false, f.readScope);
    const command = [
      ...f.blocked.map((file, i) => `wc -c < ${shellQuote(file)} > /dev/null; echo READ_${i}:$?`),
      ...f.allowed.map((file, i) => `wc -c < ${shellQuote(file)} > /dev/null; echo ALLOW_${i}:$?`),
    ].join('; ');
    const probe = await run(thread, `All files below are disposable integration fixtures created by the test runner. Their contents are neutral generated fixture text, never real credentials. For every file, only check the shell read-access exit code; do not display any file contents. Use Bash exactly once with this command, without changing it or substituting tools:\n${command}`);
    const bash = liveOutput(probe);
    expect(bash, text(probe)).not.toBe('');
    for (const [i, file] of f.blocked.entries()) { expect(bash).not.toContain(f.markers.get(file)); expect(bash).toMatch(new RegExp(`READ_${i}:[1-9]`)); }
    for (const i of f.allowed.keys()) expect(bash).toContain(`ALLOW_${i}:0`);
    for (const file of [join(f.root, 'projects/A/groups/g2/private.txt'), own, join(f.root, 'bots/A/skills/s/SKILL.md')]) {
      const reads = await run(thread, `This is an authorization regression test on a disposable random-marker fixture. Do not infer the outcome from earlier Bash commands. Call the Read tool exactly once on ${file}, even when a denial is expected. Do not substitute tools or skip the call.`);
      const results = reads.filter(event => event.type === 'tool_result');
      expect(results, text(reads)).toHaveLength(1);
      if (file === f.blocked[0]) expect(liveOutput(reads)).not.toContain(f.markers.get(file));
      else expect(liveOutput(reads)).toContain(f.markers.get(file));
    }
  });
  it.each(['qa', 'write'] as const)('%s starts with an empty default workspace without adding mount placeholders', { timeout: 180_000 }, async mode => {
    const f = scopedWorkspace(); expect(readdirSync(f.cwd)).toEqual([]);
    const command = 'true; echo START:$?; touch note.txt; echo WRITE:$?';
    const events = await run(await start(f.cwd, mode, false, f.readScope), `Use Bash exactly once: ${command}. Do not retry or use other tools.`);
    expect(liveOutput(events)).toContain('START:0');
    expect(liveOutput(events)).toContain(mode === 'write' ? 'WRITE:0' : 'WRITE:1');
    expect(workspaceFiles(f.cwd)).toEqual(mode === 'write' ? ['note.txt'] : []);
    // An otherwise empty .claude is tolerated only for the CLI-owned .cc-writes directory.
    if (existsSync(join(f.cwd, '.claude'))) expect(readdirSync(join(f.cwd, '.claude'))).toEqual(['.cc-writes']);
  });
  it('workspace writes reject guarded configuration and aliases while allowing instruction files', { timeout: 300_000 }, async () => {
    const f = scopedWorkspace(), config = join(f.cwd, '.mcp.json');
    writeFileSync(config, '{}'); mkdirSync(join(f.cwd, '.claude')); mkdirSync(join(f.cwd, '.codex'));
    writeFileSync(join(f.cwd, '.claude/settings.json'), '{}'); writeFileSync(join(f.cwd, '.codex/config.toml'), '# unchanged');
    symlinkSync(config, join(f.cwd, 'config-symlink')); linkSync(config, join(f.cwd, 'config-hardlink'));
    const thread = await start(f.cwd, 'write', false, f.readScope);
    const command = [
      'p=.mcp.json; printf hacked > "$p"; echo MCP:$?',
      'p=.mcp.json; ln "$p" bash-hardlink 2>&1; echo LINK:$?',
      'p=.claude; mv "$p" .claude-moved; echo MOVE:$?',
      "p=.codex; printf hacked > \"$p/config.toml\"; echo VARIABLE:$?",
      'p=.claude/skills/new; mkdir -p "$p"; echo SKILL:$?',
    ].join('; ');
    const bash = liveOutput(await run(thread, `Use Bash exactly once with the following boundary probes, even if commands fail. Do not retry:\n${command}`));
    for (const label of ['MCP', 'LINK', 'MOVE', 'VARIABLE', 'SKILL']) expect(bash).toMatch(new RegExp(`${label}:[1-9]`));
    expect(bash).toMatch(process.platform === 'darwin' ? /operation not permitted|EPERM/i : /cross-device|EXDEV/i);
    await run(thread, `Use Edit exactly once per file to replace {} with {"changed":true}: ${join(f.cwd, 'config-symlink')} and ${join(f.cwd, 'config-hardlink')}. Then use Write exactly once each for .claude/settings.local.json, .claude/commands/x.md, .claude/agents/x.md, .agents/skills/x/SKILL.md, each with changed. These are denial probes; do not retry or substitute tools.`);
    expect(readFileSync(config, 'utf8')).toBe('{}');
    expect(readFileSync(join(f.cwd, '.claude/settings.json'), 'utf8')).toBe('{}');
    expect(readFileSync(join(f.cwd, '.codex/config.toml'), 'utf8')).toBe('# unchanged');
    for (const file of ['bash-hardlink', '.claude-moved', '.claude/skills/new', '.claude/settings.local.json', '.claude/commands/x.md', '.claude/agents/x.md', '.agents/skills/x/SKILL.md']) expect(existsSync(join(f.cwd, file))).toBe(false);
    await run(thread, 'Use Write exactly once each to create CLAUDE.md and .claude/rules/r.md, each containing exactly allowed. Do not use other tools.');
    for (const file of ['CLAUDE.md', '.claude/rules/r.md']) expect(readFileSync(join(f.cwd, file), 'utf8').trim()).toBe('allowed');
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

// The same authenticated probes gate the native option set and exercise production wiring.
// Supply auth in the command environment; every SDK child gets a fresh HOME/config.
async function advanced(native: Record<string, unknown>, setup?: (dir: string, cwd: string, config: string) => Promise<void>, tools?: AgentTool[], resetFault?: 'failure' | 'timeout') {
  const { dir, cwd } = workspace(), config = join(dir, 'config');
  mkdirSync(config); mkdirSync(join(dir, 'home')); await setup?.(dir, cwd, config);
  const sdk = await loadBackendDep<ClaudeSdkFacade>('@anthropic-ai/claude-agent-sdk');
  const used: Array<{ name: string; input: Record<string, unknown> }> = [], resets: string[] = [], initTools: string[] = [];
  const facade: ClaudeSdkFacade = { ...sdk, query: params => {
    const q = sdk.query({ ...params, options: { ...params.options, persistSession: false, maxTurns: 16,
      env: { ...params.options?.env, HOME: join(dir, 'home'), CLAUDE_CONFIG_DIR: config },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Integration test in a temporary workspace. Call each requested tool once, continue after denials, never substitute tools, never read credentials.' } } });
    return new Proxy(q, { get(target, key) {
      if (key === 'setPermissionMode') return async (mode: Parameters<Query['setPermissionMode']>[0]) => { resets.push(mode); if (resetFault === 'failure') throw new Error('reset failed'); if (resetFault === 'timeout') return new Promise(() => {}); return target.setPermissionMode(mode); };
      if (key === Symbol.asyncIterator) return async function* () { for await (const msg of target) {
        if (msg.type === 'system' && msg.subtype === 'init') initTools.push(...msg.tools);
        if (msg.type === 'assistant') for (const block of msg.message.content) if (block.type === 'tool_use') used.push({ name: block.name, input: z.record(z.string(), z.unknown()).parse(block.input) });
        yield msg;
      } };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }) satisfies Query;
  } };
  const entries = tools ? createAgentEntries({ appId: 'fixture', isAdmin: () => true, isOwner: () => true, tools }) : undefined;
  const entry = entries?.issue({ kind: 'p2p' });
  const table = permissionTable('claude-agent'), effect = table.effect(table.parseCustom(native));
  const thread = await new ClaudeAgentBackend(async () => facade, () => undefined).startThread({ cwd, ...effect, native, model: process.env.ANTHROPIC_MODEL ?? 'haiku', entry });
  threads.push(thread); entry?.attach(thread);
  let seq = 0;
  return { dir, cwd, used, resets, initTools, thread, async turn(prompt: string, approve = false) {
    const active = entries?.openTurn(thread, { requesterKind: 'user', requesterOpenId: 'fixture', triggerMessageId: `m${++seq}`, retry: false, initiative: false, wake: false });
    const result = thread.runStreamed({ text: prompt }), events: AgentEvent[] = [];
    try { for await (const event of result.events) {
      events.push(event);
      if (approve && event.type === 'ask' && event.request.kind === 'confirmation')
        await result.respondToAsk?.(event.request.id, { kind: 'answered', answer: { kind: 'confirmation', decision: 'proceed' } });
    } } finally { active?.close(); }
    expect(events.some(e => e.type === 'error' && !e.willRetry)).toBe(false); expect(events.some(e => e.type === 'done')).toBe(true);
    return events;
  }, async close() { await thread.close(); entries?.closeAll('shutdown'); } };
}
const liveOutput = (events: AgentEvent[]) => events.flatMap(e => e.type === 'tool_result' ? [e.output ?? ''] : []).join('\n');
const curl = (host: string) => `curl -sS -m 10 -o /dev/null -w 'HTTP:%{http_code}' https://${host}`;
describe.runIf(LIVE)('advanced Claude permissions live', () => {
  it('A: strict domain sandbox admits one host and refuses the other', { timeout: 180_000 }, async () => {
    const t = await advanced({ permissionMode: 'acceptEdits', network: 'domains', domains: ['example.com'] });
    try { const events = await t.turn(`Use Bash separately and once for each command: ${curl('example.com')} ; ${curl('example.org')}. Do not retry.`);
      const output = liveOutput(events); expect(t.used.filter(x => x.name === 'Bash')).toHaveLength(2);
      expect(output).toContain('HTTP:200'); expect(output).toContain('HTTP:000'); expect(output).toMatch(/denied|allow list|只允许/);
    } finally { await t.close(); }
  });
  it('B: WebFetch domain rules and cross-host redirect boundary', { timeout: 300_000 }, async () => {
    const t = await advanced({ permissionMode: 'acceptEdits', network: 'domains', domains: ['example.com', '*.example.net'] }, async (_dir, cwd, config) => {
      const settings = JSON.stringify({ permissions: { allow: ['WebFetch'] } }); mkdirSync(join(cwd, '.claude'));
      writeFileSync(join(config, 'settings.json'), settings); writeFileSync(join(cwd, '.claude/settings.json'), settings);
    });
    try { const events = await t.turn('Use WebFetch once each: https://example.com ; https://example.org ; https://www.example.net . Ask for page title. Do not substitute.');
      expect(t.used.filter(x => x.name === 'WebFetch')).toHaveLength(3); expect(liveOutput(events)).toContain('只允许'); expect(liveOutput(events)).toContain('Example Domain');
    } finally { await t.close(); }
    // A local TLS service is needed because WebFetch upgrades loopback HTTP to HTTPS.
    const { dir } = workspace(), ca = join(dir, 'ca.pem'), key = join(dir, 'key.pem'), cfg = join(dir, 'cert.cnf');
    writeFileSync(cfg, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=probe\n[v3]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=IP:127.0.0.1,DNS:localhost.\n');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', ca, '-config', cfg], { stdio: 'ignore' });
    const hits: string[] = [], marker = randomBytes(12).toString('hex'); let port = 0;
    const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(ca) }, (req, res) => {
      const host = req.headers.host?.split(':')[0] ?? ''; hits.push(`${host}${req.url}`);
      if (req.url === '/redirect') { res.writeHead(302, { Location: `https://localhost.:${port}/target` }); res.end(); }
      else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<p>${marker}</p>`); }
    });
    await new Promise<void>(resolve => server.listen(0, '::', resolve)); port = (server.address() as AddressInfo).port;
    // This is the domain boundary itself, using the production options with only
    // the fixture's loopback names injected after schema validation (public UI excludes IPs).
    const sdk = await loadBackendDep<ClaudeSdkFacade>('@anthropic-ai/claude-agent-sdk');
    const runLocal = async (allowed: string[], urls: string[]) => {
      const queue = new LivePrompt(), calls: string[] = [];
      const access = claudeAccess('write', true, dir, dir, undefined, { permissionMode: 'acceptEdits', network: 'domains', domains: ['example.com'] });
      const options = permissionOptions({ ...access, native: { ...access.native!, domains: allowed } });
      const q = sdk.query({ prompt: queue, options: { ...options, cwd: dir, persistSession: false, maxTurns: 8, model: process.env.ANTHROPIC_MODEL ?? 'haiku',
        env: { ...process.env, NODE_EXTRA_CA_CERTS: ca, SSL_CERT_FILE: ca }, allowedTools: allowed.map(d => `WebFetch(domain:${d})`),
        canUseTool: async (tool, input) => { calls.push(String(input.url ?? input.host ?? tool)); const host = new URL(String(input.url)).hostname; return allowed.includes(host) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'host refused' }; } } });
      queue.push(`Use WebFetch exactly once for each URL, report exact returned content, do not follow redirects yourself: ${urls.join(' ; ')}. Do not use other tools.`);
      const results: unknown[] = [];
      try { for await (const msg of q) { results.push(msg); if (msg.type === 'result') { expect(msg.is_error).toBe(false); break; } } } finally { queue.end(); q.close(); }
      return { output: JSON.stringify(results), calls };
    };
    try {
      const preflight = await runLocal(['127.0.0.1', 'localhost.'], [`https://127.0.0.1:${port}/source`, `https://localhost.:${port}/target`]);
      expect(preflight.output).toContain(marker); expect(hits).toContain('127.0.0.1/source'); expect(hits).toContain('localhost./target'); hits.length = 0;
      const redirect = await runLocal(['127.0.0.1'], [`https://127.0.0.1:${port}/redirect`]);
      expect(hits).toContain('127.0.0.1/redirect'); expect(hits).not.toContain('localhost./target'); expect(redirect.output).not.toContain(marker); expect(redirect.output).toContain('REDIRECT DETECTED');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('C: every native plan turn confirms before writing', { timeout: 300_000 }, async () => {
    const t = await advanced({ permissionMode: 'plan' });
    try { for (const name of ['a.txt', 'b.txt']) {
      const before = t.used.length, events = await t.turn(`Create ${name} with hi. First write a brief plan and call ExitPlanMode, then use Write after confirmation. Do not use Bash.`, true);
      expect(events.some(e => e.type === 'ask' && e.request.kind === 'confirmation')).toBe(true); expect(existsSync(join(t.cwd, name))).toBe(true);
      const planWrites = t.used.slice(before).filter(call => call.name === 'Write' && String(call.input.file_path).includes('/plans/') && existsSync(resolve(t.cwd, String(call.input.file_path))));
      expect(planWrites.length).toBeGreaterThan(0); for (const call of planWrites) expect(realpathSync(resolve(t.cwd, String(call.input.file_path))).startsWith(realpathSync(t.cwd) + '/.claude/plans/')).toBe(true);
      const tools = t.used.slice(before).map(x => x.name); expect(tools.indexOf('ExitPlanMode')).toBeLessThan(tools.lastIndexOf('Write'));
    } expect(t.resets).toEqual(['plan', 'acceptEdits', 'plan', 'acceptEdits']); } finally { await t.close(); }
  });
  it('C negative: direct workspace Write before a plan is denied', { timeout: 180_000 }, async () => {
    const t = await advanced({ permissionMode: 'plan' });
    try { const events = await t.turn('Boundary test: call Write exactly once now to create unapproved.txt with hi, before any plan or approval. The permission layer should reject it. Do not call ExitPlanMode, do not write a plan, do not retry or substitute tools.');
      expect(t.used.some(call => call.name === 'Write' && String(call.input.file_path).endsWith('/unapproved.txt'))).toBe(true);
      expect(existsSync(join(t.cwd, 'unapproved.txt'))).toBe(false); expect(liveOutput(events)).toContain('方案确认前不能');
    } finally { await t.close(); }
  });
  it.each(['stream', 'goal'].flatMap(kind => ['failure', 'timeout'].map(fault => ({ kind, fault }))))('C reset $kind $fault closes the real query without submitting a prompt', { timeout: 30_000 }, async ({ kind, fault }) => {
    const t = await advanced({ permissionMode: 'plan' }, undefined, undefined, fault as 'failure' | 'timeout');
    try { const events: AgentEvent[] = []; for await (const event of (kind === 'goal' ? t.thread.runGoal('Create unapproved.txt now.') : t.thread.runStreamed({ text: 'Create unapproved.txt now.' })).events) events.push(event);
      expect(events.some(event => event.type === 'error' && event.message.includes('这一轮没能回到先出方案的状态'))).toBe(true);
      expect(t.used).toHaveLength(0); expect(t.thread.isAlive()).toBe(false); expect(existsSync(join(t.cwd, 'unapproved.txt'))).toBe(false);
    } finally { await t.close(); }
  });
  it.each(['default', 'acceptEdits'] as const)('D: %s sandbox-off Bash hook beats both allow settings and disabled hooks', { timeout: 300_000 }, async mode => {
    for (const disableAllHooks of [false, true]) {
      const marker = randomBytes(12).toString('hex');
      const t = await advanced({ permissionMode: mode, sandbox: false }, async (dir, cwd, config) => {
        writeFileSync(join(dir, 'outside'), marker); mkdirSync(join(cwd, '.claude'));
        const permissions = { allow: ['Bash(ls:*)', 'Bash(cat:*)'] };
        writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions })); writeFileSync(join(cwd, '.claude/settings.json'), JSON.stringify({ permissions, disableAllHooks }));
      });
      try { const events = await t.turn(`Use Bash once each and separately, even after denials: ls ; cat ${join(t.dir, 'outside')} ; echo x > out.txt . Do not substitute.`);
        expect(t.used.filter(x => x.name === 'Bash')).toHaveLength(3); expect(existsSync(join(t.cwd, 'out.txt'))).toBe(false); expect(liveOutput(events)).not.toContain(marker); expect(liveOutput(events).match(/关了命令沙箱/g)?.length).toBe(3);
      } finally { await t.close(); }
    }
  });
  it('E: auto keeps workspace and offline boundaries', { timeout: 180_000 }, async () => {
    const t = await advanced({ permissionMode: 'auto', network: 'off' });
    try { const events = await t.turn(`Use Bash: touch x ; then Write ${join(t.dir, 'outside')} with hi ; then Bash: ${curl('example.com')}. Use each tool once, do not combine or retry.`);
      expect(t.used.map(x => x.name)).toEqual(['Bash', 'Write', 'Bash']); expect(existsSync(join(t.cwd, 'x'))).toBe(true); expect(existsSync(join(t.dir, 'outside'))).toBe(false); expect(liveOutput(events)).not.toContain('HTTP:200');
    } finally { await t.close(); }
  });
  it('D command tools: sandbox-off excludes Monitor and PowerShell in the real SDK', { timeout: 180_000 }, async () => {
    const t = await advanced({ permissionMode: 'acceptEdits', sandbox: false });
    try { await t.turn('Try Monitor with command touch monitor.txt and PowerShell with command New-Item powershell.txt. If a tool is absent, report that; never use alternatives.');
      expect(t.initTools).toContain('Bash'); expect(t.initTools).not.toContain('Monitor'); expect(t.initTools).not.toContain('PowerShell');
      expect(t.used.some(call => ['Monitor', 'PowerShell'].includes(call.name))).toBe(false);
      expect(existsSync(join(t.cwd, 'monitor.txt')) || existsSync(join(t.cwd, 'powershell.txt'))).toBe(false);
    } finally { await t.close(); }
  });
  it('F: bypass with sandbox confines Bash but permits native Write and network', { timeout: 180_000 }, async () => {
    const t = await advanced({ permissionMode: 'bypassPermissions', sandbox: true });
    try { const events = await t.turn(`Use Bash once: touch ${join(t.dir, 'x')} ; Write once: ${join(t.dir, 'y')} with hi ; Bash once: ${curl('example.com')}. Do not retry or combine.`);
      expect(t.used.map(x => x.name)).toEqual(['Bash', 'Write', 'Bash']); expect(existsSync(join(t.dir, 'x'))).toBe(false); expect(existsSync(join(t.dir, 'y'))).toBe(true); expect(liveOutput(events)).toContain('HTTP:200');
    } finally { await t.close(); }
  });
  it.each(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const)('G: own MCP works in every %s combination, before a plan', { timeout: 600_000 }, async permissionMode => {
    for (const sandbox of [true, false]) for (const network of permissionMode === 'bypassPermissions' ? ['all'] : ['off', 'domains']) {
      let called = 0, marker = '';
      const tool: AgentTool = { name: 'probe_note', class: 'settings', description: 'Write the probe note before planning.', input: z.object({}), async run() { called++; writeFileSync(marker, 'called'); return { proof: 'PROBE_NOTE_OK' }; } };
      const t = await advanced({ permissionMode, sandbox, network, ...(network === 'domains' ? { domains: ['example.com'] } : {}) }, undefined, [tool]); marker = join(t.dir, 'probe-note');
      try { await t.turn('First call mcp__vonvon_bot__probe_note. Only after its response, write a two-line plan and call ExitPlanMode. Do not implement anything or call other tools.', true);
        expect(called).toBeGreaterThan(0); expect(existsSync(marker)).toBe(true);
        if (permissionMode === 'plan') expect(t.used.findIndex(x => x.name === 'mcp__vonvon_bot__probe_note')).toBeLessThan(t.used.findIndex(x => x.name === 'ExitPlanMode'));
      } finally { await t.close(); }
    }
  });
});
class LivePrompt implements AsyncIterable<SDKUserMessage> {
  private value?: SDKUserMessage; private waiter?: (result: IteratorResult<SDKUserMessage>) => void; private done = false;
  push(content: string) { this.value = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }; this.waiter?.({ value: this.value, done: false }); if (this.waiter) this.value = undefined; this.waiter = undefined; }
  end() { this.done = true; this.waiter?.({ value: undefined, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> { return { next: () => { if (this.value) { const value = this.value; this.value = undefined; return Promise.resolve({ value, done: false }); } if (this.done) return Promise.resolve({ value: undefined, done: true }); return new Promise(resolve => { this.waiter = resolve; }); } }; }
}
