import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, readlinkSync } from 'node:fs';
import { cloneLogoProbeArtifact } from '../scripts/clone-logo-probe-artifact.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDecoderRoot, linuxDecoderLaunch } from '../src/logo-sandbox.mjs';

function artifact() {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'logo-profile-')));
  for (const name of ['logo-child.mjs','logo-format.mjs','errors.mjs']) writeFileSync(join(root,name),'export {};');
  mkdirSync(join(root,'node_modules/sharp'),{recursive:true});
  writeFileSync(join(root,'node_modules/sharp/package.json'),JSON.stringify({version:'0.35.5'}));
  return root;
}

test('artifact validation rejects dependency escape and mutable decoder code',() => {
  const root = artifact();
  assert.equal(validateDecoderRoot(root),root);
  symlinkSync('/etc',join(root,'node_modules/escape'));
  assert.throws(() => validateDecoderRoot(root),/escapes/);
  const mutable = artifact();
  chmodSync(join(mutable,'logo-child.mjs'),0o666);
  assert.throws(() => validateDecoderRoot(mutable),/Writable/);
});

test('missing artifact, missing launcher and unsupported mode fail before spawning',() => {
  assert.throws(() => linuxDecoderLaunch('normalize',{root:'/nonexistent'}));
  assert.throws(() => linuxDecoderLaunch('normalize',{root:artifact(),bwrap:'/nonexistent'}));
  assert.throws(() => linuxDecoderLaunch('probe',{root:artifact()}),/mode/);
});

test('probe clone preserves internal npm executable symlinks and rejects external dependencies',async () => {
  const original = artifact();
  mkdirSync(join(original,'node_modules/.bin'));
  mkdirSync(join(original,'node_modules/semver/bin'),{recursive:true});
  writeFileSync(join(original,'node_modules/semver/bin/semver.js'),'process.exit(0);');
  symlinkSync('../semver/bin/semver.js',join(original,'node_modules/.bin/semver'));
  const target = join(realpathSync(mkdtempSync(join(tmpdir(),'logo-clone-'))),'artifact');
  assert.equal(await cloneLogoProbeArtifact(original,target),target);
  assert.equal(readlinkSync(join(target,'node_modules/.bin/semver')),'../semver/bin/semver.js');
  symlinkSync('/etc',join(original,'node_modules/external'));
  await assert.rejects(cloneLogoProbeArtifact(original,`${target}-invalid`),/escapes/);
});
