import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { adminReplySchema } from '@vonvon/protocol';
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'admin-judge-usage-'));
  const botDir = (id: string) => join(appDir, 'bots', id);
  return { botDir, botPaths: (id: string) => ({ judgeUsageFile: join(botDir(id), 'judge-usage.json') }), paths: { appDir, botsFile: join(appDir, 'bots.json') } };
});
import { paths, botPaths } from '../src/config/paths';
import { judgeUsageView } from '../src/admin/judge-usage';
import { log } from '../src/core/logger';
import { adminRpc } from '../src/server/rpc/admin';
import type { AdminService } from '../src/admin/service';
const now = new Date(2026, 9, 19, 12).getTime();
beforeEach(async () => {
  vi.spyOn(log, 'warn').mockImplementation(() => {});
  await mkdir(paths.appDir, { recursive: true });
  await writeFile(paths.botsFile, JSON.stringify({ version: 1, bots: [{ appId: 'cli_fixture_a', name: 'a', botName: 'Bot A' }, { appId: 'cli_fixture_b', name: 'Bot B' }] }));
  for (const id of ['cli_fixture_a', 'cli_fixture_b']) await mkdir(join(paths.appDir, 'bots', id), { recursive: true });
  await writeFile(botPaths('cli_fixture_a').judgeUsageFile, JSON.stringify({ version: 1, days: { '2026-10-19': { 'llm:codex-appserver': 3, 'decision:typesafe': 2 } } }));
  await writeFile(botPaths('cli_fixture_b').judgeUsageFile, JSON.stringify({ version: 1, days: { '2026-10-18': { 'llm:claude-agent': 1 } } }));
});
afterEach(async () => { vi.restoreAllMocks(); await rm(paths.appDir, { force: true, recursive: true }); });
it('aggregates fourteen local days with backend and bot names', async () => {
  const view = await judgeUsageView({ now });
  expect(view.days).toHaveLength(14);
  expect(view.days[0]).toEqual({ date: '2026-10-19', total: 5, sources: [{ kind: 'llm', id: 'codex-appserver', label: 'Codex', count: 3 }, { kind: 'decision', id: 'typesafe', label: 'TypeSafe', count: 2 }], bots: [{ agentId: 'cli_fixture_a', agentName: 'Bot A', count: 5 }] });
  expect(view.days[1]).toMatchObject({ total: 1, sources: [{ label: 'Claude' }] });
  expect(view.days[13]).toEqual({ date: '2026-10-06', total: 0, sources: [], bots: [] });
});
it.each(['not json', JSON.stringify({ version: 2, days: {} })])('skips unreadable bot files: %s', async text => {
  await writeFile(botPaths('cli_fixture_b').judgeUsageFile, text);
  const view = await judgeUsageView({ now }); expect(view.unreadBots).toBe(1); expect(view.days[0]?.total).toBe(5);
  expect(log.warn).toHaveBeenCalledWith('judge', 'usage-unreadable', expect.objectContaining({ agentId: 'cli_fixture_b', ...(text.startsWith('{') ? { newer: true } : {}) }));
});
it('reports a broken bot registry with empty days', async () => {
  await writeFile(paths.botsFile, 'not json'); const view = await judgeUsageView({ now });
  expect(view.botsUnreadable).toBe(true); expect(view.unreadBots).toBe(0); expect(view.days).toHaveLength(14); expect(view.days.every(d => d.total === 0)).toBe(true);
});
it('returns a read-only RPC reply conforming to the protocol', async () => {
  const service = {} as AdminService;
  const reply = await adminRpc(service, () => undefined, { type: 'judgeUsage' });
  expect(reply?.kind).toBe('read'); if (reply?.kind === 'read') expect(adminReplySchema.safeParse(reply.value).success).toBe(true);
});
