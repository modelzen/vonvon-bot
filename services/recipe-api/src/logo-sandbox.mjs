import { readFileSync, lstatSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const files = ['logo-child.mjs','logo-format.mjs','errors.mjs'];
export const decoderEnvironment = Object.freeze({UV_THREADPOOL_SIZE:'1',VIPS_CONCURRENCY:'1',MALLOC_ARENA_MAX:'1'});

export function validateDecoderRoot(root) {
  if (!root || !isAbsolute(root) || realpathSync(root) !== root) throw new Error('Invalid decoder artifact');
  const inspect = path => {
    const resolved = realpathSync(path);
    const inside = relative(root,resolved);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Decoder dependency escapes artifact');
    const info = statSync(path);
    if (![0,process.getuid?.()].includes(info.uid) || info.mode & 0o022) throw new Error('Writable decoder artifact');
    if (info.isDirectory() && lstatSync(path).isSymbolicLink()) throw new Error('Invalid decoder directory symlink');
    if (info.isDirectory()) for (const name of readdirSync(path)) inspect(join(path,name));
    else if (!info.isDirectory() && !info.isFile()) throw new Error('Invalid decoder artifact entry');
  };
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory()) throw new Error('Invalid decoder artifact root');
  if (![0,process.getuid?.()].includes(rootInfo.uid) || rootInfo.mode & 0o022) throw new Error('Writable decoder artifact');
  for (const file of files) {
    const path = join(root,file);
    if (!lstatSync(path).isFile()) throw new Error('Invalid decoder module');
    inspect(path);
  }
  inspect(join(root,'node_modules'));
  if (JSON.parse(String(readFileSync(join(root,'node_modules/sharp/package.json')))).version !== '0.35.5') throw new Error('Unexpected Sharp version');
  return root;
}

export function linuxDecoderLaunch(mode, {root = process.env.LOGO_DECODER_ROOT, node = process.execPath, bwrap = '/usr/bin/bwrap'} = {}) {
  if (!['normalize','check'].includes(mode)) throw new Error('Invalid decoder mode');
  validateDecoderRoot(root);
  const binary = realpathSync(bwrap);
  const info = statSync(binary);
  if (binary !== bwrap || info.uid !== 0 || info.mode & 0o022 || !info.isFile()) throw new Error('Untrusted bubblewrap');
  const args = ['--unshare-all','--unshare-user','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv',
    '--ro-bind','/usr','/usr','--dir','/decoder','--dir','/dev',
    '--dir','/tmp','--proc','/proc','--remount-ro','/proc'];
  for (const path of ['/lib','/lib64']) {
    try {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) args.push('--symlink',relative('/',realpathSync(path)),path);
      else args.push('--ro-bind',path,path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  args.push('--dir','/etc');
  try { if (statSync('/etc/ld.so.cache').isFile()) args.push('--ro-bind','/etc/ld.so.cache','/etc/ld.so.cache'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const file of files) args.push('--ro-bind',join(root,file),`/decoder/${file}`);
  args.push('--ro-bind',join(root,'node_modules'),'/decoder/node_modules','--ro-bind',realpathSync(node),'/node');
  for (const [key,value] of Object.entries(decoderEnvironment)) args.push('--setenv',key,value);
  args.push('--chdir','/decoder','--remount-ro','/','--','/node','--jitless','--max-old-space-size=48','/decoder/logo-child.mjs',mode);
  return {command:bwrap,args};
}
