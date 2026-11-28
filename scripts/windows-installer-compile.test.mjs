import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {compileWindowsInstaller} from './windows-installer-compile.mjs';

test('actual builder headers and assisted directory/upgrade pages compile for both architectures under a C locale', {timeout:120000}, async t => {
  const out = await mkdtemp(join(tmpdir(), 'vonvon-installer-compile-'));
  t.after(() => rm(out, {recursive:true, force:true, maxRetries:12, retryDelay:250}));
  const compile = options => compileWindowsInstaller({...options, env:{...process.env, LANG:'C', LC_ALL:'C'}});
  for (const architecture of ['x64', 'arm64']) {
    const result = await compile({out:join(out, architecture), architecture});
    assert.ok(result.bytes > 10000);
    assert.doesNotMatch(result.diagnostics, /unknown variable|warning 6000/i);
    await compile({out:join(out, architecture + '-uninstaller'), architecture, uninstaller:true});
    if (process.platform === 'win32') {
      // This unique test identity has no registration: an unpinned update must
      // stop before entering its install section or choosing a default folder.
      const refused = spawnSync(result.output, ['/S', '--updated'], {windowsHide:true, timeout:15000});
      assert.equal(refused.status, 2, String(refused.error ?? 'unlocated update was not refused'));
    }
  }
  // Reproduce the cloud failure through the actual compiler, including the late
  // placement of customHeader after assistedInstaller has emitted its PageEx.
  const hookFile = join(out, 'invalid-hook.nsh');
  const hook = await readFile(new URL('../packages/desktop/assets/windows-installer.nsh', import.meta.url), 'utf8');
  await writeFile(hookFile, hook + '\n!macro customHeader\n  DirVerify leave\n!macroend\n');
  await assert.rejects(compile({out:join(out, 'invalid'), hookFile}), error => /DirVerify not valid outside PageEx/.test(error.stderr));
  const duplicateHook = join(out, 'duplicate-start-app.nsh');
  await writeFile(duplicateHook, hook.replace(/Function vonvonStartApp[\s\S]*?FunctionEnd/, 'Function vonvonStartApp\n  !insertmacro StartApp\nFunctionEnd'));
  await assert.rejects(compile({out:join(out, 'duplicate'), hookFile:duplicateHook}), error => /startAppArgs.*already declared/.test(error.stderr));
});
