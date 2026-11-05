import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyReports } from './verify-linux-shard-benchmark.mjs';

function fixture() {
  const cmd = (executable, args) => ({executable, args, status: 0, signal: null});
  const names = ['protocol', 'client', 'daemon', 'ui', 'desktop'];
  const suites = names.map(name => {
    const paths = name === 'daemon' ? ['a', 'b'] : ['a'];
    return {workspace: `packages/${name}`, passed: paths.length, failed: 0, skipped: 0, total: paths.length,
      files: paths.map(p => ({path: `packages/${name}/test/${p}.test.ts`, status: 'passed', assertions: [{name: `works ${p}`, status: 'passed'}]}))};
  });
  const baseline = {phase: 'baseline', productSource: 'a'.repeat(40), testedCommit: 'b'.repeat(40), node: 'v24.22.2', cpus: 2, workers: 2, status: 0, seconds: 100,
    commands: [cmd('npm', ['run', 'build']), cmd('npm', ['run', 'typecheck']),
      ...names.map(n => cmd('npm', ['--workspace', `packages/${n}`, 'run', 'test', ...(n === 'daemon' ? ['--', '--maxWorkers=2'] : [])])),
      cmd('node', ['--test', 'scripts/a.test.mjs']), cmd('npm', ['run', 'lint']), cmd('node', ['scripts/install-smoke.mjs'])],
    suites, rootTests: {tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0}};
  const first = structuredClone(baseline);
  first.phase = '1/2';
  first.commands.find(c => c.args[1] === 'packages/daemon').args.push('--shard=1/2');
  Object.assign(first.suites[2], {passed: 1, total: 1, files: [first.suites[2].files[0]]});
  const second = structuredClone(baseline);
  second.phase = '2/2';
  second.commands = [second.commands[0], second.commands.find(c => c.args[1] === 'packages/daemon')];
  second.commands[1].args.push('--shard=2/2');
  second.suites = [{...second.suites[2], passed: 1, total: 1, files: [second.suites[2].files[1]]}];
  delete second.rootTests;
  return [baseline, first, second];
}

test('accepts the exact disjoint union including duplicate assertion names across files', () => {
  const result = verifyReports(fixture());
  assert.equal(result.coverage, 'identical');
  assert.equal(result.files, 6);
  assert.equal(result.passed, 6);
});

test('rejects a missing file, duplicate shard file, changed assertion, or added skip', () => {
  for (const mutate of [
    r => { r[2].suites[0].files = []; },
    r => { r[2].suites[0].files = structuredClone(r[1].suites[2].files); },
    r => { r[2].suites[0].files[0].assertions[0].name = 'different test'; },
    r => { r[2].suites[0].files[0].assertions[0].status = 'pending'; },
  ]) {
    const reports = fixture(); mutate(reports);
    assert.throws(() => verifyReports(reports));
  }
});

test('rejects omitted root checks, changed root counts, wrong CPU, source, or worker settings', () => {
  for (const mutate of [
    r => { r[1].commands.pop(); },
    r => { r[1].rootTests.tests++; },
    r => { r[2].cpus = 4; },
    r => { r[2].productSource = 'c'.repeat(40); },
    r => { r[1].commands.find(c => c.args[1] === 'packages/daemon').args = ['--workspace', 'packages/daemon', 'run', 'test', '--', '--shard=1/2']; },
  ]) {
    const reports = fixture(); mutate(reports);
    assert.throws(() => verifyReports(reports));
  }
});

test('rejects a command failure, killed process, missing phase, or duplicate phase', () => {
  for (const mutate of [
    r => { r[1].commands[0].status = 1; },
    r => { r[2].commands[0].signal = 'SIGKILL'; },
    r => { r.pop(); },
    r => { r[2].phase = '1/2'; },
  ]) {
    const reports = fixture(); mutate(reports);
    assert.throws(() => verifyReports(reports));
  }
});
