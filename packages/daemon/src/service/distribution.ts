import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {basename, delimiter, dirname, join, parse, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {spawnProcess} from '../platform/spawn';
import type {Definition} from './definitions';

export type Distribution =
  | {kind:'global-npm'|'bundled'|'development'|'unknown';cliPath:string}
  /** The script-installed server package (devices 7.1, 7.2): `<installRoot>/releases/<version>/app` is the package root. */
  | {kind:'standalone';cliPath:string;installRoot:string};
const metadataSchema=z.object({name:z.string(),version:z.string().optional(),bin:z.unknown().optional(),main:z.unknown().optional()});
/** Written by scripts/build-server.mjs; later fields (I3) are allowed. `installRoot`, when an installer records it, must match the layout. */
const standaloneSchema=z.object({v:z.literal(1),version:z.string(),installRoot:z.string().optional()});
const vonvonBinSchema=z.object({vonvon:z.literal('bin/vonvon.mjs')});

function canonical(path:string):string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function isRegularFile(path:string):boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function packageMetadata(path:string):z.infer<typeof metadataSchema>|undefined {
  try { return metadataSchema.parse(JSON.parse(readFileSync(path,'utf8'))); } catch { return undefined; }
}

function hasVonvonBin(metadata:NonNullable<ReturnType<typeof packageMetadata>>):boolean {
  return vonvonBinSchema.safeParse(metadata.bin).success;
}

/** `<installRoot>/releases/<version>/app`, with `standalone.json` beside `app`. A half-unpacked `<version>.part` does not count. */
function standaloneRoot(packageRoot:string, version:string|undefined):string|undefined {
  const release=dirname(packageRoot);
  const releases=dirname(release);
  if (basename(packageRoot)!=='app' || basename(releases)!=='releases' || !version || basename(release)!==version) return undefined;
  let marker:z.infer<typeof standaloneSchema>;
  try { marker=standaloneSchema.parse(JSON.parse(readFileSync(join(release,'standalone.json'),'utf8'))); } catch { return undefined; }
  const installRoot=dirname(releases);
  if (marker.version!==version || (marker.installRoot!==undefined && canonical(marker.installRoot)!==installRoot)) return undefined;
  return installRoot;
}

function inCheckout(root:string):boolean {
  for (let dir=root;;dir=dirname(dir)) {
    const marker=join(dir,'.git');
    try { if (statSync(marker).isDirectory() || statSync(marker).isFile()) return true; } catch {}
    if (dir===parse(dir).root) return false;
  }
}

export function classifyDistribution(root:string, globalRoot?:string):Distribution {
  const packageRoot=canonical(root);
  const cliPath=join(packageRoot,'bin','vonvon.mjs');
  const unknown:Distribution={kind:'unknown',cliPath};
  const metadata=packageMetadata(join(packageRoot,'package.json'));
  if (!metadata || !['@vonvon/daemon','vonvon-bot'].includes(metadata.name) || !hasVonvonBin(metadata)) return unknown;
  if (metadata.name==='@vonvon/daemon' && basename(packageRoot)==='daemon' && isRegularFile(cliPath) && isRegularFile(join(packageRoot,'dist','cli.js'))) {
    const resources=dirname(packageRoot);
    const desktop=packageMetadata(join(resources,'app.asar','package.json'));
    if (desktop?.name==='vonvon-bot-desktop' && desktop.main==='desktop/main.cjs' && isRegularFile(join(resources,'app.asar','desktop','main.cjs'))) {
      return {kind:'bundled',cliPath};
    }
  }

  // Before the checkout test: a home directory kept in git (dotfiles) must not turn an installed server into development.
  if (metadata.name==='@vonvon/daemon' && isRegularFile(cliPath) && isRegularFile(join(packageRoot,'dist','cli.js'))) {
    const installRoot=standaloneRoot(packageRoot,metadata.version);
    if (installRoot) return {kind:'standalone',cliPath,installRoot};
  }

  if (inCheckout(packageRoot)) return {kind:'development',cliPath};
  if (!isRegularFile(cliPath) || !isRegularFile(join(packageRoot,'dist','cli.js'))) return unknown;

  if (metadata.name==='vonvon-bot' && globalRoot) {
    try {
      if (packageRoot===realpathSync(join(globalRoot,'vonvon-bot'))) return {kind:'global-npm',cliPath};
    } catch {}
  }
  return unknown;
}

export const installsService=(distribution:Distribution):boolean =>
  distribution.kind==='bundled' || distribution.kind==='global-npm' || distribution.kind==='standalone';

/**
 * What a launchd or systemd definition runs. A standalone server goes through its stable `current` link with the Node it
 * ships, never the versioned realpath this process runs from, so an upgrade only moves `current` (devices 7.2). That Node
 * goes first on PATH for managed tools whose launcher is `#!/usr/bin/env node`.
 */
export function serviceProgram(distribution:Distribution, executable:string, capturedPath:string):{distribution:Definition['distribution'];capturedPath:string} {
  switch (distribution.kind) {
    case 'bundled': return {distribution:{kind:'desktop',executable,entry:distribution.cliPath},capturedPath};
    case 'global-npm': return {distribution:{kind:'npm',executable,entry:distribution.cliPath},capturedPath};
    case 'standalone': {
      const current=join(distribution.installRoot,'current');
      const node=join(current,'node','bin','node');
      const entry=join(current,'app','bin','vonvon.mjs');
      if (!isRegularFile(node) || !isRegularFile(entry)) throw new Error(`Standalone install has no usable current release at ${current}`);
      const bin=dirname(node);
      return {distribution:{kind:'standalone',executable:node,entry},capturedPath:[bin,...capturedPath.split(delimiter).filter(part=>part && part!==bin)].join(delimiter)};
    }
    default: throw new Error('Distribution cannot install a service');
  }
}

/** macOS runs a quarantined app from a random read-only copy (App Translocation); a service pointing there breaks on the next login. */
export const isTranslocated = (path:string):boolean => path.includes('/AppTranslocation/');

export function nearestPackageRoot(modulePath:string):string {
  for (let dir=dirname(modulePath);;dir=dirname(dir)) {
    if (existsSync(join(dir,'package.json'))) return dir;
    if (dir===parse(dir).root) return dir;
  }
}

export async function runtimeDistribution():Promise<Distribution> {
  const root = nearestPackageRoot(fileURLToPath(import.meta.url));
  const local = classifyDistribution(root);
  if (local.kind !== 'unknown') return local;
  const globalRoot = await new Promise<string|undefined>(resolveRoot=>{
    const child = spawnProcess('npm',['root','-g'],{stdio:['ignore','pipe','ignore']});
    let output = '';
    let overflow = false;
    const timer = setTimeout(()=>{child.kill();resolveRoot(undefined);},5000);
    child.stdout?.on('data',(chunk:Buffer)=>{
      const text=chunk.toString();
      if (text.length>8192-output.length) overflow=true;
      output+=text.slice(0,8192-output.length);
      if (overflow) child.kill();
    });
    child.once('error',()=>{clearTimeout(timer);resolveRoot(undefined);});
    child.once('close',code=>{clearTimeout(timer);resolveRoot(code===0 && !overflow ? output.trim():undefined);});
  });
  return classifyDistribution(root,globalRoot);
}
