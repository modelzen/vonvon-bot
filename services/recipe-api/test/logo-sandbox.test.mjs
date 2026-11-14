import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
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
