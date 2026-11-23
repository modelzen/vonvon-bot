import { mkdir, copyFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateDecoderRoot } from '../src/logo-sandbox.mjs';

let root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node package-logo-decoder.mjs NEW_ARTIFACT_DIRECTORY');
await mkdir(root,{recursive:false,mode:0o755});
root = await realpath(root);
await writeFile(join(root,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{sharp:'0.35.5'}}));
execFileSync('npm',['install','--prefix',root,'--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{stdio:'inherit'});
for (const name of ['logo-child.mjs','logo-format.mjs','errors.mjs']) {
  await copyFile(fileURLToPath(new URL(`../src/${name}`,import.meta.url)),join(root,name));
}
validateDecoderRoot(root);
console.log(root);
