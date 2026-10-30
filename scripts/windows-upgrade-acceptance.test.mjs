import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,stat,writeFile,readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {acceptWindowsUpgrade,windowsUpgradeAcceptanceEntry,windowsUpgradeBuilderArguments,waitForWindowsUpgradeRemoval,preserveWindowsUpgradeFailure,windowsUpgradeChildEnvironment} from './windows-upgrade-acceptance.mjs';

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
  assert(entry.includes("process.env.TEMP=c.tempDir;process.env.TMP=c.tempDir"));
  assert(entry.includes("app.setPath('temp',c.tempDir)"));
  assert(entry.includes("assert.equal(expected,index?current:undefined"));
});

test('child environment confines temporary files and caches without changing inherited settings',async t=>{
  const out=await mkdtemp(join(tmpdir(),'vonvon-upgrade-environment-'));t.after(()=>rm(out,{recursive:true,force:true}));
  const inherited=Object.freeze({...process.env,TEMP:'C:\\old-temp',TMP:'C:\\old-tmp',LOCALAPPDATA:'C:\\owner-data',ELECTRON_BUILDER_CACHE:'C:\\old-builder-cache',npm_config_cache:'C:\\old-npm-cache',ELECTRON_RUN_AS_NODE:'1'});
  const env=windowsUpgradeChildEnvironment(out,inherited);
  for(const name of ['TEMP','TMP','LOCALAPPDATA','ELECTRON_BUILDER_CACHE','npm_config_cache']){const child=relative(out,env[name]);assert(child&&!child.startsWith('..')&&!isAbsolute(child));}
  assert.equal(env.ELECTRON_RUN_AS_NODE,undefined);assert.equal(env.TEMP,env.TMP);assert.equal(inherited.ELECTRON_RUN_AS_NODE,'1');assert.equal(inherited.LOCALAPPDATA,'C:\\owner-data');
  await mkdir(env.TEMP);
  const {stdout}=await promisify(execFile)(process.execPath,['-e',"const fs=require('node:fs'),path=require('node:path');const file=path.join(fs.mkdtempSync(path.join(process.env.TEMP,'child-')),'probe');fs.writeFileSync(file,process.env.TMP);console.log(file)"],{env});
  assert.equal(await readFile(stdout.trim(),'utf8'),env.TMP);
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

test('uninstall waits for delayed registry removal even when the executable is already gone',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vonvon-upgrade-removal-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'app.exe');await writeFile(file,'fixture');await rm(file);
  let exists=true,reads=0,timer;t.after(()=>clearTimeout(timer));
  const cleanup=await waitForWindowsUpgradeRemoval(file,()=>{if(++reads===1)timer=setTimeout(()=>{exists=false;},30);return [{key:'private-test-key',exists}];},{timeoutMs:1000,intervalMs:2});
  assert(reads>1);assert.deepEqual(cleanup,{executablePresent:false,registration:[{key:'private-test-key',exists:false}]});
});

test('uninstall timeout preserves genuine file or registry leftovers instead of accepting partial removal',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vonvon-upgrade-leftovers-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'app.exe');await writeFile(file,'fixture');
  for(const executablePresent of [true,false]){
    if(!executablePresent)await rm(file);const registration=[{key:'private-test-key',exists:!executablePresent,value:'retained fixture'}];
    await assert.rejects(waitForWindowsUpgradeRemoval(file,()=>registration,{timeoutMs:0}),error=>{assert.deepEqual(error.cleanup,{executablePresent,registration});return /uninstall did not complete/.test(error.message);});
  }
});

test('failure diagnostics retain the original fault when another version is relaunched',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vonvon-upgrade-failures-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const original={version:'9.90.3',boot:{executable:'fixture-default-path',registration:[]},error:'Unexpected install path'};
  preserveWindowsUpgradeFailure(root,original);preserveWindowsUpgradeFailure(root,{version:'9.90.2',error:'Later manual launch'});
  assert.deepEqual(JSON.parse(await readFile(join(root,'failure.json'),'utf8')),original);
  assert.equal((await readdir(root)).filter(name=>/^failure-/.test(name)).length,2);
});
