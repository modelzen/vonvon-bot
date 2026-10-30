import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {createReadStream,writeFileSync} from 'node:fs';
import {mkdir,readFile,stat,statfs,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {isAbsolute,join,relative,resolve,sep,win32} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {signWindowsUpdate} from '../packages/desktop/src/windows-update-manifest.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(join(repo,'package.json'));
const versions=['9.90.1','9.90.2','9.90.3'];
const json=value=>JSON.stringify(value,null,2)+'\n';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function digest(file,algorithm='sha512',encoding='base64') {
  const hash=createHash(algorithm);for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest(encoding);
}
async function run(file,args,options={}) {
  const child=spawn(file,args,{stdio:'inherit',windowsHide:true,...options});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(Error(`Acceptance subprocess failed (${code??signal}): ${file}`)));});
}
async function externalInput(path,directory=false) {
  assert(isAbsolute(path),'Cache input must be absolute');const nested=relative(repo,resolve(path));
  assert(nested==='..'||nested.startsWith('..'+sep)||isAbsolute(nested),'Cache input must be outside the source checkout');
  assert(directory?(await stat(path)).isDirectory():(await stat(path)).isFile(),'Cache input has the wrong file type');
}
/** Only the installed Electron package's official checksum table may authorize an archive. */
export async function extractWindowsUpgradeElectronArchive(architecture,archive,destination) {
  assert(['x64','arm64'].includes(architecture),'Unsupported Windows architecture');await externalInput(archive);
  const {devDependencies}=JSON.parse(await readFile(join(repo,'package.json'),'utf8')),version=devDependencies.electron;
  const electronRequire=createRequire(require.resolve('electron/package.json')),name='electron-v'+version+'-win32-'+architecture+'.zip';
  const expected=electronRequire('./checksums.json')[name];assert.match(expected??'',/^[a-f0-9]{64}$/i,'Missing trusted Electron checksum');
  const sha256=await digest(archive,'sha256','hex');assert.equal(sha256,expected,'Electron archive checksum does not match '+name);
  await mkdir(destination,{recursive:true});await electronRequire('@electron-internal/extract-zip').extract(archive,{dir:destination});
  return {path:resolve(archive),version,arch:architecture,sha256};
}
/** The generated app is the builder project; the evidence root has no package.json. */
export function windowsUpgradeBuilderArguments(stage,configPath,architecture) {
  return [require.resolve('electron-builder/cli.js'),'--projectDir',stage,'--config',configPath,'--win','nsis','--'+architecture,'--publish','never'];
}
/** Child-only overrides: never change the coordinator's or Windows user's environment. */
export function windowsUpgradeChildEnvironment(out,base=process.env) {
  const env={...base,TEMP:join(out,'temp'),TMP:join(out,'temp'),LOCALAPPDATA:join(out,'local-app-data'),ELECTRON_BUILDER_CACHE:join(out,'builder-cache'),npm_config_cache:join(out,'npm-cache')};
  delete env.ELECTRON_RUN_AS_NODE;return env;
}
async function diskSpace(out) {
  const rows=await Promise.all([process.env.SystemRoot??'C:\\Windows',out].map(async path=>{const space=await statfs(path);return {path,availableBytes:space.bavail*space.bsize};}));
  return {at:new Date().toISOString(),system:rows[0],output:rows[1]};
}
/** NSIS removes files before registry entries; its launcher can exit before that child finishes. */
export async function waitForWindowsUpgradeRemoval(executable,readRegistration,{timeoutMs=30000,intervalMs=250}={}) {
  const deadline=Date.now()+timeoutMs;
  for(;;){
    let executablePresent=true;try{await stat(executable);}catch(error){if(error.code!=='ENOENT')throw error;executablePresent=false;}
    const cleanup={executablePresent,registration:await readRegistration()};
    if(!executablePresent&&cleanup.registration.every(row=>!row.exists))return cleanup;
    if(Date.now()>=deadline)throw Object.assign(Error('Unique test app uninstall did not complete; inspect uninstall-leftovers.json'),{cleanup});
    await pause(intervalMs);
  }
}
/** GUID-only input; the fixed script reads both views without changing registry namespaces. */
export function windowsUpgradeRegistryScript(nsisGuid) {
  assert.match(nsisGuid,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,'Invalid fixture registry GUID');
  return `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$guid='${nsisGuid}';$rows=@()
foreach($view in @('32','64')) {
  $registryView=if($view -eq '32'){[Microsoft.Win32.RegistryView]::Registry32}else{[Microsoft.Win32.RegistryView]::Registry64}
  foreach($hive in @('HKCU','HKLM')) {
    $registryHive=if($hive -eq 'HKCU'){[Microsoft.Win32.RegistryHive]::CurrentUser}else{[Microsoft.Win32.RegistryHive]::LocalMachine}
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($registryHive,$registryView)
    try { foreach($path in @("Software\\$guid","Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$guid")) {
      $key=$null
      try {
        $key=$base.OpenSubKey($path,$false);$values=@{}
        if($null -ne $key){foreach($name in $key.GetValueNames()){$values[$name]=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}}
        $rows+=@{hive=$hive;view=$view;key=$hive+'\\'+$path;exists=($null -ne $key);values=$values}
      } finally {if($null -ne $key){$key.Dispose()}}
    }} finally {$base.Dispose()}
  }
}
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($rows) -Depth 8 -Compress))))`;
}
/** Reject process/transport/schema errors instead of reporting a failed query as absence. */
export function parseWindowsUpgradeRegistryResult(nsisGuid,result) {
  if(result.error)throw result.error;
  if(result.status!==0||Buffer.from(result.stderr??'').length)throw Error('Registry query failed: exit='+result.status+' signal='+result.signal+' stderrBase64='+Buffer.from(result.stderr??'').toString('base64'));
  const output=Buffer.from(result.stdout??'');assert(output.every(byte=>byte<128),'Registry result is not ASCII base64');
  const encoded=output.toString('ascii').trim(),bytes=Buffer.from(encoded,'base64');
  assert(encoded&&bytes.toString('base64')===encoded,'Malformed registry result encoding');
  const rows=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const expected=['32','64'].flatMap(view=>['HKCU','HKLM'].flatMap(hive=>['Software\\'+nsisGuid,'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+nsisGuid].map(path=>({hive,view,key:hive+'\\'+path}))));
  assert(Array.isArray(rows)&&rows.length===expected.length,'Incomplete registry result');
  return rows.map((row,index)=>{
    assert.deepEqual({hive:row.hive,view:row.view,key:row.key},expected[index],'Mismatched registry result identity');
    assert(!Object.hasOwn(row,'error')&&!Object.hasOwn(row,'exitCode'),'Registry result contains query errors');
    assert(typeof row.exists==='boolean'&&row.values&&typeof row.values==='object'&&!Array.isArray(row.values),'Invalid registry result');
    assert(row.exists||Object.keys(row.values).length===0,'Missing registry key contains values');
    return {...row,value:Object.entries(row.values).map(([name,value])=>name+'\t'+String(value)).join('\n'),exitCode:0,error:''};
  });
}
export function readWindowsUpgradeRegistration(nsisGuid) {
  const script=windowsUpgradeRegistryScript(nsisGuid),powershell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});
  return parseWindowsUpgradeRegistryResult(nsisGuid,result);
}
/** Retain the first failure and every later failure, including after a manual relaunch. */
export function preserveWindowsUpgradeFailure(out,details) {
  const body=JSON.stringify(details,null,2)+'\n';
  writeFileSync(join(out,'failure-'+process.pid+'-'+randomUUID()+'.json'),body,{flag:'wx'});
  try{writeFileSync(join(out,'failure.json'),body,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
}
/** Only the unique fixture's paths/name can authorize process details in diagnostics. */
export function filterWindowsUpgradeProcesses(c,rows) {
  const root=win32.resolve(c.out).replace(/[\\/]+$/,'').toLowerCase()+'\\',name=c.productName.toLowerCase();
  assert(/^vonvon upgrade acceptance [a-f0-9]{8} (x64|arm64)$/.test(name),'Invalid diagnostic fixture name');
  return rows.filter(row=>String(row.executable??'').toLowerCase().startsWith(root)||String(row.commandLine??'').toLowerCase().includes(root)||String(row.executable??'').toLowerCase().includes(name)||String(row.commandLine??'').toLowerCase().includes(name))
    .map(({pid,parentPid,executable,commandLine,mainWindowTitle,windowError})=>({pid,parentPid,executable,commandLine,mainWindowTitle,...(windowError?{windowError}:{})}));
}
export function windowsUpgradeDiagnosticScript(c) {
  const input=Buffer.from(JSON.stringify({out:c.out,installDir:c.installDir,productName:c.productName,executableName:c.executableName}),'utf8').toString('base64');
  return `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'))|ConvertFrom-Json
$result=@{files=@();processes=@();errors=@()};$comparison=[StringComparison]::OrdinalIgnoreCase
$root=[IO.Path]::GetFullPath($c.out).TrimEnd('\\')+'\\'
foreach($entry in @(@{kind='executable';name=$c.executableName+'.exe'},@{kind='uninstaller';name='Uninstall '+$c.productName+'.exe'},@{kind='retiredPayloadMarker';name='retired-payload-marker'})) {
  $path=Join-Path $c.installDir $entry.name;$row=@{kind=$entry.kind;path=$path}
  try {$row.exists=Test-Path -LiteralPath $path -PathType Leaf
    if($row.exists -and $entry.kind -ne 'retiredPayloadMarker'){$version=[Diagnostics.FileVersionInfo]::GetVersionInfo($path);$row.fileVersion=$version.FileVersion;$row.productVersion=$version.ProductVersion}
  } catch {$row.error=$_.Exception.Message}
  $result.files+=@($row)
}
try {
  foreach($p in @(Get-CimInstance -ClassName Win32_Process)) {
    $exe=[string]$p.ExecutablePath;$command=[string]$p.CommandLine
    if($exe.StartsWith($root,$comparison) -or $command.IndexOf($root,$comparison) -ge 0 -or $exe.IndexOf($c.productName,$comparison) -ge 0 -or $command.IndexOf($c.productName,$comparison) -ge 0) {
      $row=@{pid=$p.ProcessId;parentPid=$p.ParentProcessId;executable=$exe;commandLine=$command}
      try {$row.mainWindowTitle=(Get-Process -Id $p.ProcessId -ErrorAction Stop).MainWindowTitle} catch {$row.windowError=$_.Exception.Message}
      $result.processes+=@($row)
    }
  }
} catch {$result.errors+=@{query='processes';error=$_.Exception.Message}}
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $result -Depth 8 -Compress))))`;
}
/** Bounded, read-only evidence; diagnostic errors never replace the acceptance failure. */
export async function recordWindowsUpgradeDiagnostics(c,error,{query=spawnSync,registration=readWindowsUpgradeRegistration,save=writeFile}={}) {
  const report={at:new Date().toISOString(),error:error.stack??String(error),fixture:{out:c.out,productName:c.productName,nsisGuid:c.nsisGuid}};
  try {report.registration=registration(c.nsisGuid);} catch(error){report.registrationError=error.stack??String(error);}
  try {
    const script=windowsUpgradeDiagnosticScript(c),powershell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const result=query(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});
    if(result.error)throw result.error;
    if(result.status!==0||Buffer.from(result.stderr??'').length)throw Error('Diagnostic query failed: exit='+result.status+' signal='+result.signal+' stderrBase64='+Buffer.from(result.stderr??'').toString('base64'));
    const encoded=Buffer.from(result.stdout??'').toString('ascii').trim(),bytes=Buffer.from(encoded,'base64');
    assert(encoded&&bytes.toString('base64')===encoded,'Invalid diagnostic transport');
    const snapshot=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    assert(Array.isArray(snapshot.files)&&Array.isArray(snapshot.processes)&&Array.isArray(snapshot.errors),'Invalid diagnostic snapshot');
    report.snapshot={...snapshot,processes:filterWindowsUpgradeProcesses(c,snapshot.processes)};
  } catch(error){report.snapshotError=error.stack??String(error);}
  await save(join(c.out,'failure-diagnostics.json'),json(report),{flag:'wx'});
}
export async function withWindowsUpgradeDiagnostics(c,operation,diagnose=recordWindowsUpgradeDiagnostics) {
  try {return await operation();}
  catch(error){try {await diagnose(c,error);} catch {/* Preserve the original failure even if evidence cannot be saved. */}throw error;}
}
/** Test-only entry. It bundles the real provider, downloader, verification and quitAndInstall. */
export function windowsUpgradeAcceptanceEntry(source) {
  return `import assert from 'node:assert/strict';
import {app} from 'electron';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,createReadStream} from 'node:fs';
import {join,resolve} from 'node:path';
import {Readable} from 'node:stream';
import {WindowsDesktopUpdater,createWindowsUpdateDriver,windowsUpdateConfiguration} from ${JSON.stringify(source)};
const c=JSON.parse(readFileSync(join(app.getAppPath(),'acceptance.json'),'utf8'));
const originalLocalAppData=process.env.LOCALAPPDATA,originalTemp=process.env.TEMP,originalTmp=process.env.TMP;
${windowsUpgradeRegistryScript.toString()}
${parseWindowsUpgradeRegistryResult.toString()}
${readWindowsUpgradeRegistration.toString()}
${preserveWindowsUpgradeFailure.toString()}
// Set isolation on every relaunch: NSIS ExecShellAsUser need not inherit our environment.
process.env.VONVON_DESKTOP_TEST_HOME=c.desktopHome;process.env.VONVON_HOME=c.dataHome;
process.env.LOCALAPPDATA=c.localAppData;process.env.TEMP=c.tempDir;process.env.TMP=c.tempDir;delete process.env.ELECTRON_RUN_AS_NODE;
for(const path of [c.desktopHome,c.dataHome,c.localAppData,c.tempDir,join(c.desktopHome,'userData')])mkdirSync(path,{recursive:true});
app.setPath('temp',c.tempDir);app.setPath('appData',c.desktopHome);app.setPath('userData',join(c.desktopHome,'userData'));
app.setAppLogsPath(join(c.desktopHome,'logs'));
const record=(name,value)=>{const file=join(c.out,name+'.json'),temp=file+'.tmp-'+process.pid;writeFileSync(temp,JSON.stringify(value,null,2)+'\\n');renameSync(temp,file);};
const log=(kind,value)=>appendFileSync(join(c.out,'native-events.ndjson'),JSON.stringify({at:new Date().toISOString(),version:app.getVersion(),pid:process.pid,kind,value})+'\\n');
let watchdog,boot;
const fail=error=>{const details={error:error.stack??String(error),version:app.getVersion(),boot};preserveWindowsUpgradeFailure(c.out,details);log('failed',String(error));clearTimeout(watchdog);app.exit(1);};
async function accept(){
  await app.whenReady();assert(app.requestSingleInstanceLock(),'Another acceptance instance owns this profile');
  const current=app.getVersion(),index=c.versions.indexOf(current),statePath=join(app.getPath('userData'),'desktop-update-expected-version'),retiredMarker=join(c.installDir,'retired-payload-marker');
  const expected=existsSync(statePath)?readFileSync(statePath,'utf8'):undefined;
  const actor=spawnSync(join(process.env.SystemRoot??'C:\\\\Windows','System32','whoami.exe'),['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});
  const identityHash=createHash('sha256').update(actor.status===0?actor.stdout.trim():String(process.env.USERDOMAIN)+'/'+String(process.env.USERNAME)).digest('hex');
  boot={current,expected,pid:process.pid,parentPid:process.ppid,architecture:process.arch,executable:process.execPath,originalLocalAppData,localAppData:process.env.LOCALAPPDATA,originalTemp,originalTmp,temp:process.env.TEMP,tmp:process.env.TMP,configuredInstallDir:c.installDir,identityHash,identityQueryStatus:actor.status,retiredPayloadMarkerPresent:existsSync(retiredMarker),registration:readWindowsUpgradeRegistration(c.nsisGuid)};
  record('bootstrap-'+current+'-'+process.pid,boot);log('bootstrap',boot);
  assert(index>=0);assert.equal(process.arch,c.architecture);assert(app.isPackaged);
  assert.equal(resolve(process.execPath),resolve(join(c.installDir,c.executableName+'.exe')));
  assert.equal(readFileSync(join(c.dataHome,'sentinel'),'utf8'),c.sentinel);
  if(index===2)assert(!existsSync(retiredMarker),'Old payload directory was not uninstalled before C');
  assert.equal(expected,index?current:undefined,'The preceding native installation did not take effect');
  const fixture=JSON.parse(readFileSync(join(c.out,'fixtures.json'),'utf8'));
  const configuration=await windowsUpdateConfiguration({appPath:app.getAppPath(),isPackaged:app.isPackaged});
  assert.equal(configuration.publicKey,c.publicKey);
  const driver=createWindowsUpdateDriver(configuration.publicKey,c.architecture);
  driver.disableDifferentialDownload=true; // This lane explicitly proves full EXE replacement.
  driver.logger={info:(...args)=>log('updater-info',args),warn:(...args)=>log('updater-warn',args),error:(...args)=>log('updater-error',args),debug:()=>{}};
  driver.on('error',error=>log('updater-error',String(error)));
  const next=c.versions[Math.min(index+1,c.versions.length-1)];
  driver.netSession.protocol.handle('https',request=>{
    const url=new URL(request.url);log('request',{url:request.url,range:request.headers.get('range')});
    const manifestURL='https://dl.vonvon.cc/bot/windows/stable/'+c.architecture+'/update.json';
    if(request.url===manifestURL)return new Response(JSON.stringify(fixture.manifests[next]),{headers:{'content-type':'application/json'}});
    const artifact=fixture.artifacts[request.url];
    if(!artifact||url.origin!=='https://dl.vonvon.cc'||url.search||url.hash)return new Response('Unknown acceptance fixture',{status:404});
    const range=request.headers.get('range'),match=range&&/^bytes=(\\d+)-(\\d*)$/.exec(range);
    if(range&&!match)return new Response(null,{status:416});
    const start=match?Number(match[1]):0,end=match&&match[2]?Number(match[2]):artifact.size-1;
    if(start>end||end>=artifact.size)return new Response(null,{status:416});
    const headers={'content-type':'application/octet-stream','content-length':String(end-start+1),'accept-ranges':'bytes'};
    if(match)headers['content-range']='bytes '+start+'-'+end+'/'+artifact.size;
    return new Response(request.method==='HEAD'?null:Readable.toWeb(createReadStream(artifact.file,{start,end})),{status:match?206:200,headers});
  });
  const updater=new WindowsDesktopUpdater({current,...configuration,architecture:c.architecture,driver,statePath,onUpdate:update=>log('progress',update),beforeInstall:async()=>{
    assert.equal(readFileSync(statePath,'utf8'),next);assert.equal(readFileSync(join(c.dataHome,'sentinel'),'utf8'),c.sentinel);
    const registration=readWindowsUpgradeRegistration(c.nsisGuid);
    record('before-install-'+current,{current,next,executable:process.execPath,installDirectory:driver.installDirectory??null,identityHash,registration});
    if(index===1){
      assert.equal(resolve(process.execPath),resolve(join(c.installDir,c.executableName+'.exe')));assert.match(c.nsisGuid,/^[a-f0-9-]{36}$/i);
      const owned=rows=>rows.some(row=>row.hive==='HKCU'&&row.exists&&row.key.includes('CurrentVersion')&&row.value.includes('UninstallString')&&row.value.includes(c.productName)&&row.value.toLowerCase().includes(c.installDir.toLowerCase()));
      assert(c.productName.startsWith('Vonvon Upgrade Acceptance ')&&owned(registration),'Refuse registry fault outside the owned fixture');
      writeFileSync(retiredMarker,c.id);assert.equal(readFileSync(retiredMarker,'utf8'),c.id);
      const reg=join(process.env.SystemRoot??'C:\\\\Windows','System32','reg.exe'),key='HKCU\\\\Software\\\\'+c.nsisGuid,deletedViews=[];
      for(const view of ['32','64']){if(spawnSync(reg,['query',key,'/v','InstallLocation','/reg:'+view],{windowsHide:true}).status!==0)continue;const deleted=spawnSync(reg,['delete',key,'/v','InstallLocation','/f','/reg:'+view],{windowsHide:true});assert.equal(deleted.status,0);deletedViews.push(view);}
      const after=readWindowsUpgradeRegistration(c.nsisGuid);record('registry-loss-regression',{current,deletedViews,oldPayloadMarkerCreated:true,before:registration,after,installDirectory:driver.installDirectory??null,identityHash});
      assert(deletedViews.length>0&&owned(after),'Missing fixture InstallLocation baseline or retained uninstaller');
      assert(after.filter(row=>row.hive==='HKCU'&&!row.key.includes('CurrentVersion')).every(row=>!row.value.includes('InstallLocation')),'Fixture InstallLocation did not disappear');
    }
    log('before-install',{current,next});
  }});
  await updater.settleInstallState();assert(!existsSync(statePath));
  record('startup-'+current,{current,expected,architecture:process.arch,pid:process.pid,executable:process.execPath,sentinelRetained:true,retiredPayloadRemoved:index===2?true:undefined});
  if(index===c.versions.length-1){
    assert.equal((await updater.check()).state,'current');record('completed',{passed:true,current,pid:process.pid,architecture:process.arch});clearTimeout(watchdog);app.quit();return;
  }
  const checked=await updater.check();assert.equal(checked.state,'available');assert.equal(checked.latest,next);log('checked',checked);
  const downloaded=await updater.install();assert.equal(downloaded.state,'downloaded');assert(!existsSync(statePath));log('downloaded',downloaded);
  // Separate calls prove that finishing download alone does not install.
  await new Promise(resolve=>setTimeout(resolve,500));assert.equal(app.getVersion(),current);
  await updater.install();
}
watchdog=setTimeout(()=>fail(Error('Native upgrade timed out')),180000);
accept().catch(fail);
`;
}
/** New external output directory only. Keeps artifacts and failed installations for inspection. */
export async function acceptWindowsUpgrade({architecture,out,sourceSha:expectedSourceSha,electronArchive,builderCache}) {
  if(process.platform!=='win32')throw Error('Run native upgrade acceptance on Windows; this script never controls a VM.');
  if(!['x64','arm64'].includes(architecture)||!isAbsolute(out??''))throw Error('Use --architecture x64|arm64 and a new absolute --out outside the repository');
  out=resolve(out);const nested=relative(repo,out);
  if(!nested||(nested!=='..'&&!nested.startsWith('..'+sep)&&!isAbsolute(nested)))throw Error('Acceptance output must be outside the source checkout');
  const git=spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}),sourceSha=git.stdout?.trim();
  if(git.error||git.status!==0||!/^[a-f0-9]{40}$/.test(sourceSha??''))throw Error('Cannot identify the acceptance source SHA');
  if(expectedSourceSha&&expectedSourceSha!==sourceSha)throw Error('Acceptance source differs from --source-sha');
  // npm can relink tracked bins on Windows without changing their normalized blobs.
  for(const args of [['diff','--quiet','HEAD','--'],['diff','--cached','--quiet','HEAD','--'],['ls-files','--others','--exclude-standard']]){
    const clean=spawnSync('git',args,{cwd:repo,encoding:'utf8'});
    if(clean.error||clean.status!==0||clean.stdout.trim())throw Error('Native acceptance requires a clean source checkout matching the recorded SHA');
  }
  if(electronArchive)await externalInput(electronArchive);if(builderCache)await externalInput(builderCache,true);
  await mkdir(out); // Refuse reuse: every run has a unique identity and an empty profile.
  await writeFile(join(out,'disk-space-before.json'),json(await diskSpace(out)));
  let failed=false;
  try{
  const id=randomUUID(),productName='Vonvon Upgrade Acceptance '+id.slice(0,8)+' '+architecture,executableName=productName,nsisGuid=randomUUID();
  const appId='com.vonvon.bot.upgrade-acceptance.'+id+'.'+architecture,packageName='vonvon-upgrade-acceptance-'+id+'-'+architecture;
  const installDir=join(out,'installed'),desktopHome=join(out,'desktop-home'),dataHome=join(out,'data'),localAppData=join(out,'local-app-data'),tempDir=join(out,'temp');
  const sentinel='preserve acceptance data '+id,keys=generateKeyPairSync('ed25519');
  const publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString(),privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const c={out,id,sourceSha,appId,productName,executableName,nsisGuid,architecture,installDir,desktopHome,dataHome,localAppData,tempDir,sentinel,publicKey,versions};
  await mkdir(dataHome);await writeFile(join(dataHome,'sentinel'),sentinel);
  const manualWizard={installer:join(out,'packages','Vonvon-Bot-Setup-'+versions[0]+'-'+architecture+'.exe'),instructions:['After automatic acceptance has uninstalled its unique app, open this fixture installer interactively.','Observe the editable directory page, fixed current-user scope, Chinese/system language and installation progress; save screenshots here.','For an alternate writable path, uncheck Run on the finish page: the automatic entry expects installDir and must not run from another location.','Uninstall only this unique product from the manually chosen path. Never use the real Vonvon Bot installer or registration.'],uninstallerName:'Uninstall '+productName+'.exe'};
  await writeFile(join(out,'acceptance-plan.json'),json({...c,electronArchive:electronArchive??null,builderCache:builderCache??null,manualWizard,installerStoreCaveat:'NSIS keeps one unique fixture installer cache under the Windows LOCALAPPDATA known folder, which may remain on C:. All large extraction/build/download work uses the output volume. See disk-space-before/after.json.',scope:'Real updater + NSIS full-download A→B→C; no full product UI, daemon, differential-download or SmartScreen-prompt claim'}));
  const production=join(repo,'packages/desktop/src/windows-updates.ts'),include=join(repo,'packages/desktop/assets/windows-installer.nsh');
  const sourceFiles=[production,include,join(repo,'packages/desktop/src/windows-update-manifest.mjs'),join(repo,'packages/desktop/electron-builder.yml'),join(repo,'package.json'),join(repo,'package-lock.json'),fileURLToPath(import.meta.url)];
  const sourceHashes={};for(const file of sourceFiles)sourceHashes[relative(repo,file)]=await digest(file,'sha256','hex');
  await writeFile(join(out,'source-hashes.json'),json(sourceHashes));
  const {build}=require('esbuild'),builderRequire=createRequire(require.resolve('app-builder-lib/package.json'));
  const original=builderRequire('js-yaml').load(await readFile(join(repo,'packages/desktop/electron-builder.yml'),'utf8'));
  const runtime=join(out,'electron-runtime'),buildHome=join(out,'build-home'),stage=join(out,'stage'),packages=join(out,'packages');
  await mkdir(buildHome);await mkdir(stage);await mkdir(join(stage,'dist'));
  const fixtureEnv=windowsUpgradeChildEnvironment(out),env={...fixtureEnv,HOME:buildHome,LOCALAPPDATA:join(buildHome,'local-app-data'),ELECTRON_SKIP_BINARY_DOWNLOAD:'1',CSC_IDENTITY_AUTO_DISCOVERY:'false',ELECTRON_BUILDER_7Z_FILTER:'BCJ'};
  if(builderCache)env.ELECTRON_BUILDER_CACHE=builderCache;
  for(const path of new Set([fixtureEnv.TEMP,fixtureEnv.LOCALAPPDATA,env.LOCALAPPDATA,env.ELECTRON_BUILDER_CACHE,env.npm_config_cache]))await mkdir(path,{recursive:true});
  if(electronArchive)await writeFile(join(out,'runtime-archive.json'),json(await extractWindowsUpgradeElectronArchive(architecture,electronArchive,runtime)));
  else await run(process.execPath,[join(repo,'scripts/windows-build-tools.mjs'),'electron',architecture,runtime],{cwd:repo,env});
  await build({stdin:{contents:windowsUpgradeAcceptanceEntry(production),sourcefile:'upgrade-acceptance-entry.js',resolveDir:repo},outfile:join(stage,'main.cjs'),bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron']});
  await writeFile(join(stage,'acceptance.json'),json(c));await writeFile(join(stage,'dist/windows-update-config.json'),json({publicKey}));
  const metadata=JSON.parse(await readFile(join(repo,'package.json'),'utf8'));
  const config={appId,productName,electronVersion:metadata.devDependencies.electron,electronDist:runtime,directories:{output:packages},asar:true,npmRebuild:false,
    files:['main.cjs','package.json','acceptance.json','dist/windows-update-config.json'],
    win:{target:'nsis',executableName,publish:{provider:'generic',url:'https://dl.vonvon.cc/bot/windows/stable/'},verifyUpdateCodeSignature:false},
    nsis:{...original.nsis,include,guid:nsisGuid,artifactName:'Vonvon-Bot-Setup-\u0024{version}-\u0024{arch}.exe',createDesktopShortcut:false,createStartMenuShortcut:false,shortcutName:productName}};
  const configPath=join(out,'electron-builder.json');await writeFile(configPath,json(config));
  const fixtures={manifests:{},artifacts:{}};
  for(const version of versions){
    await writeFile(join(stage,'package.json'),json({name:packageName,productName,version,main:'main.cjs',description:'Disposable native Windows updater acceptance',author:'modelzen',license:'UNLICENSED'}));
    await run(process.execPath,windowsUpgradeBuilderArguments(stage,configPath,architecture),{cwd:stage,env});
    const file=join(packages,'Vonvon-Bot-Setup-'+version+'-'+architecture+'.exe'),size=(await stat(file)).size,sha512=await digest(file);
    const url='https://dl.vonvon.cc/bot/windows/'+version+'/Vonvon-Bot-Setup-'+version+'-'+architecture+'.exe';
    fixtures.manifests[version]=signWindowsUpdate({schemaVersion:1,product:'vonvon-bot',version,architecture,url,size,sha512,notes:'Disposable native acceptance '+version},privateKey);
    fixtures.artifacts[url]={file,size,sha512};
  }
  await writeFile(join(out,'fixtures.json'),json(fixtures));
  const registration=()=>readWindowsUpgradeRegistration(nsisGuid);
  assert(registration().every(row=>!row.exists),'Refuse an existing test identity');
  const first=join(packages,'Vonvon-Bot-Setup-'+versions[0]+'-'+architecture+'.exe'),executable=join(installDir,executableName+'.exe');
  await withWindowsUpgradeDiagnostics(c,async()=>{
  await run(first,['/currentuser','/S','/D='+installDir],{windowsVerbatimArguments:true,env:fixtureEnv});
  const installedRegistration=registration();assert(installedRegistration.some(row=>row.hive==='HKCU'&&row.exists&&row.value.toLowerCase().includes(installDir.toLowerCase())));assert(!installedRegistration.some(row=>row.hive==='HKLM'&&row.exists));
  await writeFile(join(out,'installed-registration.json'),json(installedRegistration));
  await stat(executable);
  const app=spawn(executable,[],{stdio:'ignore',windowsHide:false,env:fixtureEnv});
  let launchError;app.on('error',error=>{launchError=error;});app.unref();
  const deadline=Date.now()+12*60*1000;
  while(true){
    if(launchError)throw launchError;
    try{const failure=JSON.parse(await readFile(join(out,'failure.json'),'utf8'));throw Error(failure.error);}catch(error){if(error.code!=='ENOENT')throw error;}
    try{const complete=JSON.parse(await readFile(join(out,'completed.json'),'utf8'));assert(complete.passed);break;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(Date.now()>deadline)throw Error('Native A→B→C timed out; inspect the dedicated test app and preserved evidence.');await pause(500);
  }
  for(const version of versions){const observed=JSON.parse(await readFile(join(out,'startup-'+version+'.json'),'utf8'));assert.equal(observed.current,version);assert.equal(observed.architecture,architecture);assert.equal(resolve(observed.executable),resolve(executable));}
  assert.equal(await readFile(join(dataHome,'sentinel'),'utf8'),sentinel);
  const registryLoss=JSON.parse(await readFile(join(out,'registry-loss-regression.json'),'utf8'));assert(registryLoss.deletedViews.length>0);
  const complete=JSON.parse(await readFile(join(out,'completed.json'),'utf8'));
  for(let i=0;i<40;i++){try{process.kill(complete.pid,0);}catch(error){if(error.code==='ESRCH')break;throw error;}if(i===39)throw Error('Last acceptance application did not exit; refusing uninstall');await pause(250);}
  const upgradedRegistration=registration();assert(!upgradedRegistration.some(row=>row.hive==='HKLM'&&row.exists));
  assert(upgradedRegistration.some(row=>row.hive==='HKCU'&&row.exists&&row.key.includes('Uninstall')&&row.value.includes(versions.at(-1))));
  assert(upgradedRegistration.filter(row=>row.exists).every(row=>row.value.toLowerCase().includes(installDir.toLowerCase())));
  await writeFile(join(out,'upgraded-registration.json'),json(upgradedRegistration));
  });
  const uninstaller=join(installDir,'Uninstall '+productName+'.exe');
  await run(uninstaller,['/currentuser','/S'],{windowsVerbatimArguments:true,env:fixtureEnv});
  try{await writeFile(join(out,'uninstalled-registration.json'),json(await waitForWindowsUpgradeRemoval(executable,registration)));}
  catch(error){await writeFile(join(out,'uninstall-leftovers.json'),json(error.cleanup??{error:error.stack??String(error)}));throw error;}
  assert.equal(await readFile(join(dataHome,'sentinel'),'utf8'),sentinel);
  await writeFile(join(out,'acceptance.json'),json({passed:true,sourceSha,architecture,versions,appId,completedAt:new Date().toISOString(),sourceHashes,scope:'Native signed full-EXE update and NSIS replacement; production UI/daemon and differential download not covered',sentinelRetained:true,missingRegistryLocationUpgradePassed:true,retiredPayloadRemoved:true,uniqueTestAppUninstalled:true,manualWizardAndProductionUi:'Not exercised by this automated lane; see acceptance-plan.json'}));
  return {passed:true,architecture,evidence:out};
  }catch(error){failed=true;throw error;}
  finally{try{await writeFile(join(out,'disk-space-after.json'),json(await diskSpace(out)));}catch(error){if(!failed)throw error;}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{architecture:{type:'string'},out:{type:'string'},'source-sha':{type:'string'},'electron-archive':{type:'string'},'builder-cache':{type:'string'},help:{type:'boolean'}}});
  if(values.help)console.log('On Windows after npm ci: node scripts/windows-upgrade-acceptance.mjs --architecture arm64 --out E:\\absolute\\new-evidence-dir --source-sha FULL_SHA\nOptional --electron-archive ABS_ZIP verifies the fixed version/architecture official checksum before extraction; --builder-cache ABS_DIR reuses a seeded copy of build tools only. Both paths must be outside source. Use a different new directory for x64. Never controls the VM, publishes, signs with the production key, or uses the owner installation. Artifacts/evidence remain; a successful run uninstalls only its unique test app. A failed run preserves its test installation for inspection. See acceptance-plan.json/manualWizard for separate interactive directory/language/progress checks; disable Run after finishing a manual alternate-path install. This lane does not prove production UI/daemon, differential download, or SmartScreen prompt behavior.');
  else try{console.log(json(await acceptWindowsUpgrade({...values,sourceSha:values['source-sha'],electronArchive:values['electron-archive'],builderCache:values['builder-cache']})));}catch(error){console.error(error.stack??error);process.exitCode=1;}
}
