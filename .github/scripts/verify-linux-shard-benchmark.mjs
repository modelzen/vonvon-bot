import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspaces = ['protocol', 'client', 'daemon', 'ui', 'desktop'].map(n => `packages/${n}`);
const canonical = values => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const withoutShard = c => ({executable: c.executable, args: c.args.filter(a => !a.startsWith('--shard='))});
const command = c => ({executable: c.executable, args: c.args});
const daemonTest = c => c.executable === 'npm' && c.args[0] === '--workspace' && c.args[1] === 'packages/daemon' && c.args[3] === 'test';

export function verifyReports(reports) {
  assert.equal(reports.length, 3, 'Need baseline and both shards');
  const byPhase = new Map(reports.map(r => [r.phase, r]));
  assert.equal(byPhase.size, 3, 'Duplicate benchmark phase');
  const baseline = byPhase.get('baseline');
  const first = byPhase.get('1/2');
  const second = byPhase.get('2/2');
  assert.ok(baseline && first && second, 'Missing phase');
  assert.match(baseline.productSource, /^[0-9a-f]{40}$/);
  assert.match(baseline.testedCommit, /^[0-9a-f]{40}$/);
  assert.equal(typeof baseline.node, 'string');
  assert.deepEqual(command(baseline.commands[0]), {executable: 'npm', args: ['run', 'build']});
  for (const report of reports) {
    assert.equal(report.status, 0, 'Benchmark failed');
    assert.equal(report.cpus, 2, 'CPU allocation differs');
    assert.equal(report.workers, 2, 'Worker count differs');
    assert.equal(report.productSource, baseline.productSource, 'Source differs');
    assert.equal(report.testedCommit, baseline.testedCommit, 'Tested commit differs');
    assert.equal(report.node, baseline.node, 'Node version differs');
    for (const c of report.commands) {
      assert.equal(c.status, 0, 'Command failed');
      assert.equal(c.signal, null, 'Command was killed');
      if (daemonTest(c)) assert.ok(c.args.includes('--maxWorkers=2'), 'Workers were not fixed');
    }
  }
  assert.deepEqual(first.commands.map(withoutShard), baseline.commands.map(command), 'First shard omitted or changed checks');
  const expectedSecond = baseline.commands.filter((c, i) => i === 0 || daemonTest(c));
  assert.equal(expectedSecond.length, 2, 'Expected build and one daemon test command');
  assert.deepEqual(second.commands.map(withoutShard), expectedSecond.map(command), 'Second shard plan differs');
  assert.equal(first.commands.filter(daemonTest).length, 1);
  assert.ok(first.commands.find(daemonTest).args.includes('--shard=1/2'));
  assert.ok(second.commands.find(daemonTest).args.includes('--shard=2/2'));
  for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    assert.ok(Number.isInteger(baseline.rootTests?.[field]), `Missing root ${field}`);
  }
  assert.equal(baseline.rootTests.fail, 0);
  assert.equal(baseline.rootTests.cancelled, 0);
  assert.deepEqual(first.rootTests, baseline.rootTests, 'Root script test counts changed');
  assert.equal(second.rootTests, undefined, 'Root tests unexpectedly duplicated');
  assert.deepEqual(baseline.suites.map(s => s.workspace), workspaces, 'Baseline workspace coverage differs');
  assert.deepEqual(first.suites.map(s => s.workspace), workspaces, 'First shard workspace coverage differs');
  assert.deepEqual(second.suites.map(s => s.workspace), ['packages/daemon']);
  const files = r => r.suites.flatMap(s => s.files.map(f => [s.workspace, f.path, f.status]));
  const assertions = r => r.suites.flatMap(s => s.files.flatMap(f => f.assertions.map(a => [s.workspace, f.path, a.name, a.status])));
  const candidateFiles = [...files(first), ...files(second)];
  const uniquePaths = new Set(candidateFiles.map(([workspace, path]) => JSON.stringify([workspace, path])));
  assert.equal(uniquePaths.size, candidateFiles.length, 'A file was executed by both shards');
  assert.deepEqual(canonical(candidateFiles), canonical(files(baseline)), 'File coverage or status changed');
  assert.deepEqual(canonical([...assertions(first), ...assertions(second)]), canonical(assertions(baseline)), 'Assertion identities or statuses changed');
  const totals = suites => suites.reduce((a, s) => {
    assert.equal(s.failed, 0);
    for (const field of ['total', 'passed', 'skipped']) a[field] += s[field];
    return a;
  }, {total: 0, passed: 0, skipped: 0});
  const counts = totals(baseline.suites);
  assert.deepEqual(totals([...first.suites, ...second.suites]), counts, 'Vitest counts changed');
  return {coverage: 'identical', files: candidateFiles.length, ...counts, rootTests: baseline.rootTests,
    baselineScriptSeconds: baseline.seconds, firstShardScriptSeconds: first.seconds, secondShardScriptSeconds: second.seconds};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  const reports = readdirSync(directory).map(name => JSON.parse(readFileSync(resolve(directory, name, 'result.json'), 'utf8')));
  const result = verifyReports(reports);
  console.log(JSON.stringify(result, null, 2));
  writeFileSync('comparison.json', JSON.stringify(result, null, 2));
}
