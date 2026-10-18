import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'directory-settings-data-')));
  return { paths: { appDir, configFile: join(appDir, 'config.json'), projectsFile: join(appDir, 'projects.json'), secretsGetterScript: join(appDir, 'getter') } };
});

import { paths } from '../src/config/paths';
import { admitDirectorySettings, parseDirectorySettings } from '../src/config/directories';
import { buildEncryptedAccountConfig, loadConfig, saveConfig } from '../src/config/store';
import type { AppConfig } from '../src/config/schema';
import { addProject, listProjects, listProjectsIn, mutateProject, resetProjectDirectoryOverride, setTierMergePending, updateProject, type Project } from '../src/project/registry';

const exec = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'directory-settings-')));
const external = join(root, 'external');
const another = join(root, 'another');
await mkdir(external);
await mkdir(another);
const policy = { dataDir: paths.appDir };
const accounts: AppConfig['accounts'] = { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } };
function config(directories?: unknown): AppConfig {
  return { accounts, preferences: { directories: parseDirectorySettings(directories) } };
}
function workspace(primary = external, additional: string[] = []) { return { workspaces: { primary, additional } }; }
async function rawFile(name: string, value: unknown): Promise<string> {
  const file = join(root, name, 'config.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
  return file;
}
async function git(...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const { stdout } = await exec('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, timeout: 5_000,
  });
  return stdout;
}
const repository = join(root, 'repository');
await git('init', '-q', repository);
await git('-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture');
const worktree = join(root, 'worktree');
await git('-C', repository, 'worktree', 'add', '-q', '--detach', worktree);

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(paths.appDir, { recursive: true, force: true });
});

describe('owned directory syntax', () => {
  it('keeps absence and explicit empty repositories distinct, with exactly one primary', () => {
    expect(parseDirectorySettings(undefined)).toBeUndefined();
    expect(parseDirectorySettings({})).toEqual({});
    expect(parseDirectorySettings({ repositories: [] })).toEqual({ repositories: [] });
    expect(parseDirectorySettings(workspace())).toEqual(workspace());
    for (const raw of [null, [], { workspaces: [] }, { workspaces: { additional: [] } },
      { workspaces: { primary: external } }, { repositories: ['https://example.invalid/repo'] },
      { repositories: ['relative'] }, { repositories: [`${external}\0`] },
      { unknownSecret: 'sensitive' }, { workspaces: { primary: external, additional: [], extra: 'sensitive' } }]) {
      expect(() => parseDirectorySettings(raw)).toThrow(/Invalid directory settings/);
      try { parseDirectorySettings(raw); } catch (error) { expect(String(error)).not.toContain('sensitive'); }
    }
  });
});

describe('actual filesystem admission', () => {
  it('admits outside directories and strict projects descendants, rejecting ancestors/protected data', async () => {
    const project = join(paths.appDir, 'projects', 'bot', 'group');
    const protectedDir = join(paths.appDir, 'bots', 'bot');
    await mkdir(project, { recursive: true });
    await mkdir(protectedDir, { recursive: true });
    expect(await admitDirectorySettings(workspace(external, [project]), policy)).toEqual(workspace(external, [project]));
    for (const path of [paths.appDir, dirname(paths.appDir), protectedDir, join(paths.appDir, 'projects')]) {
      await expect(admitDirectorySettings(workspace(path), policy)).rejects.toThrow(/Invalid directory settings/);
    }
    const sibling = `${paths.appDir}-sibling`;
    await mkdir(sibling);
    try { expect(await admitDirectorySettings(workspace(sibling), policy)).toEqual(workspace(sibling)); }
    finally { await rm(sibling, { recursive: true }); }
  });

  it('resolves symlinks before policy/duplicate checks and cannot admit bots through projects alias', async () => {
    const alias = join(root, 'external-alias');
    await symlink(external, alias);
    expect(await admitDirectorySettings(workspace(alias), policy)).toEqual(workspace());
    await expect(admitDirectorySettings(workspace(external, [alias]), policy)).rejects.toThrow(/duplicate/);
    const data = join(root, 'alias-data');
    const bot = join(data, 'bots', 'fixture');
    await mkdir(bot, { recursive: true });
    await symlink(join(data, 'bots'), join(data, 'projects'));
    await expect(admitDirectorySettings(workspace(join(data, 'projects', 'fixture')), { dataDir: data })).rejects.toThrow(/Invalid directory settings/);
    const escape = join(paths.appDir, 'projects', 'escape');
    await symlink(join(paths.appDir, 'bots'), escape);
    await expect(admitDirectorySettings(workspace(join(escape, 'bot')), policy)).rejects.toThrow(/Invalid directory settings/);
  });

  it('resolves a missing dataDir through its real existing ancestor without mkdir', async () => {
    const alias = join(root, 'parent-alias');
    await symlink(paths.appDir, alias);
    const dataDir = join(alias, 'not-created', 'data');
    expect(await admitDirectorySettings(workspace(), { dataDir })).toEqual(workspace());
    await expect(admitDirectorySettings(workspace(paths.appDir), { dataDir })).rejects.toThrow();
    await expect(stat(join(paths.appDir, 'not-created'))).rejects.toMatchObject({ code: 'ENOENT' });
    const dangling = join(root, 'dangling');
    await symlink(join(root, 'absent-target'), dangling);
    await expect(admitDirectorySettings(workspace(), { dataDir: join(dangling, 'data') })).rejects.toThrow(/Invalid directory policy/);
  });

  it('rejects files and missing directories with field-only errors', async () => {
    const file = join(root, 'private-filename');
    await writeFile(file, 'private-content');
    for (const primary of [file, join(root, 'missing-private')]) {
      await expect(admitDirectorySettings(workspace(primary), policy)).rejects.toThrow('directories.workspaces.primary');
      try { await admitDirectorySettings(workspace(primary), policy); }
      catch (error) { expect(String(error)).not.toContain(primary); }
    }
  });

  it('accepts real Git roots including linked worktrees and rejects nonroot/bare/duplicate selections', async () => {
    expect((await stat(join(worktree, '.git'))).isFile()).toBe(true);
    expect(await admitDirectorySettings({ repositories: [repository, worktree] }, policy)).toEqual({ repositories: [repository, worktree] });
    const nested = join(repository, 'nested');
    await mkdir(nested);
    const bare = join(root, 'bare.git');
    await git('init', '-q', '--bare', bare);
    for (const selected of [nested, bare, external]) {
      await expect(admitDirectorySettings({ repositories: [selected] }, policy)).rejects.toThrow(/expected local Git root/);
    }
    await expect(admitDirectorySettings({ repositories: [repository, repository] }, policy)).rejects.toThrow(/duplicate/);
    const redirected = join(root, 'redirected');
    await git('init', '-q', redirected);
    const pretendRoot = join(redirected, 'pretend-root');
    await mkdir(pretendRoot);
    await git('-C', redirected, 'config', 'core.worktree', pretendRoot);
    // show-toplevel alone can report a configured nested directory with no .git entry.
    const reported = await git('-C', pretendRoot, 'rev-parse', '--show-toplevel');
    expect(reported.trim()).toBe(pretendRoot);
    await expect(admitDirectorySettings({ repositories: [pretendRoot] }, policy)).rejects.toThrow(/expected local Git root/);
    // Workspace/repository overlap intentionally remains legal.
    expect(await admitDirectorySettings({ ...workspace(repository), repositories: [repository] }, policy)).toEqual({ ...workspace(repository), repositories: [repository] });
  });

  it('ignores inherited Git repository and config overrides', async () => {
    vi.stubEnv('GIT_DIR', join(repository, '.git'));
    vi.stubEnv('GIT_WORK_TREE', repository);
    vi.stubEnv('GIT_COMMON_DIR', join(repository, '.git'));
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.bare');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
    try {
      expect(await admitDirectorySettings({ repositories: [worktree] }, policy)).toEqual({ repositories: [worktree] });
      await expect(admitDirectorySettings({ repositories: [external] }, policy)).rejects.toThrow(/expected local Git root/);
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('config persistence owns changed declarations', () => {
  it('bounds Git admission with inherited stdout helpers and releases the save queue', async () => {
    const bin = join(root, 'git-timeout-bin');
    await mkdir(bin);
    const pidFile = join(root, 'git-helper.pid');
    const shim = join(bin, 'git');
    const helper = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 8500);`;
    await writeFile(shim, `#!/usr/bin/env node\nconst { spawn } = require('node:child_process');\nspawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['ignore', 1, 'ignore'] });\nsetInterval(() => {}, 1000);\n`);
    await chmod(shim, 0o700);
    const file = join(root, 'git-timeout-config.json');
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    const pending = saveConfig(config({ repositories: [repository] }), file).then(() => 'fulfilled', () => 'rejected');
    try {
      const outcome = await Promise.race([pending, delay(6500, 'still pending')]);
      expect(outcome).toBe('rejected');
      const pid = Number(await readFile(pidFile, 'utf8'));
      let running = true;
      for (let attempt = 0; attempt < 50 && running; attempt++) {
        try {
          const { stdout } = await exec('ps', ['-o', 'stat=', '-p', String(pid)]);
          // A reparented zombie is exited; some CI init processes reap it later.
          running = stdout.trim() !== '' && !stdout.trim().startsWith('Z');
        } catch { running = false; }
        if (running) await delay(20);
      }
      expect(running).toBe(false);
      await saveConfig({ accounts }, file);
      expect(await loadConfig(file)).toEqual({ accounts });
    } finally {
      vi.unstubAllEnvs();
      await pending;
    }
  }, 15_000);

  it('preserves ordinary repair saves for malformed legacy JSON while CAS still refuses it', async () => {
    const file = await rawFile('repair', {});
    await writeFile(file, '{broken-private-json');
    await expect(saveConfig({ accounts }, file, { accounts })).rejects.toThrow(/Invalid config JSON/);
    expect(await readFile(file, 'utf8')).toBe('{broken-private-json');
    await saveConfig({ accounts, preferences: { pendingPolicy: 'queue' } }, file);
    expect(await loadConfig(file)).toEqual({ accounts, preferences: { pendingPolicy: 'queue' } });
  });

  it('loads syntax only and preserves unknown envelopes and absent declarations without creating paths', async () => {
    const missing = join(root, 'missing-read');
    const raw = { accounts, future: { private: true }, preferences: { legacy: 42, ...{ directories: workspace(missing) } } };
    const file = await rawFile('read-only', raw);
    const before = await readFile(file, 'utf8');
    expect(await loadConfig(file)).toEqual(raw);
    expect(await readFile(file, 'utf8')).toBe(before);
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await loadConfig(join(root, 'absent-config', 'config.json'))).toEqual({});
    await expect(stat(join(root, 'absent-config'))).rejects.toMatchObject({ code: 'ENOENT' });
    const cfg = await buildEncryptedAccountConfig('fixture', 'feishu', { directories: undefined });
    expect(cfg.preferences?.directories).toBeUndefined();
  });

  it('rejects malformed reads and invalid saves before mkdir or overwriting bytes', async () => {
    const malformed = await rawFile('malformed', { accounts, preferences: { directories: { repositories: ['secret-url'] } } });
    await expect(loadConfig(malformed)).rejects.toThrow(/Invalid directory settings/);
    const file = await rawFile('reject-save', { accounts, unknown: ['keep'] });
    const before = await readFile(file, 'utf8');
    await expect(saveConfig(config(workspace(join(paths.appDir, 'bots', 'bot'))), file)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);
    const newFile = join(root, 'must-not-create', 'config.json');
    await expect(saveConfig(config(workspace(join(root, 'missing'))), newFile)).rejects.toThrow();
    await expect(stat(dirname(newFile))).rejects.toMatchObject({ code: 'ENOENT' });
    const alias = join(root, 'external-alias');
    await expect(saveConfig(config(workspace(alias)), file)).rejects.toThrow(/canonical/);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('admits introduced blocks, retains missing unchanged mounts and compares actual previous disk', async () => {
    const mount = join(root, 'mount');
    await mkdir(mount);
    const file = await rawFile('changed', { accounts, extra: { keep: true }, preferences: { legacy: true } });
    const cfg = await loadConfig(file);
    if (!cfg.accounts) throw new Error('fixture missing accounts');
    const next: AppConfig = { ...cfg, accounts: cfg.accounts, preferences: { ...cfg.preferences, directories: workspace(mount) } };
    await saveConfig(next, file);
    await rm(mount, { recursive: true });
    next.preferences = { ...next.preferences, directories: { ...workspace(mount), repositories: [repository] } };
    await saveConfig(next, file);
    expect(await loadConfig(file)).toMatchObject({ extra: { keep: true }, preferences: { legacy: true, directories: { ...workspace(mount), repositories: [repository] } } });
    await writeFile(file, JSON.stringify({ accounts }));
    await expect(saveConfig(next, file)).rejects.toThrow();
    expect(await loadConfig(file)).toEqual({ accounts });
  });

  it('snapshots queued declarations and recovers after filesystem rejection and CAS conflict', async () => {
    const file = await rawFile('queue', { accounts });
    const first = config(workspace());
    const pending = saveConfig(first, file);
    if (!first.preferences?.directories?.workspaces) throw new Error('fixture missing primary');
    first.preferences.directories.workspaces.primary = join(root, 'missing-after-snapshot');
    await pending;
    expect((await loadConfig(file)).preferences?.directories).toEqual(workspace());
    const expected = await loadConfig(file);
    if (!expected.accounts) throw new Error('fixture missing accounts');
    const next = config(workspace(another));
    const queued = saveConfig(next, file, { ...expected, accounts: expected.accounts });
    if (!next.preferences?.directories?.workspaces) throw new Error('fixture missing primary');
    next.preferences.directories.workspaces.additional.push(external);
    await queued;
    expect((await loadConfig(file)).preferences?.directories).toEqual(workspace(another));
    await expect(saveConfig(config(), file, { accounts })).rejects.toThrow(/其他进程/);
    await expect(saveConfig(config(workspace(join(root, 'missing-rejected'))), file)).rejects.toThrow();
    await saveConfig(config(workspace()), file);
    expect((await loadConfig(file)).preferences?.directories).toEqual(workspace());
  });
});

describe('project registry directory declarations', () => {
  const row = (name: string): Project => ({ name, chatId: `oc_${name}`, cwd: external, blank: false, createdAt: 1 });
  async function seed(projects: unknown[], extra: object = {}) {
    await writeFile(paths.projectsFile, JSON.stringify({ version: 1, future: { keep: true }, ...extra, projects }));
  }

  it('keeps legacy cwd and unknown row/top-level metadata, with syntax-only cross-bot reads', async () => {
    const cwd = join(root, 'legacy-missing-cwd');
    await seed([{ ...row('legacy'), cwd, oldField: { keep: true } }]);
    await updateProject('legacy', { enabled: false });
    expect(JSON.parse(await readFile(paths.projectsFile, 'utf8'))).toMatchObject({ future: { keep: true }, projects: [{ cwd, oldField: { keep: true }, enabled: false }] });
    expect((await listProjects())[0]).not.toHaveProperty('directories');
    await expect(stat(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    const file = await rawFile('other-projects', { projects: [{ ...row('other'), directories: workspace(join(root, 'missing-other')) }] });
    expect((await listProjectsIn(file))[0]?.directories).toEqual(workspace(join(root, 'missing-other')));
    await seed([{ ...row('bad'), directories: { repositories: ['private-relative-path'] } }]);
    await expect(listProjects()).rejects.toThrow(/Invalid directory settings/);
  });

  it('enforces primary/cwd on add, update and mutate, never committing partial edits', async () => {
    await seed([]);
    await expect(addProject({ ...row('bad'), directories: workspace(another) })).rejects.toThrow(/must match cwd/);
    expect(await listProjects()).toEqual([]);
    await addProject({ ...row('valid'), directories: workspace() });
    await updateProject('valid', { cwd: another });
    expect((await listProjects())[0]).toMatchObject({ cwd: another, directories: workspace(another) });
    const committed = await mutateProject('valid', project => { project.cwd = external; });
    expect(committed).toMatchObject({ cwd: external, directories: workspace() });
    expect((await listProjects())[0]).toMatchObject({ cwd: external, directories: workspace() });
    const before = await readFile(paths.projectsFile, 'utf8');
    await expect(updateProject('valid', { directories: workspace(another) })).rejects.toThrow(/must match cwd/);
    await expect(mutateProject('valid', project => { project.directories = workspace(external, [external]); })).rejects.toThrow(/duplicate/);
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(before);
  });

  it('rejects cwd edits that collide with additional workspaces and preserves in-place mutation comparisons', async () => {
    await seed([{ ...row('move'), directories: workspace(external, [another]) }]);
    const before = await readFile(paths.projectsFile, 'utf8');
    await expect(updateProject('move', { cwd: another })).rejects.toThrow(/duplicate/);
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(before);
    await expect(mutateProject('move', project => {
      if (!project.directories) throw new Error('fixture missing directories');
      project.directories.repositories = [external];
    })).rejects.toThrow(/Git root/);
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(before);
  });

  it('allows unrelated and tier-metadata writes after a mount vanishes, but admits changed blocks', async () => {
    const mount = join(root, 'registry-mount');
    await mkdir(mount);
    await seed([{ ...row('mounted'), cwd: mount, directories: workspace(mount), legacy: true }]);
    await rm(mount, { recursive: true });
    await updateProject('mounted', { network: true });
    await setTierMergePending(['oc_mounted']);
    expect(JSON.parse(await readFile(paths.projectsFile, 'utf8'))).toMatchObject({ tierMergePending: ['oc_mounted'], projects: [{ cwd: mount, legacy: true, network: true }] });
    await updateProject('mounted', { directories: { ...workspace(mount), repositories: [repository] } });
    const before = await readFile(paths.projectsFile, 'utf8');
    await expect(updateProject('mounted', { directories: workspace(mount, [another]) })).rejects.toThrow();
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(before);
  });

  it('resets only the requested raw override; undefined ordinary patches remain no-ops', async () => {
    await seed([{ ...row('reset'), directories: { ...workspace(), repositories: [] }, unrelated: 'keep' }]);
    await updateProject('reset', { directories: undefined });
    expect((await listProjects())[0]?.directories).toEqual({ ...workspace(), repositories: [] });
    await resetProjectDirectoryOverride('reset', 'repositories');
    expect((await listProjects())[0]?.directories).toEqual(workspace());
    await resetProjectDirectoryOverride('reset', 'workspaces');
    expect((await listProjects())[0]?.directories).toEqual({});
    expect(JSON.parse(await readFile(paths.projectsFile, 'utf8'))).toMatchObject({ future: { keep: true }, projects: [{ cwd: external, unrelated: 'keep' }] });
    const before = await readFile(paths.projectsFile, 'utf8');
    await resetProjectDirectoryOverride('reset', 'workspaces');
    await resetProjectDirectoryOverride('absent', 'repositories');
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(before);
  });
});
