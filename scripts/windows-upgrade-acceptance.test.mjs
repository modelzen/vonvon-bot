import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {acceptWindowsUpgrade,windowsUpgradeAcceptanceEntry,windowsUpgradeBuilderArguments} from './windows-upgrade-acceptance.mjs';

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

// Exercise the installed CLI parser and builder's actual project/config/metadata resolver.
test('builder reads the generated stage package, not the metadata-free evidence root',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vonvon-upgrade-project-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const stage=join(root,'stage'),configPath=join(root,'electron-builder.json');await mkdir(stage);
  await writeFile(join(stage,'package.json'),JSON.stringify({name:'vonvon-upgrade-acceptance-fixture',version:'9.90.2',description:'Fixture',author:'modelzen',license:'UNLICENSED',main:'main.cjs'}));
  await writeFile(join(stage,'main.cjs'),'');
  await writeFile(configPath,JSON.stringify({appId:'com.vonvon.upgrade.fixture',productName:'Vonvon Upgrade Fixture',electronVersion:'44.4.5',directories:{output:join(root,'packages')},npmRebuild:false,win:{target:'nsis',verifyUpdateCodeSignature:false}}));
  const require=createRequire(import.meta.url),cli=require('electron-builder/out/builder.js'),{Packager}=require('app-builder-lib');
  const old=new Packager({projectDir:root,config:configPath});
  await assert.rejects(old.validateConfig(),/Cannot find package.json/);
  const parsed=cli.configureBuildCommand(cli.createYargs()).parseSync(windowsUpgradeBuilderArguments(stage,configPath,'arm64').slice(1));
  const packager=new Packager(cli.normalizeOptions(parsed));await packager.validateConfig();
  assert.equal(packager.projectDir,stage);assert.equal(packager.appDir,stage);
  assert.equal(packager.devMetadata.name,'vonvon-upgrade-acceptance-fixture');assert.equal(packager.metadata.version,'9.90.2');
  assert.equal(packager.config.directories.output,join(root,'packages'));assert.equal(await packager.getPackageManager(),'npm');
});
