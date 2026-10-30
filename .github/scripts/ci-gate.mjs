import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const knownPackages = ['protocol', 'client', 'daemon', 'ui', 'desktop'];
const knownPlatforms = ['linux', 'macos', 'windows'];
const knownScopes = ['docs', 'affected', 'full'];

function parseSelection(value, allowed, label) {
  let selection;
  try {
    selection = JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!Array.isArray(selection) ||
      selection.some(item => typeof item !== 'string' || !allowed.includes(item)) ||
      new Set(selection).size !== selection.length ||
      selection.some((item, index) => index > 0 && allowed.indexOf(item) < allowed.indexOf(selection[index - 1]))) {
    throw new Error(`${label} must be a unique array in canonical order`);
  }
  return selection;
}

export function evaluateGate(needs) {
  const fail = message => ({ ok: false, message });
  if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) {
    return fail('CI_NEEDS must be an object');
  }
  if (needs.scope?.result !== 'success') {
    return fail(`Scope job did not succeed (${needs.scope?.result ?? 'missing'})`);
  }
  const outputs = needs.scope.outputs;
  if (outputs === null || typeof outputs !== 'object' || Array.isArray(outputs)) {
    return fail('Scope outputs are missing');
  }
  const { scope, ready, source_sha: sourceSha } = outputs;
  if (!knownScopes.includes(scope)) return fail(`Unknown CI scope: ${scope ?? 'missing'}`);
  if (ready !== 'true') return fail('Scope is not ready for the final gate');
  if (typeof sourceSha !== 'string' || !/^[0-9a-f]{40}$/i.test(sourceSha) || /^0+$/.test(sourceSha)) {
    return fail('Scope source SHA is missing or invalid');
  }
  let packages;
  let platforms;
  try {
    packages = parseSelection(outputs.packages, knownPackages, 'Scope packages');
    platforms = parseSelection(outputs.platforms, knownPlatforms, 'Scope platforms');
  } catch (error) {
    return fail(error.message);
  }
  if (scope === 'docs') {
    if (packages.length || platforms.length) return fail('Docs scope must select no packages or platforms');
  } else if (scope === 'full') {
    if (JSON.stringify(packages) !== JSON.stringify(knownPackages) || !platforms.includes('linux')) {
      return fail('Full scope must select every package and Linux');
    }
  } else if (packages.length === 0 || !platforms.includes('linux')) {
    return fail('Code scope requires packages and Linux');
  }
  for (const platform of knownPlatforms) {
    const actual = needs[platform]?.result;
    const expected = platforms.includes(platform) ? 'success' : 'skipped';
    if (actual !== expected) {
      return fail(`${platform} job must be ${expected}; got ${actual ?? 'missing'}`);
    }
  }
  return { ok: true, message: `${scope} checks passed for ${sourceSha}: ${platforms.length ? platforms.join(', ') : 'docs only'}` };
}

function main() {
  let needs;
  try {
    needs = JSON.parse(process.env.CI_NEEDS);
  } catch {
    throw new Error('CI_NEEDS is not valid JSON');
  }
  const result = evaluateGate(needs);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Final CI gate: **${result.ok ? 'passed' : 'failed'}**. ${result.message}\n`);
  }
  if (!result.ok) throw new Error(result.message);
  console.log(result.message);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
