import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPlan, installSmoke, packages, parseInputs, runPlan } from './ci-run.mjs';
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-run-'));
  temporaryRoots.push(root);
  const workspaces = packages.map(name => `packages/${name}`);
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    workspaces,
    scripts: {
      build: 'npm run build --workspaces --if-present',
      typecheck: 'typecheck', test: 'test', lint: 'lint',
    },
  }));
  for (const workspace of workspaces) {
    mkdirSync(join(root, workspace), { recursive: true });
    writeFileSync(join(root, workspace, 'package.json'), JSON.stringify({ scripts: { test: 'test' } }));
  }
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'root.test.mjs'), '');
  return root;
}

test('rejects malformed, empty, unknown, duplicate, and unordered package selections', () => {
  for (const raw of [undefined, '', '{}', '[]', '["unknown"]', '["ui","ui"]',
    '["desktop","ui"]', '["ui; echo bad"]']) {
    assert.throws(() => parseInputs('affected', raw));
  }
  assert.throws(() => parseInputs('docs', '["ui"]'));
  assert.deepEqual(parseInputs('affected', '["ui","desktop"]'), {
    scope: 'affected', selected: ['ui', 'desktop'],
  });
  assert.throws(() => parseInputs('full', '["ui","desktop"]'), /every workspace/);
  assert.deepEqual(parseInputs('full', JSON.stringify(packages)).selected, packages);
});

test('affected plan builds every workspace before checks and runs root script tests', () => {
  const plan = createPlan('affected', ['ui', 'desktop'], fixture());
  assert.deepEqual(plan[0], { executable: 'npm', args: ['run', 'build'] });
  assert.deepEqual(plan.slice(1, 3).map(command => command.args), [
    ['--workspace', 'packages/ui', 'run', 'typecheck', '--if-present'],
    ['--workspace', 'packages/desktop', 'run', 'typecheck', '--if-present'],
  ]);
  assert.equal(plan.filter(command => command.args.includes('--workspace')).length, 6);
  assert.deepEqual(plan.at(-1), { executable: 'node', args: ['--test', 'scripts/root.test.mjs'] });
});

test('full plan executes the root suite after the ordered workspace build', () => {
  const plan = createPlan('full', ['ui'], fixture(), 'darwin');
  assert.deepEqual(plan.map(command => command.args), [
    ['run', 'build'], ['run', 'typecheck'], ['run', 'test'], ['run', 'lint'],
  ]);
});

test('Linux runs the server install smoke last, for full scope or a daemon change only', () => {
  const root = fixture();
  writeFileSync(join(root, installSmoke), '');
  const smoke = { executable: 'node', args: [installSmoke] };
  const full = createPlan('full', packages, root, 'linux');
  assert.deepEqual(full.map(command => command.args), [['run', 'build'], ['run', 'typecheck'], ['run', 'test'], ['run', 'lint'], [installSmoke]]);
  const daemon = createPlan('affected', ['daemon', 'desktop'], root, 'linux');
  assert.deepEqual(daemon.at(-1), smoke);
  assert.deepEqual(daemon.at(-2).args[0], '--test', 'after the root script tests');
  for (const [scope, selected, platform] of [['affected', ['ui', 'desktop'], 'linux'], ['full', packages, 'darwin'], ['affected', ['daemon', 'desktop'], 'darwin']]) {
    assert.equal(createPlan(scope, selected, root, platform).some(command => command.args.includes(installSmoke)), false, `${scope} ${selected} ${platform}`);
  }
  // Windows has no server package; its lists stay those of build-windows.ps1.
  assert.equal(createPlan('full', packages, sourceRoot, 'win32').some(command => command.args.includes(installSmoke)), false);
  assert.throws(() => createPlan('full', packages, fixture(), 'linux'), /Missing install smoke/);
  assert.ok(readFileSync(join(sourceRoot, installSmoke), 'utf8').includes('installSmoke'), 'the real smoke exists');
});

test('Windows full builds and typechecks all packages, then runs supported acceptance tests', () => {
  const plan = createPlan('full', packages, sourceRoot, 'win32');
  assert.deepEqual(plan.filter(command => !command.args.includes('verify:built')).slice(0, 3).map(command => command.args),
    [['run', 'build'], ['run', 'typecheck'], ['run', 'lint']]);
  assert.equal(plan.some(command => command.executable === 'npm' &&
    command.args.join(' ') === 'run test'), false);
  assert.equal(plan.filter(command => command.args.includes('run') && command.args.includes('test')).length, 5);
});

test('Windows affected scope runs only selected package tests, with targeted daemon and desktop cases', () => {
  const plan = createPlan('affected', ['daemon', 'desktop'], sourceRoot, 'win32');
  assert.deepEqual(plan[0].args, ['run', 'build']);
  const packageTests = plan.filter(command => command.args.includes('test') && command.args.includes('--workspace'));
  assert.deepEqual(packageTests.map(command => command.args[1]), ['packages/daemon', 'packages/desktop']);
  assert.equal(packageTests[0].args.includes('test/windows-owned-process.test.ts'), true);
  assert.equal(packageTests[1].args.includes('test/windows-updates.test.ts'), true);
  assert.equal(packageTests[1].args.includes('test/updates.test.ts'), true);
  const ordinary = createPlan('affected', ['protocol', 'client', 'ui'], sourceRoot, 'win32');
  assert.deepEqual(ordinary.filter(command => command.args.includes('--workspace') && command.args.includes('test'))
    .map(command => command.args), ['protocol', 'client', 'ui']
    .map(name => ['--workspace', `packages/${name}`, 'run', 'test']));
});

test('Windows CI test lists match the existing release acceptance script exactly', () => {
  const script = readFileSync(join(sourceRoot, 'scripts/build-windows.ps1'), 'utf8');
  const invocations = [...script.matchAll(/Invoke-Node @\(([^)\n]+)\)/g)]
    .map(([, body]) => [...body.matchAll(/'([^']+)'/g)].map(([, arg]) => arg));
  const root = invocations.find(args => args[0] === '--test');
  const daemon = invocations.find(args => args.includes('@vonvon/daemon'));
  const desktop = invocations.find(args => args.includes('@vonvon/desktop'));
  const plan = createPlan('full', packages, sourceRoot, 'win32');
  assert.deepEqual(plan.find(command => command.executable === 'node').args, root);
  assert.deepEqual(plan.find(command => command.args.includes('packages/daemon') && command.args.includes('test')).args.slice(5), daemon.slice(daemon.indexOf('--') + 1));
  assert.deepEqual(plan.find(command => command.args.includes('packages/desktop') && command.args.includes('test')).args.slice(5), desktop.slice(desktop.indexOf('--') + 1));
});

test('missing workspace test script fails before any command runs', () => {
  const root = fixture();
  writeFileSync(join(root, 'packages', 'ui', 'package.json'), '{}');
  assert.throws(() => createPlan('affected', ['ui'], root), /has no test script/);
});

test('runner stops when built verification fails before source checks', () => {
  const calls = [];
  assert.throws(() => runPlan([
    { executable: 'npm', args: ['run', 'build'] },
    { executable: 'npm', args: ['--workspace', 'packages/daemon', 'run', 'verify:built'] },
    { executable: 'npm', args: ['run', 'typecheck'] },
  ], '/tmp', (executable, args) => {
    calls.push([executable, args]);
    return { status: args.includes('verify:built') ? 2 : 0 };
  }), /failed \(2\)/);
  assert.equal(calls.length, 2);
});


test('built verification follows the complete dependency build and only selects declared workspace checks', () => {
  const root = fixture();
  for (const name of ['protocol', 'daemon']) {
    writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({
      scripts: { test: 'test', 'verify:built': 'node scripts/verify-built.mjs' },
    }));
  }
  writeFileSync(join(root, installSmoke), '');
  for (const platform of ['linux', 'darwin']) {
    for (const scope of ['affected', 'full']) {
      const selected = scope === 'full' ? packages : ['daemon', 'desktop'];
      const plan = createPlan(scope, selected, root, platform);
      const checks = plan.filter(command => command.args.includes('verify:built'));
      assert.deepEqual(checks.map(command => command.args), (scope === 'full' ? ['protocol', 'daemon'] : ['daemon'])
        .map(name => ['--workspace', `packages/${name}`, 'run', 'verify:built']));
      assert.deepEqual(plan[0].args, ['run', 'build']);
      assert.deepEqual(plan.slice(1, 1 + checks.length), checks);
    }
  }
  assert.equal(createPlan('affected', ['ui', 'desktop'], root, 'darwin')
    .some(command => command.args.includes('verify:built')), false);
});

test('Windows includes built checks without changing its specialized source suites', () => {
  const plan = createPlan('full', packages, sourceRoot, 'win32');
  assert.deepEqual(plan.filter(command => command.args.includes('verify:built')).map(command => command.args), [
    ['--workspace', 'packages/protocol', 'run', 'verify:built'],
    ['--workspace', 'packages/daemon', 'run', 'verify:built'],
  ]);
});
