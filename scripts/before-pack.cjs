const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {execFileSync}=require('node:child_process');
const {Arch}=require('builder-util');
module.exports=async function beforePack(context){
  const target=context.electronPlatformName==='darwin'?'darwin-arm64':context.electronPlatformName==='win32'?'win32-x64':undefined;
  if(!target||context.arch!==(target==='darwin-arm64'?Arch.arm64:Arch.x64))throw new Error('Unsupported release target.');
  if(process.env.VONVON_DESKTOP_PREVIEW==='1'){
    const directory=target==='darwin-arm64'?'mac-arm64':'win-x64';
    const provenance=JSON.parse(readFileSync(join(context.packager.info.appDir,'build','runtime',directory,'provenance.json'),'utf8'));
    if(!provenance.development)throw new Error('Preview packaging requires explicitly staged development provenance.');
    if(!context.packager.appInfo.productName.endsWith('Preview'))throw new Error('Development app must be labelled Preview.');
    return;
  }
  execFileSync(process.execPath,['scripts/check-package.mjs',target],{cwd:context.packager.info.appDir,stdio:'inherit'});
};
