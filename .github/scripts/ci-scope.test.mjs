import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { determineScope, isFullRunEligible, parseChangedPaths } from './ci-scope.mjs';

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

test('only frozen PR events and explicit dispatch permit the full suite', () => {
  const plain = pr('a'.repeat(40), 'b'.repeat(40));
  const frozen = { pull_request: { ...plain.pull_request, labels: [{ name: 'other' }, { name: 'frozen' }] } };
  for (const eventName of ['opened', 'synchronize', 'reopened', 'labeled']) {
    assert.equal(isFullRunEligible('pull_request', { ...plain, action: eventName }), false, eventName);
    assert.equal(isFullRunEligible('pull_request', { ...frozen, action: eventName, label: { name: 'frozen' } }), true, eventName);
  }
  assert.equal(isFullRunEligible('pull_request', { ...frozen, action: 'labeled', label: { name: 'other' } }), false);
  assert.equal(isFullRunEligible('pull_request', { pull_request: { labels: [{ name: 'frozen-old' }] } }), false);
  assert.equal(isFullRunEligible('pull_request', { pull_request: { labels: 'frozen' } }), false);
  assert.equal(isFullRunEligible('pull_request', null), false);
  assert.equal(isFullRunEligible('workflow_dispatch', {}), true);
  assert.equal(isFullRunEligible('push', frozen), false);
  assert.equal(isFullRunEligible('issues', frozen), false);
});

test('event JSON drives full, deferred, docs, and unknown-path decisions', () => fixture(({ dir, put, commit, base }) => {
  const invoke = (eventName, event) => {
    const eventPath = join(dir, '.git', 'event.json');
    const outputPath = join(dir, '.git', 'output.txt');
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(outputPath, '');
    const stdout = execFileSync(process.execPath, [new URL('./ci-scope.mjs', import.meta.url).pathname], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
    });
    return { result: JSON.parse(stdout), output: readFileSync(outputPath, 'utf8') };
  };
  put('unknown-extension.asset');
  const head = commit();
  const event = pr(base, head);
  const deferred = invoke('pull_request', event);
  assert.equal(deferred.result.scope, 'full');
  assert.equal(deferred.result.full, false);
  assert.match(deferred.output, /full=false\n/);
  const frozen = invoke('pull_request', { pull_request: { ...event.pull_request, labels: [{ name: 'frozen' }] } });
  assert.equal(frozen.result.full, true);
  assert.match(frozen.output, /full=true\n/);
  const manual = invoke('workflow_dispatch', {});
  assert.equal(manual.result.full, true);
  put('docs/guide.md');
  const docsHead = commit();
  const docs = invoke('pull_request', { pull_request: { ...pr(head, docsHead).pull_request, labels: [{ name: 'frozen' }] } });
  assert.equal(docs.result.scope, 'docs');
  assert.equal(docs.result.full, false);
  assert.throws(() => invoke('pull_request', { pull_request: { ...pr('bad', docsHead).pull_request, labels: [{ name: 'frozen' }] } }),
    /CI scope collection failed/);
  const eventPath = join(dir, '.git', 'event.json');
  writeFileSync(eventPath, '{');
  assert.throws(() => execFileSync(process.execPath, [new URL('./ci-scope.mjs', import.meta.url).pathname], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: eventPath },
  }), /CI scope collection failed/);
}));

test('workflow gates every expensive step and platform on the frozen full decision', () => {
  const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  const linux = workflow.split(/^  linux:\n/m)[1]?.split(/^  windows:\n/m)[0];
  const windows = workflow.split(/^  windows:\n/m)[1]?.split(/^  macos:\n/m)[0];
  const macos = workflow.split(/^  macos:\n/m)[1];
  assert.ok(linux && windows && macos);
  assert.match(workflow, /types: \[opened, synchronize, reopened, labeled\]/);
  assert.doesNotMatch(workflow, /^  (?:push|schedule):/m);
  for (const name of ['Install dependencies', 'Build', 'Typecheck', 'Test', 'Lint']) {
    assert.match(linux, new RegExp(`      - name: ${name}\\n        if: steps\\.scope\\.outputs\\.full == 'true'\\n`), name);
  }
  assert.match(linux, /- uses: actions\/setup-node@v4\n        if: steps\.scope\.outputs\.full == 'true'/);
  assert.match(linux, /- name: Require frozen head for full scope\n        if: steps\.scope\.outputs\.scope == 'full' && steps\.scope\.outputs\.full != 'true'/);
  assert.match(windows, /    if: needs\.linux\.outputs\.full == 'true'/);
  assert.match(macos, /needs\.linux\.outputs\.full == 'true' &&/);
  for (const [platform, job] of Object.entries({ linux, windows, macos })) {
    assert.match(job, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/, platform);
    assert.match(job, /- name: Verify tested source/, platform);
    assert.match(job, /SOURCE_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/, platform);
    if (platform === 'windows') {
      assert.match(job, /git rev-parse HEAD\) -ne \$env:SOURCE_SHA/, platform);
    } else {
      assert.match(job, /run: test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/, platform);
    }
  }
});

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
