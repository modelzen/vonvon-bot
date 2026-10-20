import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPersonalityFiles, PERSONALITY_SAFETY_BYTES, type FileRead, type FileWrite, type PersonalityFile } from '../src/bot/personality-files';

const directories: string[] = [];
async function fixture(maxCharacters = 100) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vonvon-personality-files-')));
  directories.push(root);
  return { root, files: createPersonalityFiles(root, { maxCharacters, execution: 'daemon-exclusive' }) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function present(result: FileRead) {
  expect(result.kind).toBe('present');
  if (result.kind !== 'present') throw new Error('Expected real file snapshot');
  return result.snapshot;
}
function committed(result: FileWrite) {
  expect(result.kind).toBe('committed');
  if (result.kind !== 'committed') throw new Error('Expected committed file');
  return result.snapshot;
}
const soul: PersonalityFile = { kind: 'bot-soul' };
const publicMemory: PersonalityFile = { kind: 'public-memory' };

describe('personality files: actual content and commit facts', () => {
  it('distinguishes absent, empty and unreadable UTF-8 without leaking content or paths', async () => {
    const { root, files } = await fixture();
    expect(await files.read(soul)).toEqual({ kind: 'missing', file: 'SOUL.md' });
    const empty = committed(await files.write(soul, ''));
    expect(present(await files.read(soul))).toEqual(empty);
    expect(empty).toMatchObject({ content: '', characters: 0, bytes: 0, needsOrganization: false });
    await writeFile(join(root, 'SOUL.md'), Buffer.from([0xff, 0xfe]));
    const bad = await files.read(soul);
    expect(bad).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'invalid-utf8' });
    expect(JSON.stringify(bad)).not.toContain(root);
  });

  it('requires an explicit execution context and permits a trusted full-mode caller without adding a sandbox', async () => {
    const { root } = await fixture();
    expect(() => Reflect.apply(createPersonalityFiles, undefined, [root, { maxCharacters: 100 }])).toThrow('Invalid personality file policy');
    const full = createPersonalityFiles(root, { maxCharacters: 100, execution: 'full' });
    expect(committed(await full.write(soul, 'FULL_CALLER')).content).toBe('FULL_CALLER');
  });

  it('atomically publishes exact bytes, returns only committed versions and leaves no temporary file', async () => {
    const { root, files } = await fixture();
    const first = committed(await files.write(publicMemory, 'FIRST'));
    const second = committed(await files.write(publicMemory, '第二版🙂'));
    expect(second.version).not.toBe(first.version);
    expect(present(await files.read(publicMemory))).toEqual(second);
    expect(await readFile(join(root, 'memory/shared.md'), 'utf8')).toBe('第二版🙂');
    expect(await readdir(join(root, 'memory'))).toEqual(['shared.md']);
    expect((await lstat(join(root, 'memory/shared.md'))).mode & 0o777).toBe(0o600);
  });

  it('counts Unicode code points rather than UTF-8 bytes and rejects a longer write without changing the old version', async () => {
    const { root, files } = await fixture(3);
    const old = committed(await files.write(soul, '中🙂a'));
    expect(old).toMatchObject({ characters: 3, bytes: 8, needsOrganization: false });
    expect(await files.write(soul, '中🙂ab')).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'too-many-characters' });
    expect(present(await files.read(soul))).toEqual(old);
    expect((await readdir(root)).sort()).toEqual(['SOUL.md', 'daemon-staging']);
  });

  it('fully reads an already stored over-limit version and marks it for organization', async () => {
    const { root, files } = await fixture(2);
    const content = '既有合并内容🙂';
    await writeFile(join(root, 'SOUL.md'), content);
    const current = present(await files.read(soul));
    expect(current).toMatchObject({ content, characters: [...content].length, bytes: Buffer.byteLength(content), needsOrganization: true });
  });

  it('content versions stay stable on reread and detect content changes even at identical mtime', async () => {
    const { root, files } = await fixture();
    const file = join(root, 'SOUL.md');
    await writeFile(file, 'AAAA');
    const time = new Date('2025-01-01T00:00:00Z');
    await utimes(file, time, time);
    const old = present(await files.read(soul));
    expect(present(await files.read(soul)).version).toBe(old.version);
    await writeFile(file, 'BBBB');
    await utimes(file, time, time);
    expect(present(await files.read(soul)).version).not.toBe(old.version);
  });

  it('rejects invalid UTF-16 writes and preserves the valid committed content', async () => {
    const { files } = await fixture();
    const old = committed(await files.write(soul, 'VALID'));
    expect(await files.write(soul, '\ud800')).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'invalid-utf8' });
    expect(present(await files.read(soul))).toEqual(old);
  });

  it('preserves a UTF-8 BOM as part of the actual content and version', async () => {
    const { files } = await fixture();
    const write = committed(await files.write(soul, '\ufeffFULL_CONTENT'));
    expect(present(await files.read(soul))).toEqual(write);
    expect(write.content.startsWith('\ufeff')).toBe(true);
  });

  it('keeps every allowed target in its documented bot directory', async () => {
    const { root, files } = await fixture();
    const targets: [PersonalityFile, string][] = [
      [soul, 'SOUL.md'], [{ kind: 'bot-agents' }, 'AGENTS.md'], [publicMemory, 'memory/shared.md'],
      [{ kind: 'group-soul', chatId: 'group_a' }, 'groups/group_a/SOUL.md'],
      [{ kind: 'group-memory', chatId: 'group_a' }, 'groups/group_a/memory/group.md'],
      [{ kind: 'dm-memory', personId: 'person_a' }, 'memory/dm/person_a/dm.md'],
    ];
    for (const [target, relative] of targets) {
      const result = committed(await files.write(target, relative));
      expect(result.file).toBe(relative);
      expect(await readFile(join(root, relative), 'utf8')).toBe(relative);
    }
  });

  it.skipIf(process.getuid?.() === 0)('reports a real filesystem write failure without advancing the old committed snapshot', async () => {
    const { root, files } = await fixture();
    const old = committed(await files.write(soul, 'VALID_OLD_CONTENT'));
    await chmod(root, 0o500);
    try {
      const failed = await files.write(soul, 'NEW_CONTENT');
      expect(failed).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'io' });
      expect(present(await files.read(soul))).toEqual(old);
      expect(await readFile(join(root, 'SOUL.md'), 'utf8')).toBe('VALID_OLD_CONTENT');
      expect((await readdir(root)).sort()).toEqual(['SOUL.md', 'daemon-staging']);
    } finally { await chmod(root, 0o700); }
  });
});

describe('personality files: real unsafe filesystem objects', () => {
  it('never commits through an agent-writable group-memory parent replaced just before real rename', async () => {
    const { root, files } = await fixture();
    const outside = await fixture();
    const target: PersonalityFile = { kind: 'group-memory', chatId: 'fake_group' };
    committed(await files.write(target, 'OLD_GROUP_MEMORY'));
    await writeFile(join(outside.root, 'group.md'), 'OUTSIDE_KEEP');
    const memory = join(root, 'groups/fake_group/memory');
    let callbackReached = false;
    const attacked = createPersonalityFiles(root, { maxCharacters: 100, execution: { kind: 'restricted', backend: 'codex' } }, { commitRename: async (temporary, destination) => {
      callbackReached = true;
      if (typeof temporary !== 'string') throw new Error('Expected temporary filename');
      await rename(memory, `${memory}-original`);
      await symlink(outside.root, memory);
      // The agent controls its memory directory, including a file with the same temporary basename.
      await writeFile(join(outside.root, basename(temporary)), 'FOREIGN');
      await rename(temporary, destination);
    } });
    const result = await attacked.write(target, 'INTENDED');
    expect.soft(result).toMatchObject({ kind: 'error', reason: 'boundary-not-established' });
    expect.soft(callbackReached, 'unestablished restricted writer must not reach the filesystem commit hook').toBe(false);
    // Capture all actual bytes before assertions so one failure cannot hide another fact.
    const outsideBytes = await readFile(join(outside.root, 'group.md'), 'utf8');
    const originalPath = await lstat(`${memory}-original`).then(() => `${memory}-original/group.md`, () => `${memory}/group.md`);
    const originalBytes = await readFile(originalPath, 'utf8');
    expect.soft(outsideBytes, 'external target must remain unchanged').toBe('OUTSIDE_KEEP');
    if (result.kind === 'committed') {
      expect.soft({ kind: result.kind, published: originalBytes, reported: result.snapshot.content }, 'successful anchored commit facts').toEqual({ kind: 'committed', published: 'INTENDED', reported: 'INTENDED' });
      expect.soft(result.snapshot.content, 'committed content must match the actual anchored target').toBe(originalBytes);
      expect.soft(result.snapshot.version, 'committed version must hash the actual anchored target').toBe(createHash('sha256').update(originalBytes).digest('hex'));
    } else {
      expect.soft(originalBytes, 'a refused commit must preserve the old target').toBe('OLD_GROUP_MEMORY');
    }
  });

  it('never reports intended bytes committed when an agent replaces the group-memory temporary object', async () => {
    const { root, files } = await fixture();
    const target: PersonalityFile = { kind: 'group-memory', chatId: 'fake_group' };
    committed(await files.write(target, 'OLD_GROUP_MEMORY'));
    let callbackReached = false;
    const attacked = createPersonalityFiles(root, { maxCharacters: 100, execution: { kind: 'restricted', backend: 'codex' } }, { commitRename: async (temporary, destination) => {
      callbackReached = true;
      await rm(temporary);
      await writeFile(temporary, 'FOREIGN');
      await rename(temporary, destination);
    } });
    const result = await attacked.write(target, 'INTENDED');
    expect.soft(result).toMatchObject({ kind: 'error', reason: 'boundary-not-established' });
    expect.soft(callbackReached, 'unestablished restricted writer must not reach the filesystem commit hook').toBe(false);
    const actualBytes = await readFile(join(root, 'groups/fake_group/memory/group.md'), 'utf8');
    if (result.kind === 'committed') {
      expect.soft({ kind: result.kind, published: actualBytes, reported: result.snapshot.content }, 'successful commit must never report intended bytes for a foreign replacement').toEqual({ kind: 'committed', published: 'INTENDED', reported: 'INTENDED' });
      expect.soft(result.snapshot.content, 'committed content must match actual final bytes').toBe(actualBytes);
      expect.soft(result.snapshot.version, 'committed version must hash actual final bytes').toBe(createHash('sha256').update(actualBytes).digest('hex'));
    } else {
      expect.soft(actualBytes, 'a refused commit must preserve the old target').toBe('OLD_GROUP_MEMORY');
    }
  });

  it('keeps the actual source in daemon staging when an old memory-local temporary name is replaced', async () => {
    const { root, files } = await fixture();
    const target: PersonalityFile = { kind: 'group-memory', chatId: 'fake_group' };
    committed(await files.write(target, 'OLD_GROUP_MEMORY'));
    const memory = join(root, 'groups/fake_group/memory');
    let oldTemporary = '';
    const writer = createPersonalityFiles(root, { maxCharacters: 100, execution: 'daemon-exclusive' }, { commitRename: async (temporary, destination) => {
      if (typeof temporary !== 'string') throw new Error('Expected actual stage path');
      expect(temporary.startsWith(join(root, 'daemon-staging') + '/')).toBe(true);
      oldTemporary = join(memory, basename(temporary));
      await writeFile(oldTemporary, 'FOREIGN');
      await rename(temporary, destination);
    } });
    const result = committed(await writer.write(target, 'INTENDED'));
    expect(await readFile(join(memory, 'group.md'), 'utf8')).toBe(result.content);
    expect(result.content).toBe('INTENDED');
    expect(await readFile(oldTemporary, 'utf8')).toBe('FOREIGN');
    expect(await readdir(join(root, 'daemon-staging'))).toEqual([]);
  });

  it('documents that a malicious full same-uid stage-name replacement violates the trusted-stage precondition', async () => {
    const { root, files } = await fixture();
    const target: PersonalityFile = { kind: 'group-memory', chatId: 'fake_group' };
    committed(await files.write(target, 'OLD'));
    const full = createPersonalityFiles(root, { maxCharacters: 100, execution: 'full' }, { commitRename: async (temporary, destination) => {
      await rm(temporary);
      await writeFile(temporary, 'FOREIGN');
      await rename(temporary, destination);
    } });
    const result = await full.write(target, 'INTENDED');
    const actual = await readFile(join(root, 'groups/fake_group/memory/group.md'), 'utf8');
    expect(result).toMatchObject({ kind: 'committed', snapshot: { content: 'INTENDED' } });
    // Full has no same-uid adversary boundary: this mismatch is a capability-limit control, not a safety pass.
    expect(actual).toBe('FOREIGN');
    if (result.kind === 'committed') expect(result.snapshot.version).not.toBe(createHash('sha256').update(actual).digest('hex'));
  });

  it('documents the same full-mode limit for in-place malicious stage modification', async () => {
    const { root, files } = await fixture();
    committed(await files.write(soul, 'OLD'));
    const full = createPersonalityFiles(root, { maxCharacters: 100, execution: 'full' }, { commitRename: async (temporary, destination) => {
      await writeFile(temporary, 'FOREIGN');
      await rename(temporary, destination);
    } });
    expect(await full.write(soul, 'INTENDED')).toMatchObject({ kind: 'committed', snapshot: { content: 'INTENDED' } });
    expect(await readFile(join(root, 'SOUL.md'), 'utf8')).toBe('FOREIGN');
  });

  it.each(['in-place', 'atomic-replace'])('keeps the successful commit fact when a legitimate later writer uses %s', async laterKind => {
    const { root, files } = await fixture();
    committed(await files.write(soul, 'OLD'));
    const writer = createPersonalityFiles(root, { maxCharacters: 100, execution: 'daemon-exclusive' }, { commitRename: async (temporary, destination) => {
      await rename(temporary, destination);
      if (laterKind === 'in-place') await writeFile(destination, 'LATER');
      else {
        const later = join(root, 'daemon-staging/later.tmp');
        await writeFile(later, 'LATER');
        await rename(later, destination);
      }
    } });
    const submitted = committed(await writer.write(soul, 'INTENDED'));
    const later = present(await files.read(soul));
    expect(submitted.content).toBe('INTENDED');
    expect(later.content).toBe('LATER');
    expect(later.version).not.toBe(submitted.version);
  });

  it('does not let later mutation of constructor options enable an existing restricted writer', async () => {
    const { root, files } = await fixture();
    committed(await files.write(soul, 'OLD'));
    const policy: Parameters<typeof createPersonalityFiles>[1] = { maxCharacters: 100, execution: { kind: 'restricted', backend: 'codex' } };
    const restricted = createPersonalityFiles(root, policy);
    policy.execution = 'full';
    expect(await restricted.write(soul, 'NEW')).toMatchObject({ kind: 'error', reason: 'boundary-not-established' });
    expect(present(await files.read(soul)).content).toBe('OLD');
    expect(committed(await createPersonalityFiles(root, policy).write(soul, 'NEW')).content).toBe('NEW');
  });

  it.each(['codex', 'claude'])('refuses a restricted %s writer without a real consumed boundary while keeping reads available', async backend => {
    const { root, files } = await fixture();
    const old = committed(await files.write(soul, 'OLD'));
    const restricted = createPersonalityFiles(root, { maxCharacters: 100, execution: { kind: 'restricted', backend: backend === 'codex' ? 'codex' : 'claude' } });
    expect(await restricted.write(soul, 'NEW')).toMatchObject({ kind: 'error', reason: 'boundary-not-established' });
    expect(present(await restricted.read(soul))).toEqual(old);
  });

  it('refuses a linked staging directory without touching its target or the old committed file', async () => {
    const { root, files } = await fixture();
    const outside = await fixture();
    const old = committed(await files.write(soul, 'OLD'));
    await rename(join(root, 'daemon-staging'), join(root, 'stage-original'));
    await symlink(outside.root, join(root, 'daemon-staging'));
    expect(await files.write(soul, 'NEW')).toMatchObject({ kind: 'error', reason: 'unsafe-file' });
    expect(present(await files.read(soul))).toEqual(old);
    expect(await readdir(outside.root)).toEqual([]);
  });

  it('rejects a linked ancestor above the bot root before adopting another bot', async () => {
    const holder = await fixture();
    const other = await fixture();
    const otherBot = join(other.root, 'bot');
    await mkdir(otherBot);
    await writeFile(join(otherBot, 'SOUL.md'), 'OTHER_BOT_PRIVATE');
    const alias = join(holder.root, 'linked-parent');
    await symlink(other.root, alias);
    const files = createPersonalityFiles(join(alias, 'bot'), { maxCharacters: 100, execution: 'daemon-exclusive' });
    expect(await files.read(soul)).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'unsafe-file' });
    expect(await files.write(soul, 'OVERWRITE')).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'unsafe-file' });
    expect(await readFile(join(otherBot, 'SOUL.md'), 'utf8')).toBe('OTHER_BOT_PRIVATE');
    expect(await readdir(otherBot)).toEqual(['SOUL.md']);
  });

  it('keeps the old committed file and cleans its temporary after a post-write rename failure', async () => {
    const { root, files } = await fixture();
    const old = committed(await files.write(publicMemory, 'OLD_COMMITTED'));
    let attempted = false;
    const failing = createPersonalityFiles(root, { maxCharacters: 100, execution: 'daemon-exclusive' }, { commitRename: async (temporary, destination) => {
      attempted = true;
      expect(await readFile(temporary, 'utf8')).toBe('NEW_UNCOMMITTED');
      expect(await readFile(destination, 'utf8')).toBe('OLD_COMMITTED');
      throw Object.assign(new Error('controlled rename failure'), { code: 'EIO' });
    } });
    expect(await failing.write(publicMemory, 'NEW_UNCOMMITTED')).toEqual({ kind: 'error', file: 'memory/shared.md', reason: 'io' });
    expect(attempted).toBe(true);
    expect(present(await files.read(publicMemory))).toEqual(old);
    expect(await readdir(join(root, 'memory'))).toEqual(['shared.md']);
  });

  it('does not follow a swapped parent during failed-commit cleanup', async () => {
    const { root, files } = await fixture();
    const outside = await fixture();
    committed(await files.write(publicMemory, 'OLD_COMMITTED'));
    let sentinel = '';
    const failing = createPersonalityFiles(root, { maxCharacters: 100, execution: 'daemon-exclusive' }, { commitRename: async temporary => {
      if (typeof temporary !== 'string') throw new Error('Expected product temporary path');
      sentinel = basename(temporary);
      expect(await readFile(temporary, 'utf8')).toBe('NEW_UNCOMMITTED');
      await writeFile(join(outside.root, sentinel), 'DO_NOT_DELETE');
      await rename(join(root, 'memory'), join(root, 'memory-original'));
      await symlink(outside.root, join(root, 'memory'));
      throw Object.assign(new Error('parent changed during commit'), { code: 'EIO' });
    } });
    expect(await failing.write(publicMemory, 'NEW_UNCOMMITTED')).toEqual({ kind: 'error', file: 'memory/shared.md', reason: 'io' });
    expect(sentinel).not.toBe('');
    expect(await readFile(join(outside.root, sentinel), 'utf8')).toBe('DO_NOT_DELETE');
    expect(await readFile(join(root, 'memory-original/shared.md'), 'utf8')).toBe('OLD_COMMITTED');
    expect(await readdir(join(root, 'daemon-staging'))).toEqual([]);
    expect(await files.read(publicMemory)).toMatchObject({ kind: 'error', reason: 'unsafe-file' });
  });

  it('distinguishes an unavailable bot root from a missing allowed file', async () => {
    const { root } = await fixture();
    const files = createPersonalityFiles(join(root, 'absent-bot'), { maxCharacters: 100, execution: 'daemon-exclusive' });
    expect(await files.read(soul)).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'io' });
    expect(await files.write(soul, 'NEW')).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'io' });
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses a symlink used as the bot root itself', async () => {
    const { root } = await fixture();
    const outside = await fixture();
    const alias = join(root, 'bot-alias');
    await symlink(outside.root, alias);
    const files = createPersonalityFiles(alias, { maxCharacters: 100, execution: 'daemon-exclusive' });
    expect(await files.read(soul)).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'unsafe-file' });
    expect(await files.write(soul, 'NEW')).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'unsafe-file' });
    expect(await readdir(outside.root)).toEqual([]);
  });

  it.each(['\n', '\r', '\u2028', '\u2029'])('rejects all trailing line separators in routed group and DM identifiers %j', async suffix => {
    const { root, files } = await fixture();
    const targets: PersonalityFile[] = [{ kind: 'group-memory', chatId: `fake_group${suffix}` }, { kind: 'dm-memory', personId: `fake_person${suffix}` }];
    for (const target of targets) {
      expect(await files.read(target)).toMatchObject({ kind: 'error', reason: 'invalid-target' });
      expect(await files.write(target, 'NEW')).toMatchObject({ kind: 'error', reason: 'invalid-target' });
    }
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['../other', '/absolute', 'a/b', '.', '', 'a\u0000b'])('rejects an unsafe routed identifier %j before accessing the filesystem', async personId => {
    const { root, files } = await fixture();
    const target: PersonalityFile = { kind: 'dm-memory', personId };
    expect(await files.read(target)).toEqual({ kind: 'error', file: '(invalid)', reason: 'invalid-target' });
    expect(await files.write(target, 'SECRET_MARKER')).toEqual({ kind: 'error', file: '(invalid)', reason: 'invalid-target' });
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses leaf symlinks for both read and write while preserving the external file', async () => {
    const { root, files } = await fixture();
    const outside = await fixture();
    const other = join(outside.root, 'private.md');
    await writeFile(other, 'OUTSIDE_PRIVATE');
    await symlink(other, join(root, 'SOUL.md'));
    expect(await files.read(soul)).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'unsafe-file' });
    const result = await files.write(soul, 'NEW');
    expect(result).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'unsafe-file' });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain('OUTSIDE_PRIVATE');
    expect(await readFile(other, 'utf8')).toBe('OUTSIDE_PRIVATE');
    expect((await lstat(join(root, 'SOUL.md'))).isSymbolicLink()).toBe(true);
  });

  it('refuses an ancestor symlink without creating files through it', async () => {
    const { root, files } = await fixture();
    const outside = await fixture();
    await symlink(outside.root, join(root, 'memory'));
    expect(await files.read(publicMemory)).toEqual({ kind: 'error', file: 'memory/shared.md', reason: 'unsafe-file' });
    expect(await files.write(publicMemory, 'NEW')).toEqual({ kind: 'error', file: 'memory/shared.md', reason: 'unsafe-file' });
    expect(await readdir(outside.root)).toEqual([]);
  });

  it('rejects hardlinked content and cannot overwrite either link', async () => {
    const { root, files } = await fixture();
    const outside = await fixture();
    const other = join(outside.root, 'original.md');
    await writeFile(other, 'HARDLINK_PRIVATE');
    await link(other, join(root, 'SOUL.md'));
    expect(await files.read(soul)).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'unsafe-file' });
    expect(await files.write(soul, 'NEW')).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'unsafe-file' });
    expect(await readFile(other, 'utf8')).toBe('HARDLINK_PRIVATE');
    expect(await readFile(join(root, 'SOUL.md'), 'utf8')).toBe('HARDLINK_PRIVATE');
  });

  it('rejects directories and a regular-file ancestor', async () => {
    const { root, files } = await fixture();
    await mkdir(join(root, 'SOUL.md'));
    expect(await files.read(soul)).toMatchObject({ kind: 'error', reason: 'unsafe-file' });
    expect(await files.write(soul, 'NEW')).toMatchObject({ kind: 'error', reason: 'unsafe-file' });
    await writeFile(join(root, 'memory'), 'BLOCKED_PARENT');
    expect(await files.read(publicMemory)).toMatchObject({ kind: 'error', reason: 'unsafe-file' });
    expect(await files.write(publicMemory, 'NEW')).toMatchObject({ kind: 'error' });
    expect(await readFile(join(root, 'memory'), 'utf8')).toBe('BLOCKED_PARENT');
  });

  it('rejects FIFO without waiting for a writer', async () => {
    const { root, files } = await fixture();
    execFileSync('mkfifo', [join(root, 'SOUL.md')]);
    expect(await files.read(soul)).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'unsafe-file' });
    expect(await files.write(soul, 'NEW')).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'unsafe-file' });
  }, 1000);

  it('enforces the separate safety byte boundary without treating it as the character limit', async () => {
    const { root, files } = await fixture(PERSONALITY_SAFETY_BYTES + 1);
    const exact = 'x'.repeat(PERSONALITY_SAFETY_BYTES);
    expect(committed(await files.write(soul, exact)).bytes).toBe(PERSONALITY_SAFETY_BYTES);
    expect(await files.write(soul, `${exact}x`)).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'too-large' });
    expect(present(await files.read(soul)).content).toBe(exact);
    await writeFile(join(root, 'SOUL.md'), `${exact}x`);
    expect(await files.read(soul)).toEqual({ kind: 'error', file: 'SOUL.md', reason: 'too-large' });
  });

  it('rejects a replaced pinned bot root and does not publish into the replacement', async () => {
    const { root, files } = await fixture();
    committed(await files.write(soul, 'ORIGINAL'));
    const moved = `${root}-old`;
    await rename(root, moved);
    directories.push(moved);
    await mkdir(root);
    expect(await files.read(soul)).toMatchObject({ kind: 'error', reason: 'unsafe-file' });
    expect(await files.write(soul, 'NEW')).toMatchObject({ kind: 'error', reason: 'unsafe-file' });
    expect(await readdir(root)).toEqual([]);
    expect(await readFile(join(moved, 'SOUL.md'), 'utf8')).toBe('ORIGINAL');
  });
});
