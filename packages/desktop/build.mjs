import { build } from 'esbuild';
import { access, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const stage = join(root, 'stage');
const ui = join(root, '../ui/dist');
await access(join(ui, 'index.html'));
await access(join(root, 'assets/tray.png'));
await mkdir(dist, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: { main: 'src/main.ts', preload: 'src/preload.ts' },
  outdir: dist,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  define: { 'process.env.NODE_ENV': '"production"' },
});
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, 'desktop'), { recursive: true });
await mkdir(join(stage, 'assets'), { recursive: true });
await cp(join(dist, 'main.cjs'), join(stage, 'desktop/main.cjs'));
await cp(join(dist, 'preload.cjs'), join(stage, 'desktop/preload.cjs'));
await cp(ui, join(stage, 'ui'), { recursive: true });
await cp(join(root, 'assets/tray.png'), join(stage, 'assets/tray.png'));
await writeFile(join(stage, 'package.json'), JSON.stringify({
  name: 'vonvon-bot-desktop',
  version: '0.1.0',
  private: true,
  main: 'desktop/main.cjs',
  description: 'Vonvon Bot desktop',
  author: 'modelzen',
}, null, 2) + '\n');
