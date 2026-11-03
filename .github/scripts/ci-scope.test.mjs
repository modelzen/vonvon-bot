import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { determineScope, isCollectionFailure, isDocsPath, isServerReleasePath, parseChangedPaths, planScope } from './ci-scope.mjs';

const allPackages = ['protocol', 'client', 'daemon', 'ui', 'desktop'];
const allPlatforms = ['linux', 'macos', 'windows'];
const sha = letter => letter.repeat(40);
const pr = (base = sha('a'), head = sha('b'), { target = 'dev', labels = [], draft = false } = {}) => ({
  pull_request: { base: { sha: base, ref: target }, head: { sha: head }, labels: labels.map(name => ({ name })), draft },
});
const plan = (paths, options = {}) => planScope({ eventName: 'pull_request', event: pr(undefined, undefined, options),
  paths, base: sha('a'), head: sha('b'), sourceSha: sha('b') });

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
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('only ordinary documentation gets the light plan, including draft PRs', () => {
  assert.equal(isDocsPath('README.md'), true);
  assert.equal(isDocsPath('docs/nested/guide.md'), true);
  for (const path of ['AGENTS.md', 'CLAUDE.md', '.claude/skills/a/SKILL.md', 'docs/logo.svg']) {
    assert.equal(isDocsPath(path), false, path);
    assert.equal(plan([path]).scope, 'full', path);
  }
  const docs = plan(['README.md', 'docs/nested/guide.md'], { draft: true });
  assert.deepEqual([docs.scope, docs.packages, docs.platforms, docs.ready], ['docs', [], [], true]);
  assert.equal(plan(['docs/x.md', 'packages/ui/src/index.ts']).scope, 'affected');
  assert.equal(plan(['packages/ui/README.md']).scope, 'affected');
  assert.deepEqual(plan(['docs/a.md'], { labels: ['ci:macos'] }).platforms, ['linux', 'macos']);
  assert.deepEqual(plan(['docs/a.md'], { labels: ['ci:windows'] }).packages, allPackages);
  assert.equal(plan(['docs/a.md'], { labels: ['ci:all'] }).scope, 'full');
});

test('UI, daemon and desktop map to consumers and safe platform sets', () => {
  assert.deepEqual(plan(['packages/ui/src/App.tsx']).packages, ['ui', 'desktop']);
  assert.deepEqual(plan(['packages/ui/src/App.tsx']).platforms, ['linux']);
  assert.deepEqual(plan(['packages/daemon/src/main.ts']).packages, ['daemon', 'desktop']);
  assert.deepEqual(plan(['packages/daemon/src/main.ts']).platforms, allPlatforms);
  assert.deepEqual(plan(['packages/desktop/src/main.ts']).packages, ['desktop']);
  assert.deepEqual(plan(['packages/desktop/src/main.ts']).platforms, allPlatforms);
  assert.deepEqual(plan(['packages/ui/src/a.ts', 'packages/daemon/src/a.ts']).packages, ['daemon', 'ui', 'desktop']);
});

test('platform tokens and labels add checks without shrinking automatic checks', () => {
  assert.deepEqual(plan(['packages/ui/src/shell.darwin.ts']).platforms, ['linux', 'macos']);
  assert.deepEqual(plan(['packages/ui/src/shell.windows.ts']).platforms, ['linux', 'windows']);
  assert.deepEqual(plan(['packages/ui/src/Native.swift']).platforms, ['linux', 'macos']);
  assert.deepEqual(plan(['packages/ui/scripts/install.ps1']).platforms, ['linux', 'windows']);
  assert.deepEqual(plan(['packages/ui/src/macos/shell.ts']).platforms, ['linux', 'macos']);
  assert.deepEqual(plan(['packages/ui/src/darwin/shell.ts']).platforms, ['linux', 'macos']);
  assert.deepEqual(plan(['packages/ui/src/windows/shell.ts']).platforms, ['linux', 'windows']);
  assert.deepEqual(plan(['packages/ui/src/win32/shell.ts']).platforms, ['linux', 'windows']);
  assert.deepEqual(plan(['packages/ui/src/macOSish/shell.ts']).platforms, ['linux']);
  assert.deepEqual(plan(['packages/ui/src/Windowsill.ts']).platforms, ['linux']);
  assert.deepEqual(plan(['packages/ui/src/shell.macos.ts', 'packages/ui/src/shell.win32.ts']).platforms, allPlatforms);
  assert.deepEqual(plan(['packages/ui/src/App.tsx'], { labels: ['ci:windows'] }).platforms, ['linux', 'windows']);
  assert.deepEqual(plan(['packages/daemon/src/main.ts'], { labels: ['ci:macos'] }).platforms, allPlatforms);
  assert.deepEqual(plan(['packages/ui/src/App.tsx'], { labels: ['ci:macos', 'ci:windows'] }).platforms, allPlatforms);
  assert.deepEqual(plan(['packages/ui/src/App.tsx'], { labels: ['ci:all'] }).packages, allPackages);
});

test('shared consumers, governance, root config and unknown paths force full', () => {
  for (const path of ['packages/protocol/src/index.ts', 'packages/client/src/index.ts', 'package.json',
    'package-lock.json', '.github/workflows/ci.yml', 'scripts/build.mjs',
    'unknown.asset', 'packages/other/x.ts',
    'packages/ui/package.json', 'packages/ui/tsconfig.json', 'packages/ui/vite.config.ts']) {
    const result = plan([path]);
    assert.equal(result.scope, 'full', path);
    assert.deepEqual(result.packages, allPackages, path);
    assert.deepEqual(result.platforms, allPlatforms, path);
  }
  for (const path of ['AGENTS.md', 'CLAUDE.md', '.claude/skills/verify/SKILL.md',
    '.agents/skills/verify/SKILL.md']) {
    assert.equal(plan([path]).scope, 'full');
    assert.deepEqual(plan([path]).platforms, ['linux', 'macos']);
  }
  for (const path of ['.claude/skills/verify/helper.mjs', '.claude/skills/verify/install.ps1',
    '.agents/skills/verify/helper.py', '.agents/skills/verify/SKILL.MD']) {
    assert.equal(plan([path]).scope, 'full');
    assert.deepEqual(plan([path]).platforms, allPlatforms, path);
  }
  assert.deepEqual(plan(['AGENTS.md', '.github/scripts/ci-scope.mjs']).platforms, allPlatforms);
  assert.deepEqual(plan(['.agents/skills/verify/SKILL.md', '.github/scripts/ci-scope.mjs']).platforms, allPlatforms);
});

test('server install and release scripts force full with their own reason, which is not a collection failure', () => {
  for (const path of ['scripts/install.sh', 'scripts/uninstall.sh', 'scripts/install-smoke.mjs', 'scripts/build-server.mjs',
    'scripts/publish-server.mjs', 'scripts/server-manifest.mjs', 'scripts/server-node.json', 'packages/daemon/server-update.json']) {
    assert.equal(isServerReleasePath(path), true, path);
    const result = plan([path]);
    assert.equal(result.scope, 'full', path);
    assert.deepEqual(result.packages, allPackages, path);
    assert.deepEqual(result.platforms, allPlatforms, path);
    assert.equal(result.reason, `server install/release script: ${path}`);
    assert.equal(isCollectionFailure(result.reason), false, path);
  }
  for (const path of ['scripts/install.test.mjs', 'scripts/publish-server.test.mjs', 'scripts/sub/install.sh', 'packages/daemon/src/service/server-update.ts']) {
    assert.equal(isServerReleasePath(path), false, path);
  }
  assert.equal(plan(['packages/daemon/src/service/server-update.ts']).scope, 'affected');
  // The first full reason wins; the platforms are the union.
  assert.equal(plan(['scripts/build.mjs', 'scripts/install.sh']).reason, 'shared or unknown path: scripts/build.mjs');
  for (const reason of ['manual dispatch', 'main integration', 'ci:all label', 'platform label on docs', 'shared package: protocol',
    'shared or unknown path: x', 'shared package config: packages/ui/package.json', '']) assert.equal(isCollectionFailure(reason), false, reason);
  for (const reason of ['empty diff', 'Git collection failed', 'missing or invalid SHA', 'unsupported event', 'server install/release']) assert.equal(isCollectionFailure(reason), true, reason);
});

test('main integration is full for non-docs; readiness requires non-draft frozen head', () => {
  assert.equal(plan(['packages/ui/src/App.tsx'], { target: 'main' }).scope, 'full');
  assert.deepEqual(plan(['packages/ui/src/App.tsx'], { target: 'main' }).platforms, ['linux', 'macos']);
  assert.deepEqual(plan(['packages/daemon/src/macos/bridge.swift'], { target: 'main' }).platforms, ['linux', 'macos']);
  assert.deepEqual(plan(['packages/daemon/src/windows/bridge.ts'], { target: 'main' }).platforms, allPlatforms);
  assert.deepEqual(plan(['packages/daemon/src/main.ts'], { target: 'main' }).platforms, allPlatforms);
  assert.deepEqual(plan(['packages/ui/src/App.tsx'], { target: 'main', labels: ['ci:windows'] }).platforms, allPlatforms);
  assert.deepEqual(plan(['packages/ui/src/App.tsx'], { target: 'main', labels: ['ci:all'] }).platforms, allPlatforms);
  assert.equal(plan(['docs/a.md'], { target: 'main' }).scope, 'docs');
  assert.equal(plan(['packages/ui/src/App.tsx']).ready, false);
  assert.equal(plan(['packages/ui/src/App.tsx'], { labels: ['frozen'], draft: true }).ready, false);
  assert.equal(plan(['packages/ui/src/App.tsx'], { labels: ['frozen'] }).ready, true);
  assert.equal(plan(['packages/ui/src/App.tsx'], { labels: ['ci:all'] }).ready, false);
  assert.equal(plan(['packages/ui/src/App.tsx'], { labels: ['ci:all', 'frozen'] }).ready, true);
});

test('platform-specific desktop and daemon files avoid unrelated Windows checks', () => {
  assert.deepEqual(plan(['packages/desktop/src/macos/menu.swift']).platforms, ['linux', 'macos']);
  assert.deepEqual(plan(['packages/daemon/src/darwin/keychain.ts']).platforms, ['linux', 'macos']);
  assert.deepEqual(plan(['packages/desktop/src/win32/tray.ts']).platforms, ['linux', 'windows']);
  assert.deepEqual(plan(['packages/daemon/src/main.ts', 'packages/daemon/src/macos/keychain.ts']).platforms, allPlatforms);
});

test('root platform scripts stay full scope but select only relevant platforms', () => {
  const macScript = 'scripts/render-macos-icon.swift';
  const windowsScript = 'scripts/build-windows.ps1';
  assert.equal(plan([macScript]).scope, 'full');
  assert.deepEqual(plan([macScript]).packages, allPackages);
  assert.deepEqual(plan([macScript]).platforms, ['linux', 'macos']);
  assert.deepEqual(plan([macScript], { target: 'main' }).platforms, ['linux', 'macos']);
  assert.deepEqual(plan([windowsScript]).platforms, ['linux', 'windows']);
  assert.deepEqual(plan([windowsScript], { target: 'main' }).platforms, allPlatforms);
  assert.deepEqual(plan(['scripts/build.mjs']).platforms, allPlatforms);
  assert.deepEqual(plan(['scripts/macAddress.ts']).platforms, allPlatforms);
  assert.deepEqual(plan([macScript, 'packages/daemon/src/main.ts']).platforms, allPlatforms);
});

test('PR uses cumulative merge-base diff rather than latest commit', () => fixture(({ dir, git, put, commit, base }) => {
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
  assert.equal(result.source_sha, head);
  assert.equal(result.scope, 'full');
  assert.ok(result.paths.includes('packages/protocol/src/index.ts'));
}));

test('push includes all commits; deletions and renames keep source and destination', () => fixture(({ dir, git, put, commit, base }) => {
  put('packages/ui/src/removed.ts');
  put('outside.md');
  const middle = commit();
  git('rm', 'packages/ui/src/removed.ts');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  git('mv', 'outside.md', 'docs/moved.md');
  const head = commit();
  const result = determineScope('push', { before: middle, after: head }, dir);
  assert.equal(result.scope, 'full');
  assert.deepEqual(result.paths, ['docs/moved.md', 'outside.md', 'packages/ui/src/removed.ts']);
  assert.equal(determineScope('push', { before: base, after: head }, dir).scope, 'docs',
    'an add then delete has no cumulative change');
}));

test('push covers an earlier code commit followed by a documentation commit', () => fixture(({ dir, put, commit, base }) => {
  put('packages/ui/src/App.tsx');
  commit();
  put('docs/latest.md');
  const head = commit();
  const result = determineScope('push', { before: base, after: head }, dir);
  assert.equal(result.scope, 'affected');
  assert.deepEqual(result.packages, ['ui', 'desktop']);
}));

test('NUL paths preserve spaces and non-ASCII; malformed and excessive diffs fail closed', () => fixture(({ dir, put, commit, base }) => {
  put('docs/空 格\nline.md');
  const head = commit();
  assert.deepEqual(determineScope('pull_request', pr(base, head), dir).paths, ['docs/空 格\nline.md']);
  assert.equal(parseChangedPaths(Buffer.from('docs/a.md\0')).length, 1);
  assert.equal(parseChangedPaths(Buffer.from('docs/a.md')), null);
  assert.equal(parseChangedPaths(Buffer.from(Array.from({ length: 4097 }, (_, i) => `docs/${i}.md\0`).join(''))), null);
  assert.throws(() => parseChangedPaths(Buffer.from([0xff, 0])), TypeError);
}));

test('missing SHAs, empty diffs, unavailable commits and ambiguous merge bases block evidence', () => fixture(({ dir, git, base }) => {
  for (const event of [pr('bad', base), pr(sha('0'), base), pr(sha('f'), base), pr(base, base)]) {
    const result = determineScope('pull_request', event, dir);
    assert.equal(result.scope, 'full');
    assert.equal(result.ready, false);
    assert.ok(result.reason);
  }
  const tree = git('rev-parse', `${base}^{tree}`);
  const make = (message, ...parents) => git('-c', 'user.name=CI', '-c', 'user.email=ci@example.test',
    'commit-tree', tree, '-m', message, ...parents.flatMap(parent => ['-p', parent]));
  const a = make('a', base), b = make('b', base);
  const left = make('left', a, b), right = make('right', b, a);
  assert.equal(determineScope('pull_request', pr(left, right, { labels: ['frozen'] }), dir).reason, 'ambiguous merge base');
}));

test('CLI emits parseable outputs and fails on collection errors', () => fixture(({ dir, put, commit, base }) => {
  put('packages/ui/src/App.tsx');
  const head = commit();
  const eventPath = join(dir, '.git', 'event.json');
  const outputPath = join(dir, '.git', 'output.txt');
  writeFileSync(eventPath, JSON.stringify(pr(base, head, { labels: ['ci:macos', 'frozen'] })));
  const stdout = execFileSync(process.execPath, [new URL('./ci-scope.mjs', import.meta.url).pathname], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
  });
  const result = JSON.parse(stdout);
  const outputs = Object.fromEntries(readFileSync(outputPath, 'utf8').trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
  assert.equal(result.scope, 'affected');
  assert.deepEqual(JSON.parse(outputs.packages), ['ui', 'desktop']);
  assert.deepEqual(JSON.parse(outputs.platforms), ['linux', 'macos']);
  assert.equal(outputs.ready, 'true');
  assert.equal(outputs.source_sha, head);
  assert.equal(outputs.target_sha, base);
  writeFileSync(eventPath, JSON.stringify(pr('bad', head, { labels: ['frozen'] })));
  assert.throws(() => execFileSync(process.execPath, [new URL('./ci-scope.mjs', import.meta.url).pathname], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath },
  }), /CI scope collection failed/);
}));

test('unknown filename with newlines cannot inject GitHub outputs or summary markup', () => fixture(({ dir, put, commit, base }) => {
  put('unknown\nready=true\nplatforms=["linux"]<tag>.asset');
  const head = commit();
  const eventPath = join(dir, '.git', 'event.json');
  const outputPath = join(dir, '.git', 'output.txt');
  const summaryPath = join(dir, '.git', 'summary.md');
  writeFileSync(eventPath, JSON.stringify(pr(base, head, { labels: ['frozen'] })));
  execFileSync(process.execPath, [new URL('./ci-scope.mjs', import.meta.url).pathname], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath },
  });
  const lines = readFileSync(outputPath, 'utf8').trim().split('\n');
  assert.deepEqual(lines.map(line => line.slice(0, line.indexOf('='))),
    ['scope', 'packages', 'platforms', 'ready', 'source_sha', 'target_sha', 'base', 'head']);
  assert.equal(lines.filter(line => line.startsWith('ready=')).length, 1);
  assert.equal(lines.find(line => line.startsWith('ready=')), 'ready=true');
  assert.doesNotMatch(readFileSync(summaryPath, 'utf8'), /<tag>/);
  assert.match(readFileSync(summaryPath, 'utf8'), /Packages:.*Platforms:/);
}));
