import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { ClaudeAgentBackend } from '../src/agent/claude-agent/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import type { AgentBackend, AgentThread } from '../src/agent/types';

// Keep HOME/VONVON_HOME isolated. Point CODEX_HOME/CLAUDE_CONFIG_DIR at the
// existing login in the command environment; never copy credentials into a fixture.
const live = process.env.SESSION_PROFILE_LIVE === '1';
async function fingerprint(file: string): Promise<string> {
  try { return createHash('sha256').update(await readFile(file)).digest('hex'); }
  catch (err) { if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return 'absent'; throw err; }
}
async function memoryMetadata(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const result: string[] = [];
    for (const entry of entries) {
      const file = join(root, entry.name);
      const info = await stat(file);
      result.push(`${entry.name}:${info.size}:${info.mtimeMs}`);
      if (entry.isDirectory()) result.push(...(await memoryMetadata(file)).map(item => `${entry.name}/${item}`));
    }
    return result.sort();
  } catch (err) { if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return []; throw err; }
}
async function turn(thread: AgentThread, text: string, expected: string): Promise<void> {
  const types: string[] = [];
  let reply = '';
  for await (const event of thread.runStreamed({ text }).events) {
    types.push(event.type);
    if (event.type === 'text_delta') reply += event.delta;
  }
  expect(types).toContain('done');
  expect(types).not.toContain('error');
  expect(reply).toContain(expected);
}

describe.runIf(live)('s37 authenticated provider profile integration', () => {
  for (const kind of ['codex', 'claude'] as const) {
    it(`${kind}: start, release, resume with native memory disabled`, { timeout: 180_000 }, async () => {
      const root = process.env.SESSION_PROFILE_LIVE_ROOT;
      if (!root || !(await realpath(root)).startsWith(`${await realpath(tmpdir())}/`)
        || process.env.HOME !== join(root, 'home') || process.env.VONVON_HOME !== join(root, 'vh')
        || await realpath(process.env.HOME) !== join(await realpath(root), 'home')
        || await realpath(process.env.VONVON_HOME) !== join(await realpath(root), 'vh')) {
        throw new Error('Create a fresh temporary root with isolated home/vh before enabling live checks');
      }
      const nativeHome = kind === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;
      if (!nativeHome) throw new Error('Explicit native login directory required');
      const config = join(nativeHome, kind === 'codex' ? 'config.toml' : 'settings.json');
      const cwd = await mkdtemp(join(tmpdir(), 'vonvon-s37-live-'));
      const memory = kind === 'codex' ? join(nativeHome, 'memories')
        : join(nativeHome, 'projects', (await realpath(cwd)).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
      const configBefore = await fingerprint(config);
      // Inspect only metadata. Claude's own test-project memory excludes its
      // expected transcript writes and other sessions' private files.
      const memoryBefore = await memoryMetadata(memory);
      const backend: AgentBackend = kind === 'codex' ? new CodexAppServerBackend() : new ClaudeAgentBackend();
      const options = { cwd, mode: 'full' as const,
        model: kind === 'codex' ? 'gpt-6-luna' : 'haiku',
        profile: { instructions: 'Reply briefly without tools.', env: { S37_PROFILE_LIVE: '1' },
          nativeSettings: { automaticMemory: false as const }, additionalRoots: [], capabilityPackages: [], mcpServers: [] } };
      let thread: AgentThread | undefined;
      try {
        thread = await backend.startThread(options);
        await turn(thread, 'Reply exactly S37_START_OK. Do not call tools or save memories.', 'S37_START_OK');
        const sessionId = thread.sessionId;
        await thread.close();
        thread = undefined;
        thread = await backend.resumeThread({ ...options, sessionId });
        await turn(thread, 'Reply exactly S37_RESUME_OK. Do not call tools or save memories.', 'S37_RESUME_OK');
      } finally {
        const cleanup = await Promise.allSettled([
          thread?.close(),
          ...(kind === 'codex' ? [shutdownResidentClients()] : []),
        ]);
        expect(await fingerprint(config)).toBe(configBefore);
        expect(JSON.stringify(await memoryMetadata(memory)) === JSON.stringify(memoryBefore)).toBe(true);
        for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
      }
    });
  }
});
