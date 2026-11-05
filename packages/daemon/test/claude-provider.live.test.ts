import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { discoverProviderModels } from '../src/admin/model-catalog';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { loadBackendDep } from '../src/agent/backend-loader';
import { resetClaudeLoginCache } from '../src/agent/claude-agent/login';

// Linux file-credential fixture, explicitly opted in: metadata only, no inference.
// Other platforms may store OAuth in the real login keychain rather than this copy.
const live = process.env.CLAUDE_PROVIDER_LIVE === '1' && process.platform === 'linux';
const sourceHome = homedir();
const sourceConfig = process.env.CLAUDE_CONFIG_DIR || join(sourceHome, '.claude');
const directories: string[] = [];
const exits: Promise<void>[] = [];
afterEach(async () => {
  // Query.close() returns before the CLI finishes its shutdown writes.
  await Promise.all(exits.splice(0));
  resetClaudeLoginCache();
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function realBackend() {
  const sdk = await loadBackendDep<ClaudeSdkFacade>('@anthropic-ai/claude-agent-sdk');
  return new ClaudeAgentBackend(async () => ({ ...sdk, query: params => sdk.query({ ...params, options: {
    ...params.options,
    spawnClaudeCodeProcess: ({ command, args, signal: _signal, ...options }) => {
      const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      exits.push(new Promise(resolve => child.once('close', () => resolve())));
      child.stderr.resume();
      return child;
    },
  } }) }));
}

function isolatedHome() {
  const root = mkdtempSync(join(tmpdir(), 'claude-provider-live-'));
  directories.push(root);
  mkdirSync(join(root, '.claude'), { mode: 0o700 });
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN']) vi.stubEnv(name, undefined);
  return root;
}

it.runIf(live)('retains the real SDK account catalog across repeated initialization and refresh', { timeout: 90_000 }, async () => {
  const root = isolatedHome();
  const globalConfig = process.env.CLAUDE_PROVIDER_CONFIG || join(sourceHome, '.claude.json');
  copyFileSync(globalConfig, join(root, '.claude.json'));
  copyFileSync(join(sourceConfig, '.credentials.json'), join(root, '.claude', '.credentials.json'));
  writeFileSync(join(root, '.claude', 'settings.json'), '{}');
  const backend = await realBackend();
  expect(await backend.loginStatus({ refresh: true })).toMatchObject({ state: 'signedIn' });
  const first = await discoverProviderModels('claude-agent', () => backend, true);
  expect(first.message).toBeUndefined();
  expect(first.models.length).toBeGreaterThan(0);
  const file = join(root, '.claude.json');
  const state = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(file, 'utf8')));
  // Simulate another CLI updating its counters after the successful query.
  writeFileSync(file, JSON.stringify({ ...state, numStartups: 999 }));
  expect(backend.peekModels()?.map(model => model.id)).toEqual(first.models.map(model => model.id));
  const refreshed = await discoverProviderModels('claude-agent', () => backend, true);
  expect(refreshed.message).toBeUndefined();
  expect(refreshed.models.length).toBeGreaterThan(0);
});

it.runIf(live).each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const)('reads custom API settings using %s with the real SDK', { timeout: 60_000 }, async credential => {
  const root = isolatedHome();
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ env: {
    [credential]: 'fixture-key-no-inference', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_MODEL: 'fixture/custom-model',
  } }));
  const backend = await realBackend();
  expect(await backend.loginStatus({ refresh: true })).toMatchObject({ state: 'signedIn', account: { kind: 'api' } });
  const result = await discoverProviderModels('claude-agent', () => backend, true);
  expect(result.message).toBeUndefined();
  expect(result.models).toContainEqual(expect.objectContaining({ id: 'fixture/custom-model', isDefault: true }));
  expect(JSON.stringify(result)).not.toContain('fixture-key-no-inference');
  expect(existsSync(join(root, '.claude', '.credentials.json'))).toBe(false);
});
