import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { determineScope, parseChangedPaths } from './ci-scope.mjs';

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-scope-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const put = (path, contents = path) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  };
  const commit = () => {
    git('add', '-A');
    git('-c', 'user.name=CI', '-c', 'user.email=ci@example.test', 'commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q', '--initial-branch=main');
    put('README.md', 'base\n');
    const base = commit();
    run({ dir, git, put, commit, base });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pr = (base, head) => ({ pull_request: { base: { sha: base }, head: { sha: head } } });

test('root and nested Markdown documentation is lightweight', () => fixture(({ dir, put, commit, base }) => {
  put('README.md', 'changed\n');
  put('AGENTS.md');
  put('CLAUDE.md');
  put('docs/plan.md');
  put('docs/nested/deep.md');
  const head = commit();
  const result = determineScope('pull_request', pr(base, head), dir);
  assert.equal(result.scope, 'docs');
  assert.deepEqual(result.paths, ['AGENTS.md', 'CLAUDE.md', 'README.md', 'docs/nested/deep.md', 'docs/plan.md']);
  assert.equal(result.base, base);
  assert.equal(result.head, head);
}));

test('code, config, Markdown outside docs, and mixed changes require full', () => fixture(({ dir, put, commit, base }) => {
  let before = base;
  for (const path of ['packages/protocol/src/index.ts', 'packages/protocol/test/index.test.ts',
    'packages/ui/README.md', 'package.json', 'package-lock.json', '.github/workflows/ci.yml',
    'scripts/check.js', 'docs/notes.txt', 'unknown']) {
    put(path);
    const head = commit();
    assert.equal(determineScope('pull_request', pr(before, head), dir).scope, 'full', path);
    before = head;
  }
}));

test('PR uses the cumulative merge-base diff, not the latest commit or merge checkout', () => fixture(({ dir, git, put, commit, base }) => {
  git('checkout', '-qb', 'feature');
  put('packages/protocol/src/index.ts');
  commit();
  put('docs/latest.md');
  const head = commit();
  git('checkout', '-q', 'main');
  put('docs/base.md');
  const currentBase = commit();
  const result = determineScope('pull_request', pr(currentBase, head), dir);
  assert.equal(result.base, base);
  assert.equal(result.scope, 'full');
  assert.ok(result.paths.includes('packages/protocol/src/index.ts'));
}));

test('push includes every commit from before through after', () => fixture(({ dir, put, commit, base }) => {
  put('packages/protocol/index.ts');
  commit();
  put('docs/latest.md');
  const after = commit();
  const result = determineScope('push', { before: base, after }, dir);
  assert.equal(result.scope, 'full');
  assert.ok(result.paths.includes('packages/protocol/index.ts'));
}));

test('deletions and cross-class renames retain their changed paths', () => fixture(({ dir, git, put, commit }) => {
  put('docs/deleted.md');
  put('outside.md');
  const base = commit();
  git('rm', 'docs/deleted.md');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  git('mv', 'outside.md', 'docs/moved.md');
  const head = commit();
  const result = determineScope('push', { before: base, after: head }, dir);
  assert.equal(result.scope, 'full');
  assert.deepEqual(result.paths, ['docs/deleted.md', 'docs/moved.md', 'outside.md']);
}));

test('NUL output preserves spaces, newlines, and non-ASCII filenames', () => fixture(({ dir, put, commit, base }) => {
  put('docs/空 格\nline.md');
  const head = commit();
  const result = determineScope('push', { before: base, after: head }, dir);
  assert.equal(result.scope, 'docs');
  assert.deepEqual(result.paths, ['docs/空 格\nline.md']);
}));

test('more than 3000 documentation paths followed by code never grant docs', () => fixture(({ dir, put, commit, base }) => {
  for (let i = 0; i < 3001; i++) put(`docs/${String(i).padStart(4, '0')}.md`);
  put('packages/protocol/src/zz.ts');
  const head = commit();
  const result = determineScope('push', { before: base, after: head }, dir);
  assert.equal(result.scope, 'full');
  assert.ok(result.paths.includes('packages/protocol/src/zz.ts'));
}));

test('empty, unavailable, invalid, manual, and unknown events require full', () => fixture(({ dir, git, base }) => {
  assert.equal(determineScope('push', { before: base, after: base }, dir).scope, 'full');
  assert.equal(determineScope('push', { before: '0'.repeat(40), after: base }, dir).scope, 'full');
  assert.equal(determineScope('push', { before: 'bad', after: base }, dir).scope, 'full');
  assert.equal(determineScope('push', { before: 'f'.repeat(40), after: base }, dir).scope, 'full');
  assert.equal(determineScope('pull_request', {}, dir).scope, 'full');
  assert.equal(determineScope('workflow_dispatch', {}, dir).scope, 'full');
  assert.equal(determineScope('issues', {}, dir).scope, 'full');
  assert.equal(determineScope('push', { before: base, after: git('rev-parse', 'HEAD') }, '/missing/git/dir').scope, 'full');
  assert.equal(parseChangedPaths(Buffer.from('docs/a.md\0')).length, 1);
  assert.equal(parseChangedPaths(Buffer.from('docs/a.md')), null);
  assert.equal(parseChangedPaths(Buffer.from(Array.from({ length: 4097 }, (_, i) => `docs/${i}.md\0`).join(''))), null);
  assert.throws(() => parseChangedPaths(Buffer.from([0xff, 0])), TypeError);
}));

test('Git whitespace check rejects actual documentation violations', () => fixture(({ dir, git, put, commit, base }) => {
  put('docs/space.md', 'bad trailing space \n');
  const head = commit();
  assert.equal(determineScope('push', { before: base, after: head }, dir).scope, 'docs');
  assert.throws(() => git('diff', '--check', base, head));
}));
