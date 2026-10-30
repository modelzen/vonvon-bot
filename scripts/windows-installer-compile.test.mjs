import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {compileWindowsInstaller} from './windows-installer-compile.mjs';

test('actual builder headers and assisted directory/upgrade pages compile for both architectures', {timeout:120000}, async t => {
  const out = await mkdtemp(join(tmpdir(), 'vonvon-installer-compile-'));
  t.after(() => rm(out, {recursive:true, force:true}));
  for (const architecture of ['x64', 'arm64']) {
    const result = await compileWindowsInstaller({out:join(out, architecture), architecture});
    assert.ok(result.bytes > 10000);
    assert.doesNotMatch(result.diagnostics, /unknown variable|warning 6000/i);
  }
  // Reproduce the cloud failure through the actual compiler, including the late
  // placement of customHeader after assistedInstaller has emitted its PageEx.
  const hookFile = join(out, 'invalid-hook.nsh');
  const hook = await readFile(new URL('../packages/desktop/assets/windows-installer.nsh', import.meta.url), 'utf8');
  await writeFile(hookFile, hook + '\n!macro customHeader\n  DirVerify leave\n!macroend\n');
  await assert.rejects(compileWindowsInstaller({out:join(out, 'invalid'), hookFile}), error => /DirVerify not valid outside PageEx/.test(error.stderr));
});
