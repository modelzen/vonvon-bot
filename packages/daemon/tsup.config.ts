import { defineConfig } from 'tsup';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

async function bundleOpenCodePlugin(): Promise<void> {
  const result = await build({
    entryPoints: ['src/agent/providers/opencode/v2/bridge-plugin.mjs'],
    bundle: true, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
    target: 'es2022', write: false, metafile: true,
  });
  if (Object.values(result.metafile!.outputs).some(output => output.imports.length > 0)) {
    throw new Error('OpenCode plugin bundle contains external imports');
  }
  const artifact = result.outputFiles[0];
  if (!artifact) throw new Error('OpenCode plugin bundle is empty');
  await mkdir('dist/v2', { recursive: true });
  await writeFile('dist/v2/bridge-plugin.bundle.mjs', artifact.contents);
}

// @anthropic-ai/claude-agent-sdk 是「按需下载」后端依赖（不在 dependencies，故 tsup
// 默认会把它打进 dist）——显式外置：dist 只保留运行时 import，真正加载走 loadBackendDep
// （桥/全局/用户私装目录三路探测），未装则 Web 出「下载」按钮。
const external = ['@anthropic-ai/claude-agent-sdk'];

export default defineConfig([
  {
    entry: { cli: 'src/cli/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    sourcemap: false,
    splitting: false,
    dts: false,
    external,
    onSuccess: bundleOpenCodePlugin,
  },
  {
    entry: { index: 'src/index.ts', host: 'src/host/public.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: false,
    splitting: false,
    dts: true,
    external,
  },
]);
