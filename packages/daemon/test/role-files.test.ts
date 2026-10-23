import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config/paths', async () => {
  const { join } = await import('node:path');
  const botDir = (appId: string) => join(fixture.root, 'bots', appId);
  const botPaths = (appId: string) => {
    const dir = botDir(appId);
    return { dir, configFile: join(dir, 'config.json'), sessionsFile: join(dir, 'sessions.json'), projectsFile: join(dir, 'projects.json'),
      processesFile: join(dir, 'processes.json'), setupFile: join(dir, 'setup.json'), topicsDir: join(dir, 'topics'),
      droppedFile: join(dir, 'dropped.json'), judgeUsageFile: join(dir, 'judge-usage.json') };
  };
  return {
    botDir, botPaths,
    paths: {
      get appDir() { return fixture.root; },
      get botsFile() { return join(fixture.root, 'bots.json'); },
      get projectsFile() { return join(fixture.root, 'projects.json'); },
      get projectsRootDir() { return join(fixture.root, 'projects'); },
    },
  };
});

import { prepareLibraryAtStartup } from '../src/admin/library';
import { assemble, loadContextSources } from '../src/bot/context-assembly';
import {
  composeRole, IDENTITY_MAX, migrateRoleFiles, parseRole, readRole, roleDraft, roleProblem, updateRole,
} from '../src/bot/role-files';

const APP = 'cli_a';
beforeEach(() => {
  fixture.root = realpathSync(mkdtempSync(join(tmpdir(), 'role-files-')));
  mkdirSync(join(fixture.root, 'bots', APP), { recursive: true });
});
afterEach(() => { rmSync(fixture.root, { recursive: true, force: true }); });

const botFile = (...parts: string[]) => join(fixture.root, 'bots', APP, ...parts);
const put = (name: string, content: string) => writeFileSync(botFile(name), content);
const get = (...parts: string[]) => readFileSync(botFile(...parts), 'utf8');
const count = (text: string, part: string) => text.split(part).length - 1;

describe('two-section parsing and writing', () => {
  it('reads the two sections and writes them back with both headings', () => {
    const text = composeRole({ identity: '支付组的发布助手。', notes: '简短，先结论。\n\n不改线上配置。' });
    expect(text).toBe('## 身份与职责\n支付组的发布助手。\n\n## 其他说明\n简短，先结论。\n\n不改线上配置。\n');
    expect(parseRole(text)).toEqual({ identity: '支付组的发布助手。', notes: '简短，先结论。\n\n不改线上配置。', headed: true });
    expect(composeRole(parseRole(text))).toBe(text);
  });
  it('shows an old SOUL without headings as it is, in the notes, and does not rewrite the file by reading', async () => {
    const legacy = '你是个爱说话的助手\n\n## 随便一个标题\n正文';
    put('SOUL.md', legacy);
    expect(parseRole(legacy)).toEqual({ identity: '', notes: legacy, headed: false });
    expect(await readRole(APP)).toMatchObject({ identity: '', notes: legacy, headed: false });
    expect(get('SOUL.md')).toBe(legacy);
  });
  it('keeps text before the first heading, other ## lines and fenced headings', () => {
    const text = '前言\n\n## 身份与职责\n我是助手\n\n```\n## 其他说明\n```\n\n## 其他说明\n第一段\n## 别的标题\n第二段\n';
    expect(parseRole(text)).toEqual({ identity: '我是助手\n\n```\n## 其他说明\n```', notes: '前言\n\n第一段\n## 别的标题\n第二段', headed: true });
  });
  it('handles a file with only one of the headings', () => {
    expect(parseRole('## 其他说明\n只有说明')).toEqual({ identity: '', notes: '只有说明', headed: true });
    expect(parseRole('## 身份与职责\n只有身份')).toEqual({ identity: '只有身份', notes: '', headed: true });
  });
  it('limits identity to 500 characters on the section that changed, never the other', () => {
    const long = '字'.repeat(IDENTITY_MAX + 1);
    expect(roleProblem({ identity: long, notes: '' }, { identity: '', notes: '' })).toContain('500');
    expect(roleProblem({ identity: '字'.repeat(IDENTITY_MAX), notes: '' }, { identity: '', notes: '' })).toBeUndefined();
    // an old file's long notes opens, and an edit to the identity alone is not refused for them
    const oldNotes = '旧'.repeat(9_000);
    expect(roleProblem({ identity: '新身份', notes: oldNotes }, { identity: '', notes: oldNotes })).toBeUndefined();
    expect(roleProblem({ identity: '新身份', notes: `${oldNotes}加` }, { identity: '', notes: oldNotes })).toContain('8000');
    expect(roleProblem({ identity: 'x\n## 其他说明\ny', notes: '' })).toContain('分界');
  });
  it('drafts the identity from the app name only', () => {
    expect(roleDraft('小支')).toBe('我是「小支」，团队里的 AI 助手。我负责：');
    expect(roleDraft('  a\n## 其他说明「x」 ')).not.toContain('\n');
    expect(roleDraft(undefined)).toBe('');
  });
});

describe('saving the role', () => {
  it('adds the headings at the first save of an old SOUL, records its hash and an event, and never touches AGENTS.md', async () => {
    put('SOUL.md', '旧 SOUL 全文');
    put('AGENTS.md', '');
    const before = statSync(botFile('AGENTS.md')).mtimeMs;
    const saved = await updateRole(APP, current => ({ ...current, identity: '发布助手' }));
    expect(saved).toMatchObject({ identity: '发布助手', notes: '旧 SOUL 全文', headed: true, integrity: 'ok' });
    expect(get('SOUL.md')).toBe('## 身份与职责\n发布助手\n\n## 其他说明\n旧 SOUL 全文\n');
    expect(statSync(botFile('AGENTS.md')).mtimeMs).toBe(before);
    const integrity = JSON.parse(get('memory', 'integrity.json'));
    expect(integrity.files['SOUL.md'].sha256).toMatch(/^[0-9a-f]{64}$/);
    const events = get('memory', 'role-events.jsonl').trim().split('\n').map(line => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'role_edit', before: { identity: '', notes: '旧 SOUL 全文' }, after: { identity: '发布助手', notes: '旧 SOUL 全文' }, actor: { actorRole: 'desktop' } });
    expect(events[0].eventId).toMatch(/^b:e_[0-9a-f]{12}$/);
    expect(statSync(botFile('memory', 'role-events.jsonl')).mode & 0o777).toBe(0o600);
  });
  it('flags a SOUL.md changed outside vonvon and does not write an unchanged role', async () => {
    await updateRole(APP, () => ({ identity: 'a', notes: 'b' }));
    expect((await readRole(APP)).integrity).toBe('ok');
    put('SOUL.md', `${get('SOUL.md')}偷偷加的\n`);
    expect((await readRole(APP)).integrity).toBe('changed');
    await updateRole(APP, current => current);
    // nothing to write: still flagged until the person saves something
    expect((await readRole(APP)).integrity).toBe('changed');
    expect(get('memory', 'role-events.jsonl').trim().split('\n')).toHaveLength(1);
    await updateRole(APP, current => ({ ...current, notes: 'c' }));
    expect((await readRole(APP)).integrity).toBe('ok');
  });
  it('refuses a too-long identity, stale callers and leaves the file as it was', async () => {
    await updateRole(APP, () => ({ identity: 'a', notes: 'b' }));
    const text = get('SOUL.md');
    await expect(updateRole(APP, current => ({ ...current, identity: '字'.repeat(501) }))).rejects.toThrow('500');
    await expect(updateRole(APP, () => ({ identity: 'z', notes: 'z' }), { beforeCommit: () => { throw new Error('stale'); } })).rejects.toThrow('stale');
    expect(get('SOUL.md')).toBe(text);
  });
  it('serializes concurrent edits of the two sections', async () => {
    await Promise.all([
      updateRole(APP, current => ({ ...current, identity: '身份' })),
      updateRole(APP, current => ({ ...current, notes: '说明' })),
    ]);
    expect(await readRole(APP)).toMatchObject({ identity: '身份', notes: '说明' });
  });
  it('opens an old over-long SOUL and says it is oversized; the first edit has to trim it', async () => {
    const huge = 'x'.repeat(25_000);
    put('SOUL.md', huge);
    expect(await readRole(APP)).toMatchObject({ headed: false, oversized: true });
    await expect(updateRole(APP, current => ({ ...current, notes: `${current.notes}多` }))).rejects.toThrow('8000');
    await updateRole(APP, current => ({ ...current, notes: '精简后' }));
    expect(await readRole(APP)).toMatchObject({ notes: '精简后', oversized: false });
  });
});

describe('migration step R', () => {
  it('merges a used AGENTS.md at the end of the notes once, backs both files up as they were and empties it', async () => {
    put('SOUL.md', '## 身份与职责\n发布助手\n\n## 其他说明\n简短。\n');
    put('AGENTS.md', '做事规矩：\n- 不改线上\n');
    expect(await migrateRoleFiles(APP)).toBe('merged');
    expect(get('SOUL.md')).toBe('## 身份与职责\n发布助手\n\n## 其他说明\n简短。\n\n做事规矩：\n- 不改线上\n');
    expect(count(get('SOUL.md'), '不改线上')).toBe(1);
    expect(get('memory', 'originals', 'SOUL.md')).toBe('## 身份与职责\n发布助手\n\n## 其他说明\n简短。\n');
    expect(get('memory', 'originals', 'AGENTS.md')).toBe('做事规矩：\n- 不改线上\n');
    expect(statSync(botFile('memory', 'originals', 'AGENTS.md')).mode & 0o777).toBe(0o600);
    expect(get('AGENTS.md')).toBe('');
    expect(JSON.parse(get('memory', 'import-state.json')).role).toMatchObject({ merged: true });
    expect(JSON.parse(get('memory', 'integrity.json')).files['SOUL.md']).toBeDefined();
    expect((await readRole(APP)).mergedNotice).toBe(true);
    expect(await migrateRoleFiles(APP)).toBe('marked');
    expect(count(get('SOUL.md'), '不改线上')).toBe(1);
  });
  it('appends at the very end of an old SOUL without headings', async () => {
    put('SOUL.md', '旧人格\n');
    put('AGENTS.md', '旧规矩');
    await migrateRoleFiles(APP);
    expect(get('SOUL.md')).toBe('旧人格\n\n旧规矩\n');
    expect(await readRole(APP)).toMatchObject({ headed: false, notes: '旧人格\n\n旧规矩\n' });
  });
  it('leaves the SOUL.md of a bot saved on dev (empty AGENTS.md) untouched, with no backups', async () => {
    put('SOUL.md', '## 身份与职责\n已保存\n');
    put('AGENTS.md', '  \n');
    expect(await migrateRoleFiles(APP)).toBe('empty');
    expect(get('SOUL.md')).toBe('## 身份与职责\n已保存\n');
    expect(existsSync(botFile('memory', 'originals'))).toBe(false);
    expect(JSON.parse(get('memory', 'import-state.json')).role.merged).toBe(false);
    expect((await readRole(APP)).mergedNotice).toBe(false);
  });
  it('migrates a bot with no SOUL.md at all', async () => {
    put('AGENTS.md', '只有规矩');
    await migrateRoleFiles(APP);
    expect(get('SOUL.md')).toBe('只有规矩');
    expect(existsSync(botFile('memory', 'originals', 'SOUL.md'))).toBe(true);
    expect(get('memory', 'originals', 'SOUL.md')).toBe('');
  });
  it('survives a kill between the SOUL.md write and emptying AGENTS.md', async () => {
    // the state a kill leaves: backups made, SOUL.md already has the text, AGENTS.md still full, no marker
    put('AGENTS.md', '规矩 A\n规矩 B');
    put('SOUL.md', '## 其他说明\n简短。\n\n规矩 A\n规矩 B\n');
    mkdirSync(botFile('memory', 'originals'), { recursive: true });
    writeFileSync(botFile('memory', 'originals', 'AGENTS.md'), '规矩 A\n规矩 B');
    writeFileSync(botFile('memory', 'originals', 'SOUL.md'), '## 其他说明\n简短。\n');
    expect(await migrateRoleFiles(APP)).toBe('already-in');
    expect(count(get('SOUL.md'), '规矩 A')).toBe(1);
    expect(get('AGENTS.md')).toBe('');
    // the backups are never overwritten by the second run
    expect(get('memory', 'originals', 'SOUL.md')).toBe('## 其他说明\n简短。\n');
    expect(JSON.parse(get('memory', 'import-state.json')).role.merged).toBe(true);
  });
  it('survives a kill after AGENTS.md was emptied and before the marker, still reporting the merge', async () => {
    put('SOUL.md', '合并后的 SOUL\n');
    put('AGENTS.md', '');
    mkdirSync(botFile('memory', 'originals'), { recursive: true });
    writeFileSync(botFile('memory', 'originals', 'AGENTS.md'), '原来的规矩');
    expect(await migrateRoleFiles(APP)).toBe('merged');
    expect(get('SOUL.md')).toBe('合并后的 SOUL\n');
    expect((await readRole(APP)).mergedNotice).toBe(true);
  });
  it('does not take what is written to AGENTS.md afterwards into any context', async () => {
    put('SOUL.md', '## 身份与职责\n助手\n');
    await migrateRoleFiles(APP);
    put('AGENTS.md', 'AGENTS_LATER_MARKER');
    expect(await migrateRoleFiles(APP)).toBe('marked');
    expect(get('AGENTS.md')).toBe('AGENTS_LATER_MARKER');
    expect((await readRole(APP)).notes).not.toContain('AGENTS_LATER_MARKER');
    const sources = await loadContextSources({ appId: APP, botName: '助手', place: { kind: 'group', chatId: 'oc_x', chatName: '群' }, botDirectory: join(fixture.root, 'bots', APP) });
    const assembled = assemble(sources);
    const text = [assembled.identity, assembled.role, assembled.supplement, assembled.botMemory].join('\n');
    expect(text).not.toContain('AGENTS_LATER_MARKER');
    expect(text).toContain('助手');
  });
  it('keeps the other keys of import-state.json and does not need the bot to be running', async () => {
    mkdirSync(botFile('memory'), { recursive: true });
    writeFileSync(botFile('memory', 'import-state.json'), JSON.stringify({ version: 1, memory: { done: true } }));
    put('AGENTS.md', '');
    await migrateRoleFiles(APP);
    expect(JSON.parse(get('memory', 'import-state.json'))).toMatchObject({ memory: { done: true }, role: { merged: false } });
  });
  it('runs at host start for every registered bot, enabled or not, and a failing bot does not stop the others', async () => {
    writeFileSync(join(fixture.root, 'bots.json'), JSON.stringify({ version: 1, current: APP, bots: [
      { name: 'a', appId: APP, tenant: 'feishu', createdAt: 1, active: true },
      { name: 'b', appId: 'cli_b', tenant: 'feishu', createdAt: 1, active: false },
      { name: 'c', appId: 'cli_c', tenant: 'feishu', createdAt: 1, active: true },
    ] }));
    put('AGENTS.md', '规矩甲');
    mkdirSync(join(fixture.root, 'bots', 'cli_b'), { recursive: true });
    writeFileSync(join(fixture.root, 'bots', 'cli_b', 'AGENTS.md'), '规矩乙');
    // cli_c's AGENTS.md is a directory: unreadable, its error is reported and the rest still migrates
    mkdirSync(join(fixture.root, 'bots', 'cli_c', 'AGENTS.md'), { recursive: true });
    const report = await prepareLibraryAtStartup();
    expect(report.failed.map(item => item.botId)).toEqual(['cli_c']);
    expect(get('SOUL.md')).toBe('规矩甲');
    expect(readFileSync(join(fixture.root, 'bots', 'cli_b', 'SOUL.md'), 'utf8')).toBe('规矩乙');
    expect(get('AGENTS.md')).toBe('');
    // a second start changes nothing
    await prepareLibraryAtStartup();
    expect(get('SOUL.md')).toBe('规矩甲');
  });
});
