import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateGate } from './ci-gate.mjs';

const sha = 'a'.repeat(40);

function needs(scope = 'affected', packages = ['ui', 'desktop'], platforms = ['linux', 'macos']) {
  return {
    scope: { result: 'success', outputs: {
      scope, packages: JSON.stringify(packages), platforms: JSON.stringify(platforms),
      ready: 'true', source_sha: sha,
    } },
    linux: { result: platforms.includes('linux') ? 'success' : 'skipped' },
    macos: { result: platforms.includes('macos') ? 'success' : 'skipped' },
    windows: { result: platforms.includes('windows') ? 'success' : 'skipped' },
  };
}

test('passes only a matching selected platform set', () => {
  assert.equal(evaluateGate(needs()).ok, true);
  assert.equal(evaluateGate(needs('full', ['protocol', 'client', 'daemon', 'ui', 'desktop'],
    ['linux', 'macos', 'windows'])).ok, true);
  assert.equal(evaluateGate(needs('full', ['protocol', 'client', 'daemon', 'ui', 'desktop'],
    ['linux', 'macos'])).ok, true);
  const selectedWindows = needs('affected', ['desktop'], ['linux', 'windows']);
  selectedWindows.windows.result = 'failure';
  assert.match(evaluateGate(selectedWindows).message, /windows job must be success/);
  const unexpectedMac = needs('affected', ['ui'], ['linux']);
  unexpectedMac.macos.result = 'success';
  assert.match(evaluateGate(unexpectedMac).message, /macos job must be skipped/);
});

test('full scope requires every package and Linux, while other platforms follow selection', () => {
  assert.match(evaluateGate(needs('full', ['ui'], ['linux', 'macos', 'windows'])).message,
    /every package and Linux/);
  assert.match(evaluateGate(needs('full', ['protocol', 'client', 'daemon', 'ui', 'desktop'],
    ['macos'])).message, /every package and Linux/);
  const skippedSelectedMac = needs('full', ['protocol', 'client', 'daemon', 'ui', 'desktop'],
    ['linux', 'macos']);
  skippedSelectedMac.macos.result = 'skipped';
  assert.match(evaluateGate(skippedSelectedMac).message, /macos job must be success/);
});

test('docs pass only when all heavy jobs are skipped', () => {
  assert.equal(evaluateGate(needs('docs', [], [])).ok, true);
  const docsRanLinux = needs('docs', [], []);
  docsRanLinux.linux.result = 'success';
  assert.equal(evaluateGate(docsRanLinux).ok, false);
  assert.equal(evaluateGate(needs('docs', ['ui'], [])).ok, false);
});

test('rejects unfrozen, empty, unknown, malformed and missing selections', () => {
  const unfrozen = needs();
  unfrozen.scope.outputs.ready = 'false';
  assert.equal(evaluateGate(unfrozen).ok, false);
  assert.equal(evaluateGate(needs('affected', ['ui'], [])).ok, false);
  assert.equal(evaluateGate(needs('affected', [], ['linux'])).ok, false);
  assert.equal(evaluateGate(needs('other')).ok, false);
  assert.equal(evaluateGate(needs('affected', ['bogus'], ['linux'])).ok, false);
  assert.equal(evaluateGate(needs('affected', ['ui'], ['linux', 'bogus'])).ok, false);
  const malformed = needs();
  malformed.scope.outputs.packages = '{';
  assert.equal(evaluateGate(malformed).ok, false);
  const missing = needs();
  delete missing.scope.outputs.platforms;
  assert.equal(evaluateGate(missing).ok, false);
});

test('rejects failed, cancelled or missing scope and invalid source evidence', () => {
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    const candidate = needs();
    candidate.scope.result = result;
    assert.equal(evaluateGate(candidate).ok, false);
  }
  const missingOutputs = needs();
  delete missingOutputs.scope.outputs;
  assert.equal(evaluateGate(missingOutputs).ok, false);
  const badSha = needs();
  badSha.scope.outputs.source_sha = 'bad';
  assert.equal(evaluateGate(badSha).ok, false);
  assert.equal(evaluateGate(null).ok, false);
});

test('missing or skipped selected job cannot satisfy the gate', () => {
  const missing = needs();
  delete missing.macos;
  assert.equal(evaluateGate(missing).ok, false);
  const skipped = needs();
  skipped.linux.result = 'skipped';
  assert.equal(evaluateGate(skipped).ok, false);
});
