import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {promisify} from 'node:util';
import {z} from 'zod';

const exec = promisify(execFile);
const configuration = z.object({manifestURL:z.string().url(),teamIdentifier:z.string().regex(/^[A-Z0-9]{10}$/)}).strict();
type Options = {appPath:string;isPackaged:boolean;platform?:NodeJS.Platform};

export async function desktopUpdateConfiguration(options:Options):Promise<{signed:boolean;manifestURL?:string}> {
  if (!options.isPackaged || (options.platform ?? process.platform) !== 'darwin') return {signed:false};
  try {
    const config = configuration.parse(JSON.parse(await readFile(join(options.appPath,'dist','update-config.json'),'utf8')));
    const url = new URL(config.manifestURL);
    if (url.protocol !== 'https:' || url.username || url.password) return {signed:false};
    const bundle = dirname(dirname(dirname(options.appPath)));
    if (!bundle.endsWith('.app')) return {signed:false};
    await exec('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{timeout:15000,maxBuffer:65536});
    const {stderr} = await exec('/usr/bin/codesign',['--display','--verbose=4',bundle],{timeout:15000,maxBuffer:65536});
    if (!stderr.split('\n').includes(`TeamIdentifier=${config.teamIdentifier}`) || !/^Authority=Developer ID Application:/m.test(stderr)) return {signed:false};
    return {signed:true,manifestURL:url.href};
  } catch {
    return {signed:false};
  }
}
