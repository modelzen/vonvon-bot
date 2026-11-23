import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
await build({entryPoints: [new URL('src/viewer.tsx', import.meta.url).pathname], bundle: true, format: 'esm',
  outfile: new URL('dist/viewer.mjs', import.meta.url).pathname, jsx: 'automatic', minify: true,
  define: {'process.env.NODE_ENV': '"production"'}, absWorkingDir: root});
await build({entryPoints: [new URL('src/rich-detail.mjs', import.meta.url).pathname], bundle: true, format: 'esm',
  platform: 'node', target: 'node22', outfile: new URL('dist/rich-detail.mjs', import.meta.url).pathname,
  absWorkingDir: root});
