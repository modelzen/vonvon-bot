/**
 * s1b (owner 2026-11-02): does a group session open vonvon's two builtin skills when it should, and leave them shut
 * when it should not? Each message gets a short session of its own, started the way a group's session starts
 * (Claude: the Agent SDK with the builtin plugin; Codex: app-server with `selectedCapabilityRoots`), read-only tier, the
 * group's tool list with every call refused (nothing runs), the backend's default model. "Opened" is Claude's `Skill`
 * call (or a Read of the SKILL.md); for Codex it is a `skills.read` of the package (often inside a code-mode `exec`,
 * which the run's events do not show) or a command that reads the SKILL.md, both found in the thread's rollout under
 * `~/.codex/sessions` after the turn. A Claude session stops at the first skill it opens; either stops at its turn's
 * end, after a few tool calls or after 4 minutes. Not a vitest file, not run in CI.
 *
 * The logged-in Claude Code and Codex accounts are read from the real HOME, so HOME stays as it is; only the data root
 * is a temporary one, given in front of the one command:
 *
 *   T=$(mktemp -d); mkdir -p node_modules/.cache; B=$(mktemp -d -p node_modules/.cache)
 *   npx esbuild test/manual/skill-trigger-eval.ts --bundle --platform=node --format=esm --packages=external --outfile="$B/eval.mjs"
 *   VONVON_HOME="$T/vh" node "$B/eval.mjs" --out "$T/round-1.json" [--providers claude,codex] [--only s1,f2]
 *   rm -rf -- "${B:?}" "${T:?}"
 *
 * Sends nothing to Feishu and connects to no daemon. Each case is one provider call (one or two model turns).
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { loadBackendDep } from '../../src/agent/backend-loader';
import { ensureBuiltinPackage } from '../../src/agent/builtin-skills/package';
import { builtinSkillsOfSet } from '../../src/agent/builtin-skills/registry';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../../src/agent/claude-agent/backend';
import { CodexAppServerBackend } from '../../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../../src/agent/codex-appserver/client-pool';
import { createCommandTools } from '../../src/agent/entry/command-tools';
import type { SessionProfile } from '../../src/agent/session-profile';
import type { AgentBackend, AgentEntry, AgentThread } from '../../src/agent/types';

type Skill = 'vonvon-schedule' | 'vonvon-feishu-message';
interface Case { id: string; text: string; want: Skill | null }

/** The messages: 9 for each skill, 5 that open neither (two of them near a skill's words). */
const CASES: Case[] = [
  { id: 's1', want: 'vonvon-schedule', text: '每天早上 9 点在群里发一下昨天的进度' },
  { id: 's2', want: 'vonvon-schedule', text: '20 分钟后再看看构建结果' },
  { id: 's3', want: 'vonvon-schedule', text: '本群有哪些定时任务' },
  { id: 's4', want: 'vonvon-schedule', text: '把下周一的提醒停掉' },
  { id: 's5', want: 'vonvon-schedule', text: '每个工作日下午 6 点提醒大家填日报' },
  { id: 's6', want: 'vonvon-schedule', text: '明天上午十点提醒我跟进一下合同' },
  { id: 's7', want: 'vonvon-schedule', text: '每隔两小时检查一下线上告警，有问题就在群里说' },
  { id: 's8', want: 'vonvon-schedule', text: '把周报那个任务改成每周五下午 4 点' },
  { id: 's9', want: 'vonvon-schedule', text: '部署完了，你过半小时回来看看日志有没有报错' },
  { id: 'f1', want: 'vonvon-feishu-message', text: '用卡片总结一下这次改动：登录页改版、修了导出的乱码、接口超时从 10 秒改成 30 秒' },
  { id: 'f2', want: 'vonvon-feishu-message', text: '把报告文件发给我' },
  { id: 'f3', want: 'vonvon-feishu-message', text: '截个图放上来' },
  { id: 'f4', want: 'vonvon-feishu-message', text: '把 Redis、Memcached、本地缓存三个方案的优缺点做成表格发群里' },
  { id: 'f5', want: 'vonvon-feishu-message', text: '做一张本周的 changelog 卡片' },
  { id: 'f6', want: 'vonvon-feishu-message', text: '把刚才生成的 CSV 导出给我下载' },
  { id: 'f7', want: 'vonvon-feishu-message', text: '回复里把关键风险用红色标出来：数据库迁移没有回滚脚本、证书下周过期' },
  { id: 'f8', want: 'vonvon-feishu-message', text: '画个部署架构图放到回复里' },
  { id: 'f9', want: 'vonvon-feishu-message', text: '帮我把这周的进展整理成周报，用标题和分隔线排好版：完成支付对账、上线灰度、修复 3 个线上问题' },
  { id: 'n1', want: null, text: '解释一下这段代码：`const total = items.reduce((sum, item) => sum + item.price, 0)`' },
  { id: 'n2', want: null, text: '帮我看下这个 bug：登录成功后跳到了 404 页面，可能是什么原因' },
  { id: 'n3', want: null, text: '今天天气怎么样' },
  { id: 'n4', want: null, text: 'TypeScript 里 interface 和 type 有什么区别？' },
  { id: 'n5', want: null, text: 'JS 的 setInterval 和 setTimeout 有什么区别？' },
];

const APP_ID = 'cli_eval';
const SKILLS: Skill[] = ['vonvon-schedule', 'vonvon-feishu-message'];
/** A group turn as vonvon hands it over (bot/context-weave.ts): the record block, then the message. */
const turnText = (text: string) => `[飞书 · 群「研发群」· 主区 · 你是「小码」]\n09:58 李四：下午三点发版\n[/飞书]\n${text}`;

interface Outcome { id: string; provider: 'claude' | 'codex'; want: Skill | null; opened: Skill[]; tools: string[]; ended: string; ms: number; hit: boolean }

/** The tools a group's session lists (registry `places`), each call refused: nothing runs. */
function fakeEntry(calls: string[]): AgentEntry {
  const tools = createCommandTools({
    appId: APP_ID,
    settings: {} as never,
    projects: async () => [],
    groups: async () => ({ groups: [] }) as never,
    members: async () => ({ members: [] }) as never,
    memory: {} as never,
    schedule: { execute: async () => { throw new Error('not in the eval'); } } as never,
  }).filter(tool => !tool.places || tool.places.includes('group'));
  return {
    sessionId: `ses_${randomBytes(8).toString('hex')}`,
    tools: () => tools.map(({ name, description, input }) => ({ name, description, input })),
    call: async name => { calls.push(name); return { ok: false, code: 'refused', message: '这是一次测试，工具没有执行。直接告诉用户你本来会怎么做。' }; },
    noteToolUse: () => {},
    attach: () => {},
    revoke: () => {},
  };
}

/**
 * Codex: what the thread's rollout says it called. The skill's body comes through `skills.read` with
 * `{package: "e0/skills/<dir>"}`, as a namespaced function call or from a code-mode `exec` script.
 */
async function codexCalls(threadId: string): Promise<{ opened: Skill[]; tools: string[] }> {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  const newest = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort().reverse();
  let file: string | undefined;
  search: for (const year of await newest(root)) for (const month of await newest(join(root, year))) for (const day of await newest(join(root, year, month))) {
    const found = (await newest(join(root, year, month, day))).find(name => name.includes(threadId) && name.endsWith('.jsonl'));
    if (found) { file = join(root, year, month, day, found); break search; }
  }
  if (!file) return { opened: [], tools: ['(no rollout)'] };
  const opened = new Set<Skill>();
  const tools: string[] = [];
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const payload = (JSON.parse(line) as { payload?: Record<string, unknown> }).payload;
    if (!payload || !['function_call', 'custom_tool_call', 'local_shell_call'].includes(String(payload.type))) continue;
    const text = JSON.stringify(payload);
    const name = `${payload.namespace ? `${String(payload.namespace)}.` : ''}${String(payload.name ?? payload.type)}`;
    tools.push(payload.type === 'custom_tool_call' ? `${name}: ${String(payload.input ?? '').replace(/\s+/g, ' ').slice(0, 160)}` : name);
    if (!/skills__read|"namespace":"skills"|SKILL\.md/.test(text)) continue;
    for (const skill of SKILLS) if (text.includes(`skills/${skill}`) || text.includes(`${skill}/SKILL.md`)) opened.add(skill);
  }
  return { opened: [...opened], tools };
}

const skillIn = (text: string): Skill | undefined => SKILLS.find(skill => text.includes(`${skill}/SKILL.md`) || text.includes(`vonvon:${skill}`) || text === skill);

/** Claude: the SDK's own messages, for the Skill call's input the run's events do not carry. */
function watchingFacade(sdk: ClaudeSdkFacade, seen: (message: SDKMessage) => void): ClaudeSdkFacade {
  return { ...sdk, query: params => {
    const query: Query = sdk.query({ ...params, options: { ...params.options, maxTurns: 4 } });
    // The thread reads it with for-await, whose iterator need not be the query's own next.
    const iterate = query[Symbol.asyncIterator].bind(query);
    query[Symbol.asyncIterator] = () => {
      const inner = iterate();
      const outer: AsyncGenerator<SDKMessage, void> = {
        next: async (...args) => {
          const result = await inner.next(...args);
          if (!result.done) seen(result.value);
          return result;
        },
        return: value => inner.return(value),
        throw: error => inner.throw(error),
        [Symbol.asyncIterator]: () => outer,
        [Symbol.asyncDispose]: async () => { await inner.return(undefined); },
      };
      return outer;
    };
    return query;
  } };
}

async function runCase(provider: 'claude' | 'codex', backend: AgentBackend, profile: SessionProfile, item: Case, seen: { messages?: (handler: (message: SDKMessage) => void) => void }): Promise<Outcome> {
  const cwd = await mkdtemp(join(tmpdir(), 'skill-eval-'));
  const calls: string[] = [];
  const opened = new Set<Skill>();
  const tools: string[] = [];
  let codexTools = 0;
  const started = Date.now();
  let ended = 'done';
  let thread: AgentThread | undefined;
  let threadId: string | undefined;
  try {
    seen.messages?.(message => {
      if (message.type !== 'assistant') return;
      for (const block of message.message.content as Array<{ type: string; name?: string; input?: Record<string, unknown> }>) {
        if (block.type !== 'tool_use') continue;
        const input = JSON.stringify(block.input ?? {});
        tools.push(`${block.name}${block.name === 'Skill' || block.name === 'Read' ? ` ${input}` : ''}`);
        const skill = block.name === 'Skill' ? SKILLS.find(name => input.includes(name)) : block.name === 'Read' ? skillIn(input) : undefined;
        if (skill) opened.add(skill);
      }
    });
    thread = await backend.startThread({ cwd, mode: 'qa', profile, entry: fakeEntry(calls) });
    threadId = thread.sessionId;
    const run = thread.runStreamed({ text: turnText(item.text) });
    const stop = async () => { const turnId = run.turnId(); if (turnId) await thread?.abort(turnId).catch(() => undefined); };
    const timer = setTimeout(() => { ended = 'timeout'; void stop(); }, 240_000);
    try {
      for await (const event of run.events) {
        if (event.type === 'error' && !event.willRetry) { ended = `error: ${event.message.slice(0, 120)}`; break; }
        if (event.type === 'done') break;
        // Claude: a skill opened, or enough tools seen, and the answer is in. Codex's calls are read from its rollout.
        if (provider === 'codex' && event.type === 'tool_use' && ++codexTools >= 6) { ended = 'stopped-after-tools'; await stop(); break; }
        if (opened.size || tools.length >= 6) { ended = opened.size ? 'stopped-after-skill' : 'stopped-after-tools'; await stop(); break; }
      }
    } finally { clearTimeout(timer); }
  } catch (error) {
    ended = `failed: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`;
  } finally {
    await thread?.close().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
  if (provider === 'codex' && threadId) {
    const read = await codexCalls(threadId).catch((error: unknown) => ({ opened: [] as Skill[], tools: [`(rollout unreadable: ${String(error).slice(0, 80)})`] }));
    for (const skill of read.opened) opened.add(skill);
    tools.push(...read.tools);
  }
  const list = [...opened];
  const hit = item.want ? list.includes(item.want) : list.length === 0;
  return { id: item.id, provider, want: item.want, opened: list, tools: [...tools, ...calls.map(name => `called ${name}`)], ended, ms: Date.now() - started, hit };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const out = flag('--out');
  if (!out) throw new Error('give --out <file>');
  if (!process.env.VONVON_HOME?.startsWith(tmpdir())) throw new Error('Run with a temporary VONVON_HOME in front of the command');
  const providers = (flag('--providers') ?? 'claude,codex').split(',') as Array<'claude' | 'codex'>;
  const only = flag('--only')?.split(',');
  const cases = CASES.filter(item => !only || only.includes(item.id));

  const { path } = await ensureBuiltinPackage(APP_ID, 'group', builtinSkillsOfSet('group'));
  const profile: SessionProfile = { instructions: '', env: {}, nativeSettings: { automaticMemory: false }, additionalRoots: [],
    capabilityPackages: [{ path, kind: 'builtin' }], mcpServers: [], tools: { schedule: true } };
  const results: Outcome[] = [];
  for (const provider of providers) {
    let handler: ((message: SDKMessage) => void) | undefined;
    const backend: AgentBackend = provider === 'claude'
      ? new ClaudeAgentBackend(async () => watchingFacade(await loadBackendDep<ClaudeSdkFacade>('@anthropic-ai/claude-agent-sdk'), message => handler?.(message)))
      : new CodexAppServerBackend();
    for (const item of cases) {
      const result = await runCase(provider, backend, profile, item, provider === 'claude' ? { messages: next => { handler = next; } } : {});
      handler = undefined;
      results.push(result);
      process.stdout.write(`${provider}\t${item.id}\twant=${item.want ?? '-'}\topened=${result.opened.join('+') || '-'}\t${result.hit ? 'OK' : 'MISS'}\t${result.ended}\t${result.ms}ms\t${result.tools.join(' | ').slice(0, 300)}\n`);
      await writeFile(out, JSON.stringify(results, null, 2));
    }
  }
  await shutdownResidentClients().catch(() => undefined);
  const misses = results.filter(result => !result.hit);
  process.stdout.write(`${results.length} calls, ${misses.length} misses: ${misses.map(miss => `${miss.provider}/${miss.id}`).join(' ') || 'none'}\n`);
  return 0;
}

main().then(code => process.exit(code), (error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1); });
