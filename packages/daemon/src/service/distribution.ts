import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {basename, dirname, join, parse, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {spawnProcess} from '../platform/spawn';

export type Distribution = {kind:'global-npm'|'bundled'|'development'|'unknown';cliPath:string};
const metadataSchema=z.object({name:z.string(),bin:z.unknown().optional(),main:z.unknown().optional()});
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

  if (inCheckout(packageRoot)) return {kind:'development',cliPath};
  if (!isRegularFile(cliPath) || !isRegularFile(join(packageRoot,'dist','cli.js'))) return unknown;

  if (metadata.name==='vonvon-bot' && globalRoot) {
    try {
      if (packageRoot===realpathSync(join(globalRoot,'vonvon-bot'))) return {kind:'global-npm',cliPath};
    } catch {}
  }
  return unknown;
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
