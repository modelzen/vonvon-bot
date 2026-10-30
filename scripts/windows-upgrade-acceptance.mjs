import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
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
/** The generated app is the builder project; the evidence root has no package.json. */
export function windowsUpgradeBuilderArguments(stage,configPath,architecture) {
  return [require.resolve('electron-builder/cli.js'),'--projectDir',stage,'--config',configPath,'--win','nsis','--'+architecture,'--publish','never'];
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
/** Test-only entry. It bundles the real provider, downloader, verification and quitAndInstall. */
export function windowsUpgradeAcceptanceEntry(source) {
  return `import assert from 'node:assert/strict';
import {app} from 'electron';
import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,createReadStream} from 'node:fs';
import {join,resolve} from 'node:path';
import {Readable} from 'node:stream';
import {WindowsDesktopUpdater,createWindowsUpdateDriver,windowsUpdateConfiguration} from ${JSON.stringify(source)};
const c=JSON.parse(readFileSync(join(app.getAppPath(),'acceptance.json'),'utf8'));
// Set isolation on every relaunch: NSIS ExecShellAsUser need not inherit our environment.
process.env.VONVON_DESKTOP_TEST_HOME=c.desktopHome;process.env.VONVON_HOME=c.dataHome;
process.env.LOCALAPPDATA=c.localAppData;delete process.env.ELECTRON_RUN_AS_NODE;
for(const path of [c.desktopHome,c.dataHome,c.localAppData,join(c.desktopHome,'userData')])mkdirSync(path,{recursive:true});
app.setPath('appData',c.desktopHome);app.setPath('userData',join(c.desktopHome,'userData'));
app.setAppLogsPath(join(c.desktopHome,'logs'));
const record=(name,value)=>{const file=join(c.out,name+'.json'),temp=file+'.tmp-'+process.pid;writeFileSync(temp,JSON.stringify(value,null,2)+'\\n');renameSync(temp,file);};
const log=(kind,value)=>appendFileSync(join(c.out,'native-events.ndjson'),JSON.stringify({at:new Date().toISOString(),version:app.getVersion(),pid:process.pid,kind,value})+'\\n');
let watchdog;
async function accept(){
  await app.whenReady();assert(app.requestSingleInstanceLock(),'Another acceptance instance owns this profile');
  const current=app.getVersion(),index=c.versions.indexOf(current);
  assert(index>=0);assert.equal(process.arch,c.architecture);assert(app.isPackaged);
  assert.equal(resolve(process.execPath),resolve(join(c.installDir,c.executableName+'.exe')));
  assert.equal(readFileSync(join(c.dataHome,'sentinel'),'utf8'),c.sentinel);
  const statePath=join(app.getPath('userData'),'desktop-update-expected-version');
  const expected=existsSync(statePath)?readFileSync(statePath,'utf8'):undefined;
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
    assert.equal(readFileSync(statePath,'utf8'),next);assert.equal(readFileSync(join(c.dataHome,'sentinel'),'utf8'),c.sentinel);log('before-install',{current,next});
  }});
  await updater.settleInstallState();assert(!existsSync(statePath));
  record('startup-'+current,{current,expected,architecture:process.arch,pid:process.pid,executable:process.execPath,sentinelRetained:true});
  if(index===c.versions.length-1){
    assert.equal((await updater.check()).state,'current');record('completed',{passed:true,current,pid:process.pid,architecture:process.arch});clearTimeout(watchdog);app.quit();return;
  }
  const checked=await updater.check();assert.equal(checked.state,'available');assert.equal(checked.latest,next);log('checked',checked);
  const downloaded=await updater.install();assert.equal(downloaded.state,'downloaded');assert(!existsSync(statePath));log('downloaded',downloaded);
  // Separate calls prove that finishing download alone does not install.
  await new Promise(resolve=>setTimeout(resolve,500));assert.equal(app.getVersion(),current);
  await updater.install();
}
watchdog=setTimeout(()=>{record('failure',{error:'Native upgrade timed out',version:app.getVersion()});app.exit(1);},180000);
accept().catch(error=>{record('failure',{error:error.stack??String(error),version:app.getVersion()});log('failed',String(error));clearTimeout(watchdog);app.exit(1);});
`;
}
/** New external output directory only. Keeps artifacts and failed installations for inspection. */
export async function acceptWindowsUpgrade({architecture,out,sourceSha:expectedSourceSha}) {
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
  await mkdir(out); // Refuse reuse: every run has a unique identity and an empty profile.
  const id=randomUUID(),productName='Vonvon Upgrade Acceptance '+id.slice(0,8)+' '+architecture,executableName=productName,nsisGuid=randomUUID();
  const appId='com.vonvon.bot.upgrade-acceptance.'+id+'.'+architecture,packageName='vonvon-upgrade-acceptance-'+id+'-'+architecture;
  const installDir=join(out,'installed'),desktopHome=join(out,'desktop-home'),dataHome=join(out,'data'),localAppData=join(out,'local-app-data');
  const sentinel='preserve acceptance data '+id,keys=generateKeyPairSync('ed25519');
  const publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString(),privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const c={out,id,sourceSha,appId,productName,executableName,nsisGuid,architecture,installDir,desktopHome,dataHome,localAppData,sentinel,publicKey,versions};
  await mkdir(dataHome);await writeFile(join(dataHome,'sentinel'),sentinel);
  const manualWizard={installer:join(out,'packages','Vonvon-Bot-Setup-'+versions[0]+'-'+architecture+'.exe'),instructions:['After automatic acceptance has uninstalled its unique app, open this fixture installer interactively.','Observe the editable directory page, fixed current-user scope, Chinese/system language and installation progress; save screenshots here.','For an alternate writable path, uncheck Run on the finish page: the automatic entry expects installDir and must not run from another location.','Uninstall only this unique product from the manually chosen path. Never use the real Vonvon Bot installer or registration.'],uninstallerName:'Uninstall '+productName+'.exe'};
  await writeFile(join(out,'acceptance-plan.json'),json({...c,manualWizard,scope:'Real updater + NSIS full-download A→B→C; no full product UI, daemon, differential-download or SmartScreen-prompt claim'}));
  const production=join(repo,'packages/desktop/src/windows-updates.ts'),include=join(repo,'packages/desktop/assets/windows-installer.nsh');
  const sourceFiles=[production,include,join(repo,'packages/desktop/src/windows-update-manifest.mjs'),join(repo,'packages/desktop/electron-builder.yml'),join(repo,'package.json'),join(repo,'package-lock.json'),fileURLToPath(import.meta.url)];
  const sourceHashes={};for(const file of sourceFiles)sourceHashes[relative(repo,file)]=await digest(file,'sha256','hex');
  await writeFile(join(out,'source-hashes.json'),json(sourceHashes));
  const {build}=require('esbuild'),builderRequire=createRequire(require.resolve('app-builder-lib/package.json'));
  const original=builderRequire('js-yaml').load(await readFile(join(repo,'packages/desktop/electron-builder.yml'),'utf8'));
  const runtime=join(out,'electron-runtime'),buildHome=join(out,'build-home'),stage=join(out,'stage'),packages=join(out,'packages');
  await mkdir(buildHome);await mkdir(stage);await mkdir(join(stage,'dist'));
  const env={...process.env,HOME:buildHome,ELECTRON_SKIP_BINARY_DOWNLOAD:'1',CSC_IDENTITY_AUTO_DISCOVERY:'false',ELECTRON_BUILDER_7Z_FILTER:'BCJ'};
  delete env.ELECTRON_RUN_AS_NODE;
  await run(process.execPath,[join(repo,'scripts/windows-build-tools.mjs'),'electron',architecture,runtime],{cwd:repo,env});
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
  const reg=join(process.env.SystemRoot??'C:\\Windows','System32','reg.exe');
  const registration=()=>['32','64'].flatMap(view=>['HKCU','HKLM'].flatMap(hive=>['Software\\'+nsisGuid,'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+nsisGuid].map(path=>{const key=hive+'\\'+path,result=spawnSync(reg,['query',key,'/reg:'+view],{encoding:'utf8',windowsHide:true});if(result.error)throw result.error;return {hive,view,key,exists:result.status===0,value:result.stdout};})));
  assert(registration().every(row=>!row.exists),'Refuse an existing test identity');
  const first=join(packages,'Vonvon-Bot-Setup-'+versions[0]+'-'+architecture+'.exe');
  await run(first,['/currentuser','/S','/D='+installDir],{windowsVerbatimArguments:true});
  const installedRegistration=registration();assert(installedRegistration.some(row=>row.hive==='HKCU'&&row.exists&&row.value.toLowerCase().includes(installDir.toLowerCase())));assert(!installedRegistration.some(row=>row.hive==='HKLM'&&row.exists));
  await writeFile(join(out,'installed-registration.json'),json(installedRegistration));
  const executable=join(installDir,executableName+'.exe');await stat(executable);
  const app=spawn(executable,[],{stdio:'ignore',windowsHide:false});
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
  const complete=JSON.parse(await readFile(join(out,'completed.json'),'utf8'));
  for(let i=0;i<40;i++){try{process.kill(complete.pid,0);}catch(error){if(error.code==='ESRCH')break;throw error;}if(i===39)throw Error('Last acceptance application did not exit; refusing uninstall');await pause(250);}
  const upgradedRegistration=registration();assert(!upgradedRegistration.some(row=>row.hive==='HKLM'&&row.exists));
  assert(upgradedRegistration.some(row=>row.hive==='HKCU'&&row.exists&&row.key.includes('Uninstall')&&row.value.includes(versions.at(-1))));
  assert(upgradedRegistration.filter(row=>row.exists).every(row=>row.value.toLowerCase().includes(installDir.toLowerCase())));
  await writeFile(join(out,'upgraded-registration.json'),json(upgradedRegistration));
  const uninstaller=join(installDir,'Uninstall '+productName+'.exe');
  await run(uninstaller,['/currentuser','/S'],{windowsVerbatimArguments:true});
  try{await writeFile(join(out,'uninstalled-registration.json'),json(await waitForWindowsUpgradeRemoval(executable,registration)));}
  catch(error){await writeFile(join(out,'uninstall-leftovers.json'),json(error.cleanup??{error:error.stack??String(error)}));throw error;}
  assert.equal(await readFile(join(dataHome,'sentinel'),'utf8'),sentinel);
  await writeFile(join(out,'acceptance.json'),json({passed:true,sourceSha,architecture,versions,appId,completedAt:new Date().toISOString(),sourceHashes,scope:'Native signed full-EXE update and NSIS replacement; production UI/daemon and differential download not covered',sentinelRetained:true,uniqueTestAppUninstalled:true,manualWizardAndProductionUi:'Not exercised by this automated lane; see acceptance-plan.json'}));
  return {passed:true,architecture,evidence:out};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{architecture:{type:'string'},out:{type:'string'},'source-sha':{type:'string'},help:{type:'boolean'}}});
  if(values.help)console.log('On Windows after npm ci: node scripts/windows-upgrade-acceptance.mjs --architecture arm64 --out C:\\absolute\\new-evidence-dir --source-sha FULL_SHA\nUse a different new directory for x64. Never controls the VM, publishes, signs with the production key, or uses the owner installation. Artifacts/evidence remain; a successful run uninstalls only its unique test app. A failed run preserves its test installation for inspection. See acceptance-plan.json/manualWizard for separate interactive directory/language/progress checks; disable Run after finishing a manual alternate-path install. This lane does not prove production UI/daemon, differential download, or SmartScreen prompt behavior.');
  else try{console.log(json(await acceptWindowsUpgrade({...values,sourceSha:values['source-sha']})));}catch(error){console.error(error.stack??error);process.exitCode=1;}
}
