import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {acceptWindowsUpgrade,windowsUpgradeAcceptanceEntry} from './windows-upgrade-acceptance.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
test('native acceptance entry bundles real production update code and has valid Node syntax',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vonvon-upgrade-entry-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const entry=windowsUpgradeAcceptanceEntry(join(repo,'packages/desktop/src/windows-updates.ts')),outfile=join(root,'main.cjs');
  const result=await build({stdin:{contents:entry,sourcefile:'upgrade-acceptance-entry.js',resolveDir:repo},outfile,bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],metafile:true});
  const inputs=Object.keys(result.metafile.inputs).map(path=>path.replaceAll('\\','/'));
  for(const suffix of ['packages/desktop/src/windows-updates.ts','packages/desktop/src/windows-update-manifest.mjs','electron-updater/out/NsisUpdater.js','electron-updater/out/providers/GenericProvider.js'])assert(inputs.some(path=>path.endsWith(suffix)),suffix);
  await promisify(execFile)(process.execPath,['--check',outfile]);
  const code=await readFile(outfile,'utf8');
  assert(code.includes('https://dl.vonvon.cc/bot/windows/stable/'));
  assert(entry.includes("driver.netSession.protocol.handle('https'"));
  assert(entry.includes('driver.disableDifferentialDownload=true'));
  assert(entry.includes("process.env.LOCALAPPDATA=c.localAppData"));
  assert(entry.includes("assert.equal(expected,index?current:undefined"));
});

test('non-Windows native acceptance refuses before creating an evidence directory',{skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'vonvon-upgrade-guard-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const out=join(root,'never-created');
  await assert.rejects(acceptWindowsUpgrade({architecture:'arm64',out}),/Run native upgrade acceptance on Windows/);
  await assert.rejects(stat(out),{code:'ENOENT'});
});
