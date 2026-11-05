import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { availableParallelism } from 'node:os';
import { createPlan, packages } from './ci-run.mjs';

const root = process.cwd();
const output = resolve(process.env.RUNNER_TEMP || root, 'linux-shard-benchmark-output');
const phase = process.env.BENCHMARK_PHASE;
if (!['baseline', '1/2', '2/2'].includes(phase)) throw new Error('Unknown benchmark phase');
if (availableParallelism() !== 2) throw new Error('This comparison requires a two-CPU runner');
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
if (manifest.scripts.test !== 'npm run test --workspaces --if-present && node --test scripts/*.test.mjs') {
  throw new Error('Root test contract changed');
}
if (manifest.scripts.pretest !== undefined || manifest.scripts.posttest !== undefined) {
  throw new Error('Root test lifecycle hooks need explicit preservation before splitting');
}
const scriptTests = readdirSync('scripts').filter(n => n.endsWith('.test.mjs')).sort().map(n => `scripts/${n}`);
const normal = createPlan('full', packages).flatMap(command => {
  if (command.executable !== 'npm' || JSON.stringify(command.args) !== JSON.stringify(['run', 'test'])) return [command];
  return [...packages.map(name => ({executable: 'npm', args: ['--workspace', `packages/${name}`, 'run', 'test']})),
    {executable: 'node', args: ['--test', ...scriptTests]}];
});
const daemonTest = c => c.executable === 'npm' && c.args[0] === '--workspace' && c.args[1] === 'packages/daemon' && c.args[3] === 'test';
let plan = phase === '2/2' ? normal.filter((c, i) => i === 0 || daemonTest(c)) : normal;
plan = plan.map(c => daemonTest(c) ? {...c, args: [...c.args, '--', '--maxWorkers=2', ...(phase === 'baseline' ? [] : [`--shard=${phase}`])]} : c);
mkdirSync(output, {recursive: true});
const started = performance.now();
const report = {phase, productSource: process.env.BENCHMARK_SOURCE, testedCommit: process.env.GITHUB_SHA,
  node: process.version, cpus: availableParallelism(), workers: 2, commands: [], suites: [], status: 0};
try {
  for (const [index, command] of plan.entries()) {
    const args = [...command.args];
    const rootTests = command.executable === 'node' && args[0] === '--test';
    if (rootTests) args.splice(1, 0, '--test-reporter=tap');
    const workspace = command.executable === 'npm' && args[0] === '--workspace' && args[3] === 'test' ? args[1] : null;
    const outputFile = resolve(output, `vitest-${workspace?.split('/').at(-1)}.json`);
    if (workspace) {
      if (!args.includes('--')) args.push('--');
      args.push('--reporter=json', `--outputFile=${outputFile}`);
    }
    console.log(`> ${command.executable} ${args.join(' ')}`);
    const start = performance.now();
    const result = spawnSync(command.executable === 'node' ? process.execPath : 'npm', args,
      {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    writeFileSync(resolve(output, `command-${index}.log`), (result.stdout || '') + (result.stderr || ''));
    const measured = {...command, seconds: (performance.now() - start) / 1000, status: result.status, signal: result.signal};
    report.commands.push(measured);
    console.log(JSON.stringify(measured));
    if (rootTests) report.rootTests = Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gm)].map(m => [m[1], Number(m[2])]));
    if (workspace) {
      const data = JSON.parse(readFileSync(outputFile, 'utf8'));
      const files = data.testResults.map(file => ({path: relative(root, file.name).replaceAll('\\', '/'),
        status: file.status, assertions: file.assertionResults.map(a => ({name: a.fullName, status: a.status}))}));
      const suite = {workspace, passed: data.numPassedTests, failed: data.numFailedTests,
        skipped: data.numPendingTests, total: data.numTotalTests, files};
      report.suites.push(suite);
      console.log(JSON.stringify({...suite, files: files.length}));
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Command failed with ${result.status ?? result.signal}`);
  }
} catch (error) {
  report.status = 1;
  report.error = String(error.message || error);
  console.error(error);
} finally {
  report.seconds = (performance.now() - started) / 1000;
  writeFileSync(resolve(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({phase, seconds: report.seconds, status: report.status}));
}
process.exitCode = report.status;
