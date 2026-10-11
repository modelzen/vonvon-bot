import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ImportJournalReadError, readJournalJson } from '../src/import/bridge/journal';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; file: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-journal-'));
  roots.push(root);
  const source = join(root, 'source.json');
  await writeFile(source, '{"source":"untouched"}\n');
  return { root, file: join(root, 'private', 'journal.json'), source };
}

it('returns undefined for a missing journal', async () => {
  const { file } = await fixture();
  expect(await readJournalJson(file)).toBeUndefined();
});

it('returns nested JSON and primitives without claiming a schema', async () => {
  const { root, file, source } = await fixture();
  const sourceBytes = await readFile(source);
  await mkdir(join(root, 'private'));
  for (const value of [{ phase: 'caller-owned', nested: [1, true, null] }, [false, { count: 2 }], null, true, 42, 'text']) {
    await writeFile(file, JSON.stringify(value));
    expect(await readJournalJson(file)).toEqual(value);
  }
  expect(await readFile(source)).toEqual(sourceBytes);
});

it('rejects malformed, oversized, and invalid UTF-8 journals', async () => {
  const { root, file, source } = await fixture();
  const sourceBytes = await readFile(source);
  await mkdir(join(root, 'private'));
  for (const bytes of ['{', Buffer.alloc(1024 * 1024 + 1, 0x20), Buffer.from([0xff])]) {
    await writeFile(file, bytes);
    await expect(readJournalJson(file)).rejects.toBeInstanceOf(ImportJournalReadError);
  }
  expect(await readFile(source)).toEqual(sourceBytes);
});

it('rejects symlinked and non-file journals', async () => {
  const { root, file, source } = await fixture();
  const sourceBytes = await readFile(source);
  await mkdir(join(root, 'private'));
  await symlink(source, file);
  await expect(readJournalJson(file)).rejects.toBeInstanceOf(ImportJournalReadError);
  await rm(file);
  await mkdir(file);
  await expect(readJournalJson(file)).rejects.toBeInstanceOf(ImportJournalReadError);
  expect(await readFile(source)).toEqual(sourceBytes);
});
