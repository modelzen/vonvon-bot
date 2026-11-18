import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
const jobStart = workflow.indexOf('\njobs:\n');
assert.notEqual(jobStart, -1, 'jobs section missing');
const jobsSource = workflow.slice(jobStart + '\njobs:\n'.length);
const markers = [...jobsSource.matchAll(/^  ([a-z][a-z0-9_-]*):\s*$/gm)];
const jobs = Object.fromEntries(markers.map((marker, index) => [
  marker[1], jobsSource.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? jobsSource.length),
]));

test('PR changes on dev and main re-evaluate the gate, with manual full dispatch', () => {
  assert.match(workflow, /^on:\s*\n  pull_request:/m);
  assert.match(workflow, /branches:\s*\[([^\]]*\bdev\b[^\]]*\bmain\b|[^\]]*\bmain\b[^\]]*\bdev\b)[^\]]*\]/);
  assert.match(workflow, /types:\s*\[[^\]]*\bunlabeled\b[^\]]*\]/);
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  push:/m);
});

test('final gate always runs after the scope and all platform jobs', () => {
  assert.ok(jobs.gate, 'gate job missing');
  assert.match(jobs.gate,
    /name:\s*\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*&&\s*'CI gate'\s*\|\|\s*'Manual CI result'\s*\}\}/);
  assert.doesNotMatch(jobs.gate, /^    name:\s*CI gate\s*$/m);
  assert.match(jobs.gate, /needs:\s*\[[^\]]*\bscope\b[^\]]*\blinux\b[^\]]*\bmacos\b[^\]]*\bwindows\b[^\]]*\]/);
  assert.match(jobs.gate, /if:\s*(?:\$\{\{\s*)?always\(\)/);
  assert.match(jobs.gate, /CI_NEEDS:/);
  assert.match(jobs.gate, /node \.github\/scripts\/ci-gate\.mjs/);
});

test('every platform requires scope readiness and its own selection', () => {
  for (const platform of ['linux', 'macos', 'windows']) {
    const body = jobs[platform];
    assert.ok(body, `${platform} job missing`);
    assert.match(body, /needs:\s*scope/);
    assert.match(body, /needs\.scope\.outputs\.ready/);
    assert.match(body, /needs\.scope\.outputs\.platforms/);
    assert.match(body, new RegExp(`['\"]${platform}['\"]`));
    assert.match(body, /ref:\s*\$\{\{\s*needs\.scope\.outputs\.source_sha\s*\}\}/);
    assert.match(body, /node \.github\/scripts\/ci-run\.mjs/);
    assert.doesNotMatch(body, /vars\./);
  }
});

test('public macOS jobs use the standard cloud runner, private jobs retain the isolated runner guard', () => {
  const body = jobs.macos;
  assert.match(body, /toJSON\(github\.event\.repository\.private\)\s*==\s*'false'\s*\|\|\s*github\.event_name/);
  assert.match(body, /toJSON\(github\.event\.repository\.private\)\s*==\s*'false'\s*&&\s*'\["macos-15"\]'\s*\|\|\s*'\["self-hosted", "macOS", "ARM64", "modelzen-macos", "modelzen-macos-isolated"\]'/);
  assert.match(body, /github\.event_name\s*==\s*'workflow_dispatch'/);
  assert.match(body, /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/);
  assert.match(body, /- name: Require dedicated isolated CI account\s+if: toJSON\(github\.event\.repository\.private\) != 'false'/);
  assert.match(body, /EXPECTED_MACOS_CI_USER:\s*\$\{\{\s*secrets\.EXPECTED_MACOS_CI_USER\s*\}\}/);
  assert.match(body, /id -un/);
  assert.match(body, /id -Gn/);
  assert.match(body, /admin/);
});

test('the Linux job keeps the pinned server Node between runs for the install smoke; other jobs do not', () => {
  const body = jobs.linux;
  assert.match(body, /uses:\s*actions\/cache@v4/);
  assert.match(body, /path:\s*\$\{\{\s*runner\.temp\s*\}\}\/vonvon-server-node/);
  assert.match(body, /key:\s*server-node-\$\{\{\s*hashFiles\('scripts\/server-node\.json'\)\s*\}\}/);
  assert.match(body, /VONVON_SMOKE_NODE_CACHE:\s*\$\{\{\s*runner\.temp\s*\}\}\/vonvon-server-node/);
  // The cache is restored after the exact source is checked out and verified.
  assert.ok(body.indexOf('actions/cache') > body.indexOf('SOURCE_SHA'));
  for (const platform of ['macos', 'windows']) assert.doesNotMatch(jobs[platform], /VONVON_SMOKE_NODE_CACHE|vonvon-server-node/);
});
