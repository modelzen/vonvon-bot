import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
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
  const informational = invoke('pull_request', {
    action: 'labeled', label: { name: 'other' },
    pull_request: { ...event.pull_request, labels: [{ name: 'frozen' }] },
  });
  assert.equal(informational.result.scope, 'full');
  assert.equal(informational.result.full, false);
  assert.match(informational.output, /full=false\n/);
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


const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
const jobs = Object.fromEntries(['linux', 'windows', 'macos'].map(name =>
  [name, workflow.split(new RegExp(`^  ${name}:\n`, 'm'))[1]?.split(/^  \w+:\n/m)[0]]));

function expression(source, context) {
  return runInNewContext(source, {
    ...context,
    format: (pattern, ...values) => pattern.replace(/\{(\d+)\}/g, (_, i) => values[Number(i)]),
  }, { timeout: 100 });
}

function rendered(source, context) {
  return source.replace(/\$\{\{(.*?)\}\}/g, (_, value) => String(expression(value, context)));
}

function workflowDecision(eventName, event, scope = 'full') {
  const full = scope === 'full' && isFullRunEligible(eventName, event);
  const context = {
    github: { workflow: 'CI', event_name: eventName, event, run_id: 123, sha: 'd'.repeat(40), repository: 'owner/repo' },
    steps: { scope: { outputs: { scope, full: String(full) } } },
    needs: { linux: { outputs: { full: String(full) } } },
    vars: { ENABLE_SELF_HOSTED_MACOS_CI: 'true' },
  };
  const names = Object.fromEntries(Object.entries(jobs).map(([id, job]) =>
    [id, rendered(job.match(/^    name: (.+)$/m)?.[1] ?? id, context)]));
  const guard = jobs.linux.match(/- name: Require frozen head for full scope\n        if: (.+)/)[1];
  const expensive = [...jobs.linux.matchAll(/        if: (steps\.scope\.outputs\.full == 'true')/g)]
    .map(match => expression(match[1], context));
  return {
    names,
    group: rendered(workflow.match(/^  group: (.+)$/m)[1], context),
    cancel: rendered(workflow.match(/^  cancel-in-progress: (.+)$/m)[1], context) === 'true',
    full,
    rejects: expression(guard, context),
    expensive,
    windows: expression(jobs.windows.match(/^    if: (.+)$/m)[1], context),
    macos: expression(jobs.macos.match(/    if: >-\n([\s\S]*?)\n    runs-on:/)[1].trim(), context),
    sources: Object.values(jobs).map(job => rendered(job.match(/          ref: (.+)/)[1], context)),
  };
}

const routingEvent = (action, { frozen = true, label = 'frozen', head = 'b'.repeat(40), fork = false } = {}) => ({
  action, label: { name: label }, pull_request: {
    ...pr('a'.repeat(40), head).pull_request,
    number: 217,
    head: { sha: head, repo: { full_name: fork ? 'fork/repo' : 'owner/repo' } },
    labels: frozen ? [{ name: 'frozen' }] : [],
  },
});

const formalNames = { linux: 'linux', windows: 'Windows checks', macos: 'macOS checks' };
const informationalNames = {
  linux: 'informational linux', windows: 'informational Windows checks', macos: 'informational macOS checks',
};

test('actual workflow isolates unrelated labels before, during, and after formal evidence', () => {
  const formal = workflowDecision('pull_request', routingEvent('labeled'));
  assert.deepEqual(formal.names, formalNames);
  assert.equal(formal.group, 'CI-pr-217');
  assert.equal(formal.full, true);
  assert.equal(formal.rejects, false);
  assert.equal(formal.windows, true);
  assert.equal(formal.macos, true);
  for (const status of ['pending', 'in_progress', 'success']) {
    const info = workflowDecision('pull_request', routingEvent('labeled', { label: 'in-progress' }));
    assert.deepEqual(info.names, informationalNames, status);
    assert.equal(info.group, 'CI-pr-217-informational', status);
    assert.equal(info.full, false);
    assert.equal(info.rejects, false);
    assert.equal(info.windows, false);
    assert.equal(info.macos, false);
    assert.equal(info.expensive.length, 6);
    assert.ok(info.expensive.every(value => value === false));
    assert.equal(info.cancel && info.group === formal.group, false, `cannot cancel ${status}`);
    const evidence = new Map(Object.values(formal.names).map(name => [name, status]));
    for (const [platform, name] of Object.entries(info.names)) evidence.set(name, platform === 'linux' ? 'success' : 'skipped');
    for (const name of Object.values(formalNames)) assert.equal(evidence.get(name), status);
  }
  const beforeFreeze = workflowDecision('pull_request', routingEvent('labeled', { frozen: false, label: 'other' }));
  assert.deepEqual(beforeFreeze.names, informationalNames);
  assert.equal(beforeFreeze.group, 'CI-pr-217-informational');
  assert.equal(beforeFreeze.rejects, false);
});

test('actual workflow preserves formal gates, source heads, docs, dispatch, and platform trust', () => {
  for (const action of ['opened', 'synchronize', 'reopened']) {
    const unfrozen = workflowDecision('pull_request', routingEvent(action, { frozen: false }));
    assert.deepEqual(unfrozen.names, formalNames);
    assert.equal(unfrozen.group, 'CI-pr-217');
    assert.equal(unfrozen.rejects, true);
    assert.ok(unfrozen.expensive.every(value => value === false));
    assert.equal(unfrozen.windows, false);
    assert.equal(unfrozen.macos, false);
    const frozen = workflowDecision('pull_request', routingEvent(action, { head: 'c'.repeat(40) }));
    assert.deepEqual(frozen.names, formalNames);
    assert.equal(frozen.group, 'CI-pr-217');
    assert.equal(frozen.full, true);
    assert.equal(frozen.rejects, false);
    assert.deepEqual(frozen.sources, Array(3).fill('c'.repeat(40)));
  }
  for (const action of ['opened', 'labeled', 'synchronize', 'reopened']) {
    const docs = workflowDecision('pull_request', routingEvent(action), 'docs');
    assert.deepEqual(docs.names, formalNames);
    assert.equal(docs.full, false);
    assert.equal(docs.rejects, false);
    assert.equal(docs.windows, false);
    assert.equal(docs.macos, false);
  }
  const manual = workflowDecision('workflow_dispatch', { pull_request: { head: {} } });
  assert.deepEqual(manual.names, formalNames);
  assert.equal(manual.group, 'CI-workflow_dispatch-123');
  assert.equal(manual.cancel, false);
  assert.equal(manual.full, true);
  assert.equal(manual.windows, true);
  assert.equal(manual.macos, true);
  assert.deepEqual(manual.sources, Array(3).fill('d'.repeat(40)));
  const fork = workflowDecision('pull_request', routingEvent('labeled', { fork: true }));
  assert.equal(fork.windows, true);
  assert.equal(fork.macos, false);
  for (const event of ['push', 'schedule']) assert.equal(isFullRunEligible(event, routingEvent('labeled')), false);
});


test('ambiguous PR merge bases cannot grant lightweight or full evidence', () => fixture(({ dir, git, base }) => {
  const tree = git('rev-parse', `${base}^{tree}`);
  const commit = (message, ...parents) => git('-c', 'user.name=CI', '-c', 'user.email=ci@example.test',
    'commit-tree', tree, '-m', message, ...parents.flatMap(parent => ['-p', parent]));
  const a = commit('a', base);
  const b = commit('b', base);
  const left = commit('left', a, b);
  const right = commit('right', b, a);
  assert.equal(git('merge-base', '--all', left, right).split('\n').length, 2);
  const result = determineScope('pull_request', pr(left, right), dir);
  assert.equal(result.scope, 'full');
  assert.equal(result.reason, 'ambiguous merge base');
  const eventPath = join(dir, '.git', 'ambiguous-event.json');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { ...pr(left, right).pull_request, labels: [{ name: 'frozen' }] } }));
  assert.throws(() => execFileSync(process.execPath, [new URL('./ci-scope.mjs', import.meta.url).pathname], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath },
  }), /CI scope collection failed/);
}));
