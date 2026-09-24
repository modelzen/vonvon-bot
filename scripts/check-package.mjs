import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,basename} from 'node:path';
const target=process.argv[2];
const lock=JSON.parse(await readFile('runtime-lock.json','utf8'));
if(!Object.hasOwn(lock.targets,target))throw new Error('Unsupported package target.');
const runtime=JSON.parse(await readFile(join('build','runtime',lock.targets[target].builderTarget,'provenance.json'),'utf8'));
if(runtime.development)throw new Error('Release packaging refuses a development core override.');
const source=JSON.parse(await readFile('vendor/core/provenance.json','utf8'));
if(runtime.sourceCommit!==source.sourceCommit||runtime.artifactSha256!==source.artifactSha256)throw new Error('Staged core differs from the committed pin.');
const digest=createHash('sha256').update(await readFile(join('vendor','core',basename(source.artifact)))).digest('hex');
if(digest!==source.artifactSha256)throw new Error('Core artifact hash mismatch.');
if(runtime.nodeArchiveSha256!==lock.targets[target].sha256)throw new Error('Node runtime hash mismatch.');
process.stdout.write(`Verified production package inputs for ${target}.\n`);

const lockDigest=createHash('sha256').update(await readFile('vendor/core/source-package-lock.json')).digest('hex');
if(lockDigest!==source.sourceLockSha256||runtime.sourceLockSha256!==source.sourceLockSha256)throw new Error('Core source lock differs from the reviewed pin.');
