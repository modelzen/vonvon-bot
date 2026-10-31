import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { loadBackendDep } from '../src/agent/backend-loader';
import { ensureBuiltinPackage } from '../src/agent/builtin-skills/package';
import { builtinSkillsOfSet } from '../src/agent/builtin-skills/registry';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';

// T4b self-test step 5 (product.md 9.22) on the real CLI, without a model turn: the session's command list says
// whether the builtin plugin loaded. Not run in CI. Run with a fresh temporary HOME and VONVON_HOME, e.g.
//   T=$(mktemp -d); HOME=$T/home VONVON_HOME=$T/vh BUILTIN_SKILL_LIVE=1 npx vitest run test/builtin-skill.live.test.ts
// adding CLAUDE_CONFIG_DIR=<the logged-in config dir> if the CLI will not initialize without a login. "flag" is vonvon's
// own `enabledPlugins` in the flag settings; the last case shows a workspace turns the plugin off without it (SDK 0.3.296,
// CLI 2.1.296), which is why the flag stays. The second case shows the plugin loads without the flag when nothing turns it off.
const live = process.env.BUILTIN_SKILL_LIVE === '1';
describe.runIf(live)('the builtin package on the real Claude CLI', () => {
  it.each([
    ['no workspace setting, flag', false, true, true],
    ['no workspace setting, no flag', false, false, true],
    ['workspace off, flag', true, true, true],
    ['workspace off, no flag', true, false, false],
  ] as const)('%s', { timeout: 120_000 }, async (name, workspaceOff, flag, expected) => {
    if (![process.env.HOME, process.env.VONVON_HOME].every(dir => dir?.startsWith(tmpdir()))) throw new Error('Run with a temporary HOME and VONVON_HOME');
    const cwd = await mkdtemp(join(tmpdir(), 't4b-live-'));
    if (workspaceOff) {
      await mkdir(join(cwd, '.claude'));
      await writeFile(join(cwd, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'vonvon@inline': false } }));
    }
    const { path } = await ensureBuiltinPackage('live', 'group', builtinSkillsOfSet('group'));
    const sdk = await loadBackendDep<typeof import('@anthropic-ai/claude-agent-sdk')>('@anthropic-ai/claude-agent-sdk');
    let query: Query | undefined;
    const facade: ClaudeSdkFacade = { ...sdk, query: params => {
      const settings = { ...params.options?.settings as Record<string, unknown> };
      if (!flag) delete settings.enabledPlugins;
      return (query = sdk.query({ ...params, options: { ...params.options, settings } }));
    } };
    const thread = await new ClaudeAgentBackend(async () => facade).startThread({ cwd, mode: 'full', profile: { instructions: '', env: {},
      nativeSettings: { automaticMemory: false }, additionalRoots: [], capabilityPackages: [{ path, kind: 'builtin' }], mcpServers: [], tools: { schedule: true } } });
    try {
      const names = (await query!.supportedCommands()).map(command => command.name);
      console.log(`[t4b-live] ${name}: vonvon:scheduled-tasks ${names.includes('vonvon:scheduled-tasks') ? 'listed' : 'missing'}`);
      expect(names.includes('vonvon:scheduled-tasks')).toBe(expected);
    } finally {
      await thread.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
