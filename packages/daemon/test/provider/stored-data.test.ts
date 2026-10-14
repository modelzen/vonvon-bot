import { rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackend } from '../../src/agent';
import { safeBackendId } from '../../src/bot/handle-message';
import { getSession, getSessionTitleJob, listSessionTitleJobs, listSessions, upsertSession } from '../../src/bot/session-store';
import { paths } from '../../src/config/paths';
import { getSessionTitleConfig, type AppConfig } from '../../src/config/schema';
import { loadConfig, saveConfig } from '../../src/config/store';
import { getProjectByName, listProjects, updateProject } from '../../src/project/registry';
import { migrateProviderId } from '../../src/provider/model';

vi.mock('../../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'stored-data-test-'));
  return { paths: { sessionsFile: join(dir, 'sessions.json'), projectsFile: join(dir, 'projects.json'), configFile: join(dir, 'config.json') } };
});

afterAll(() => rmSync(dirname(paths.sessionsFile), { recursive: true, force: true }));

const dir = (): string => dirname(paths.sessionsFile);

// The shapes below are what `main`'s session-store, project registry, and preference writers put on disk.
const mainProjects = {
  version: 1,
  projects: [
    { name: 'codex-proj', chatId: 'oc_codex', cwd: '/w/codex', kind: 'multi', backend: 'codex-appserver', mode: 'write', admins: ['ou_admin'] },
    { name: 'claude-proj', chatId: 'oc_claude', cwd: '/w/claude', kind: 'single', backend: 'claude-agent', defaultModel: 'sonnet' },
    { name: 'legacy-proj', chatId: 'oc_legacy', cwd: '/w/legacy' },
  ],
};

const mainSessions = {
  version: 3,
  sessions: [
    { threadId: 'omt_codex', chatId: 'oc_codex', cwd: '/w/codex', sessionId: 'thr_codex', backend: 'codex-appserver', titleJobKey: 'codex-appserver:thr_codex', summary: 'fix the build', createdAt: 1, updatedAt: 2 },
    { threadId: 'oc_claude', chatId: 'oc_claude', cwd: '/w/claude', sessionId: '0b6d7c1e-claude', backend: 'claude-agent', model: 'sonnet', summary: 'review', createdAt: 3, updatedAt: 4 },
    { threadId: 'omt_v1', chatId: 'oc_codex', cwd: '/w/codex', codexThreadId: 'thr_v1', summary: 'v1 record', createdAt: 5, updatedAt: 6 },
  ],
  titleJobs: [
    { key: 'codex-appserver:thr_codex', backend: 'codex-appserver', sessionId: 'thr_codex', cwd: '/w/codex', phase: 'pending', source: 'fix the build', attempts: 0, createdAt: 1, updatedAt: 2 },
    { key: 'claude-agent:0b6d7c1e-claude', backend: 'claude-agent', sessionId: '0b6d7c1e-claude', cwd: '/w/claude', phase: 'done', outcome: 'written', finalTitle: 'Review', attempts: 1, createdAt: 3, updatedAt: 4 },
  ],
};

const mainConfig = {
  accounts: { app: { id: 'cli_fixture', secret: 'fixture-secret', tenant: 'feishu' } },
  preferences: {
    comments: { backend: 'claude-agent', model: 'sonnet' },
    sessionTitles: { byBackend: { 'codex-appserver': { enabled: true, model: 'gpt-5.4-mini', effort: 'low' }, 'claude-agent': { enabled: false } } },
  },
};

async function seed(files: { projects?: unknown; sessions?: unknown; config?: unknown }): Promise<void> {
  await mkdir(dir(), { recursive: true });
  await writeFile(paths.projectsFile, JSON.stringify(files.projects ?? mainProjects));
  await writeFile(paths.sessionsFile, JSON.stringify(files.sessions ?? mainSessions));
  await writeFile(paths.configFile, JSON.stringify(files.config ?? mainConfig));
}

async function loadAll(): Promise<unknown> {
  return { projects: await listProjects(), sessions: await listSessions(), titleJobs: await listSessionTitleJobs(), config: await loadConfig() };
}

beforeEach(() => seed({}));

describe('main-era stored data under the new provider ids', () => {
  it('maps each old id and leaves the new ids unchanged', () => {
    expect(migrateProviderId('codex-appserver')).toBe('codex');
    expect(migrateProviderId('claude-agent')).toBe('claude');
    expect(migrateProviderId('codex')).toBe('codex');
    expect(migrateProviderId('claude')).toBe('claude');
    expect(migrateProviderId('constructor')).toBe('constructor');
  });

  it('loads projects with the new ids and keeps a missing backend missing', async () => {
    const byName = Object.fromEntries((await listProjects()).map(p => [p.name, p.backend]));
    expect(byName).toEqual({ 'codex-proj': 'codex', 'claude-proj': 'claude', 'legacy-proj': undefined });
  });

  it('resumes the Codex and the Claude session through the mapped id', async () => {
    const codex = await getSession('omt_codex');
    const claude = await getSession('oc_claude');
    expect([codex?.backend, codex?.sessionId]).toEqual(['codex', 'thr_codex']);
    expect([claude?.backend, claude?.sessionId]).toEqual(['claude', '0b6d7c1e-claude']);
    expect(createBackend(codex!.backend).id).toBe('codex');
    expect(createBackend(claude!.backend).id).toBe('claude');
    expect((await getSession('omt_v1'))?.backend).toBe('codex');
  });

  it('rewrites the title-job keys so a pending Codex job is found under its new key', async () => {
    const pending = await getSessionTitleJob('codex:thr_codex');
    expect(pending).toMatchObject({ backend: 'codex', sessionId: 'thr_codex', phase: 'pending', source: 'fix the build' });
    expect((await listSessionTitleJobs()).map(job => job.key)).toEqual(['codex:thr_codex', 'claude:0b6d7c1e-claude']);
    expect((await getSession('omt_codex'))?.titleJobKey).toBe('codex:thr_codex');
  });

  it('keeps one job when an old-id job and its migrated twin are both stored', async () => {
    const twin = { ...mainSessions.titleJobs[0], key: 'codex:thr_codex', backend: 'codex', phase: 'done', attempts: 1 };
    await seed({ sessions: { ...mainSessions, titleJobs: [twin, ...mainSessions.titleJobs] } });
    const jobs = (await listSessionTitleJobs()).filter(job => job.sessionId === 'thr_codex');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.phase).toBe('done');
  });

  it('maps the comment backend and the title policies keyed by provider id', async () => {
    const cfg = (await loadConfig()) as AppConfig;
    expect(cfg.preferences?.comments?.backend).toBe('claude');
    expect(Object.keys(cfg.preferences?.sessionTitles?.byBackend ?? {}).sort()).toEqual(['claude', 'codex']);
    expect(getSessionTitleConfig(cfg, 'codex')).toEqual({ enabled: true, model: 'gpt-5.4-mini', effort: 'low' });
    expect(getSessionTitleConfig(cfg, 'claude')).toEqual({ enabled: false });
  });

  it('prefers a title policy already stored under the new id over the legacy one', async () => {
    const byBackend = { codex: { enabled: true, model: 'gpt-5.5', effort: 'high' }, 'codex-appserver': { enabled: false } };
    await seed({ config: { ...mainConfig, preferences: { sessionTitles: { byBackend } } } });
    expect(getSessionTitleConfig((await loadConfig()) as AppConfig, 'codex')).toEqual({ enabled: true, model: 'gpt-5.5', effort: 'high' });
  });

  it('accepts an old id from a card a main-era daemon sent', () => {
    expect(safeBackendId({ backend: 'claude-agent' })).toBe('claude');
  });

  it('gives identical results on a second load and after the daemon writes the migrated data back', async () => {
    const first = await loadAll();
    expect(await loadAll()).toEqual(first);

    await upsertSession((await getSession('oc_claude'))!);
    await updateProject('claude-proj', {});
    const cfg = (await loadConfig()) as AppConfig;
    await saveConfig(cfg, paths.configFile, cfg);
    expect(await loadAll()).toEqual(first);

    const disk = [await readFile(paths.sessionsFile, 'utf8'), await readFile(paths.projectsFile, 'utf8'), await readFile(paths.configFile, 'utf8')].join('\n');
    expect(disk).not.toMatch(/codex-appserver|claude-agent/);
    expect((await getProjectByName('claude-proj'))?.backend).toBe('claude');
  });
});
