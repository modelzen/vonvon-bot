import {execFileSync} from 'node:child_process';
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('This preview command supports native macOS arm64 only.');
execFileSync(process.execPath,['scripts/build.mjs'],{stdio:'inherit'});
execFileSync(process.execPath,['node_modules/electron-builder/cli.js','--mac','dir','--arm64','--publish','never','--config.productName=Vonvon Bot Preview'],{stdio:'inherit',env:{...process.env,VONVON_DESKTOP_PREVIEW:'1'}});
