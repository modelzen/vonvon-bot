import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,cp,rm,rename,stat} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const target=process.argv[2]??`${process.platform}-${process.arch}`;
const lock=JSON.parse(await readFile(join(root,'runtime-lock.json'),'utf8'));
if(!Object.hasOwn(lock.targets,target))throw new Error(`Unsupported runtime target ${target}.`);
if(target!==`${process.platform}-${process.arch}`)throw new Error('Prepare production dependencies on the native target to retain correct optional packages.');
const entry=lock.targets[target];
const cache=join(root,'build','downloads');await mkdir(cache,{recursive:true});
const archive=process.env.VONVON_NODE_ARCHIVE?resolve(process.env.VONVON_NODE_ARCHIVE):join(cache,entry.archive);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try{await stat(archive);}catch{const response=await fetch(entry.url);if(!response.ok)throw new Error(`Node download failed ${response.status}.`);await writeFile(archive,Buffer.from(await response.arrayBuffer()));}
if(hash(await readFile(archive))!==entry.sha256)throw new Error('Node archive integrity mismatch.');
const dev=process.env.VONVON_CORE_DEV_ARTIFACT;
const provenancePath=join(root,'vendor','core','provenance.json');
const devProvenance=dev&&process.env.VONVON_CORE_DEV_PROVENANCE?JSON.parse(await readFile(process.env.VONVON_CORE_DEV_PROVENANCE,'utf8')):{};
const provenance=dev?{development:true,artifact:resolve(dev),artifactSha256:hash(await readFile(resolve(dev))),repository:devProvenance.repository,sourceCommit:devProvenance.commit,sourceLockSha256:devProvenance.lockSha256,packCommand:devProvenance.packCommand,containsCompanionCapabilities:devProvenance.containsCompanionCapabilities}:JSON.parse(await readFile(provenancePath,'utf8'));
if(!dev&&(!/^[a-f0-9]{40}$/.test(provenance.sourceCommit)||!provenance.sourceLockSha256||!provenance.repository||!provenance.packCommand))throw new Error('Pinned core provenance is incomplete.');
const artifact=dev?resolve(dev):join(root,'vendor','core',basename(provenance.artifact));
if(hash(await readFile(artifact))!==provenance.artifactSha256)throw new Error('Core artifact integrity mismatch.');
const destination=join(root,'build','runtime',entry.builderTarget);
const stage=`${destination}.staging`;
await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
if(target.startsWith('darwin')) {
  const members=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).split('\n').filter(Boolean);
  if(members.some(member=>member.startsWith('/')||member.split('/').includes('..')||!member.startsWith(`${entry.folder}/`)))throw new Error('Unsafe Node archive member.');
  execFileSync('tar',['-xzf',archive,'-C',stage]);
} else {
  const command="Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($env:VONVON_EXTRACT_SOURCE); foreach ($entry in $zip.Entries) { if ($entry.FullName.StartsWith('/') -or $entry.FullName.Split('/').Contains('..') -or -not $entry.FullName.StartsWith('node-v24.14.1-win-x64/')) { throw 'Unsafe archive member' } }; $zip.Dispose(); [IO.Compression.ZipFile]::ExtractToDirectory($env:VONVON_EXTRACT_SOURCE,$env:VONVON_EXTRACT_DESTINATION)";
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{env:{...process.env,VONVON_EXTRACT_SOURCE:archive,VONVON_EXTRACT_DESTINATION:stage}});
}
await rename(join(stage,entry.folder),join(stage,'node'));
const node=join(stage,'node',target.startsWith('win')?'node.exe':'bin/node');
const npm=join(stage,'node',target.startsWith('win')?'node_modules/npm/bin/npm-cli.js':'lib/node_modules/npm/bin/npm-cli.js');
if(execFileSync(node,['--version'],{encoding:'utf8'}).trim()!==`v${lock.nodeVersion}`)throw new Error('Bundled Node version mismatch.');
if(execFileSync(node,[npm,'--version'],{encoding:'utf8'}).trim()!==lock.npmVersion)throw new Error('Bundled npm version mismatch.');
const core=join(stage,'core');
const coreMembers=execFileSync('tar',['-tzf',artifact],{encoding:'utf8'}).split('\n').filter(Boolean);
if(coreMembers.some(member=>!member.startsWith('package/')||member.split('/').includes('..')))throw new Error('Unsafe core archive member.');
execFileSync('tar',['-xzf',artifact,'-C',stage]);
await rename(join(stage,'package'),core);
const sourceLock=dev?process.env.VONVON_CORE_DEV_LOCK:join(root,'vendor','core','source-package-lock.json');
if(!sourceLock)throw new Error('An exact source package lock is required with the core artifact.');
const sourceLockBytes=await readFile(sourceLock);
if(provenance.sourceLockSha256&&hash(sourceLockBytes)!==provenance.sourceLockSha256)throw new Error('Core source lock integrity mismatch.');
await writeFile(join(core,'package-lock.json'),sourceLockBytes);
execFileSync(node,[npm,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:core,stdio:'inherit',env:{...process.env,npm_config_cache:join(root,'build','npm-cache')}});
const pkg=JSON.parse(await readFile(join(core,'package.json'),'utf8'));
if(!pkg.exports?.['./host']?.import)throw new Error('Core does not export the frozen Host API.');
await writeFile(join(stage,'provenance.json'),JSON.stringify({...provenance,nodeArchiveSha256:entry.sha256,target,coreVersion:pkg.version},null,2)+'\n');
await rm(destination,{recursive:true,force:true});await rename(stage,destination);
process.stdout.write(`Staged ${dev?'development':'pinned'} runtime at ${destination}\n`);
