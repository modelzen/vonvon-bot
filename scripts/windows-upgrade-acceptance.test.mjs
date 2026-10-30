import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,stat,writeFile,readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {runInNewContext} from 'node:vm';
import {build} from 'esbuild';
import {acceptWindowsUpgrade,windowsUpgradeAcceptanceEntry,windowsUpgradeBuilderArguments,waitForWindowsUpgradeRemoval,preserveWindowsUpgradeFailure,windowsUpgradeChildEnvironment,windowsUpgradeRegistryScript,parseWindowsUpgradeRegistryResult,readWindowsUpgradeRegistration} from './windows-upgrade-acceptance.mjs';

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

const registryFixture=guid=>['32','64'].flatMap(view=>['HKCU','HKLM'].flatMap(hive=>['Software\\'+guid,'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+guid].map(path=>({hive,view,key:hive+'\\'+path,exists:false,values:{}}))));
const registryResult=rows=>({status:0,stdout:Buffer.from(Buffer.from(JSON.stringify(rows),'utf8').toString('base64'),'ascii'),stderr:Buffer.alloc(0)});
test('serialized entry registry helpers execute with Unicode transport and reject missing dependencies',()=>{
  const guid=randomUUID(),rows=registryFixture(guid);rows[0].exists=true;rows[0].values.InstallLocation='E:\\验收 空格\\installed';
  const entry=windowsUpgradeAcceptanceEntry('unused-source'),helpers=entry.slice(entry.indexOf('function windowsUpgradeRegistryScript('),entry.indexOf('// Set isolation on every relaunch'));
  let calls=0;const result=runInNewContext(helpers+'\nreadWindowsUpgradeRegistration('+JSON.stringify(guid)+')',{assert,Buffer,TextDecoder,join,process:{env:{SystemRoot:'C:\\Windows'}},spawnSync:(file,args)=>{calls++;assert(file.endsWith('powershell.exe'));assert(args.includes('-NoProfile'));assert.equal(Buffer.from(args.at(-1),'base64').toString('utf16le'),windowsUpgradeRegistryScript(guid));return registryResult(rows);}});
  assert.equal(calls,1);assert.equal(result.length,8);assert.equal(result[0].values.InstallLocation,rows[0].values.InstallLocation);assert(result[0].value.includes(rows[0].values.InstallLocation));
});

test('registry reader rejects process errors, invalid identities and corrupt or incomplete transport',()=>{
  const guid=randomUUID(),rows=registryFixture(guid),encode=registryResult;
  assert(parseWindowsUpgradeRegistryResult(guid,encode(rows)).every(row=>!row.exists));
  assert.throws(()=>readWindowsUpgradeRegistration("not-a-guid';throw 'injected"),/Invalid fixture registry GUID/);
  const wrongIdentity=structuredClone(rows);wrongIdentity[0].key+='wrong';
  const queryError=structuredClone(rows);queryError[0].error='Access denied';
  for(const result of [{...encode(rows),status:1},{...encode(rows),stderr:Buffer.from('query failure')},{...encode(rows),stdout:Buffer.from('invalid!')},{...encode(rows),stdout:Buffer.from(Buffer.from([255]).toString('base64'))},encode(rows.slice(1)),encode(wrongIdentity),encode(queryError)])assert.throws(()=>parseWindowsUpgradeRegistryResult(guid,result));
  const error=Error('PowerShell launch failed');assert.throws(()=>parseWindowsUpgradeRegistryResult(guid,{error}),caught=>caught===error);
});

test('native registry reader preserves a Unicode path and distinguishes its own removed key',{skip:process.platform!=='win32'},async t=>{
  const guid=randomUUID(),location='E:\\升级验收 空格\\installed',path='Software\\'+guid;
  assert(readWindowsUpgradeRegistration(guid).every(row=>!row.exists),'Fresh test identity already exists');
  const powershell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const invoke=script=>promisify(execFile)(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';"+script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000});
  const eachView=body=>"foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)){$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view);try{"+body+"}finally{$base.Dispose()}}";
  const cleanup=()=>invoke(eachView("$key=$base.OpenSubKey('"+path+"');if($null -ne $key){try{if($key.GetValue('AcceptanceTestOwner') -ne '"+guid+"'){throw 'Refuse non-owned test key'}}finally{$key.Dispose()};$base.DeleteSubKeyTree('"+path+"',$false)}"));
  t.after(cleanup); // Delete only this fresh UUID key, and only with its ownership value.
  await invoke(eachView("$key=$base.CreateSubKey('"+path+"');try{$key.SetValue('AcceptanceTestOwner','"+guid+"');$key.SetValue('InstallLocation',[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+Buffer.from(location,'utf8').toString('base64')+"')))}finally{$key.Dispose()}"));
  const observed=readWindowsUpgradeRegistration(guid).filter(row=>row.hive==='HKCU'&&!row.key.includes('CurrentVersion'));
  assert.equal(observed.length,2);for(const row of observed){assert(row.exists);assert.equal(row.values.InstallLocation,location);assert(row.value.includes(location));}
  await cleanup();assert(readWindowsUpgradeRegistration(guid).every(row=>!row.exists));
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
