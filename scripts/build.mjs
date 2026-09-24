import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
await build({entryPoints:['desktop/main/index.ts'],outfile:'dist/main.cjs',bundle:true,platform:'node',format:'cjs',external:['electron'],sourcemap:true});
await build({entryPoints:['desktop/preload.ts'],outfile:'dist/preload.cjs',bundle:true,platform:'node',format:'cjs',external:['electron'],sourcemap:true});
await viteBuild({root:'desktop/renderer',base:'./',build:{outDir:'../../dist/renderer',emptyOutDir:true}});
